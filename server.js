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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "data.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");

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

app.put("/api/data", (req, res) => {
  const { products, bundles, trash } = req.body || {};
  if (!Array.isArray(products) || !Array.isArray(bundles)) {
    return res.status(400).json({ error: "products and bundles must be arrays" });
  }
  const saved = writeData({ products, bundles, trash: Array.isArray(trash) ? trash : [] });
  res.json({ ok: true, updatedAt: saved.updatedAt });
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  ensureDirs();
  console.log(`\n  Bundle Price Manager running`);
  console.log(`  → Open http://localhost:${PORT} in your browser`);
  console.log(`  → Data saved to ${DATA_FILE}`);
  console.log(`  → Backups in ${BACKUP_DIR}\n`);
});
