// Sales per item for the Sales table, written by scripts/zoho-sales.js.
// Admin only: middleware.js doesn't list this among the team's calls.

import { Redis } from "@upstash/redis";
import { SALES_KEY } from "../lib/zohoSales.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    const redis = new Redis({ url, token });
    return res.status(200).json((await redis.get(SALES_KEY)) || { rows: [] });
  } catch (e) {
    console.error("sales error:", e);
    return res.status(500).json({ error: "sales error", detail: String(e?.message || e) });
  }
}
