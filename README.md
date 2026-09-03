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

## Later: connecting to Shopify

This version is deliberately standalone. If you later want it to pull and push
prices to Shopify automatically, that needs a hosted version with Shopify API
credentials — the bundle mapping you build here carries over unchanged.
