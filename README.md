# Bundle Price Manager (local)

A small app that keeps your Shopify bundle prices in sync with their component
prices. Change one product's price and it instantly shows every bundle that's
now wrong, with the corrected price ready to copy into Shopify.

Runs entirely on your computer. No accounts, no cloud, no Shopify credentials.
All data lives in **`data/data.json`** on your disk.

---

## One-time setup

1. Install [Node.js](https://nodejs.org) (the "LTS" version is fine).
2. Open a terminal **in this folder** and run:

   ```
   npm install
   ```

## Running it

```
npm start
```

Then open **http://localhost:4321** in your browser. Leave the terminal window
open while you use it. To stop, press `Ctrl+C` in the terminal.

Every change you make autosaves to `data/data.json`. A rolling backup of the
last 20 saves is kept in `data/backups/` automatically.

---

## Loading your catalog and bundles

Your 738-product catalog is already loaded in `data/data.json`.

To (re)load from CSVs — for example after filling the bundle template:

```
npm run import -- products.csv bundle_template.csv
```

- **products.csv** columns: `name, sku, price` (optional `status`, `dead`).
  Rows with `dead = yes` are skipped.
- **bundle_template.csv** columns: `bundle_name, item_sku, qty`
  (optional `bundle_price` = current live Shopify price). One row per component;
  repeat `bundle_name` across rows for each item in that bundle. Items are
  matched to products by **SKU**.

> Note: `import` **replaces** everything in `data.json`. Your previous file is
> backed up first under `data/backups/`.

---

## How you'll use it day to day

1. A product price changes → edit it once on the **Products** tab.
2. Open **Needs updating** → every affected bundle is listed with old price,
   correct price, and the difference.
3. **Copy all** → paste into Shopify. Click **Mark all updated** so they go green.

That's it.

---

## Your data is yours

`data/data.json` is a plain text file. You can open it, copy it, put it in
Dropbox/Drive, or move it to another computer — the app reads whatever is there.
Back it up by copying that one file.

## Hosting it (free) — Vercel + Upstash Redis

`server.js` writes to a local file, which a serverless host can't keep. The
hosted copy instead uses **`api/data.js`** (a Vercel function) backed by
**Upstash Redis** — both have a permanent free tier, no card. The frontend and
`npm start` for local use don't change.

1. **Push to GitHub.**
2. **Vercel → Add New… → Project → import the repo.** Framework preset:
   **Other**. Deploy. (`public/` is served statically, `api/data.js` becomes the
   `/api/data` endpoint.)
3. **Add the database.** In the Vercel project: **Storage → Upstash → Redis →
   create** (free plan). Connect it to the project — this sets
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_*`;
   the code accepts either). Redeploy.
4. **Lock it down.** Project → **Settings → Environment Variables** → add
   `BASIC_AUTH_USER` and `BASIC_AUTH_PASS`. `middleware.js` then makes the whole
   site prompt for that login. Until both are set the URL is open to anyone.
   Redeploy.
5. **Load your catalog once.** Locally, make a `.env` file next to
   `package.json` with the two `UPSTASH_REDIS_REST_*` values (copy from the
   Upstash console), then:

   ```
   npm run seed
   ```

   This pushes `data/data.json` (or `seed/data.json`) into Redis. Without it the
   hosted app starts empty.

Backups: the last 20 pre-save versions are kept in the Redis list
`bundle-manager:backups`. To pull the live data down, open
`https://<your-app>/api/data` (after logging in) and save the JSON.

## Keeping the catalog in sync with Shopify

New products get added in Shopify over time. To pull those into the live app
**without disturbing anything else**, use the sync script. It matches on **SKU**
and only ever *adds* products — it never edits or deletes an existing product,
and never touches bundles, prices you've changed by hand, or history. (Bundles
link to products by an internal id, so replacing the product list would break
every bundle — hence add-only.)

### With a CSV export (no API setup)

1. Shopify admin → **Products → Export → All products → CSV**.
2. Dry run to see what would change:

   ```
   npm run sync-store -- path/to/products_export.csv
   ```

   It lists: new products it would add, SKUs already in the catalog (skipped),
   draft/archived products (skipped), price differences (reported only, never
   changed), and catalog SKUs missing from the export.
3. Happy with it? Add `--apply`:

   ```
   npm run sync-store -- path/to/products_export.csv --apply
   ```

   The previous state is backed up to `data/backups/before-sync-*.json` and to
   the Redis backup list first.

Flags: `--include-draft` also adds draft products (as inactive);
`--base <file>` merges against a local JSON file instead of live data
(needs `--force` to `--apply`).

### Straight from the Shopify API

Create a **custom app** in Shopify admin (Settings → Apps and sales channels →
Develop apps), give it the **`read_products`** Admin API scope, install it, copy
the Admin API access token. Add to `.env`:

```
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_...
```

Then:

```
npm run sync-store -- --shopify          # dry run
npm run sync-store -- --shopify --apply
```

### Automating it

`.github/workflows/sync-store.yml` runs the check **weekly as a dry run** and
posts the diff to the workflow summary. To actually add products, open the
**Actions** tab → *Sync store products* → **Run workflow** with *apply* checked.

Add these repository secrets (Settings → Secrets and variables → Actions):
`KV_REST_API_URL`, `KV_REST_API_TOKEN` (same as Vercel), `SHOPIFY_STORE`,
`SHOPIFY_ADMIN_TOKEN`.

Fully unattended auto-apply is possible (add `--apply` to the schedule step) and
reasonably safe since the script is add-only — but a weekly glance at the report
catches SKU typos and mis-statused products before they land.

### Other helpers

- `npm run pull` — download the current live catalog to `data/live-<time>.json`
  and refresh `data/data.json`. A quick manual backup, or a way to see exactly
  what's live before syncing.

## Seeing which bundles are out of stock

Bundles don't track their own stock — they're only as available as their least
available component. To see that at a glance, `scripts/fetch-stock.js` pulls
current inventory from Shopify and matches it onto your catalog by **SKU**
(same matching rule as the product sync). It only ever updates the `stock`
field on products that already exist — it never adds/removes products or
touches bundles, prices, or history.

```
npm run fetch-stock              dry run — reports what would change
npm run fetch-stock -- --apply   writes the refreshed stock live
```

Needs the same `.env` as `--shopify` sync above, plus your custom app's Admin
API token needs the **`read_inventory`** scope in addition to `read_products`
(Shopify admin → your app → Configuration → Admin API integration → add scope
→ Save; you'll be asked to accept the new scope, the token itself doesn't
change).

Once applied, the app shows:
- An **Out of stock** tab (sorted A–Z) listing every bundle blocked by a
  zero-stock component, and which component(s) those are. An "Out of stock"
  filter pill on both the **Bundles** and **Products** tabs finds the same
  thing without leaving those views.
- An `oos` tag on affected bundles in the **Bundles** list, and a red
  "out of stock" badge on the specific component when you open a bundle.
  Each bundle also shows its own sellable stock — the least of its active,
  tracked components, since that's what actually limits how many you can
  build.
- A **Stock** column on the **Products** tab for each product's own count
  (`—` means Shopify isn't tracking inventory for that item, so it's never
  flagged as a blocker). A discontinued (inactive) product is never counted
  as a stock blocker either — it's already flagged separately as missing.

`.github/workflows/fetch-stock.yml` runs this automatically every 4 hours
(`--apply`, since it only ever touches a stock number — safe to run
unattended) using the same repository secrets as the product sync workflow.
Trigger it manually anytime from the **Actions** tab → *Fetch Shopify stock* →
**Run workflow**.

## Adding bundles Shopify doesn't know are bundles

Shopify has no "bundle" concept the app can read — every bundle here is
built by hand. But on this store, a combo/packaged listing usually shows up
as an **active product with no SKU** (a real standalone product almost always
has one). `scripts/import-bundle-shells.js` uses that pattern: it adds each
matching Shopify listing as an **empty bundle shell** — name and current
price, zero components — so it lands in the same "not built yet" state as a
bundle you started yourself, ready for you to add its real components.

```
npm run import-bundle-shells              dry run
npm run import-bundle-shells -- --apply   writes the new (empty) bundles live
```

Only ever **adds** bundles — never touches an existing bundle or product.
Skips anything whose name already matches an existing bundle or product, and
excludes obvious non-bundles (gift cards, vouchers, partial-payment/test
listings) by name.

## One-click sync

The **"Sync with Shopify"** button in the app header runs all three of the
above in a single pass — new products, new bundle shells, and a stock
refresh — with one Shopify fetch and one write. Throttled to **once every
24 hours**, enforced by the server (`/api/sync`), not just the button, so
it's safe even if the endpoint is hit directly.

For the hosted app, it needs `SHOPIFY_STORE` and `SHOPIFY_ADMIN_TOKEN` added
to the Vercel project's **Environment Variables** (same two values as your
local `.env`) — without them the button fails with a clear "Shopify not
configured" message rather than doing anything unexpected. Locally, it works
through `npm start` as long as `.env` has those two values (server.js loads
`.env` itself for this route; no other local behavior needs it).

## Later: connecting to Shopify

This version is deliberately standalone. If you later want it to pull and push
prices to Shopify automatically, that needs a hosted version with Shopify API
credentials — the bundle mapping you build here carries over unchanged.
