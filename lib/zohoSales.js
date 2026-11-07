// Sales per item from Zoho Inventory sales orders: pieces and value in the last
// month, 6 months and year, each counted back from today.
//
// Zoho's order list has no line items, so each order needs its own detail call.
// Those are cached by order and re-fetched only when the order changes, which
// makes the first run long (one call per order) and later runs short.
//
// Counts orders that aren't void or draft, less any cancelled or returned
// pieces. A bundle counts as sold under the bundle, not its parts.

import { zohoConfig, getAccessToken, zget, listAll } from "./zohoReorder.js";

export const SALES_KEY = "bundle-manager:sales";
export const SALES_CACHE_KEY = "bundle-manager:sales-cache";
export const EMPTY_SALES_CACHE = { orders: {}, items: {}, lastSyncAt: null };

const SKIP_STATUS = new Set(["void", "draft"]);
const IST_MS = 5.5 * 60 * 60 * 1000;

export const istToday = (now = Date.now()) => new Date(now + IST_MS).toISOString().slice(0, 10);

// "2026-03-31" less 1 month → "2026-02-28": short months clamp to their last day
export function monthsBack(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

// one order's goods as [[itemKey, pieces, value]], recording names in `items`
export function orderLines(order, items) {
  const lines = [];
  for (const l of order.line_items || []) {
    if (l.product_type === "service") continue;
    const ordered = Number(l.quantity) || 0;
    const pieces = ordered - (Number(l.quantity_cancelled) || 0) - (Number(l.quantity_returned) || 0);
    if (ordered <= 0 || pieces <= 0) continue;
    const key = l.item_id || l.sku || l.name;
    items[key] = { name: l.name, sku: l.sku || "" };
    const value = ((Number(l.item_total) || 0) * pieces) / ordered;
    lines.push([key, pieces, Math.round(value * 100) / 100]);
  }
  return lines;
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Brings the cache up to date, fetching at most maxDetails orders; run it again
// to continue. onProgress gets the cache every 100 orders, so a failed run
// keeps what it fetched.
export async function syncSales(
  prev,
  { cfg = zohoConfig(), today = istToday(), maxDetails = 2500, pauseMs = 600, onProgress } = {},
) {
  const token = await getAccessToken(cfg);
  const list = await listAll(cfg, token, "salesorders", "salesorders", {
    date_start: monthsBack(today, 12),
    date_end: today,
  });
  const live = list.filter((o) => !SKIP_STATUS.has(o.status));
  const liveIds = new Set(live.map((o) => o.salesorder_id));

  const cache = { ...EMPTY_SALES_CACHE, ...prev, orders: {}, items: { ...prev?.items } };
  for (const [id, o] of Object.entries(prev?.orders || {})) if (liveIds.has(id)) cache.orders[id] = o;

  const todo = live.filter((o) => cache.orders[o.salesorder_id]?.m !== o.last_modified_time);
  const batch = todo.slice(0, maxDetails);
  let fetched = 0;
  for (const o of batch) {
    const j = await zget(cfg, await getAccessToken(cfg), `salesorders/${o.salesorder_id}`);
    cache.orders[o.salesorder_id] = {
      d: o.date,
      m: o.last_modified_time,
      l: orderLines(j.salesorder, cache.items),
    };
    fetched++;
    if (fetched % 100 === 0) await onProgress?.(cache, fetched, batch.length);
    await pause(pauseMs);
  }
  cache.lastSyncAt = new Date().toISOString();
  return { cache, fetched, pending: todo.length - fetched, total: live.length };
}

// the table's rows, busiest over the year first
export function summarizeSales(cache, { today = istToday(), pending = 0 } = {}) {
  const starts = { month: monthsBack(today, 1), six: monthsBack(today, 6), year: monthsBack(today, 12) };
  const rows = new Map();
  const dates = [];
  for (const o of Object.values(cache.orders)) {
    if (o.d < starts.year || o.d > today) continue;
    dates.push(o.d);
    for (const [key, pieces, value] of o.l) {
      if (!rows.has(key)) {
        const item = cache.items[key] || {};
        rows.set(key, {
          id: key,
          name: item.name || key,
          sku: item.sku || "",
          month: { pieces: 0, value: 0 },
          six: { pieces: 0, value: 0 },
          year: { pieces: 0, value: 0 },
        });
      }
      const row = rows.get(key);
      for (const span of ["month", "six", "year"]) {
        if (o.d >= starts[span]) {
          row[span].pieces += pieces;
          row[span].value += value;
        }
      }
    }
  }
  for (const r of rows.values())
    for (const span of ["month", "six", "year"]) r[span].value = Math.round(r[span].value * 100) / 100;
  dates.sort();
  return {
    rows: [...rows.values()].sort((a, b) => b.year.pieces - a.year.pieces || a.name.localeCompare(b.name)),
    today,
    starts,
    orders: dates.length,
    firstOrder: dates[0] || null,
    pending,
    lastSyncAt: cache.lastSyncAt,
  };
}
