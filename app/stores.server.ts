export type DestinationName = "belwari" | "keno";

interface DestinationConfig {
  name: DestinationName;
  shop: string;
  clientId: string;
  clientSecret: string;
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
const locationCache = new Map<DestinationName, string>();

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

  return access_token;
}

async function destinationGraphql<T = unknown>(
  destination: DestinationConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
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

  if (response.status === 401 || response.status === 403) {
    tokenCache.delete(destination.name);
    throw new Error(`${destination.name}: GraphQL unauthorized (${response.status})`);
  }

  if (!response.ok) {
    throw new Error(
      `${destination.name}: GraphQL request failed (${response.status})`,
    );
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(
      `${destination.name}: GraphQL errors: ${JSON.stringify(json.errors)}`,
    );
  }

  if (!json.data) {
    throw new Error(`${destination.name}: GraphQL response contained no data`);
  }

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
): Promise<{ id: string } | null> {
  const data = await destinationGraphql<{
    productSet: {
      product: { id: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    destination,
    `#graphql
      mutation UpsertProduct($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
        productSet(input: $input, identifier: $identifier) {
          product {
            id
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

  return data.productSet.product;
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

async function getDestinationLocationId(
  destination: DestinationConfig,
): Promise<string | null> {
  const cached = locationCache.get(destination.name);
  if (cached) {
    return cached;
  }

  const data = await destinationGraphql<{
    locations: { nodes: { id: string }[] };
  }>(
    destination,
    `#graphql
      query PrimaryLocation {
        locations(first: 1) {
          nodes {
            id
          }
        }
      }`,
  );

  const locationId = data.locations.nodes[0]?.id ?? null;
  if (locationId) {
    locationCache.set(destination.name, locationId);
  }

  return locationId;
}

export async function setDestinationAvailableQuantity(
  destination: DestinationConfig,
  inventoryItemId: string,
  quantity: number,
): Promise<void> {
  const locationId = await getDestinationLocationId(destination);
  if (!locationId) {
    throw new Error(`${destination.name}: no location found for inventory sync`);
  }

  const data = await destinationGraphql<{
    inventorySetQuantities: {
      userErrors: { code: string | null; field: string[] | null; message: string }[];
    };
  }>(
    destination,
    `#graphql
      mutation SetAvailableQuantity($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
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
        quantities: [{ inventoryItemId, locationId, quantity }],
      },
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
