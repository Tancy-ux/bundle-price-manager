// Sales per item from Zoho Inventory sales orders. Keeps three years, so any
// dates in the last year can be compared with the period before them, or the
// same dates one or two years earlier. The summary has
// per-day totals for the Sales table, plus the last month, 6 months and year
// for the Reorder list's Sold column.
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
// orders[id].l lines are [n, pieces, value], where keys[n] is the item: each
// long Zoho id is stored once, which keeps three years under Upstash's 1MB
export const EMPTY_SALES_CACHE = { orders: {}, items: {}, keys: [], lastSyncAt: null };

const SKIP_STATUS = new Set(["void", "draft"]);
// how far back orders are kept: a year, plus two years to compare it with
const KEEP_MONTHS = 36;
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
// date: the order's, so an item keeps the name from its newest order
export function orderLines(order, items, date = "") {
  const lines = [];
  for (const l of order.line_items || []) {
    if (l.product_type === "service") continue;
    const ordered = Number(l.quantity) || 0;
    const pieces = ordered - (Number(l.quantity_cancelled) || 0) - (Number(l.quantity_returned) || 0);
    if (ordered <= 0 || pieces <= 0) continue;
    const key = l.item_id || l.sku || l.name;
    if (!items[key] || !items[key].d || date >= items[key].d) items[key] = { name: l.name, sku: l.sku || "", d: date };
    const value = ((Number(l.item_total) || 0) * pieces) / ordered;
    lines.push([key, pieces, Math.round(value * 100) / 100]);
  }
  return lines;
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Brings the cache up to date, fetching at most maxDetails orders; run it again
// to continue. onProgress gets the cache every 500 orders, so a failed run
// keeps what it fetched.
export async function syncSales(
  prev,
  { cfg = zohoConfig(), today = istToday(), maxDetails = 2500, pauseMs = 600, onProgress } = {},
) {
  const token = await getAccessToken(cfg);
  const list = await listAll(cfg, token, "salesorders", "salesorders", {
    date_start: monthsBack(today, KEEP_MONTHS),
    date_end: today,
  });
  const live = list.filter((o) => !SKIP_STATUS.has(o.status));
  const liveIds = new Set(live.map((o) => o.salesorder_id));

  const cache = { ...EMPTY_SALES_CACHE, ...prev, orders: {}, items: { ...prev?.items }, keys: [...(prev?.keys || [])] };
  const index = new Map(cache.keys.map((k, n) => [k, n]));
  const numbered = (lines) =>
    lines.map(([key, pieces, value]) => {
      if (typeof key === "number") return [key, pieces, value];
      if (!index.has(key)) {
        index.set(key, cache.keys.length);
        cache.keys.push(key);
      }
      return [index.get(key), pieces, value];
    });
  // orders cached before keys existed carry the id itself
  for (const [id, o] of Object.entries(prev?.orders || {}))
    if (liveIds.has(id)) cache.orders[id] = { ...o, l: numbered(o.l) };

  // newest first, so a run cut short by maxDetails still has the latest year
  const todo = live
    .filter((o) => cache.orders[o.salesorder_id]?.m !== o.last_modified_time)
    .sort((a, b) => b.date.localeCompare(a.date));
  const batch = todo.slice(0, maxDetails);
  let fetched = 0;
  for (const o of batch) {
    const j = await zget(cfg, await getAccessToken(cfg), `salesorders/${o.salesorder_id}`);
    cache.orders[o.salesorder_id] = {
      d: o.date,
      m: o.last_modified_time,
      l: numbered(orderLines(j.salesorder, cache.items, o.date)),
    };
    fetched++;
    if (fetched % 500 === 0) await onProgress?.(cache, fetched, todo.length);
    await pause(pauseMs);
  }
  cache.lastSyncAt = new Date().toISOString();
  return { cache, fetched, pending: todo.length - fetched, total: live.length };
}

// rows for the last month, 6 months and year (busiest over the year first), and
// per-day totals by item for any other dates: daily[item] = [[date, pieces, value]]
export function summarizeSales(cache, { today = istToday(), pending = 0 } = {}) {
  const byDay = new Map();
  const items = {};
  let firstKept = null;
  for (const o of Object.values(cache.orders)) {
    if (o.d > today) continue;
    if (!firstKept || o.d < firstKept) firstKept = o.d;
    for (const [k, pieces, value] of o.l) {
      const key = typeof k === "number" ? cache.keys[k] : k;
      items[key] ||= cache.items[key] || { name: key, sku: "" };
      if (!byDay.has(key)) byDay.set(key, new Map());
      const days = byDay.get(key);
      const day = days.get(o.d) || [0, 0];
      day[0] += pieces;
      day[1] += value;
      days.set(o.d, day);
    }
  }
  const daily = {};
  for (const [key, days] of byDay)
    daily[key] = [...days]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, [pieces, value]]) => [d, pieces, Math.round(value * 100) / 100]);

  const starts = { month: monthsBack(today, 1), six: monthsBack(today, 6), year: monthsBack(today, 12) };
  const rows = new Map();
  const dates = [];
  for (const o of Object.values(cache.orders)) {
    // after the start day, so each window is exactly its length
    if (o.d <= starts.year || o.d > today) continue;
    dates.push(o.d);
    for (const [k, pieces, value] of o.l) {
      const key = typeof k === "number" ? cache.keys[k] : k;
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
        if (o.d > starts[span]) {
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
    daily,
    items,
    today,
    starts,
    orders: dates.length,
    firstOrder: dates[0] || null,
    firstKept,
    // where keeping orders starts, so the page can tell what's incomplete
    keptFrom: monthsBack(today, KEEP_MONTHS),
    // the last year is fully in (orders are fetched newest first)
    yearComplete: pending === 0 || (firstKept != null && firstKept <= starts.year),
    pending,
    lastSyncAt: cache.lastSyncAt,
  };
}
