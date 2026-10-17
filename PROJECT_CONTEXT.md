# StoreBridge — Project Context / Handoff

_Last updated: 2026-10-17. Read this first when resuming on another machine._

## What this is

**StoreBridge** is a Shopify app (scaffolded from the official **React Router app template**) that mirrors catalog data from one main store into two destination stores.

- **Blucheez** — the **main/source** store. This app is installed here; Shopify webhooks fire from here.
- **Belwari** (`belwari-2.myshopify.com`) — a **destination** store.
- **Keno** — a **separate destination** store (domain not yet recorded here — see env).

**Sync rules**
- **Product identity = variant SKU.** No SKU in the source → skip.
  - Create event: SKU missing in destination → create; SKU present → update.
  - Update event: SKU missing in destination → skip (never creates); SKU present → update the full product.
- Product **created/updated** in Blucheez → destination chosen by `vendor`:
  - `vendor == "belwari"` → push to **Belwari** (case-insensitive, trimmed)
  - any other vendor → push to **Keno**
- **Stock identity = variant barcode.** Barcode must exist in BOTH source and destination, else skip (never creates). Mirrored to **both** Belwari and Keno, at **all** locations.
- **On product create/update**, after `productSet`, each variant that has a **barcode** gets its `inventory_quantity` set at **all locations** of the routed destination. The inventory item id comes straight from the `productSet` response — no barcode re-query, so there is no post-create race. The separate inventory webhook still broadcasts by barcode to **both** destinations.

## Stack

- React Router 7.18.2 + TypeScript + Vite (`@shopify/shopify-app-react-router` v3)
- Prisma 6 + SQLite (`prisma/schema.prisma`) — currently only the `Session` model (session storage). **No custom tables.**
- Admin API version: **2026-07** (`ApiVersion.July26` in `app/shopify.server.ts`; also the `API_VERSION` constant in `app/stores.server.ts`).
- `shopify.app.toml`: `embedded = false`; webhook `api_version = "2026-10"` (one version ahead of the Admin API client — the payload mapping is REST-shaped webhook JSON, unaffected).
- Node >= 22.12, pnpm workspaces (`extensions/` is empty, only `.gitkeep`).
- **Use the Shopify AI Toolkit (Shopify Dev MCP) for any Shopify API/platform work.** See `AGENTS.md`.

## Environment variables

Secrets live in `.env` (gitignored — never commit). Values are NOT stored in this file. As of 2026-10-17 only the `BELWARI_*` trio is set; `KENO_*` is still missing.

```
# Belwari destination store
BELWARI_SHOP=<belwari-2.myshopify.com>
BELWARI_CLIENT_ID=<...>
BELWARI_CLIENT_SECRET=<...>

# Keno destination store (still to be filled in)
KENO_SHOP=<...>
KENO_CLIENT_ID=<...>
KENO_CLIENT_SECRET=<...>
```

Also provided at runtime by the Shopify CLI / host (not in `.env`): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`.

**Auth model:** both destinations are reached via the **client credentials grant** — each store has its own Dev Dashboard app (client ID + secret). Requires:
- Destinations in the **same Shopify org** as Blucheez (else `shop_not_permitted`).
- Each destination app version with scopes: `read_products, write_products, read_inventory, write_inventory, read_locations`.

## Code map

| File | Responsibility |
| --- | --- |
| `app/stores.server.ts` | Per-destination Shopify Admin client. Client-credentials token (in-memory cache, 24h, 60s early expiry), `destinationGraphql` (401/403 clears token), `findDestinationProductIdBySku`, `upsertDestinationProduct` (`productSet`), `findDestinationVariantByBarcode`, `getDestinationLocationIds` (**all** locations, paginated, cached), `stockInventoryItemAtLocations` (`inventoryBulkToggleActivation`, activates the item at every location), `setDestinationAvailableQuantity` (`inventorySetQuantities` across **all** locations). Search terms are escaped (`escapeSearchTerm`). |
| `app/product-sync.server.ts` | `destinationForVendor` routing (belwari→belwari, else→keno), webhook-payload → `ProductSetInput` mapping (`STATUS_MAP`, `normalizeTags`, `buildOptionValues`, `buildVariantInput`, `buildProductOptions`, `buildImageFiles`), `syncProductToDestination(product, "create" \| "update", extras?)` — matched by **SKU**; create mode creates when absent, update mode only ever updates; no SKU → skip. Merges `SourceProductExtras` (SEO, metafields, variant cost/origin) into the `productSet` input. After `productSet`, `setDestinationQuantities` sets each barcode-bearing variant's `inventory_quantity` at all routed-destination locations using inventory item ids from the response (no barcode re-query) and `syncCollections` adds the product to handle-matched collections. Update mode retries the SKU lookup 3× (800ms apart) so a racing create isn't dropped. |
| `app/source-product.server.ts` | Reads the deeper/authoritative fields the product webhook may not carry from the **source** store via `admin.graphql`: `seo`, `media` images, product/variant metafields, variant `inventoryItem` (`tracked`, `unitCost`, country of origin, HS code) and collection handles. Skips `$app`-namespace and reference-type metafields. |
| `app/inventory-sync.server.ts` | `syncInventoryToDestinations` — broadcasts absolute available qty to **every location** of both stores; matches variant by **barcode only** and **never creates products** (skips if no barcode or no match); aggregates errors and throws if any destination failed. |
| `app/logger.server.ts` | Tiny logging helper — `log` / `logWarn` / `logError` emit one `[storebridge:<scope>] message key=value` line so a sync can be traced end-to-end. |
| `app/routes/webhooks.products.create.tsx` | `products/create` → reads `SourceProductExtras` (if a source `admin` session exists) → `syncProductToDestination(product, "create", extras)`. |
| `app/routes/webhooks.products.update.tsx` | `products/update` → reads `SourceProductExtras` → `syncProductToDestination(product, "update", extras)`. |
| `app/routes/webhooks.inventory_levels.update.tsx` | `inventory_levels/update` → resolves source barcode via source `admin.graphql`, then broadcasts stock. |
| `app/routes/webhooks.app.uninstalled.tsx`, `...scopes_update.tsx` | Template defaults. |
| `app/routes/app.tsx` | Embedded layout: `AppProvider` + nav (Home, Additional page), error/headers boundaries. |
| `app/routes/app._index.tsx` | Template demo page (Generate a product: `productCreate` + `productVariantsBulkUpdate` + `metaobjectUpsert`). Not app-specific. |
| `app/routes/_index/route.tsx` | Public login form; submits to its own `action` → `login(request)`; `error.server.tsx` maps `LoginErrorType` to messages; `styles.module.css`. |
| `app/shopify.server.ts` | `shopifyApp` config (apiVersion July26, Prisma session storage, `expiringOfflineAccessTokens: true`). |
| `shopify.app.toml` | App config + **webhook subscriptions**: `app/uninstalled`, `app/scopes_update`, `products/create`, `products/update`, `inventory_levels/update`. |
| `prisma/schema.prisma` | SQLite datasource + `Session` model (includes `refreshToken` / `refreshTokenExpires`). |
| `run.sh` | `shopify app dev` (one-line convenience). |

## Logging

Every sync log goes through `app/logger.server.ts` and emits one line per event in a stable shape. All lines go to **stdout** (warnings/errors are prefixed `WARN:` / `ERROR:`), so ordering is preserved:

```
[storebridge:<scope>] <message> key=value key=value
```

Each webhook handler runs inside `withCorrelation`, so every line also carries `req=<id>`. Grep by `req=<id>` to follow one request even when several run at once.

Scopes:
- `webhook` — webhook entry/exit (`received …` → `… handled` / `… failed`), source reads, and skips.
- `products` — payload read, vendor routing, SKU match, create/update, retries, quantity handoff, collections.
- `source` — reads from the source store (skipped metafields, etc.).
- `inventory` — barcode match and per-destination quantity result (inventory webhook path).
- `destination` — token refresh, location loading, stock activation, collection lookup.
- `api` — every destination Admin API call: `sending request` / `received response` with `operation`, `status`, `ms`.

Example trace for one product update:

```
[storebridge:webhook] received products/update shop=… product=123 req=a1b2c3d4
[storebridge:products] read payload product=123 title=Example vendor=belwari variants=1 skus=ABC-1 barcodes=123456 req=a1b2c3d4
[storebridge:products] update sync started product=123 vendor=belwari sku=ABC-1 destination=belwari req=a1b2c3d4
[storebridge:api] sending request destination=belwari operation=findProductIdBySku req=a1b2c3d4
[storebridge:destination] refreshed access token destination=belwari shop=belwari-2.myshopify.com req=a1b2c3d4
[storebridge:api] received response destination=belwari operation=findProductIdBySku status=200 ms=143 req=a1b2c3d4
[storebridge:products] matched destination product sku=ABC-1 destination=belwari destinationProduct=gid://shopify/Product/999 req=a1b2c3d4
[storebridge:api] sending request destination=belwari operation=productSet req=a1b2c3d4
[storebridge:api] received response destination=belwari operation=productSet status=200 ms=210 req=a1b2c3d4
[storebridge:products] product updated product=123 destination=belwari destinationProduct=gid://shopify/Product/999 req=a1b2c3d4
[storebridge:api] sending request destination=belwari operation=locations req=a1b2c3d4
[storebridge:destination] loaded locations destination=belwari count=2 req=a1b2c3d4
[storebridge:api] received response destination=belwari operation=locations status=200 ms=75 req=a1b2c3d4
[storebridge:api] sending request destination=belwari operation=inventoryBulkToggleActivation req=a1b2c3d4
[storebridge:destination] stocked item at all locations destination=belwari locations=2 req=a1b2c3d4
[storebridge:api] received response destination=belwari operation=inventoryBulkToggleActivation status=200 ms=120 req=a1b2c3d4
[storebridge:api] sending request destination=belwari operation=inventorySetQuantities req=a1b2c3d4
[storebridge:api] received response destination=belwari operation=inventorySetQuantities status=200 ms=105 req=a1b2c3d4
[storebridge:products] set inventory quantity destination=belwari barcode=123456 quantity=5 req=a1b2c3d4
[storebridge:webhook] products/update handled product=123 action=updated req=a1b2c3d4
```

The inventory webhook path (`inventory_levels/update`) still logs `webhook → inventory → destination` with `findVariantByBarcode` / `inventoryBulkToggleActivation` / `inventorySetQuantities`.

## GraphQL operations used (validated against Admin API 2026-07)

- **Find product by SKU (destination):** `productVariants(first:1, query:"sku:\"...\"") { nodes { product { id } } }`
- **Upsert product (destination):** `productSet(input: ProductSetInput!, identifier: ProductSetIdentifiers)` — no identifier = create, `{ id }` = update. Payload maps `title, descriptionHtml, handle, templateSuffix, vendor, productType, tags, status, productOptions, variants[optionValues,sku,barcode,price,compareAtPrice,position,taxable,inventoryPolicy,inventoryItem{requiresShipping,tracked,measurement.weight(GRAMS)}], files[]`. The response selects `product { id variants(first:100) { nodes { barcode inventoryItem { id } } } }` so the quantity can be set deterministically afterwards.
- **Find variant (destination, for stock):** `productVariants(first:1, query:"barcode:\"...\"") { nodes { id inventoryItem { id } } }`
- **All locations (destination):** `locations(first:100, after:$cursor) { nodes { id } pageInfo { hasNextPage endCursor } }` — paginated.
- **Stock item at locations (destination, for stock):** `inventoryBulkToggleActivation(inventoryItemId, inventoryItemUpdates:[{locationId, activate:true}])` — activates the inventory item at every location so quantity can be set (needed when the variant isn't already stocked everywhere).
- **Set stock (destination):** `inventorySetQuantities(input:{ name:"available", reason:"correction", quantities:[{ inventoryItemId, locationId, quantity, changeFromQuantity:null }] }, ignoreCompareQuantity omitted) @idempotent(key: randomUUID())`. Each quantity entry **must** include `changeFromQuantity` explicitly (`null` opts out of compare-and-swap). The `@idempotent` key is **required** as of API 2026-04.
- **Source item lookup (inventory webhook):** `inventoryItem(id: "gid://shopify/InventoryItem/<id>") { variants(first:1) { nodes { barcode } } }` — uses non-deprecated `variants`.
- **Source product extras (products webhook, source store):** `product(id) { seo { title description } media(first:100){nodes{... on MediaImage { image { url altText } }}} metafields(first:100){nodes{namespace key value type}} variants(first:100){nodes{sku metafields(first:100){nodes{namespace key value type}} inventoryItem{tracked unitCost{amount} countryCodeOfOrigin provinceCodeOfOrigin harmonizedSystemCode}}} collections(first:100){nodes{handle}} }` — authoritative `tracked` / images, since the webhook payload may omit them.
- **Destination collections by handle:** `collections(first:1, query:"handle:\"<handle>\"") { nodes { id } }`
- **Add product to collection (destination):** `collectionAddProducts(id, productIds)` — **deprecated** in 2026-07 (new model uses `collectionUpdate` with `sourcesToUpdate[].condition.inclusion.selectionsToAdd`, which needs the collection's source id).

## Local setup (new machine)

```bash
npm install                 # or pnpm install
# create .env with the vars above
npm run setup               # prisma generate && prisma migrate deploy
npm run dev                 # shopify app dev (creates tunnel, links app) — or ./run.sh
```

Checks:
```bash
npm run typecheck
npm run lint
npm run build
```

Deploy config/webhooks:
```bash
npm run deploy              # shopify app deploy — REQUIRED after shopify.app.toml changes
```

## Status as of this session

- `typecheck`, `lint` pass.
- Product sync (vendor-routed, SKU-matched) and inventory broadcast implemented and pushed (last commit 2026-10-11).
- **Stock sync reworked (2026-10-17)** to mirror to **all** destination locations, and to supply the fields the 2026-07 schema requires (`changeFromQuantity: null`, `@idempotent` key). Not yet re-verified against live stores.
- **Product sync sets inventory (2026-10-17)**: barcode-bearing variants get `inventory_quantity` set at all routed-destination locations, using the inventory item ids returned by `productSet` (no barcode re-query, so no post-create race). Update mode retries the SKU lookup 3× to survive a racing create. Logs carry `req=<id>` on a single stdout stream, and the `api` scope records every destination send/receive.
- **Wider product clone (2026-10-17)**: `productSet` now also carries `handle`, `templateSuffix`, and variant `position` / `taxable` / `inventoryPolicy` / `inventoryItem` (`requiresShipping`, `tracked`, weight in grams) — everything the product webhook exposes.
- **Deeper clone (2026-10-17)**: products webhook reads SEO, metafields, unit cost, origin/HS code and collections from the source and writes them to the destination (`source-product.server.ts`).
- **Readability + logging pass (2026-10-17)**: sync modules split into small named steps; all logs now go through `app/logger.server.ts` (see Logging above).
- **Not yet run end-to-end against live stores** (needs real store access + tunnel).

## Known caveats / decisions

- **Keno env not filled in yet.** If a destination is unconfigured, the sync logs a warning and skips (webhook still returns 200). Fill `KENO_*` to enable it.
- Publishing the new `inventory_levels/update` subscription requires `npm run deploy`.
- Product status gate removed: draft/archived product updates now propagate too.
- `handle` is now copied from the source. If the destination already has a product with that handle, `productSet` can error (sync returns 500 and retries) — drop the `handle` mapping if that becomes a problem.
- **Deeper fields now copied (2026-10-17)**: SEO, product/variant metafields, unit cost, country of origin and HS code ride inside `productSet`; collections are matched by handle and added with `collectionAddProducts`. `$app`-namespace and reference-type metafields are **skipped** (they don't transfer between stores — see `source` scope logs).
- **Still not copied**: image order (`FileSetInput` has no `position`), `publishedAt`, sales channels / publications, translations, and all IDs / timestamps (Shopify-managed). Collection adds use the deprecated `collectionAddProducts` and only match collections that already exist in the destination by handle.
- Weight is normalised to `GRAMS` (from the payload's `grams`), so it matches physically regardless of the source's display unit.
- **`tracked` and images come from the source read** (`source`-scope log `sourceExtras=`/`sourceTracked=`), because the product webhook omits `inventory_management`. If neither the source value nor the payload says, variants default to **tracked: true** (a mirrored variant should track stock). Images are sent with an explicit `filename` (`FileSetInput`). Source extras need a source `admin` session — without one the route logs `no admin session; skipping source extras` and syncs the payload only.
- Destination edits are overwritten on the next Blucheez update — intentional one-way mirror.
- Stock is mirrored to **every** location of each destination. On product create/update the quantity is set right after `productSet` (item ids from its response) via activate → `inventorySetQuantities`; the inventory webhook does the same after a barcode lookup. If activation fails at a location (e.g. the item is managed by a third-party fulfillment service, or the variant has no SKU — `MISSING_SKU`), that sync for the destination throws and returns 500.
- Product identity is **SKU**; stock identity is **barcode**. A missing source key → skip. Stock never creates products. Neither SKU nor barcode is unique in Shopify, so shared values can mis-match.
- If a destination API call fails during stock broadcast, the other still runs and the webhook returns 500 so Shopify retries (upsert/set are idempotent).
- Webhook-triggered inventory sync needs the source `admin` session; CLI-triggered webhooks (fake shop) have none and will be skipped by design.
- Minor: the products webhook log line prints `products/${topic}` where `topic` is already `products/create`, so logs read `products/products/create`.

## Possible next steps

- Fill in `KENO_*` and run an end-to-end test (create/update a `belwari` vendor product → Belwari; another vendor → Keno; change stock → both).
- Admin health page showing each destination's configured status / token check.
- Consider async `productSet` (`synchronous: false`) if large products time out.
