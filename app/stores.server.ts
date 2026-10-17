import { randomUUID } from "node:crypto";

import { log, logError, logWarn } from "./logger.server";

export type DestinationName = "belwari" | "keno";

export interface DestinationConfig {
  name: DestinationName;
  shop: string;
  clientId: string;
  clientSecret: string;
}

export interface DestinationProduct {
  id: string;
  variants: { barcode: string | null; inventoryItemId: string | null }[];
}

const API_VERSION = "2026-07";

const ENV_PREFIX: Record<DestinationName, string> = {
  belwari: "BELWARI",
  keno: "KENO",
};

export function getDestination(name: DestinationName): DestinationConfig | null {
  const prefix = ENV_PREFIX[name];
  const shop = process.env[`${prefix}_SHOP`];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];

  if (!shop || !clientId || !clientSecret) {
    return null;
  }

  return { name, shop, clientId, clientSecret };
}

const tokenCache = new Map<DestinationName, { token: string; expiresAt: number }>();
const locationCache = new Map<DestinationName, string[]>();

async function getToken(destination: DestinationConfig): Promise<string> {
  const cached = tokenCache.get(destination.name);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const response = await fetch(
    `https://${destination.shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: destination.clientId,
        client_secret: destination.clientSecret,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `${destination.name}: token request failed (${response.status}) ${await response.text()}`,
    );
  }

  const { access_token, expires_in } = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  tokenCache.set(destination.name, {
    token: access_token,
    expiresAt: Date.now() + expires_in * 1000,
  });

  log("destination", "refreshed access token", {
    destination: destination.name,
    shop: destination.shop,
  });

  return access_token;
}

async function destinationGraphql<T = unknown>(
  destination: DestinationConfig,
  operation: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  log("api", "sending request", {
    destination: destination.name,
    operation,
  });

  const startedAt = Date.now();
  const response = await fetch(
    `https://${destination.shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": await getToken(destination),
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const durationMs = Date.now() - startedAt;

  if (response.status === 401 || response.status === 403) {
    tokenCache.delete(destination.name);
    logWarn("destination", "unauthorized; cleared cached token", {
      destination: destination.name,
      status: response.status,
    });
    throw new Error(`${destination.name}: GraphQL unauthorized (${response.status})`);
  }

  if (!response.ok) {
    logError("api", "request failed", {
      destination: destination.name,
      operation,
      status: response.status,
      ms: durationMs,
    });
    throw new Error(
      `${destination.name}: GraphQL request failed (${response.status})`,
    );
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    logError("api", "request returned errors", {
      destination: destination.name,
      operation,
      errors: json.errors.map((error) => error.message).join("; "),
    });
    throw new Error(
      `${destination.name}: GraphQL errors: ${JSON.stringify(json.errors)}`,
    );
  }

  if (!json.data) {
    throw new Error(`${destination.name}: GraphQL response contained no data`);
  }

  log("api", "received response", {
    destination: destination.name,
    operation,
    status: response.status,
    ms: durationMs,
  });

  return json.data;
}

function escapeSearchTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function findDestinationProductIdBySku(
  destination: DestinationConfig,
  sku: string,
): Promise<string | null> {
  const data = await destinationGraphql<{
    productVariants: { nodes: { product: { id: string } }[] };
  }>(
    destination,
    "findProductIdBySku",
    `#graphql
      query FindProductBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          nodes {
            product {
              id
            }
          }
        }
      }`,
    { query: `sku:"${escapeSearchTerm(sku)}"` },
  );

  return data.productVariants.nodes[0]?.product.id ?? null;
}

export async function upsertDestinationProduct(
  destination: DestinationConfig,
  input: Record<string, unknown>,
  identifier?: Record<string, unknown>,
): Promise<DestinationProduct | null> {
  const data = await destinationGraphql<{
    productSet: {
      product: {
        id: string;
        variants: {
          nodes: { barcode: string | null; inventoryItem: { id: string } | null }[];
        };
      } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    destination,
    "productSet",
    `#graphql
      mutation UpsertProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(input: $input, identifier: $identifier) {
          product {
            id
            variants(first: 100) {
              nodes {
                barcode
                inventoryItem {
                  id
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    { input, identifier: identifier ?? null },
  );

  if (data.productSet.userErrors.length > 0) {
    throw new Error(
      `${destination.name}: productSet failed: ${JSON.stringify(data.productSet.userErrors)}`,
    );
  }

  const product = data.productSet.product;
  if (!product) {
    return null;
  }

  return {
    id: product.id,
    variants: product.variants.nodes.map((node) => ({
      barcode: node.barcode,
      inventoryItemId: node.inventoryItem?.id ?? null,
    })),
  };
}

export async function findDestinationVariantByBarcode(
  destination: DestinationConfig,
  barcode: string,
): Promise<{ variantId: string; inventoryItemId: string } | null> {
  const data = await destinationGraphql<{
    productVariants: {
      nodes: { id: string; inventoryItem: { id: string } | null }[];
    };
  }>(
    destination,
    "findVariantByBarcode",
    `#graphql
      query FindVariantByBarcode($query: String!) {
        productVariants(first: 1, query: $query) {
          nodes {
            id
            inventoryItem {
              id
            }
          }
        }
      }`,
    { query: `barcode:"${escapeSearchTerm(barcode)}"` },
  );

  const node = data.productVariants.nodes[0];
  if (!node?.inventoryItem) {
    return null;
  }

  return { variantId: node.id, inventoryItemId: node.inventoryItem.id };
}

interface LocationsPage {
  locations: {
    nodes: { id: string }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function fetchLocationsPage(
  destination: DestinationConfig,
  cursor: string | null,
): Promise<LocationsPage> {
  return destinationGraphql<LocationsPage>(
    destination,
    "locations",
    `#graphql
      query AllLocations($cursor: String) {
        locations(first: 100, after: $cursor) {
          nodes {
            id
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
    { cursor },
  );
}

async function getDestinationLocationIds(
  destination: DestinationConfig,
): Promise<string[]> {
  const cached = locationCache.get(destination.name);
  if (cached) {
    return cached;
  }

  const locationIds: string[] = [];
  let cursor: string | null = null;

  do {
    const data = await fetchLocationsPage(destination, cursor);

    locationIds.push(...data.locations.nodes.map((node) => node.id));
    cursor = data.locations.pageInfo.hasNextPage
      ? data.locations.pageInfo.endCursor
      : null;
  } while (cursor);

  locationCache.set(destination.name, locationIds);
  log("destination", "loaded locations", {
    destination: destination.name,
    count: locationIds.length,
  });
  return locationIds;
}

async function stockInventoryItemAtLocations(
  destination: DestinationConfig,
  inventoryItemId: string,
  locationIds: string[],
): Promise<void> {
  const data = await destinationGraphql<{
    inventoryBulkToggleActivation: {
      userErrors: { code: string | null; field: string[] | null; message: string }[];
    };
  }>(
    destination,
    "inventoryBulkToggleActivation",
    `#graphql
      mutation StockInventoryItem($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!, $idempotencyKey: String!) {
        inventoryBulkToggleActivation(
          inventoryItemId: $inventoryItemId
          inventoryItemUpdates: $inventoryItemUpdates
        ) @idempotent(key: $idempotencyKey) {
          userErrors {
            code
            field
            message
          }
        }
      }`,
    {
      inventoryItemId,
      inventoryItemUpdates: locationIds.map((locationId) => ({
        locationId,
        activate: true,
      })),
      idempotencyKey: randomUUID(),
    },
  );

  const errors = data.inventoryBulkToggleActivation.userErrors;
  if (errors.length > 0) {
    throw new Error(
      `${destination.name}: inventoryBulkToggleActivation failed: ${JSON.stringify(
        errors,
      )}`,
    );
  }

  log("destination", "stocked item at all locations", {
    destination: destination.name,
    locations: locationIds.length,
  });
}

export async function setDestinationAvailableQuantity(
  destination: DestinationConfig,
  inventoryItemId: string,
  quantity: number,
): Promise<void> {
  const locationIds = await getDestinationLocationIds(destination);
  if (locationIds.length === 0) {
    throw new Error(`${destination.name}: no locations found for inventory sync`);
  }

  await stockInventoryItemAtLocations(destination, inventoryItemId, locationIds);

  const data = await destinationGraphql<{
    inventorySetQuantities: {
      userErrors: { code: string | null; field: string[] | null; message: string }[];
    };
  }>(
    destination,
    "inventorySetQuantities",
    `#graphql
      mutation SetAvailableQuantity($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
        inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
          userErrors {
            code
            field
            message
          }
        }
      }`,
    {
      input: {
        name: "available",
        reason: "correction",
        quantities: locationIds.map((locationId) => ({
          inventoryItemId,
          locationId,
          quantity,
          changeFromQuantity: null,
        })),
      },
      idempotencyKey: randomUUID(),
    },
  );

  if (data.inventorySetQuantities.userErrors.length > 0) {
    throw new Error(
      `${destination.name}: inventorySetQuantities failed: ${JSON.stringify(
        data.inventorySetQuantities.userErrors,
      )}`,
    );
  }
}

/** Resolves destination collection ids by handle. Handles not present are skipped. */
export async function findDestinationCollectionIds(
  destination: DestinationConfig,
  handles: string[],
): Promise<string[]> {
  const collectionIds: string[] = [];

  for (const handle of handles) {
    const data = await destinationGraphql<{
      collections: { nodes: { id: string }[] };
    }>(
      destination,
      "collectionsByHandle",
      `#graphql
        query CollectionsByHandle($query: String!) {
          collections(first: 1, query: $query) {
            nodes {
              id
            }
          }
        }`,
      { query: `handle:"${escapeSearchTerm(handle)}"` },
    );

    const collectionId = data.collections.nodes[0]?.id;
    if (collectionId) {
      collectionIds.push(collectionId);
    } else {
      logWarn("destination", "collection not found by handle; skipping", {
        destination: destination.name,
        handle,
      });
    }
  }

  return collectionIds;
}

export async function addProductToCollections(
  destination: DestinationConfig,
  productId: string,
  collectionIds: string[],
): Promise<void> {
  for (const collectionId of collectionIds) {
    const data = await destinationGraphql<{
      collectionAddProducts: {
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      destination,
      "collectionAddProducts",
      `#graphql
        mutation AddProductToCollection($id: ID!, $productIds: [ID!]!) {
          collectionAddProducts(id: $id, productIds: $productIds) {
            userErrors {
              field
              message
            }
          }
        }`,
      { id: collectionId, productIds: [productId] },
    );

    if (data.collectionAddProducts.userErrors.length > 0) {
      throw new Error(
        `${destination.name}: collectionAddProducts failed: ${JSON.stringify(
          data.collectionAddProducts.userErrors,
        )}`,
      );
    }
  }
}
