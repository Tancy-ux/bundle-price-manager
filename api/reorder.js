// Zoho reorder list (Vercel serverless function) — separate from the Shopify
// catalog document, stored under its own Redis key.
//
//   GET                         → the stored reorder document
//   POST                        → refresh numbers from Zoho (see lib/zohoReorder.js)
//   PATCH {id, expectedDate?, notes?} → save one row's hand-entered fields
//
// Refresh is throttled to once per 10 min (Zoho caps API calls per day, and
// this is reachable by anyone who can load the app).
//
// Env vars: the Upstash pair (same as api/data.js) plus
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID

import { Redis } from "@upstash/redis";
import {
  REORDER_KEY,
  EMPTY_REORDER,
  zohoConfig,
  fetchZohoReorder,
  mergeReorder,
  patchReorderRow,
} from "../lib/zohoReorder.js";

let _redis;
function getRedis() {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Upstash Redis is not configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN"
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

const THROTTLE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  try {
    const redis = getRedis();

    if (req.method === "GET") {
      return res.status(200).json((await redis.get(REORDER_KEY)) || EMPTY_REORDER);
    }

    if (req.method === "POST") {
      const cfg = zohoConfig();
      const prev = (await redis.get(REORDER_KEY)) || EMPTY_REORDER;
      if (prev.lastSyncAt) {
        const elapsed = Date.now() - new Date(prev.lastSyncAt).getTime();
        if (elapsed < THROTTLE_MS) {
          return res.status(429).json({ error: "throttled", lastSyncAt: prev.lastSyncAt, retryAfterMs: THROTTLE_MS - elapsed });
        }
      }
      const fresh = await fetchZohoReorder(cfg);
      // re-read right before writing so notes saved during the Zoho fetch survive
      const base = (await redis.get(REORDER_KEY)) || EMPTY_REORDER;
      const { doc, summary } = mergeReorder(base, fresh);
      await redis.set(REORDER_KEY, doc);
      return res.status(200).json({ ok: true, summary, data: doc });
    }

    if (req.method === "PATCH") {
      const { id, expectedDate, notes } = req.body || {};
      if (!id) return res.status(400).json({ error: "id is required" });
      const doc = patchReorderRow((await redis.get(REORDER_KEY)) || EMPTY_REORDER, id, { expectedDate, notes });
      if (!doc) return res.status(404).json({ error: "row not found" });
      await redis.set(REORDER_KEY, doc);
      return res.status(200).json({ ok: true, row: doc.items[id] });
    }

    res.setHeader("Allow", "GET, POST, PATCH");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("reorder error:", e);
    return res.status(500).json({ error: "reorder error", detail: String(e?.message || e) });
  }
}
