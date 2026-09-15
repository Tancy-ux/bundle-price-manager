// Shared merge helpers for the diff-based /api/data save. Used by both
// api/data.js (hosted) and server.js (local).
//
// WHY: the old save sent the client's whole products/bundles/trash arrays
// and the server just replaced everything. Two people with the app open at
// once could silently clobber each other's edits — whoever's browser tab
// happened to autosave last would overwrite anything the other person had
// just changed, even in a completely unrelated item.
//
// Now the client sends only what it actually changed (an "upserts" list of
// full items plus a "deletes" list of ids), and the server merges that onto
// whatever is CURRENTLY stored — read fresh at write time, not trusting the
// client's idea of what was there before. So two people editing different
// items at the same time no longer conflict; only editing the exact same
// item within moments of each other can still have one edit win.

// products/bundles: keyed by their own id
export function mergeUpserts(liveArray, upserts = [], deletes = []) {
  const deleteSet = new Set(deletes);
  const liveIds = new Set(liveArray.map((x) => x.id));
  const newItems = upserts.filter((x) => !liveIds.has(x.id));
  const updated = liveArray
    .filter((x) => !deleteSet.has(x.id))
    .map((x) => upserts.find((u) => u.id === x.id) || x);
  return [...newItems, ...updated];
}

// trash entries have no id of their own — keyed by the nested item's id
export function mergeTrash(liveTrash, upserts = [], deletes = []) {
  const deleteSet = new Set(deletes);
  const liveIds = new Set(liveTrash.map((x) => x.item?.id));
  const newItems = upserts.filter((x) => !liveIds.has(x.item?.id));
  const updated = liveTrash
    .filter((x) => !deleteSet.has(x.item?.id))
    .map((x) => upserts.find((u) => u.item?.id === x.item?.id) || x);
  return [...newItems, ...updated];
}

// excludedSkus / excludedBundleNames: plain string sets
export function mergeSet(liveArray = [], added = [], removed = []) {
  const s = new Set(liveArray);
  added.forEach((x) => s.add(x));
  removed.forEach((x) => s.delete(x));
  return [...s];
}
