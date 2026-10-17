import {
  addProductToCollections,
  findDestinationCollectionIds,
  findDestinationProductIdBySku,
  getDestination,
  setDestinationAvailableQuantity,
  upsertDestinationProduct,
  type DestinationConfig,
  type DestinationName,
  type DestinationProduct,
} from "./stores.server";
import {
  type SourceImage,
  type SourceProductExtras,
  type SourceVariantExtras,
} from "./source-product.server";
import { log, logWarn } from "./logger.server";

interface WebhookVariant {
  sku?: string | null;
  barcode?: string | null;
  inventory_quantity?: number | null;
  inventory_management?: string | null;
  inventory_policy?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  taxable?: boolean | null;
  requires_shipping?: boolean | null;
  grams?: number | null;
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
  template_suffix?: string | null;
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

/** How many times to look up the destination product before giving up (update mode). */
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_RETRY_MS = 800;

const STATUS_MAP: Record<string, string> = {
  active: "ACTIVE",
  draft: "DRAFT",
  archived: "ARCHIVED",
};

const INVENTORY_POLICY_MAP: Record<string, string> = {
  deny: "DENY",
  continue: "CONTINUE",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function destinationForVendor(
  vendor: string | null | undefined,
): DestinationName {
  return vendor?.trim().toLowerCase() === "belwari" ? "belwari" : "keno";
}

function primarySku(product: WebhookProduct): string | null {
  return (
    (product.variants ?? [])
      .map((variant) => variant.sku?.trim())
      .find((sku): sku is string => Boolean(sku)) ?? null
  );
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

function joinValues(values: (string | null | undefined)[]): string {
  const cleaned = values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  return cleaned.length > 0 ? cleaned.join(",") : "(none)";
}

/** SKUs repeated across variants — they make SKU-based matching ambiguous. */
function duplicateSkus(product: WebhookProduct): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const variant of product.variants ?? []) {
    const sku = variant.sku?.trim();
    if (!sku) {
      continue;
    }
    if (seen.has(sku)) {
      duplicates.add(sku);
    }
    seen.add(sku);
  }

  return [...duplicates];
}

/**
 * On an update, the matching create may still be in flight. Retry the lookup a
 * few times so the update is not dropped just because the product isn't there yet.
 */
async function findDestinationProductId(
  destination: DestinationConfig,
  sku: string,
  attempts: number,
): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const productId = await findDestinationProductIdBySku(destination, sku);
    if (productId) {
      return productId;
    }
    if (attempt < attempts) {
      log("products", "destination product not found yet; retrying", {
        sku,
        attempt,
        attempts,
      });
      await sleep(LOOKUP_RETRY_MS);
    }
  }
  return null;
}

/** Maps a variant's option1/option2/option3 onto the product's option names. */
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

function inventoryPolicy(variant: WebhookVariant): string | undefined {
  return variant.inventory_policy
    ? INVENTORY_POLICY_MAP[variant.inventory_policy.toLowerCase()]
    : undefined;
}

/**
 * Whether the destination variant should track inventory. Prefers the source's
 * real value; the webhook payload usually omits `inventory_management`, and a
 * mirrored variant should track stock by default.
 */
function isTracked(
  variant: WebhookVariant,
  extra?: SourceVariantExtras,
): boolean {
  if (extra?.tracked !== undefined) {
    return extra.tracked;
  }
  if (variant.inventory_management) {
    return variant.inventory_management === "shopify";
  }
  return true;
}

/** Inventory-item fields that mirror the source variant's tracking, shipping, weight, cost and origin. */
function buildInventoryItem(
  variant: WebhookVariant,
  extra?: SourceVariantExtras,
): Record<string, unknown> | undefined {
  const item: Record<string, unknown> = {};

  if (typeof variant.requires_shipping === "boolean") {
    item.requiresShipping = variant.requires_shipping;
  }
  item.tracked = isTracked(variant, extra);
  if (typeof variant.grams === "number" && variant.grams > 0) {
    item.measurement = { weight: { value: variant.grams, unit: "GRAMS" } };
  }
  if (extra?.cost) {
    item.cost = extra.cost;
  }
  if (extra?.countryCodeOfOrigin) {
    item.countryCodeOfOrigin = extra.countryCodeOfOrigin;
  }
  if (extra?.provinceCodeOfOrigin) {
    item.provinceCodeOfOrigin = extra.provinceCodeOfOrigin;
  }
  if (extra?.harmonizedSystemCode) {
    item.harmonizedSystemCode = extra.harmonizedSystemCode;
  }

  return Object.keys(item).length > 0 ? item : undefined;
}

function buildVariantInput(
  variant: WebhookVariant,
  options: WebhookOption[],
  extra?: SourceVariantExtras,
): Record<string, unknown> {
  return {
    optionValues: buildOptionValues(variant, options),
    sku: variant.sku ?? undefined,
    barcode: variant.barcode ?? undefined,
    price: variant.price ?? undefined,
    compareAtPrice: variant.compare_at_price ?? undefined,
    position: variant.position ?? undefined,
    taxable: variant.taxable ?? undefined,
    inventoryPolicy: inventoryPolicy(variant),
    inventoryItem: buildInventoryItem(variant, extra),
    ...(extra && extra.metafields.length > 0
      ? { metafields: extra.metafields }
      : {}),
  };
}

function indexVariantExtras(
  extras: SourceProductExtras | null,
): Map<string, SourceVariantExtras> {
  return new Map(
    (extras?.variants ?? []).map((variant) => [variant.sku, variant]),
  );
}

function buildProductOptions(
  options: WebhookOption[],
): Record<string, unknown>[] {
  return options
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((option, index) => ({
      name: option.name ?? `Option ${index + 1}`,
      position: option.position ?? index + 1,
      values: (option.values ?? []).map((name) => ({ name })),
    }));
}

function imageFilename(url: string, index: number): string {
  const withoutQuery = url.split("?")[0];
  const name = withoutQuery.substring(withoutQuery.lastIndexOf("/") + 1);
  return name || `image-${index + 1}.jpg`;
}

/** Prefers the webhook images; falls back to media read from the source. */
function buildImageFiles(
  images: WebhookImage[],
  fallback: SourceImage[],
): Record<string, unknown>[] {
  const fromPayload = images
    .filter((image) => image.src)
    .map((image, index) => ({
      url: image.src as string,
      alt: image.alt ?? undefined,
      filename: imageFilename(image.src as string, index),
    }));

  const sources =
    fromPayload.length > 0
      ? fromPayload
      : fallback.map((image, index) => ({
          url: image.url,
          alt: image.alt,
          filename: imageFilename(image.url, index),
        }));

  return sources.map((source) => ({
    originalSource: source.url,
    filename: source.filename,
    alt: source.alt,
    contentType: "IMAGE",
  }));
}

function buildProductSetInput(
  product: WebhookProduct,
  extras: SourceProductExtras | null,
): Record<string, unknown> {
  const options = product.options ?? [];
  const files = buildImageFiles(product.images ?? [], extras?.images ?? []);
  const variantExtras = indexVariantExtras(extras);

  return {
    title: product.title ?? undefined,
    descriptionHtml: product.body_html ?? undefined,
    handle: product.handle ?? undefined,
    templateSuffix: product.template_suffix ?? undefined,
    vendor: product.vendor ?? undefined,
    productType: product.product_type ?? undefined,
    tags: normalizeTags(product.tags),
    status: product.status ? STATUS_MAP[product.status] : undefined,
    seo: extras?.seo ?? undefined,
    ...(extras && extras.metafields.length > 0
      ? { metafields: extras.metafields }
      : {}),
    productOptions: buildProductOptions(options),
    variants: (product.variants ?? []).map((variant) =>
      buildVariantInput(
        variant,
        options,
        variantExtras.get(variant.sku?.trim() ?? ""),
      ),
    ),
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * Pushes the source quantity to the destination variant we just wrote, using the
 * inventory item ids returned by productSet. That avoids re-querying by barcode
 * (which can miss right after a create). Variants without a barcode are skipped.
 */
async function setDestinationQuantities(
  destination: DestinationConfig,
  synced: DestinationProduct,
  product: WebhookProduct,
): Promise<void> {
  const inventoryItemIdsByBarcode = new Map(
    synced.variants
      .filter(
        (variant): variant is { barcode: string; inventoryItemId: string } =>
          Boolean(variant.barcode && variant.inventoryItemId),
      )
      .map((variant) => [variant.barcode, variant.inventoryItemId]),
  );

  for (const variant of product.variants ?? []) {
    const barcode = variant.barcode?.trim();
    const quantity = variant.inventory_quantity;

    if (!barcode || typeof quantity !== "number") {
      continue;
    }

    const inventoryItemId = inventoryItemIdsByBarcode.get(barcode);
    if (!inventoryItemId) {
      logWarn("products", "no destination inventory item for barcode", {
        destination: destination.name,
        barcode,
      });
      continue;
    }

    await setDestinationAvailableQuantity(destination, inventoryItemId, quantity);
    log("products", "set inventory quantity", {
      destination: destination.name,
      barcode,
      quantity,
    });
  }
}

/**
 * Adds the destination product to the collections the source product is in,
 * matching collections across stores by handle.
 */
async function syncCollections(
  destination: DestinationConfig,
  productId: string,
  extras: SourceProductExtras | null,
): Promise<void> {
  const handles = extras?.collectionHandles ?? [];
  if (handles.length === 0) {
    return;
  }

  const collectionIds = await findDestinationCollectionIds(destination, handles);
  if (collectionIds.length === 0) {
    return;
  }

  await addProductToCollections(destination, productId, collectionIds);

  log("products", "added to collections", {
    destination: destination.name,
    collections: collectionIds.length,
  });
}

export async function syncProductToDestination(
  product: WebhookProduct,
  mode: ProductSyncMode,
  extras: SourceProductExtras | null = null,
): Promise<ProductSyncOutcome | null> {
  const destinationName = destinationForVendor(product.vendor);
  const destination = getDestination(destinationName);
  const sku = primarySku(product);

  log("products", "read payload", {
    product: product.id,
    title: product.title ?? "(none)",
    vendor: product.vendor ?? "(none)",
    variants: product.variants?.length ?? 0,
    skus: joinValues((product.variants ?? []).map((variant) => variant.sku)),
    barcodes: joinValues(
      (product.variants ?? []).map((variant) => variant.barcode),
    ),
    images: product.images?.length ?? 0,
    sourceMedia: extras?.images.length ?? 0,
    management: joinValues(
      (product.variants ?? []).map((variant) => variant.inventory_management),
    ),
    sourceExtras: extras ? "yes" : "no",
    sourceTracked: extras
      ? extras.variants
          .map((variant) => `${variant.sku}:${variant.tracked ?? "?"}`)
          .join(",")
      : "(none)",
  });

  const duplicates = duplicateSkus(product);
  if (duplicates.length > 0) {
    logWarn("products", "variants share a SKU; matching may be ambiguous", {
      product: product.id,
      skus: duplicates.join(","),
    });
  }

  log("products", `${mode} sync started`, {
    product: product.id,
    vendor: product.vendor ?? "(none)",
    sku: sku ?? "(none)",
    destination: destinationName,
    metafields: extras?.metafields.length ?? 0,
    collections: extras?.collectionHandles.length ?? 0,
  });

  if (!destination) {
    logWarn("products", "destination not configured; skipping", {
      product: product.id,
      destination: destinationName,
    });
    return null;
  }

  if (!sku) {
    logWarn("products", "no variant SKU; skipping", {
      product: product.id,
      reason: "SKU is the match key",
    });
    return { destination: destinationName, action: "skipped", productId: null };
  }

  const existingProductId = await findDestinationProductId(
    destination,
    sku,
    mode === "update" ? LOOKUP_ATTEMPTS : 1,
  );

  log(
    "products",
    existingProductId
      ? "matched destination product"
      : "no matching destination product",
    {
      sku,
      destination: destinationName,
      destinationProduct: existingProductId ?? "(none)",
    },
  );

  if (!existingProductId && mode === "update") {
    logWarn("products", "update skipped; this mode never creates", {
      product: product.id,
      sku,
    });
    return { destination: destinationName, action: "skipped", productId: null };
  }

  const input = buildProductSetInput(product, extras);
  const synced = await upsertDestinationProduct(
    destination,
    input,
    existingProductId ? { id: existingProductId } : undefined,
  );

  const action = existingProductId ? "updated" : "created";
  log("products", `product ${action}`, {
    product: product.id,
    destination: destinationName,
    destinationProduct: synced?.id ?? "(none)",
  });

  if (synced) {
    await setDestinationQuantities(destination, synced, product);
    await syncCollections(destination, synced.id, extras);
  }

  return { destination: destinationName, action, productId: synced?.id ?? null };
}
