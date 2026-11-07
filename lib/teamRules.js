// What the no-password team view may change in the catalog: prices, nothing
// else. The team's save is treated as a list of requested prices. Every other
// field, every delete and every Trash change in it is ignored, so a stale tab or
// a hand-made request can't alter or lose anything. The server records the
// history entry itself, which keeps the "Team edited" tag trustworthy.

const MAX_HISTORY = 50;
// team changes to one item this close together are one edit in History
const SAME_EDIT_MS = 5 * 60 * 1000;

function withTeamEntry(history = [], at, from, to) {
  const last = history[0];
  // counted from when that edit started, so a run of changes can't merge forever
  if (last && last.by === "team" && Date.parse(at) - Date.parse(last.start || last.at) < SAME_EDIT_MS) {
    // still the same edit: keep where it started, update where it ended
    if (to === last.from) return history.slice(1);
    return [{ ...last, at, to, start: last.start || last.at }, ...history.slice(1)];
  }
  return [{ at, from, to, by: "team", start: at }, ...history].slice(0, MAX_HISTORY);
}

// _was: the price the team's tab last saw. If it's no longer the stored price,
// someone changed it since, so the stale change is refused (counted in stale)
function applyPrices(items = [], upserts = [], field, at) {
  const requested = new Map(upserts.map((u) => [u?.id, u]));
  let changed = false;
  let stale = 0;
  const next = items.map((item) => {
    const u = requested.get(item.id);
    const to = u?.[field];
    const from = item[field] || 0;
    if (!Number.isFinite(to) || to < 0 || to === from) return item;
    if (u._was !== undefined && u._was !== from) {
      stale++;
      return item;
    }
    changed = true;
    return {
      ...item,
      [field]: to,
      history: withTeamEntry(item.history, at, from, to),
    };
  });
  return { next, changed, stale };
}

// → { doc, changed, stale }: the catalog with the team's price changes applied
export function applyTeamSave(prev, { productsDiff, bundlesDiff }, at = new Date().toISOString()) {
  const products = applyPrices(prev.products, productsDiff?.upserts, "price", at);
  const bundles = applyPrices(prev.bundles, bundlesDiff?.upserts, "storedPrice", at);
  return {
    doc: { ...prev, products: products.next, bundles: bundles.next, updatedAt: at },
    changed: products.changed || bundles.changed,
    stale: products.stale + bundles.stale,
  };
}

// An admin tab opened before a team price change sends the old price and
// history back with its next save. Keep the team's history entries, and the
// team's price too unless the admin changed the price themselves.
export function keepTeamEdits(liveItems = [], upserts = [], field) {
  const live = new Map(liveItems.map((x) => [x.id, x]));
  const id = (h) => h.start || h.at;
  return (upserts || []).map((u) => {
    const cur = live.get(u.id);
    const sent = u.history || [];
    const missing = (cur?.history || []).filter((h) => h.by === "team" && !sent.some((x) => id(x) === id(h)));
    if (!missing.length) return u;
    const latest = missing[0];
    const keepPrice = (u[field] || 0) === latest.from && cur.history[0] === latest;
    return {
      ...u,
      ...(keepPrice ? { [field]: cur[field] } : {}),
      history: [...missing, ...sent].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_HISTORY),
    };
  });
}
