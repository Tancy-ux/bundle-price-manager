// What the no-password team view may change in the catalog: prices, nothing
// else. The team's save is treated as a list of requested prices. Every other
// field, every delete and every Trash change in it is ignored, so a stale tab or
// a hand-made request can't alter or lose anything. The server records the
// history entry itself, which keeps the "Team edited" tag trustworthy.

const MAX_HISTORY = 50;

function applyPrices(items = [], upserts = [], field, at) {
  const requested = new Map(upserts.map((u) => [u?.id, u?.[field]]));
  let changed = false;
  const next = items.map((item) => {
    const to = requested.get(item.id);
    const from = item[field] || 0;
    if (!Number.isFinite(to) || to < 0 || to === from) return item;
    changed = true;
    return {
      ...item,
      [field]: to,
      history: [{ at, from, to, by: "team" }, ...(item.history || [])].slice(0, MAX_HISTORY),
    };
  });
  return { next, changed };
}

// → { doc, changed }: the catalog with the team's price changes applied
export function applyTeamSave(prev, { productsDiff, bundlesDiff }, at = new Date().toISOString()) {
  const products = applyPrices(prev.products, productsDiff?.upserts, "price", at);
  const bundles = applyPrices(prev.bundles, bundlesDiff?.upserts, "storedPrice", at);
  return {
    doc: { ...prev, products: products.next, bundles: bundles.next, updatedAt: at },
    changed: products.changed || bundles.changed,
  };
}
