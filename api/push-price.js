// Push a single product's or bundle's price straight to its linked Shopify
// variant (Vercel serverless function). Only ever sends {id, price} to
// Shopify — see lib/shopifySync.js's pushVariantPrice for why that's the
// only field that can change on Shopify's side from this call.
//
// This is the first thing in this app that writes to the LIVE STORE rather
// than just this app's own data — so it only ever acts on an item that
// already has a shopifyVariantId captured by a previous sync (never guesses
// one from a name/handle at push-time), and it never touches anything else
// about the item (title, images, inventory, status) on either side.
//
// Env vars needed (Vercel project → Settings → Environment Variables):
//   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN
//   SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN

import { Redis } from "@upstash/redis";
import { pushVariantPrice, pushHistory } from "../lib/shopifySync.js";
import { mergeUpserts } from "../lib/mergeData.js";

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const { kind, id, price } = req.body || {};
    if ((kind !== "product" && kind !== "bundle") || !id || typeof price !== "number") {
      return res.status(400).json({ error: "kind (product|bundle), id, and numeric price are required" });
    }

    const store = process.env.SHOPIFY_STORE;
    const token = process.env.SHOPIFY_ADMIN_TOKEN;
    const redis = getRedis();

    // first read: just to find the variant id to push to. Deliberately NOT
    // used to build the write below — the Shopify round-trip can take a
    // while, and writing based on this snapshot would risk clobbering any
    // edit someone else makes to a different item during that window
    // (exactly the whole-array-replace bug the diff-based /api/data save
    // was built to fix — a single-item write needs the same discipline).
    const preCheck = (await redis.get(KEY)) || { products: [], bundles: [], trash: [] };
    const preList = kind === "product" ? preCheck.products : preCheck.bundles;
    const preItem = (preList || []).find((x) => x.id === id);
    if (!preItem) return res.status(404).json({ error: `${kind} not found` });
    if (!preItem.shopifyVariantId) {
      return res.status(400).json({ error: "Not linked to a Shopify variant yet — run a sync first" });
    }

    await pushVariantPrice({ store, token, variantId: preItem.shopifyVariantId, price });

    // second read, right before writing — picks up anything that changed
    // elsewhere during the Shopify call, same pattern as /api/data's PUT
    const base = (await redis.get(KEY)) || { products: [], bundles: [], trash: [] };
    const list = kind === "product" ? base.products : base.bundles;
    const item = (list || []).find((x) => x.id === id) || preItem;
    const priceField = kind === "product" ? "price" : "storedPrice";
    const from = item[priceField] || 0;
    const updatedItem = { ...item, [priceField]: price, history: pushHistory(item, from, price) };

    await redis.lpush(BACKUPS, JSON.stringify({ at: new Date().toISOString(), data: base }));
    await redis.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);

    const saved = {
      ...base,
      [kind === "product" ? "products" : "bundles"]: mergeUpserts(list || [], [updatedItem], []),
      updatedAt: new Date().toISOString(),
    };
    await redis.set(KEY, saved);

    return res.status(200).json({ ok: true, item: updatedItem });
  } catch (e) {
    console.error("push-price error:", e);
    return res.status(500).json({ error: "push-price error", detail: String(e?.message || e) });
  }
}
