# StoreBridge — Project Context / Handoff

_Last updated: 2026-10-10. Read this first when resuming on another machine._

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
  - `vendor == "belwari"` → push to **Belwari**
  - any other vendor → push to **Keno**
- **Stock identity = variant barcode.** Barcode must exist in BOTH source and destination, else skip (never creates). Mirrored to **both** Belwari and Keno.

## Stack

- React Router 7 + TypeScript + Vite (`@shopify/shopify-app-react-router`)
- Prisma + SQLite (`prisma/schema.prisma`) — currently only the `Session` model (session storage). **No custom tables.**
- Admin API version: **2026-07** (`ApiVersion.July26` in `app/shopify.server.ts`; also the constant in `app/stores.server.ts`).
- Node >= 22.12, pnpm workspaces (extensions dir is empty).
- **Use the Shopify AI Toolkit (Shopify Dev MCP) for any Shopify API/platform work.** See `AGENTS.md`.

## Environment variables

Secrets live in `.env` (gitignored — never commit). Values are NOT stored in this file.

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
| `app/stores.server.ts` | Per-destination Shopify Admin client. Client-credentials token (in-memory cache, 24h), `destinationGraphql`, `findDestinationProductIdBySku`, `upsertDestinationProduct` (`productSet`), `findDestinationVariantByBarcode`, `getDestinationLocationId` (first/primary, cached), `setDestinationAvailableQuantity` (`inventorySetQuantities`). |
| `app/product-sync.server.ts` | `destinationForVendor` routing (belwari→belwari, else→keno), webhook-payload → `ProductSetInput` mapping, `syncProductToDestination(product, "create" \| "update")` — matched by **SKU**; create mode creates when absent, update mode only ever updates; no SKU → skip. |
| `app/inventory-sync.server.ts` | `syncInventoryToDestinations` — broadcasts absolute available qty to both stores; matches variant by **barcode only** and **never creates products** (skips if no barcode or no match); aggregates errors and throws if any destination failed. |
| `app/routes/webhooks.products.create.tsx` | `products/create` → `syncProductToDestination`. |
| `app/routes/webhooks.products.update.tsx` | `products/update` → `syncProductToDestination`. |
| `app/routes/webhooks.inventory_levels.update.tsx` | `inventory_levels/update` → resolves source barcode via source `admin.graphql`, then broadcasts stock. |
| `app/routes/webhooks.app.uninstalled.tsx`, `...scopes_update.tsx` | Template defaults. |
| `app/shopify.server.ts` | `shopifyApp` config (apiVersion July26, Prisma session storage). |
| `shopify.app.toml` | App config + **webhook subscriptions**: `app/uninstalled`, `app/scopes_update`, `products/create`, `products/update`, `inventory_levels/update`. |
| `prisma/schema.prisma` | SQLite datasource + `Session` model. |

## GraphQL operations used (all validated against 2026-07)

- **Find product by SKU (destination):** `productVariants(first:1, query:"sku:\"...\"") { nodes { product { id } } }`
- **Upsert product (destination):** `productSet(input: ProductSetInput!, identifier: ProductSetIdentifiers)` — no identifier = create, `{ id }` = update. Payload maps `title, descriptionHtml, vendor, productType, tags, status, productOptions, variants[sku,barcode,price,compareAtPrice], files[]`. `handle` intentionally omitted.
- **Find variant (destination, for stock):** `productVariants(first:1, query:"barcode:\"...\"") { nodes { id inventoryItem { id } } }`
- **Primary location (destination):** `locations(first:1) { nodes { id } }`
- **Set stock (destination):** `inventorySetQuantities(input:{ name:"available", reason:"correction", quantities:[{ inventoryItemId, locationId, quantity }] })`
- **Source item lookup (inventory webhook):** `inventoryItem(id: "gid://shopify/InventoryItem/<id>") { sku variants(first:1) { nodes { barcode } } }` — uses non-deprecated `variants`.

## Local setup (new machine)

```bash
npm install                 # or pnpm install
# create .env with the vars above
npm run setup               # prisma generate && prisma migrate deploy
npm run dev                 # shopify app dev (creates tunnel, links app)
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
- Product sync (vendor-routed, barcode-matched) and inventory broadcast implemented.
- Inventory sync is update-only (never creates products); product sync skips products with no barcode to avoid duplicates.
- **Not yet run end-to-end against live stores** (needs real store access + tunnel).

## Known caveats / decisions

- **Keno env not filled in yet.** If a destination is unconfigured, the sync logs a warning and skips (webhook still returns 200). Fill `KENO_*` to enable it.
- Publishing the new `inventory_levels/update` subscription requires `npm run deploy`.
- Product status gate removed: draft/archived product updates now propagate too.
- `handle` omitted on destination → Shopify generates it (avoids collisions).
- Destination edits are overwritten on the next Blucheez update — intentional one-way mirror.
- Stock is mirrored to **one** location per destination (the first/primary). Multi-location routing is not handled.
- Product identity is **SKU**; stock identity is **barcode**. A missing source key → skip. Stock never creates products. Neither SKU nor barcode is unique in Shopify, so shared values can mis-match.
- If a destination API call fails during stock broadcast, the other still runs and the webhook returns 500 so Shopify retries (upsert/set are idempotent).
- Webhook-triggered inventory sync needs the source `admin` session; CLI-triggered webhooks (fake shop) have none and will be skipped by design.

## Possible next steps

- Fill in `KENO_*` and run an end-to-end test (create/update a `belwari` vendor product → Belwari; another vendor → Keno; change stock → both).
- Multi-location inventory mapping (if destinations have >1 location).
- Admin health page showing each destination's configured status / token check.
- Consider async `productSet` (`synchronous: false`) if large products time out.
