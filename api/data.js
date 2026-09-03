// Hosted persistence for the Bundle Price Manager (Vercel serverless function).
// Stores the whole {products, bundles, trash} document as one JSON value in
// Upstash Redis, mirroring what server.js does with data/data.json locally.
//
// Env vars (set by the Upstash + Vercel integration, either naming works):
//   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN

import { Redis } from "@upstash/redis";

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

const EMPTY = { products: [], bundles: [], trash: [], updatedAt: null };

export default async function handler(req, res) {
  try {
    const redis = getRedis();

    if (req.method === "GET") {
      const data = (await redis.get(KEY)) || EMPTY;
      return res.status(200).json(data);
    }

    if (req.method === "PUT") {
      const { products, bundles, trash } = req.body || {};
      if (!Array.isArray(products) || !Array.isArray(bundles)) {
        return res.status(400).json({ error: "products and bundles must be arrays" });
      }

      // rolling backup of the previous version (last 20 kept)
      const prev = await redis.get(KEY);
      if (prev) {
        await redis.lpush(
          BACKUPS,
          JSON.stringify({ at: new Date().toISOString(), data: prev })
        );
        await redis.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);
      }

      const saved = {
        products,
        bundles,
        trash: Array.isArray(trash) ? trash : [],
        updatedAt: new Date().toISOString(),
      };
      await redis.set(KEY, saved);
      return res.status(200).json({ ok: true, updatedAt: saved.updatedAt });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("storage error:", e);
    return res.status(500).json({ error: "storage error", detail: String(e?.message || e) });
  }
}
