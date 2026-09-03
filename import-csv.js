// Import your catalog + bundle mapping into data/data.json
//
// Usage:
//   node import-csv.js products.csv [bundle_template.csv]
//
// products.csv columns (header names flexible): name, sku, price, status, dead
// bundle_template.csv columns:                  bundle_name, item_sku, qty
//   (plus optional bundle_price / live_price for the current Shopify price)

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data", "data.json");

// --- tiny CSV parser (handles quoted fields, commas, newlines) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") {}
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function toObjects(rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

function pick(o, keys) {
  for (const k of keys) if (o[k] !== undefined && o[k] !== "") return o[k];
  return "";
}

const uid = () => Math.random().toString(36).slice(2, 9);

const productsPath = process.argv[2];
const bundlesPath = process.argv[3];

if (!productsPath) {
  console.error("Usage: node import-csv.js products.csv [bundle_template.csv]");
  process.exit(1);
}

// --- products ---
const prodObjs = toObjects(parseCSV(fs.readFileSync(productsPath, "utf-8")));
const products = [];
const skuToId = {};
for (const o of prodObjs) {
  const dead = /^(yes|true|1)$/i.test(pick(o, ["dead"]));
  if (dead) continue; // drop items marked dead
  const sku = pick(o, ["sku", "variant sku"]);
  const id = uid();
  if (sku) skuToId[sku.toLowerCase()] = id;
  products.push({
    id,
    sku,
    name: pick(o, ["name", "title"]),
    price: parseFloat(pick(o, ["price", "variant price"])) || 0,
    active: !/^(draft|false|0|inactive)$/i.test(pick(o, ["status", "active"])),
  });
}

// --- bundles ---
let bundles = [];
if (bundlesPath && fs.existsSync(bundlesPath)) {
  const bObjs = toObjects(parseCSV(fs.readFileSync(bundlesPath, "utf-8")));
  const grouped = {};
  let unmatched = 0;
  for (const o of bObjs) {
    const bname = pick(o, ["bundle_name", "bundle name", "bundle"]);
    if (!bname || /^example/i.test(bname)) continue;
    const isku = pick(o, ["item_sku", "item sku", "sku"]).toLowerCase();
    const qty = parseInt(pick(o, ["qty", "quantity"])) || 1;
    const key = bname.toLowerCase();
    if (!grouped[key]) {
      grouped[key] = { id: uid(), sku: pick(o, ["bundle_sku"]), name: bname, items: [], storedPrice: 0 };
    }
    const lp = parseFloat(pick(o, ["bundle_price", "live_price", "price"]));
    if (!isNaN(lp)) grouped[key].storedPrice = lp;
    if (isku) {
      const pid = skuToId[isku];
      if (pid) grouped[key].items.push({ productId: pid, qty });
      else { unmatched++; }
    }
  }
  bundles = Object.values(grouped);
  if (unmatched) console.log(`  ⚠ ${unmatched} bundle item rows had a SKU not found in products (skipped).`);
}

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.writeFileSync(DATA_FILE, JSON.stringify({ products, bundles, updatedAt: new Date().toISOString() }, null, 2));
console.log(`  ✓ Imported ${products.length} products and ${bundles.length} bundles.`);
console.log(`  ✓ Wrote ${DATA_FILE}`);
