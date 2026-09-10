// Shared Upstash helpers for the maintenance scripts (pull.js, sync-store.js).
// Uses the same key + backup list as api/data.js so the hosted app and these
// scripts stay consistent.

import fs from "fs";
import { Redis } from "@upstash/redis";

export const KEY = "bundle-manager:data";
export const BACKUPS = "bundle-manager:backups";
export const MAX_BACKUPS = 20;

export function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    console.error(
      "Missing Upstash credentials.\n" +
        "Put KV_REST_API_URL and KV_REST_API_TOKEN in a .env file next to package.json\n" +
        "(same values you used for `npm run seed`)."
    );
    process.exit(1);
  }
  return new Redis({ url, token });
}

// current live document
export async function pull(r = redis()) {
  const data = await r.get(KEY);
  if (!data) {
    console.error(`No data found at Redis key "${KEY}".`);
    process.exit(1);
  }
  return data;
}

// write a new document, keeping a rolling backup of the previous one
// (both to a local timestamped file and to the Redis backup list)
export async function push(data, r = redis()) {
  const prev = await r.get(KEY);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  if (prev) {
    const dir = new URL("../data/backups/", import.meta.url);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(new URL(`before-sync-${stamp}.json`, dir), JSON.stringify(prev, null, 2));
    await r.lpush(BACKUPS, JSON.stringify({ at: new Date().toISOString(), data: prev }));
    await r.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);
  }

  data.updatedAt = new Date().toISOString();
  await r.set(KEY, data);
  return { stamp };
}

// CSV parser copied from import-csv.js (handles quoted fields, embedded newlines)
export function parseCSV(text) {
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
