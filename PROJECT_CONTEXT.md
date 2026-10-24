# StoreBridge — Project Context / Handoff

_Last updated: 2026-10-24. Read this first when resuming on another machine._

## What this is

**StoreBridge** is a Shopify app (scaffolded from the official **React Router app template**) that mirrors catalog data from one main store into two destination stores.

- **Blucheez** — the **main/source** store. This app is installed here; Shopify webhooks fire from here.
- **Belwari** (`belwari-2.myshopify.com`) — a **destination** store.
- **Keno** — a **separate destination** store (domain not yet recorded here — see env).

**Sync rules**
- **Product identity = variant SKU.** No SKU in the source → skip.
  - SKU missing in destination → **create**; SKU present → update the full product.
  - `products/create` and `products/update` behave the same: an **update also creates** when the SKU isn't in the destination.
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
- **Production runs on Google Cloud Run + Cloud SQL for PostgreSQL** (region `asia-south1`). Local development keeps the SQLite datasource — see [Deployment](#deployment-google-cloud-run).
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
| `app/product-sync.server.ts` | `destinationForVendor` routing (belwari→belwari, else→keno), webhook-payload → `ProductSetInput` mapping (`STATUS_MAP`, `normalizeTags`, `buildOptionValues`, `buildVariantInput`, `buildProductOptions`, `buildImageFiles`), `syncProductToDestination(product, "create" \| "update", extras?)` — matched by **SKU**; creates when the SKU is absent, updates when present; no SKU → skip. Merges `SourceProductExtras` (SEO, metafields, variant cost/origin) into the `productSet` input. After `productSet`, `setDestinationQuantities` sets each barcode-bearing variant's `inventory_quantity` at all routed-destination locations using inventory item ids from the response (no barcode re-query) and `syncCollections` adds the product to handle-matched collections. Update mode retries the SKU lookup 3× (800ms apart) so a racing create isn't dropped. |
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
| `prisma/schema.prod.prisma` | Postgres mirror of `schema.prisma` — only the datasource differs. Copied over `schema.prisma` by the image build; local dev never uses it. |
| `Dockerfile` | Production image: `node:22-alpine` + Cloud SQL Auth Proxy; swaps in the Postgres schema, drops the SQLite migrations, `prisma generate`, then `react-router build`. |
| `start.sh` | Cloud Run entrypoint: starts the proxy, `npm run setup:prod`, then `exec npm run start` so Node is PID 1. |
| `deploy.sh` | One-shot `gcloud run deploy --source .` with region, secrets, Cloud SQL and scaling flags. |
| `.gcloudignore` / `.dockerignore` | Keep `.env`, the local SQLite file and build output out of the build context and the image. |

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

## Deployment (Google Cloud Run)

Production target: **Cloud Run** (`storebridge`, region `asia-south1`/Mumbai — nearest supported region to Bangladesh) with **Cloud SQL for PostgreSQL 15** (`storebridge-db`, database `shopify_app`). Follows Shopify's [Cloud Run guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-google-cloud-run) with two deltas: `prisma generate` runs at **image build** time (not container start), and the region is `asia-south1`.

**Why Postgres:** `prisma/schema.prisma` hardcodes `url = "file:dev.sqlite"`. On Cloud Run every new revision gets an empty disk, so sessions would be lost and every deployment would force a re-install. The image therefore swaps in `prisma/schema.prod.prisma`; the SQLite `prisma/migrations/` are removed from the image (its DDL cannot run on Postgres) and the schema is created with `prisma db push --skip-generate` at container start.

**Secrets** (Secret Manager → Cloud Run env vars, never in the image):

| Secret | Env var |
| --- | --- |
| `shopify-api-key` | `SHOPIFY_API_KEY` |
| `shopify-api-secret` | `SHOPIFY_API_SECRET` |
| `database-url` | `DATABASE_URL` (`postgresql://postgres:<pw>@localhost:5432/shopify_app`) |
| `belwari-shop`, `belwari-client-id`, `belwari-client-secret` | `BELWARI_*` |
| `keno-shop`, `keno-client-id`, `keno-client-secret` | `KENO_*` — **not created yet**; see caveats |

Plain env vars: `SCOPES`, `SHOPIFY_APP_URL`, `INSTANCE_CONNECTION_NAME`.

**One-time setup** (install the [Cloud CLI](https://cloud.google.com/sdk/docs/install) first — `gcloud` is not on this machine):
```bash
export PROJECT_ID="storebridge-prod"        # must be globally unique
export SERVICE_REGION="asia-south1"

gcloud projects create "$PROJECT_ID" && gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com

eval "$(shopify app info --web-env)"        # exports SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SCOPES

# Secrets (values for BELWARI_* come from .env)
printf '%s' "$SHOPIFY_API_KEY"    | gcloud secrets create shopify-api-key    --data-file=-
printf '%s' "$SHOPIFY_API_SECRET" | gcloud secrets create shopify-api-secret --data-file=-
printf '%s' "<belwari shop>"      | gcloud secrets create belwari-shop          --data-file=-
printf '%s' "<belwari client id>" | gcloud secrets create belwari-client-id     --data-file=-
printf '%s' "<belwari secret>"    | gcloud secrets create belwari-client-secret --data-file=-

# Cloud SQL
export DB_PASSWORD="<strong password>"
gcloud sql instances create storebridge-db --database-version=POSTGRES_15 \
  --tier=db-f1-micro --region="$SERVICE_REGION" --root-password="$DB_PASSWORD"
gcloud sql databases create shopify_app --instance=storebridge-db
printf '%s' "postgresql://postgres:${DB_PASSWORD}@localhost:5432/shopify_app" \
  | gcloud secrets create database-url --data-file=-

# Runtime service account permissions
export RUNTIME_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" --role=roles/cloudsql.client
```

**Deploy:**
```bash
PROJECT_ID=$PROJECT_ID SERVICE_REGION=$SERVICE_REGION \
INSTANCE_CONNECTION_NAME="<project>:asia-south1:storebridge-db" \
SCOPES="$SCOPES" SHOPIFY_APP_URL="https://placeholder.invalid" ./deploy.sh

# SHOPIFY_APP_URL is unknowable until the service exists: the first run creates it
# (and the container fails to start), then read the real URL and deploy again.
SHOPIFY_APP_URL=$(gcloud run services list --filter="metadata.name:storebridge" --format='get(URL)')
```

Then set `application_url` in `shopify.app.toml` to that URL and run `npm run deploy` so the app config and the five webhook subscriptions point at the deployment.

**Runtime flags** (`deploy.sh`): `--min-instances 1` (the sync path is fully sequential, so a cold start risks Shopify's retry window), `--max-instances 3` (limits how many separate in-memory `tokenCache` / `locationCache` maps exist in `app/stores.server.ts`), `--memory 1Gi`, `--timeout 300`, `--allow-unauthenticated` (Shopify must reach the webhooks).

**Verify:**
```bash
gcloud run services logs read storebridge --region asia-south1 --limit 100   # proxy, db push, [storebridge:*] lines
gcloud sql connect storebridge-db --database=shopify_app                      # SELECT count(*) FROM "Session";
```

## Status as of this session

- `typecheck`, `lint` pass.
- **GCP deployment prepared (2026-10-24)**: `prisma/schema.prod.prisma`, `Dockerfile` (Cloud SQL proxy + build-time `prisma generate`), `start.sh`, `deploy.sh`, `.gcloudignore`, hardened `.dockerignore`, `setup:prod` script. The `docker-start` script was removed (the Dockerfile now runs `start.sh`). `typecheck`, `lint` and `prisma validate` are clean, and `prisma generate` against `schema.prod.prisma` succeeds. The image is now built and verified by Cloud Build (`gcloud run deploy --source .`), so the local Docker daemon is not needed for deploys.
- **Deployed to Cloud Run (2026-10-24)**: service `storebridge` in project `store-bridge` (region `asia-south1`), revision `storebridge-00002-hjv`, at <https://storebridge-463178614843.asia-south1.run.app>. gcloud 590.0.1 installed user-local in `~/google-cloud-sdk`, authenticated as `blucheez.bd@gmail.com`. Startup verified end to end: Cloud SQL proxy up, `prisma db push` synced the Postgres schema in 236 ms, `GET /` returns 200. Shopify app version `storebridge-2` released with `application_url` pointing at the service and all five webhook subscriptions.
- **Not verified end to end against live stores yet** — no product/stock sync has run through the deployed app, because that needs the app installed and exercised on the real source store.
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
- **Update creates on a SKU miss** (changed 2026-10-17). Because `products/create` and `products/update` can arrive together, two events can both create a product with the same SKU in the destination. The update-mode SKU-lookup retry (3× / 800ms) reduces but can't fully prevent duplicates.
- If a destination API call fails during stock broadcast, the other still runs and the webhook returns 500 so Shopify retries (upsert/set are idempotent).
- Webhook-triggered inventory sync needs the source `admin` session; CLI-triggered webhooks (fake shop) have none and will be skipped by design.
- **Deployment: `prisma db push --skip-generate` runs on every container start.** Harmless and self-healing for an additive schema, but it is why `--min-instances 1` matters — with scale-to-zero the first request after idle pays proxy startup plus the schema sync before the server listens, which risks Shopify's retry window. Move it to a one-time step (a Cloud Run Job, or a local proxy session) if the always-on instance becomes a cost concern. `db push` refuses destructive changes non-interactively, so an incompatible `Session` change needs a manual table recreate.
- **Deployment: `prisma/migrations/` is discarded in the image**, so the SQLite migration history does not apply to Postgres. Nothing in the app depends on migration history; Postgres schema state is owned by `db push`.
- **Deployment: Keno stays unconfigured** until `keno-*` secrets exist and are appended to `deploy.sh`'s `--set-secrets` — same behaviour as local (`getDestination()` → `null` → warning + skip + HTTP 200). Watch out that `--set-secrets` referencing a secret that does not exist fails the whole deploy.
- **Deployment: `AppDistribution.AppStore`** is set in `app/shopify.server.ts`. Fine for testing on the Blucheez dev store; App Store distribution needs review before real merchants can install. Switch to `AppDistribution.SingleMerchant` if the app is only ever meant for these three stores.
- **Deployment: highest-latency hop is Shopify → Mumbai** (Shopify's webhook egress is US-based). Webhooks are async so this is tolerable; `asia-south1` keeps the outbound Admin API calls to all three stores fast. `asia-southeast1` is the fallback if a service is unavailable in Mumbai.
- **Login form on `/` needed `?index` (fixed 2026-10-24)**: React Router's `getTargetMatch` drops pathless index routes from the action target unless the URL carries a naked `?index`, so the template's `<Form method="post">` in `app/routes/_index/route.tsx` posted to `/` and returned **405** (`You made a POST request to "/" but did not provide an action for route "root"`). The form now sets `action="?index"`, which reaches the action and redirects to the Shopify install URL. The install path Shopify itself uses — `GET /?shop=<store>` → 302 → `/app` — was never affected, so this only ever broke the manual fallback. Reproduced identically on a local production build, i.e. it was **not** caused by the Cloud Run deployment.
- **`GET /app` returns 410 until the app is installed** on that shop — that is the Shopify library's "not installed" response, expected against a fresh (empty) `Session` table.

## Possible next steps

- **Run the first live end-to-end test through the deployed app**: install it on the source store, then create/update a `belwari` vendor product, update another-vendor product, and change stock.
- **Redeploy** with `./deploy.sh` (see [Deployment](#deployment-google-cloud-run)) after any code change — `npm run deploy` is separate and only pushes app config/webhooks.
- Fill in `KENO_*` and run an end-to-end test (create/update a `belwari` vendor product → Belwari; another vendor → Keno; change stock → both).
- Admin health page showing each destination's configured status / token check.
- Consider async `productSet` (`synchronous: false`) if large products time out.
