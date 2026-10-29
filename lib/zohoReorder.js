// Zoho Inventory reorder list — completely separate from the Shopify side.
//
// Pulls every active, stock-tracked Zoho item that has a reorder level, works
// out "quantity to be received" from open purchase orders (Zoho's item API
// doesn't expose that number directly — the "Order Now" screen computes it the
// same way: ordered − received − cancelled, over POs still issued / partially
// received), and merges the result into the stored reorder document.
//
// The merge never deletes a row and never touches the hand-entered fields
// (expectedDate, notes) — it only refreshes the Zoho numbers. Items that climb
// back above their reorder level stay stored, just flagged as restocked.
//
// Env vars:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
//   ZOHO_ACCOUNTS_URL (optional, default https://accounts.zoho.in)
//   ZOHO_API_URL      (optional, default https://www.zohoapis.in)

export const REORDER_KEY = "bundle-manager:reorder";
export const EMPTY_REORDER = { items: {}, lastSyncAt: null };
// min gap between Refresh button presses (counted from the last press, stored
// as lastManualSyncAt — scheduled refreshes don't count). The UI greys the
// button out for the same window (keep in sync with REORDER_COOLDOWN_MS in
// app.src.jsx)
export const REFRESH_COOLDOWN_MS = 8 * 60 * 60 * 1000;

export function zohoConfig(env = process.env) {
  const cfg = {
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    orgId: env.ZOHO_ORG_ID,
    accountsUrl: env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.in",
    apiUrl: env.ZOHO_API_URL || "https://www.zohoapis.in",
  };
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken || !cfg.orgId) {
    throw new Error(
      "Zoho not configured — set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN and ZOHO_ORG_ID"
    );
  }
  return cfg;
}

// access tokens last an hour — reuse one while it's valid, since Zoho also
// rate-limits how often new ones can be minted
let _token = null; // {value, expiresAt}
async function getAccessToken(cfg, attempt = 0) {
  if (_token && _token.expiresAt > Date.now() + 60000) return _token.value;
  const body = new URLSearchParams({
    refresh_token: cfg.refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "refresh_token",
  });
  let j;
  try {
    j = await (await fetch(`${cfg.accountsUrl}/oauth/v2/token`, { method: "POST", body })).json();
  } catch (e) {
    if (attempt >= 2) throw e;
    await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    return getAccessToken(cfg, attempt + 1);
  }
  if (!j.access_token) throw new Error(`Zoho token refresh failed: ${j.error || "no token"}`);
  _token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000 };
  return _token.value;
}

// retries network blips and rate-limit responses a couple of times
async function zget(cfg, token, path, params = {}, attempt = 0) {
  const qs = new URLSearchParams({ organization_id: cfg.orgId, ...params });
  let r, j;
  try {
    r = await fetch(`${cfg.apiUrl}/inventory/v1/${path}?${qs}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    j = await r.json();
  } catch (e) {
    if (attempt >= 2) throw e;
  }
  if ((!j || r.status === 429) && attempt < 2) {
    await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
    return zget(cfg, token, path, params, attempt + 1);
  }
  if (j.code !== 0) throw new Error(`Zoho ${path}: ${j.message || r.status}`);
  return j;
}

async function listAll(cfg, token, path, key, params) {
  const out = [];
  for (let page = 1; ; page++) {
    const j = await zget(cfg, token, path, { ...params, page, per_page: 200 });
    out.push(...(j[key] || []));
    if (!j.page_context?.has_more_page) return out;
  }
}

// run fn over items, at most `limit` at a time — Zoho allows ~100 calls/min
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// → { items: [{id, name, sku, vendor, unit, reorderLevel, stockOnHand}],
//     incoming: { [itemId]: { qty, pos: [{number, expected}] } } }
export async function fetchZohoReorder(cfg = zohoConfig()) {
  const token = await getAccessToken(cfg);

  const raw = await listAll(cfg, token, "items", "items", { filter_by: "Status.Active" });
  const items = raw
    .filter((i) => i.track_inventory && i.reorder_level !== "" && Number(i.reorder_level) > 0)
    .map((i) => ({
      id: i.item_id,
      name: i.name,
      sku: i.sku || "",
      vendor: i.vendor_name || "",
      unit: i.unit || "",
      reorderLevel: Number(i.reorder_level),
      stockOnHand: Number(i.stock_on_hand) || 0,
    }));

  // open POs: issued + partially received, minus any the team has closed
  // (a closed PO can still say "partially received" but Zoho stops counting it)
  const pos = [
    ...(await listAll(cfg, token, "purchaseorders", "purchaseorders", { filter_by: "Status.Issued" })),
    ...(await listAll(cfg, token, "purchaseorders", "purchaseorders", { filter_by: "Status.PartiallyReceived" })),
  ].filter((p, i, all) => p.order_status !== "closed" && all.findIndex((q) => q.purchaseorder_id === p.purchaseorder_id) === i);
  const details = await mapLimit(pos, 4, (p) =>
    zget(cfg, token, `purchaseorders/${p.purchaseorder_id}`).then((j) => j.purchaseorder)
  );

  // Remaining per line = ordered − cancelled − whichever is larger of
  // received and billed: a bill raised before the goods are received already
  // counts as stock-in in Zoho. Checked against Zoho's own "Order Now" numbers.
  const incoming = {};
  for (const po of details) {
    for (const li of po.line_items || []) {
      const done = Math.max(
        (Number(li.quantity_received) || 0) + (Number(li.quantity_marked_as_received) || 0),
        Number(li.quantity_billed) || 0,
      );
      const qty = (Number(li.quantity) || 0) - (Number(li.quantity_cancelled) || 0) - done;
      if (qty <= 0) continue;
      const e = (incoming[li.item_id] ||= { qty: 0, pos: [] });
      e.qty += qty;
      e.pos.push({ number: po.purchaseorder_number, qty, expected: po.expected_delivery_date || po.delivery_date || "" });
    }
  }

  // the warehouse view is its own failure domain — if that part errors (e.g.
  // the token is missing the compositeitems scope) the reorder list still
  // refreshes
  let warehouseStock = null, warehouseError = null;
  try {
    warehouseStock = await fetchWarehouseStock(cfg, token, raw);
  } catch (e) {
    warehouseError = String(e?.message || e);
  }

  return { items, incoming, poCount: pos.length, warehouseStock, warehouseError };
}

// Stock on hand + committed, per warehouse, for every active item and
// composite item.
//
// Items: the items list takes a warehouse_id filter that swaps stock_on_hand
// and available_for_sale for that warehouse's numbers, so it's one list pass
// per warehouse instead of one detail call per item (committed = on hand −
// available for sale, checked against the detail page).
// Composites: their list has no available_for_sale, so each one's detail is
// fetched — it carries both numbers per warehouse.
//
// `total` is Zoho's combined stock_on_hand from the plain list. It's the
// warehouses plus anything in transit (on a transfer order that's left one
// warehouse and not been received at the other), so the UI shows
// total − warehouses as "in transit". (The detail page's top-line
// stock_on_hand is the physical-stock figure instead — not used.)
//
// Inactive warehouses (Studio, Design Office, …) are left out, but they still
// hold a few leftover units that Zoho's total counts — so they're pulled
// anyway and their stock is taken off `total`, or it would read as in transit.
// → { warehouses: [{id, name}],
//     items / composites: [{id, name, sku, tracked, total, byWarehouse: {[whId]: [onHand, committed]}}] }
async function fetchWarehouseStock(cfg, token, rawItems) {
  const rawComposites = await listAll(cfg, token, "compositeitems", "composite_items", { filter_by: "Status.Active" });
  const compDetails = await mapLimit(rawComposites, 4, (c) =>
    zget(cfg, token, `compositeitems/${c.composite_item_id}`).then((j) => j.composite_item)
  );
  // there's no warehouse list without the settings scope, but every detail
  // carries the org's full list
  const probe = compDetails[0] || (await zget(cfg, token, `items/${rawItems[0].item_id}`)).item;
  const allWarehouses = (probe?.warehouses || [])
    .sort((a, b) => b.is_primary - a.is_primary || (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || a.warehouse_name.localeCompare(b.warehouse_name))
    .map((w) => ({ id: w.warehouse_id, name: w.warehouse_name, active: w.status === "active" }));
  if (!allWarehouses.length) throw new Error("Zoho returned no warehouses");

  const row = (r, id) => ({ id, name: r.name, sku: r.sku || "", tracked: !!r.track_inventory, total: Number(r.stock_on_hand) || 0, byWarehouse: {} });
  const items = {};
  for (const r of rawItems) items[r.item_id] = row(r, r.item_id);
  for (const w of allWarehouses) {
    const rows = await listAll(cfg, token, "items", "items", { filter_by: "Status.Active", warehouse_id: w.id });
    for (const r of rows) {
      if (!items[r.item_id]) continue;
      const onHand = Number(r.stock_on_hand) || 0;
      const committed = r.available_for_sale == null ? 0 : onHand - (Number(r.available_for_sale) || 0);
      items[r.item_id].byWarehouse[w.id] = [onHand, committed];
    }
  }

  const composites = rawComposites.map((c, i) => {
    const out = row(c, c.composite_item_id);
    for (const w of compDetails[i]?.warehouses || [])
      out.byWarehouse[w.warehouse_id] = [Number(w.warehouse_stock_on_hand) || 0, Number(w.warehouse_committed_stock) || 0];
    return out;
  });

  const inactive = allWarehouses.filter((w) => !w.active);
  const all = [...Object.values(items), ...composites];
  for (const r of all) {
    for (const w of inactive) {
      r.total -= (r.byWarehouse[w.id] || [0])[0];
      delete r.byWarehouse[w.id];
    }
  }
  const warehouses = allWarehouses.filter((w) => w.active).map(({ id, name }) => ({ id, name }));
  if (!warehouses.length) throw new Error("Zoho returned no active warehouses");

  return { warehouses, items: Object.values(items), composites };
}

// Merge fresh Zoho numbers into the stored doc. A row is added the first time
// an item is seen below its reorder level; after that it's kept for good and
// just refreshed. Hand-entered expectedDate / notes are never touched.
export function mergeReorder(prev, { items, incoming, warehouseStock, warehouseError }, now = new Date().toISOString()) {
  const stored = { ...(prev?.items || {}) };
  const seen = new Set();
  let added = 0, updated = 0;

  for (const it of items) {
    seen.add(it.id);
    const below = it.stockOnHand < it.reorderLevel;
    const old = stored[it.id];
    if (!old && !below) continue;
    const inc = incoming[it.id] || { qty: 0, pos: [] };
    stored[it.id] = {
      expectedDate: "",
      notes: "",
      firstSeenAt: now,
      ...old,
      ...it,
      toReceive: inc.qty,
      openPOs: inc.pos,
      below,
      missing: false,
      syncedAt: now,
    };
    old ? updated++ : added++;
  }

  // stored rows Zoho no longer returns (item deactivated, or its reorder
  // level removed) — kept, just flagged, never deleted
  let missing = 0;
  for (const id of Object.keys(stored)) {
    if (!seen.has(id) && !stored[id].missing) {
      stored[id] = { ...stored[id], missing: true, below: false };
      missing++;
    }
  }

  // the warehouse view is a straight snapshot (nothing hand-entered on it);
  // a failed fetch keeps the last good one
  const doc = { ...prev, items: stored, lastSyncAt: now };
  if (warehouseStock) doc.warehouseStock = { ...warehouseStock, syncedAt: now };

  return {
    doc,
    summary: {
      added,
      updated,
      missing,
      below: Object.values(stored).filter((r) => r.below).length,
      warehouseError: warehouseError || null,
    },
  };
}

// Hand-entered fields for the Ceramitec bundles (Shopify products, not Zoho
// items), kept under doc.manual keyed by SKU. mergeReorder spreads ...prev,
// so a Zoho refresh never touches these.
export function patchManualRow(doc, sku, patch) {
  const key = String(sku || "").trim().toUpperCase();
  if (!key) return null;
  const row = { ...(doc?.manual?.[key] || {}) };
  if (patch.toReceive !== undefined) {
    const n = Math.floor(Number(patch.toReceive));
    row.toReceive = patch.toReceive === "" || patch.toReceive === null || !(n >= 0) ? null : n;
  }
  if (typeof patch.expectedDate === "string") row.expectedDate = patch.expectedDate.slice(0, 10);
  if (typeof patch.notes === "string") row.notes = patch.notes.slice(0, 2000);
  row.editedAt = new Date().toISOString();
  return { ...doc, manual: { ...(doc?.manual || {}), [key]: row } };
}

// Apply a hand edit to one row. Only expectedDate and notes are editable.
export function patchReorderRow(doc, id, patch) {
  const row = doc?.items?.[id];
  if (!row) return null;
  const next = { ...row };
  if (typeof patch.expectedDate === "string") next.expectedDate = patch.expectedDate.slice(0, 10);
  if (typeof patch.notes === "string") next.notes = patch.notes.slice(0, 2000);
  next.editedAt = new Date().toISOString();
  return { ...doc, items: { ...doc.items, [id]: next } };
}
