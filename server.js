// Bundle Price Manager — local server
// Serves the app and persists all data to data/data.json on disk.
// Nothing leaves your machine. No accounts, no cloud, no Shopify credentials.
//
// This is the LOCAL / offline server. The hosted copy on Vercel uses
// api/data.js + Upstash Redis instead — see README.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchShopifyCatalog, computeSync, pushVariantPrice, pushHistory } from "./lib/shopifySync.js";
import { mergeUpserts, mergeTrash, mergeSet } from "./lib/mergeData.js";
import { EMPTY_REORDER, REFRESH_COOLDOWN_MS, zohoConfig, fetchZohoReorder, mergeReorder, patchReorderRow } from "./lib/zohoReorder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const REORDER_FILE = path.join(DATA_DIR, "reorder.json");

// optional, dependency-free .env loader — only fills in vars that aren't
// already set, and does nothing if the file doesn't exist (basic local use
// needs no .env at all; this just lets SHOPIFY_* reach the /api/sync route)
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function readData() {
  ensureDirs();
  if (!fs.existsSync(DATA_FILE)) {
    return { products: [], bundles: [], trash: [], updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch (e) {
    console.error("data.json is corrupt:", e.message);
    return { products: [], bundles: [], updatedAt: null, error: "corrupt" };
  }
}

function writeData(data) {
  ensureDirs();
  // keep a rolling backup before each write
  if (fs.existsSync(DATA_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, `data-${stamp}.json`));
    // prune to last 20 backups
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
    while (files.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  return data;
}

app.get("/api/data", (req, res) => {
  res.json(readData());
});

// diff-based, not a full replace — see lib/mergeData.js for why: this is
// what lets two people with the app open at once edit different items
// without one person's save silently overwriting the other's.
app.put("/api/data", (req, res) => {
  const { productsDiff, bundlesDiff, trashDiff, excludedSkusDiff, excludedBundleNamesDiff } = req.body || {};
  if (!productsDiff || !bundlesDiff) {
    return res.status(400).json({ error: "productsDiff and bundlesDiff are required" });
  }
  const prev = readData();
  const saved = writeData({
    ...prev,
    products: mergeUpserts(prev.products || [], productsDiff.upserts, productsDiff.deletes),
    bundles: mergeUpserts(prev.bundles || [], bundlesDiff.upserts, bundlesDiff.deletes),
    trash: mergeTrash(prev.trash || [], trashDiff?.upserts, trashDiff?.deletes),
    excludedSkus: mergeSet(prev.excludedSkus, excludedSkusDiff?.added, excludedSkusDiff?.removed),
    excludedBundleNames: mergeSet(prev.excludedBundleNames, excludedBundleNamesDiff?.added, excludedBundleNamesDiff?.removed),
  });
  // return the full merged doc so the client can adopt it — this is also
  // how a client picks up anyone else's concurrent changes
  res.json({ ok: true, data: saved });
});

const SYNC_THROTTLE_MS = 4 * 60 * 60 * 1000;

app.post("/api/sync", async (req, res) => {
  try {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!store || !token) {
      return res.status(500).json({
        error: "Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in .env",
      });
    }

    const base = readData();
    if (base.lastSyncAt) {
      const elapsed = Date.now() - new Date(base.lastSyncAt).getTime();
      if (elapsed < SYNC_THROTTLE_MS) {
        return res.status(429).json({
          error: "throttled",
          lastSyncAt: base.lastSyncAt,
          retryAfterMs: SYNC_THROTTLE_MS - elapsed,
        });
      }
    }

    const variants = await fetchShopifyCatalog({ store, token });
    const { merged, summary } = computeSync(base, variants);
    const saved = writeData(merged);
    res.json({ ok: true, summary, data: saved });
  } catch (e) {
    console.error("sync error:", e);
    res.status(500).json({ error: "sync error", detail: String(e?.message || e) });
  }
});

app.post("/api/push-price", async (req, res) => {
  try {
    const { kind, id, price } = req.body || {};
    if ((kind !== "product" && kind !== "bundle") || !id || typeof price !== "number") {
      return res.status(400).json({ error: "kind (product|bundle), id, and numeric price are required" });
    }
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;

    // first read: just to find the variant id to push to — not used to build
    // the write below, same reasoning as api/push-price.js (hosted)
    const preCheck = readData();
    const preList = kind === "product" ? preCheck.products : preCheck.bundles;
    const preItem = (preList || []).find((x) => x.id === id);
    if (!preItem) return res.status(404).json({ error: `${kind} not found` });
    if (!preItem.shopifyVariantId) {
      return res.status(400).json({ error: "Not linked to a Shopify variant yet — run a sync first" });
    }

    await pushVariantPrice({ store, token, variantId: preItem.shopifyVariantId, price });

    // second read, right before writing — picks up anything that changed
    // elsewhere during the Shopify call
    const base = readData();
    const list = kind === "product" ? base.products : base.bundles;
    const item = (list || []).find((x) => x.id === id) || preItem;
    const priceField = kind === "product" ? "price" : "storedPrice";
    const from = item[priceField] || 0;
    const updatedItem = { ...item, [priceField]: price, history: pushHistory(item, from, price) };

    writeData({ ...base, [kind === "product" ? "products" : "bundles"]: mergeUpserts(list || [], [updatedItem], []) });

    res.json({ ok: true, item: updatedItem });
  } catch (e) {
    console.error("push-price error:", e);
    res.status(500).json({ error: "push-price error", detail: String(e?.message || e) });
  }
});

// Zoho reorder list — own file, separate from the Shopify catalog. Same
// behaviour as api/reorder.js (hosted); see lib/zohoReorder.js.
function readReorder() {
  ensureDirs();
  if (!fs.existsSync(REORDER_FILE)) return EMPTY_REORDER;
  return JSON.parse(fs.readFileSync(REORDER_FILE, "utf-8"));
}
function writeReorder(doc) {
  fs.writeFileSync(REORDER_FILE, JSON.stringify(doc, null, 2));
  return doc;
}

// the team's Zoho-only page (hosted, the middleware limits the team login to it)
app.get("/inventory", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "inventory.html"));
});

app.get("/api/reorder", (req, res) => {
  res.json(readReorder());
});

app.post("/api/reorder", async (req, res) => {
  try {
    const prev = readReorder();
    if (prev.lastManualSyncAt) {
      const elapsed = Date.now() - new Date(prev.lastManualSyncAt).getTime();
      if (elapsed < REFRESH_COOLDOWN_MS) {
        return res.status(429).json({ error: "throttled", lastManualSyncAt: prev.lastManualSyncAt, retryAfterMs: REFRESH_COOLDOWN_MS - elapsed });
      }
    }
    const fresh = await fetchZohoReorder(zohoConfig());
    const { doc, summary } = mergeReorder(readReorder(), fresh);
    doc.lastManualSyncAt = doc.lastSyncAt;
    res.json({ ok: true, summary, data: writeReorder(doc) });
  } catch (e) {
    console.error("reorder sync error:", e);
    res.status(500).json({ error: "reorder error", detail: String(e?.message || e) });
  }
});

app.patch("/api/reorder", (req, res) => {
  const { id, expectedDate, notes } = req.body || {};
  if (!id) return res.status(400).json({ error: "id is required" });
  const doc = patchReorderRow(readReorder(), id, { expectedDate, notes });
  if (!doc) return res.status(404).json({ error: "row not found" });
  writeReorder(doc);
  res.json({ ok: true, row: doc.items[id] });
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  ensureDirs();
  console.log(`\n  Bundle Price Manager running`);
  console.log(`  → Open http://localhost:${PORT} in your browser`);
  console.log(`  → Data saved to ${DATA_FILE}`);
  console.log(`  → Backups in ${BACKUP_DIR}\n`);
});
