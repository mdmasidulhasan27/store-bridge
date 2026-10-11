import {
  findDestinationProductIdBySku,
  getDestination,
  upsertDestinationProduct,
  type DestinationName,
} from "./stores.server";

interface WebhookVariant {
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
  position?: number | null;
}

interface WebhookOption {
  name?: string | null;
  position?: number | null;
  values?: string[] | null;
}

interface WebhookImage {
  src?: string | null;
  alt?: string | null;
}

export interface WebhookProduct {
  id?: number | string;
  title?: string | null;
  body_html?: string | null;
  vendor?: string | null;
  product_type?: string | null;
  handle?: string | null;
  status?: string | null;
  tags?: string | string[] | null;
  options?: WebhookOption[] | null;
  variants?: WebhookVariant[] | null;
  images?: WebhookImage[] | null;
}

type ProductSyncMode = "create" | "update";

interface ProductSyncOutcome {
  destination: DestinationName;
  action: "created" | "updated" | "skipped";
  productId: string | null;
}

const STATUS_MAP: Record<string, string> = {
  active: "ACTIVE",
  draft: "DRAFT",
  archived: "ARCHIVED",
};

function destinationForVendor(
  vendor: string | null | undefined,
): DestinationName {
  return vendor?.trim().toLowerCase() === "belwari" ? "belwari" : "keno";
}

function normalizeTags(tags: WebhookProduct["tags"]): string[] {
  if (!tags) {
    return [];
  }
  if (Array.isArray(tags)) {
    return tags.map((tag) => tag.trim()).filter(Boolean);
  }
  return tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function buildOptionValues(
  variant: WebhookVariant,
  options: WebhookOption[],
): { optionName: string; name: string }[] {
  const values = [variant.option1, variant.option2, variant.option3];

  return options
    .map((option, index) => ({ option, value: values[index] }))
    .filter(
      (entry): entry is { option: WebhookOption; value: string } =>
        Boolean(entry.option.name && entry.value),
    )
    .map((entry) => ({
      optionName: entry.option.name as string,
      name: entry.value,
    }));
}

function buildProductSetInput(
  product: WebhookProduct,
): Record<string, unknown> {
  const options = product.options ?? [];
  const variants = (product.variants ?? []).map((variant) => ({
    optionValues: buildOptionValues(variant, options),
    sku: variant.sku ?? undefined,
    barcode: variant.barcode ?? undefined,
    price: variant.price ?? undefined,
    compareAtPrice: variant.compare_at_price ?? undefined,
  }));

  const files = (product.images ?? [])
    .filter((image) => image.src)
    .map((image) => ({
      originalSource: image.src as string,
      alt: image.alt ?? undefined,
      contentType: "IMAGE",
    }));

  return {
    title: product.title ?? undefined,
    descriptionHtml: product.body_html ?? undefined,
    vendor: product.vendor ?? undefined,
    productType: product.product_type ?? undefined,
    tags: normalizeTags(product.tags),
    status: product.status ? STATUS_MAP[product.status] : undefined,
    productOptions: options
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((option, index) => ({
        name: option.name ?? `Option ${index + 1}`,
        position: option.position ?? index + 1,
        values: (option.values ?? []).map((name) => ({ name })),
      })),
    variants,
    ...(files.length > 0 ? { files } : {}),
  };
}

function primarySku(product: WebhookProduct): string | null {
  return (
    (product.variants ?? [])
      .map((variant) => variant.sku?.trim())
      .find((sku): sku is string => Boolean(sku)) ?? null
  );
}

export async function syncProductToDestination(
  product: WebhookProduct,
  mode: ProductSyncMode,
): Promise<ProductSyncOutcome | null> {
  const destinationName = destinationForVendor(product.vendor);
  const destination = getDestination(destinationName);

  if (!destination) {
    console.warn(
      `[sync] destination "${destinationName}" is not configured; skipping source product ${product.id}`,
    );
    return null;
  }

  const sku = primarySku(product);
  if (!sku) {
    console.warn(
      `[sync] source product ${product.id} has no variant SKU; skipping (SKU is the match key)`,
    );
    return { destination: destinationName, action: "skipped", productId: null };
  }

  const existingProductId = await findDestinationProductIdBySku(destination, sku);

  if (!existingProductId && mode === "update") {
    console.warn(
      `[sync] no ${destinationName} product with SKU "${sku}"; skipping update (never creates)`,
    );
    return { destination: destinationName, action: "skipped", productId: null };
  }

  const input = buildProductSetInput(product);
  const synced = await upsertDestinationProduct(
    destination,
    input,
    existingProductId ? { id: existingProductId } : undefined,
  );

  return {
    destination: destinationName,
    action: existingProductId ? "updated" : "created",
    productId: synced?.id ?? null,
  };
}
