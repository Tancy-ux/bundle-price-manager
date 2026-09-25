// Refresh the Zoho reorder list (the app's "Reorder" tab) from Zoho Inventory.
//
// SAFE BY DESIGN: only refreshes the Zoho numbers (stock on hand, reorder
// level, quantity to be received, open POs). Never deletes a row and never
// touches the hand-entered "expected by" dates or notes — see
// lib/zohoReorder.js. Doesn't touch the Shopify catalog at all.
//
// Usage:
//   npm run zoho-reorder                dry run — shows what would change
//   npm run zoho-reorder -- --apply     write the refreshed list to Upstash
//
// .env (next to package.json) needs:
//   KV_REST_API_URL=...
//   KV_REST_API_TOKEN=...
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID

import { redis } from "./_store.js";
import { REORDER_KEY, EMPTY_REORDER, fetchZohoReorder, mergeReorder } from "../lib/zohoReorder.js";

const apply = process.argv.includes("--apply");

const r = redis();
const fresh = await fetchZohoReorder();
console.log(`Zoho: ${fresh.items.length} tracked items with a reorder level, ${fresh.poCount} open POs`);

// read right before merging so the write doesn't drop notes saved meanwhile
const prev = (await r.get(REORDER_KEY)) || EMPTY_REORDER;
const { doc, summary } = mergeReorder(prev, fresh);
console.log(
  `Rows: ${summary.added} new, ${summary.updated} refreshed, ${summary.missing} no longer in Zoho (kept) — ${summary.below} currently below reorder level`
);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to save.");
} else {
  await r.set(REORDER_KEY, doc);
  console.log("\nSaved.");
}
