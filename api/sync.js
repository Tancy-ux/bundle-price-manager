// Hosted "Sync with Shopify" button (Vercel serverless function). Fetches
// the current Shopify catalog and applies scripts/sync-store.js +
// scripts/import-bundle-shells.js + scripts/fetch-stock.js worth of logic in
// one pass — see lib/shopifySync.js for the actual diff/merge logic.
//
// Throttled to once per 24h (enforced here, not just in the UI) since it's
// reachable by anyone who can load the app.
//
// Env vars needed (Vercel project → Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL     (same as api/data.js)
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN
//   SHOPIFY_STORE             e.g. your-store.myshopify.com
//   SHOPIFY_ADMIN_TOKEN

import { Redis } from "@upstash/redis";
import { fetchShopifyCatalog, computeSync } from "../lib/shopifySync.js";

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

const KEY = "bundle-manager:data";
const BACKUPS = "bundle-manager:backups";
const MAX_BACKUPS = 20;
const THROTTLE_MS = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    if (!store || !token) {
      return res.status(500).json({
        error: "Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN in Vercel's Environment Variables",
      });
    }

    const redis = getRedis();
    const base = (await redis.get(KEY)) || { products: [], bundles: [], trash: [] };

    if (base.lastSyncAt) {
      const elapsed = Date.now() - new Date(base.lastSyncAt).getTime();
      if (elapsed < THROTTLE_MS) {
        return res.status(429).json({
          error: "throttled",
          lastSyncAt: base.lastSyncAt,
          retryAfterMs: THROTTLE_MS - elapsed,
        });
      }
    }

    const variants = await fetchShopifyCatalog({ store, token });
    const { merged, summary } = computeSync(base, variants);

    // rolling backup of the previous version, same as api/data.js
    await redis.lpush(BACKUPS, JSON.stringify({ at: new Date().toISOString(), data: base }));
    await redis.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);

    merged.updatedAt = new Date().toISOString();
    await redis.set(KEY, merged);

    return res.status(200).json({ ok: true, summary, data: merged });
  } catch (e) {
    console.error("sync error:", e);
    return res.status(500).json({ error: "sync error", detail: String(e?.message || e) });
  }
}
