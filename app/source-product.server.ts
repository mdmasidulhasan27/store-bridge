import { logWarn } from "./logger.server";

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface SourceImage {
  url: string;
  alt?: string;
}

export interface SourceVariantExtras {
  sku: string;
  tracked?: boolean;
  cost?: string;
  countryCodeOfOrigin?: string;
  provinceCodeOfOrigin?: string;
  harmonizedSystemCode?: string;
  metafields: MetafieldInput[];
}

export interface SourceProductExtras {
  seo: { title?: string; description?: string } | null;
  images: SourceImage[];
  metafields: MetafieldInput[];
  variants: SourceVariantExtras[];
  collectionHandles: string[];
}

interface AdminGraphql {
  graphql: (
    query: string,
    options: { variables: Record<string, unknown> },
  ) => Promise<Response>;
}

interface MetafieldNode {
  namespace: string;
  key: string;
  value: string;
  type: string;
}

interface SourceProductResponse {
  product: {
    seo: { title: string | null; description: string | null } | null;
    media: {
      nodes: { image?: { url: string; altText: string | null } | null }[];
    };
    metafields: { nodes: MetafieldNode[] };
    variants: {
      nodes: {
        sku: string | null;
        metafields: { nodes: MetafieldNode[] };
        inventoryItem: {
          tracked: boolean;
          unitCost: { amount: string } | null;
          countryCodeOfOrigin: string | null;
          provinceCodeOfOrigin: string | null;
          harmonizedSystemCode: string | null;
        } | null;
      }[];
    };
    collections: { nodes: { handle: string }[] };
  } | null;
}

/**
 * Reference-typed metafields point at source IDs that don't exist in the
 * destination, and `$app` metafields belong to the source app install, so
 * neither can be copied meaningfully.
 */
function isCopyable(node: MetafieldNode): boolean {
  return (
    Boolean(node.namespace && node.key && node.type) &&
    !node.namespace.startsWith("$app") &&
    !node.type.includes("reference")
  );
}

function copyableMetafields(nodes: MetafieldNode[]): MetafieldInput[] {
  const copyable = nodes.filter(isCopyable);

  if (copyable.length < nodes.length) {
    logWarn("source", "skipped metafields", {
      skipped: nodes.length - copyable.length,
      reason: "app-owned or reference type",
    });
  }

  return copyable.map((node) => ({
    namespace: node.namespace,
    key: node.key,
    value: node.value,
    type: node.type,
  }));
}

export async function fetchSourceProductExtras(
  admin: AdminGraphql,
  productId: number | string,
): Promise<SourceProductExtras | null> {
  const response = await admin.graphql(
    `#graphql
      query SourceProductExtras($id: ID!) {
        product(id: $id) {
          seo {
            title
            description
          }
          media(first: 100) {
            nodes {
              ... on MediaImage {
                image {
                  url
                  altText
                }
              }
            }
          }
          metafields(first: 100) {
            nodes {
              namespace
              key
              value
              type
            }
          }
          variants(first: 100) {
            nodes {
              sku
              metafields(first: 100) {
                nodes {
                  namespace
                  key
                  value
                  type
                }
              }
              inventoryItem {
                tracked
                unitCost {
                  amount
                }
                countryCodeOfOrigin
                provinceCodeOfOrigin
                harmonizedSystemCode
              }
            }
          }
          collections(first: 100) {
            nodes {
              handle
            }
          }
        }
      }`,
    { variables: { id: `gid://shopify/Product/${productId}` } },
  );

  const body = (await response.json()) as {
    data?: SourceProductResponse;
    errors?: { message: string }[];
  };

  if (body.errors?.length) {
    throw new Error(body.errors.map((error) => error.message).join("; "));
  }

  const product = body.data?.product;
  if (!product) {
    return null;
  }

  return {
    seo:
      product.seo?.title || product.seo?.description
        ? {
            title: product.seo?.title ?? undefined,
            description: product.seo?.description ?? undefined,
          }
        : null,
    images: product.media.nodes
      .map((node) => node.image)
      .filter((image): image is { url: string; altText: string | null } =>
        Boolean(image?.url),
      )
      .map((image) => ({ url: image.url, alt: image.altText ?? undefined })),
    metafields: copyableMetafields(product.metafields.nodes),
    variants: product.variants.nodes
      .filter((node) => Boolean(node.sku))
      .map((node) => ({
        sku: node.sku as string,
        tracked: node.inventoryItem?.tracked,
        cost: node.inventoryItem?.unitCost?.amount,
        countryCodeOfOrigin: node.inventoryItem?.countryCodeOfOrigin ?? undefined,
        provinceCodeOfOrigin:
          node.inventoryItem?.provinceCodeOfOrigin ?? undefined,
        harmonizedSystemCode:
          node.inventoryItem?.harmonizedSystemCode ?? undefined,
        metafields: copyableMetafields(node.metafields.nodes),
      })),
    collectionHandles: product.collections.nodes.map((node) => node.handle),
  };
}
