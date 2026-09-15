// Import "bundle shells" from Shopify: active products that have NO SKU on
// their variant. On this store that pattern usually means a bundle/combo
// listing (a real product with no components has a SKU; a packaged combo
// often doesn't). Each one lands here as an empty bundle — name + live price,
// items: [] — same "not built yet" state as a bundle you started by hand, so
// you can open it and add its real components yourself.
//
// SAFE BY DESIGN: only ever ADDS new bundles. Never edits or deletes an
// existing bundle or product, never touches prices, items, or history. Skips
// anything whose normalised name already matches an existing bundle OR an
// existing product (so it won't shadow something already tracked).
//
// Usage:
//   npm run import-bundle-shells                 dry run — shows what would be added
//   npm run import-bundle-shells -- --apply       writes the new (empty) bundles live
//
// .env (next to package.json) needs the same SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN
// / KV_REST_API_* values as the other Shopify scripts.

import { pull, push } from "./_store.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");

const uid = () => Math.random().toString(36).slice(2, 9);
// same normalisation the app's search box and sync-store use
const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const money = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN");

async function fetchActiveNoSkuFromShopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error("Set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in .env.");
    process.exit(1);
  }
  const ver = "2025-01";
  let url = `https://${store}/admin/api/${ver}/products.json?limit=250&fields=id,title,status,variants`;
  const out = [];
  let page = 0;
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) {
      console.error(`Shopify API ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const body = await res.json();
    for (const p of body.products || []) {
      if (p.status !== "active") continue;
      for (const v of p.variants || []) {
        if ((v.sku || "").trim()) continue; // has a SKU — not a bundle-shell candidate
        const variantName =
          v.title && v.title !== "Default Title" ? `${p.title} ${v.title}` : p.title;
        out.push({ name: variantName, price: parseFloat(v.price) || 0 });
      }
    }
    page++;
    const link = res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  console.log(`Fetched ${out.length} active, no-SKU variant(s) from Shopify (${page} page(s)).`);
  return out;
}

const base = await pull();
if (!Array.isArray(base.products) || !Array.isArray(base.bundles)) {
  console.error("Base data doesn't look right (missing products/bundles arrays).");
  process.exit(1);
}

let incoming = await fetchActiveNoSkuFromShopify();

// dedupe incoming by normalised name
const seen = new Set();
incoming = incoming.filter((p) => {
  const n = normName(p.name);
  if (!n || seen.has(n)) return false;
  seen.add(n);
  return true;
});

const existingBundleNames = new Set(base.bundles.map((b) => normName(b.name)));
const existingProductNames = new Set(base.products.map((p) => normName(p.name)));

// not bundles — gift cards, payment/testing artifacts. Matched as substrings
// of the normalised name, so wording variants ("giftcard", "gift-card") still hit.
const EXCLUDE_KEYWORDS = ["gift card", "voucher", "partial payment", "bogus"];
const isExcluded = (name) => {
  const n = normName(name);
  return EXCLUDE_KEYWORDS.some((k) => n.includes(k));
};

// bundle names the user deliberately deleted before (still in Trash, or
// permanently deleted) — never re-add these; restoring from Trash clears them
const deletedBundleNames = new Set(base.excludedBundleNames || []);

const toAdd = [];
const skippedBundle = [];
const skippedProduct = [];
const skippedExcluded = [];
const skippedDeleted = [];

for (const p of incoming) {
  const n = normName(p.name);
  if (isExcluded(p.name)) { skippedExcluded.push(p); continue; }
  if (deletedBundleNames.has(n)) { skippedDeleted.push(p); continue; }
  if (existingBundleNames.has(n)) { skippedBundle.push(p); continue; }
  if (existingProductNames.has(n)) { skippedProduct.push(p); continue; }
  toAdd.push({ id: uid(), sku: "", name: p.name, items: [], storedPrice: p.price });
}

const L = "─".repeat(60);
console.log(L);
console.log(`base      live Upstash data - ${base.products.length} products, ${base.bundles.length} bundles`);
console.log(`incoming  ${incoming.length} unique active/no-SKU variant(s) from Shopify`);
console.log(L);

console.log(`\n  +${toAdd.length} new empty bundle(s) to add`);
toAdd.slice(0, 60).forEach((b) => console.log(`     ${money(b.storedPrice).padStart(10)}  ${b.name}`));
if (toAdd.length > 60) console.log(`     ...and ${toAdd.length - 60} more`);

if (skippedExcluded.length) {
  console.log(`\n  -${skippedExcluded.length} excluded (gift card / voucher / payment / test item)`);
  skippedExcluded.forEach((p) => console.log(`     ${money(p.price).padStart(10)}  ${p.name}`));
}
if (skippedDeleted.length) {
  console.log(`\n  -${skippedDeleted.length} skipped — you deleted these before, not re-adding`);
  skippedDeleted.forEach((p) => console.log(`     ${money(p.price).padStart(10)}  ${p.name}`));
}
if (skippedBundle.length)
  console.log(`\n  =${skippedBundle.length} already exist as a bundle here (skipped, left untouched)`);
if (skippedProduct.length)
  console.log(`  =${skippedProduct.length} already exist as a product here (skipped — check if that's really a bundle you added as a product by mistake)`);

console.log(`\n${L}`);

if (!apply) {
  console.log(`DRY RUN — nothing written. Add --apply to add the ${toAdd.length} bundle(s) above.`);
  process.exit(0);
}
if (!toAdd.length) {
  console.log("Nothing to add. Done.");
  process.exit(0);
}

const merged = { ...base, bundles: [...base.bundles, ...toAdd] };
await push(merged);
console.log(`APPLIED — added ${toAdd.length} empty bundle(s), ready to build in the app.`);
