// Add products that exist in Shopify but not yet in the Bundle Price Manager.
//
// SAFE BY DESIGN: this only ADDS products, matched by SKU. It never edits or
// deletes an existing product, and never touches bundles or trash. Your bundle
// links, manual price edits, and history are all left untouched.
//
// Usage:
//   npm run sync-store -- products_export.csv           dry run - shows the diff
//   npm run sync-store -- products_export.csv --apply    write the new products live
//   npm run sync-store -- --shopify                      get the list from Shopify API
//   npm run sync-store -- --shopify --apply
//
// Options:
//   --apply             actually write to Upstash (default is a dry run)
//   --include-draft     also add products whose Shopify status is "draft"
//                       (added as inactive). "archived" is always skipped.
//   --base <file>       merge against a local JSON file instead of the live data.
//                       Requires --force to --apply, since it can overwrite
//                       edits made on the site since that file was saved.
//   --force             allow --apply together with --base
//
// .env (next to package.json) needs:
//   KV_REST_API_URL=...            (same as `npm run seed`)
//   KV_REST_API_TOKEN=...
// For --shopify also add:
//   SHOPIFY_STORE=your-store.myshopify.com
//   SHOPIFY_ADMIN_TOKEN=shpat_...   (custom app, Admin API scope: read_products)

import fs from "fs";
import { pull, push, parseCSV } from "./_store.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const apply = has("--apply");
const force = has("--force");
const includeDraft = has("--include-draft");
const useShopify = has("--shopify");
const baseIdx = args.indexOf("--base");
const basePath = baseIdx >= 0 ? args[baseIdx + 1] : null;
const csvPath = args.find((a, i) => !a.startsWith("--") && i !== baseIdx + 1);

const uid = () => Math.random().toString(36).slice(2, 9);
const normSku = (s) => (s || "").trim().toLowerCase();
const money = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN");

// ---------- read the Shopify product list ----------

function productsFromCSV(path) {
  const rows = parseCSV(fs.readFileSync(path, "utf8"));
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const iTitle = head.indexOf("title");
  const iSku = head.indexOf("variant sku");
  const iPrice = head.indexOf("variant price");
  const iStatus = head.indexOf("status");
  const iOpts = ["option1 value", "option2 value", "option3 value"]
    .map((h) => head.indexOf(h))
    .filter((i) => i >= 0);
  if (iSku < 0) {
    console.error('This CSV has no "Variant SKU" column. Export it from Shopify: Products > Export > CSV.');
    process.exit(1);
  }
  let lastTitle = "";
  let lastStatus = "active";
  const out = [];
  for (const r of rows.slice(1)) {
    if (iTitle >= 0 && (r[iTitle] || "").trim()) lastTitle = r[iTitle].trim();
    if (iStatus >= 0 && (r[iStatus] || "").trim()) lastStatus = r[iStatus].trim().toLowerCase();
    const sku = (r[iSku] || "").trim();
    if (!sku) continue;
    const opts = iOpts
      .map((i) => (r[i] || "").trim())
      .filter((v) => v && v.toLowerCase() !== "default title");
    out.push({
      name: [lastTitle, ...opts].filter(Boolean).join(" "),
      sku,
      price: parseFloat(String(r[iPrice] ?? "").replace(/[^0-9.]/g, "")) || 0,
      status: lastStatus,
    });
  }
  return out;
}

async function productsFromShopify() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!store || !token) {
    console.error("Set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in .env for --shopify.");
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
      for (const v of p.variants || []) {
        if (!v.sku) continue;
        const variantName =
          v.title && v.title !== "Default Title" ? `${p.title} ${v.title}` : p.title;
        out.push({ name: variantName, sku: v.sku, price: parseFloat(v.price) || 0, status: p.status });
      }
    }
    page++;
    const link = res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  console.log(`Fetched ${out.length} variants with a SKU from Shopify (${page} page(s)).`);
  return out;
}

// ---------- load base ----------

const base = basePath ? JSON.parse(fs.readFileSync(basePath, "utf8")) : await pull();
if (!Array.isArray(base.products) || !Array.isArray(base.bundles)) {
  console.error("Base data doesn't look right (missing products/bundles arrays).");
  process.exit(1);
}

let incoming;
if (useShopify) incoming = await productsFromShopify();
else if (csvPath) incoming = productsFromCSV(csvPath);
else {
  console.error("Give a Shopify CSV export path, or pass --shopify.");
  process.exit(1);
}

// dedupe incoming by SKU (first row wins)
const seen = new Set();
incoming = incoming.filter((p) => {
  const k = normSku(p.sku);
  if (!k || seen.has(k)) return false;
  seen.add(k);
  return true;
});

// ---------- diff ----------

const existing = new Map();
base.products.forEach((p) => {
  const k = normSku(p.sku);
  if (k) existing.set(k, p);
});

const toAdd = [];
const skippedDraft = [];
const skippedArchived = [];
const priceDiffs = [];

for (const p of incoming) {
  const k = normSku(p.sku);
  const cur = existing.get(k);
  if (cur) {
    if (p.price && Math.abs((cur.price || 0) - p.price) > 0.009) {
      priceDiffs.push({ name: cur.name, sku: cur.sku, app: cur.price || 0, shopify: p.price });
    }
    continue;
  }
  if (p.status === "archived") {
    skippedArchived.push(p);
    continue;
  }
  if (p.status === "draft" && !includeDraft) {
    skippedDraft.push(p);
    continue;
  }
  toAdd.push({
    id: uid(),
    sku: p.sku,
    name: p.name || "(unnamed)",
    price: p.price || 0,
    active: p.status !== "draft",
  });
}

const incomingSkus = new Set(incoming.map((p) => normSku(p.sku)));
const usedInBundle = new Set();
base.bundles.forEach((b) => (b.items || []).forEach((it) => usedInBundle.add(it.productId)));
const notInShopify = base.products.filter(
  (p) => normSku(p.sku) && !incomingSkus.has(normSku(p.sku))
);

// ---------- report ----------

const L = "─".repeat(60);
console.log(L);
console.log(`base      ${basePath || "live Upstash data"} - ${base.products.length} products, ${base.bundles.length} bundles`);
console.log(`incoming  ${useShopify ? "Shopify API" : csvPath} - ${incoming.length} unique SKUs`);
console.log(L);

console.log(`\n  +${toAdd.length} new product(s) to add`);
toAdd.slice(0, 60).forEach((p) =>
  console.log(`     ${p.sku.padEnd(18)} ${money(p.price).padStart(10)}  ${p.name}${p.active ? "" : "  (inactive)"}`)
);
if (toAdd.length > 60) console.log(`     ...and ${toAdd.length - 60} more`);

if (skippedDraft.length)
  console.log(`\n  -${skippedDraft.length} draft product(s) skipped  (run with --include-draft to add them as inactive)`);
if (skippedArchived.length) console.log(`  -${skippedArchived.length} archived product(s) skipped`);

const already = incoming.length - toAdd.length - skippedDraft.length - skippedArchived.length;
console.log(`\n  =${already} SKU(s) already in the catalog  (left untouched)`);

if (priceDiffs.length) {
  console.log(`\n  !${priceDiffs.length} price difference(s) between app and Shopify  (NOT changed - review by hand):`);
  priceDiffs.slice(0, 40).forEach((d) =>
    console.log(`     ${d.sku.padEnd(18)} app ${money(d.app)}  vs Shopify ${money(d.shopify)}   ${d.name}`)
  );
  if (priceDiffs.length > 40) console.log(`     ...and ${priceDiffs.length - 40} more`);
}

if (notInShopify.length) {
  console.log(`\n  ?${notInShopify.length} catalog product(s) whose SKU is NOT in this Shopify list:`);
  notInShopify.slice(0, 40).forEach((p) =>
    console.log(`     ${p.sku.padEnd(18)} ${p.name}${usedInBundle.has(p.id) ? "   [used in a bundle]" : ""}`)
  );
  if (notInShopify.length > 40) console.log(`     ...and ${notInShopify.length - 40} more`);
  console.log(`     (left alone - deactivate by hand in the app if they're truly discontinued)`);
  if (notInShopify.length > base.products.length * 0.25)
    console.log(`     NOTE: that is a lot. If your export was only recent/partial products, ignore this list.`);
}

console.log(`\n${L}`);

// ---------- apply ----------

if (!apply) {
  console.log("DRY RUN - nothing written. Add --apply to add the new products.");
  process.exit(0);
}
if (basePath && !force) {
  console.error("Refusing to --apply with --base (it could overwrite site edits made since that file). Add --force if you're sure.");
  process.exit(1);
}
if (!toAdd.length) {
  console.log("Nothing to add. Done.");
  process.exit(0);
}

const merged = {
  products: [...base.products, ...toAdd],
  bundles: base.bundles,
  trash: base.trash || [],
};
const { stamp } = await push(merged);
console.log(`APPLIED - added ${toAdd.length} product(s).`);
console.log(`Previous state backed up to data/backups/before-sync-${stamp}.json and the Redis backup list.`);
