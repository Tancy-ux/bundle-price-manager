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

  return { items, incoming, poCount: pos.length };
}

// Merge fresh Zoho numbers into the stored doc. A row is added the first time
// an item is seen below its reorder level; after that it's kept for good and
// just refreshed. Hand-entered expectedDate / notes are never touched.
export function mergeReorder(prev, { items, incoming }, now = new Date().toISOString()) {
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

  return {
    doc: { ...prev, items: stored, lastSyncAt: now },
    summary: {
      added,
      updated,
      missing,
      below: Object.values(stored).filter((r) => r.below).length,
    },
  };
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
