// Refresh stock levels from Shopify for products already in the catalog.
//
// SAFE BY DESIGN: this only ever updates the `stock` / `stockTracked` /
// `stockUpdatedAt` fields on products that already exist (matched by SKU). It
// never adds, removes, or renames products, and never touches bundles, prices,
// or history.
//
// Usage:
//   npm run fetch-stock                 dry run — shows what would change
//   npm run fetch-stock -- --apply      write the refreshed stock to Upstash
//
// Options:
//   --apply     actually write to Upstash (default is a dry run/report only)
//
// .env (next to package.json) needs:
//   KV_REST_API_URL=...
//   KV_REST_API_TOKEN=...
//   SHOPIFY_STORE=your-store.myshopify.com
//   SHOPIFY_ADMIN_TOKEN=shpat_...   custom app, Admin API scopes:
//                                   read_products + read_inventory

import { pull, push } from "./_store.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

const normSku = (s) => (s || "").trim().toLowerCase();

async function fetchStockFromShopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error("Set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in .env.");
    process.exit(1);
  }
  const ver = "2025-01";
  let url = `https://${store}/admin/api/${ver}/products.json?limit=250&fields=id,title,status,variants`;
  const bySku = new Map(); // normSku -> {quantity, tracked}
  let page = 0;
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) {
      console.error(`Shopify API ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const body = await res.json();
    for (const p of body.products || []) {
      for (const v of p.variants || []) {
        const sku = normSku(v.sku);
        if (!sku) continue;
        const tracked = v.inventory_management === "shopify";
        const quantity = tracked ? (Number(v.inventory_quantity) || 0) : null;
        bySku.set(sku, { quantity, tracked });
      }
    }
    page++;
    const link = res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  console.log(`Fetched stock for ${bySku.size} SKU(s) from Shopify (${page} page(s)).`);
  return bySku;
}

const base = await pull();
if (!Array.isArray(base.products)) {
  console.error("Base data doesn't look right (missing products array).");
  process.exit(1);
}

const stockBySku = await fetchStockFromShopify();

const now = new Date().toISOString();
let updated = 0;
let wentOOS = 0;
let backInStock = 0;
let noSku = 0;
let notFound = 0;
const oosNow = [];

const products = base.products.map((p) => {
  const sku = normSku(p.sku);
  if (!sku) { noSku++; return p; }
  const hit = stockBySku.get(sku);
  if (!hit) { notFound++; return p; }

  const wasOOS = p.stockTracked && (p.stock || 0) <= 0;
  const isOOS = hit.tracked && (hit.quantity || 0) <= 0;
  if (!wasOOS && isOOS) wentOOS++;
  if (wasOOS && !isOOS) backInStock++;
  if (isOOS) oosNow.push({ name: p.name, sku: p.sku, qty: hit.quantity });

  if (hit.tracked !== p.stockTracked || hit.quantity !== p.stock) updated++;

  return { ...p, stock: hit.quantity, stockTracked: hit.tracked, stockUpdatedAt: now };
});

const L = "─".repeat(60);
console.log(L);
console.log(`${updated} product(s) with a changed stock value`);
console.log(`${wentOOS} product(s) newly out of stock, ${backInStock} back in stock`);
if (noSku) console.log(`${noSku} catalog product(s) have no SKU — can't match, left as-is`);
if (notFound) console.log(`${notFound} catalog product(s) with a SKU not found in this Shopify fetch — left as-is`);
if (oosNow.length) {
  console.log(`\nCurrently out of stock (${oosNow.length}):`);
  oosNow.slice(0, 40).forEach((p) => console.log(`   ${(p.sku || "(no sku)").padEnd(18)} ${p.name}`));
  if (oosNow.length > 40) console.log(`   ...and ${oosNow.length - 40} more`);
}
console.log(L);

if (!apply) {
  console.log("DRY RUN — nothing written. Add --apply to save this to the live data.");
  process.exit(0);
}

const merged = { ...base, products };
await push(merged);
console.log(`APPLIED — stock refreshed on ${products.length} product(s) at ${now}.`);
