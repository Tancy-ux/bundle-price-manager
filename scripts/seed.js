// One-time: push your local catalog into Upstash Redis so the hosted app
// starts with your data instead of empty.
//
// 1. Create a .env file next to package.json with:
//      UPSTASH_REDIS_REST_URL=...
//      UPSTASH_REDIS_REST_TOKEN=...
//    (copy from Upstash console, or from the Vercel project after connecting)
// 2. Run:  npm run seed

import fs from "fs";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = "bundle-manager:data";

// prefer your live local file; fall back to the committed snapshot
const candidates = [
  new URL("../data/data.json", import.meta.url),
  new URL("../seed/data.json", import.meta.url),
];
const src = candidates.find((u) => fs.existsSync(u));
if (!src) {
  console.error("No data/data.json or seed/data.json found.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(src, "utf-8"));
data.updatedAt = new Date().toISOString();
await redis.set(KEY, data);

console.log(
  `Seeded ${data.products?.length ?? 0} products / ${data.bundles?.length ?? 0} bundles ` +
    `into Redis key "${KEY}" from ${src.pathname.split("/").slice(-2).join("/")}.`
);
