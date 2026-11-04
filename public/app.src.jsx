const { useState, useEffect, useMemo, useRef } = React;

const money = (n) =>
  isNaN(n) || n == null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(n);
const round2 = (n) => Math.round(n * 100) / 100;
const uid = () => Math.random().toString(36).slice(2, 9);

// relative time for the "stock synced" indicator, e.g. "3h ago", "just now"
function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Price-change trail kept on each product/bundle: newest first, and capped so the
// saved document can't grow without bound.
const MAX_HISTORY = 50;
const pushHistory = (item, from, to) =>
  [{ at: new Date().toISOString(), from, to }, ...(item.history || [])].slice(
    0,
    MAX_HISTORY,
  );

// Token search: every word in the query must appear somewhere in the haystack,
// in any order. So "plate lunar" matches "Lunar Nude Plate", and "lun pla"
// matches it too (partial words). Punctuation/extra spaces are ignored.
const norm = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const normSku = (s) => (s || "").trim().toLowerCase();
function matchText(query, haystack) {
  const q = norm(query);
  if (!q) return true;
  const hay = norm(haystack);
  return q.split(" ").every((w) => hay.includes(w));
}

async function apiGet() {
  const r = await fetch("/api/data");
  return r.json();
}

// Diff-based save: only what actually changed since the last confirmed save
// goes over the wire, and the server merges it onto whatever's currently
// stored (not onto what this tab thinks was there). Without this, two
// people with the app open at once could silently overwrite each other's
// edits — see lib/mergeData.js (server side) for the full explanation.
function diffById(baseline, current) {
  const baseMap = new Map(baseline.map((x) => [x.id, x]));
  const curMap = new Map(current.map((x) => [x.id, x]));
  const upserts = [];
  curMap.forEach((item, id) => {
    const prev = baseMap.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item))
      upserts.push(item);
  });
  const deletes = [];
  baseMap.forEach((_, id) => {
    if (!curMap.has(id)) deletes.push(id);
  });
  return { upserts, deletes };
}
// trash entries have no id of their own — keyed by the nested item's id
function diffTrash(baseline, current) {
  const baseMap = new Map(baseline.map((x) => [x.item?.id, x]));
  const curMap = new Map(current.map((x) => [x.item?.id, x]));
  const upserts = [];
  curMap.forEach((item, id) => {
    const prev = baseMap.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item))
      upserts.push(item);
  });
  const deletes = [];
  baseMap.forEach((_, id) => {
    if (!curMap.has(id)) deletes.push(id);
  });
  return { upserts, deletes };
}
function diffSet(baseline, current) {
  const baseSet = new Set(baseline || []),
    curSet = new Set(current || []);
  return {
    added: [...curSet].filter((x) => !baseSet.has(x)),
    removed: [...baseSet].filter((x) => !curSet.has(x)),
  };
}

async function apiPutDiff(diff) {
  const r = await fetch("/api/data", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(diff),
  });
  return r.json();
}

function App() {
  const [products, setProducts] = useState(null);
  const [bundles, setBundles] = useState(null);
  const [trash, setTrash] = useState([]); // {kind, item, at}
  // SKUs (products) / normalised names (bundles) deliberately deleted before —
  // a future Shopify sync won't re-add them. Restoring from Trash clears the entry.
  const [excludedSkus, setExcludedSkus] = useState([]);
  const [excludedBundleNames, setExcludedBundleNames] = useState([]);
  const [tab, setTab] = useState("reorder");
  // which Zoho Inventory table is open — picked from under it in the sidebar
  const [zohoTable, setZohoTable] = useState("items");
  // the top bar's search / buttons slots, filled by the open tab (see InBar)
  const [barSlots, setBarSlots] = useState(null);
  // set when jumping from a bundle's component to Products, so it opens
  // pre-searched to that exact item instead of the full list
  const [productJumpQuery, setProductJumpQuery] = useState("");
  // set when jumping from a product's "in bundles" pill back to Bundles, so
  // it opens pre-searched to (and with) that exact bundle expanded
  const [bundleJumpTarget, setBundleJumpTarget] = useState(null); // {id, name}
  const [toast, setToast] = useState(null);
  const [undo, setUndo] = useState(null); // {label, restore}
  const [confirmState, setConfirmState] = useState(null); // {title, detail, confirmLabel, danger, resolve}
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncing, setSyncing] = useState(false);
  // Zoho reorder list — its own document, separate from the Shopify catalog
  const [reorder, setReorder] = useState({ items: {}, lastSyncAt: null });
  const firstLoad = useRef(true);
  // last confirmed-saved state, used to compute what actually changed —
  // see diffById/apiPutDiff above and lib/mergeData.js for why
  const baselineRef = useRef({
    products: [],
    bundles: [],
    trash: [],
    excludedSkus: [],
    excludedBundleNames: [],
  });
  // the sticky top bar's height (TopBar reports it), so each tab's own
  // filter row can stick right below it instead of scrolling away
  const [headerH, setHeaderH] = useState(0);
  // per-table counts for the sidebar's Zoho Inventory list
  const zohoCounts = useMemo(() => {
    const ws = reorder.warehouseStock;
    return zohoTableCounts(
      splitWarehouseTables(ws, products),
      ws,
      Object.values(reorder.items || {}).filter((r) => r.below).length,
    );
  }, [reorder, products]);

  useEffect(() => {
    (async () => {
      const d = await apiGet();
      const initial = {
        products: d.products || [],
        bundles: d.bundles || [],
        trash: d.trash || [],
        excludedSkus: d.excludedSkus || [],
        excludedBundleNames: d.excludedBundleNames || [],
      };
      setProducts(initial.products);
      setBundles(initial.bundles);
      setTrash(initial.trash);
      setExcludedSkus(initial.excludedSkus);
      setExcludedBundleNames(initial.excludedBundleNames);
      baselineRef.current = initial;
      setLastSyncAt(d.lastSyncAt || null);
      setReady(true);
    })();
    // separate request so a Zoho/Redis hiccup here never blocks the main app
    fetch("/api/reorder")
      .then((r) => r.json())
      .then((d) => d && d.items && setReorder(d))
      .catch(() => {});
  }, []);

  // autosave on any change (skip the initial load) — diffs against the last
  // confirmed-saved baseline, sends only what changed, and adopts whatever
  // the server sends back (which may include someone else's concurrent
  // edits merged in too)
  useEffect(() => {
    if (!ready) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    const baseline = baselineRef.current;
    const productsDiff = diffById(baseline.products, products);
    const bundlesDiff = diffById(baseline.bundles, bundles);
    const trashDiff = diffTrash(baseline.trash, trash);
    const excludedSkusDiff = diffSet(baseline.excludedSkus, excludedSkus);
    const excludedBundleNamesDiff = diffSet(
      baseline.excludedBundleNames,
      excludedBundleNames,
    );
    const nothingChanged =
      !productsDiff.upserts.length &&
      !productsDiff.deletes.length &&
      !bundlesDiff.upserts.length &&
      !bundlesDiff.deletes.length &&
      !trashDiff.upserts.length &&
      !trashDiff.deletes.length &&
      !excludedSkusDiff.added.length &&
      !excludedSkusDiff.removed.length &&
      !excludedBundleNamesDiff.added.length &&
      !excludedBundleNamesDiff.removed.length;
    if (nothingChanged) return;
    let cancel = false;
    setSaving(true);
    apiPutDiff({
      productsDiff,
      bundlesDiff,
      trashDiff,
      excludedSkusDiff,
      excludedBundleNamesDiff,
    })
      .then((res) => {
        if (cancel) return;
        setSaving(false);
        if (res && res.ok && res.data) {
          const d = res.data;
          const merged = {
            products: d.products || [],
            bundles: d.bundles || [],
            trash: d.trash || [],
            excludedSkus: d.excludedSkus || [],
            excludedBundleNames: d.excludedBundleNames || [],
          };
          baselineRef.current = merged;
          setProducts(merged.products);
          setBundles(merged.bundles);
          setTrash(merged.trash);
          setExcludedSkus(merged.excludedSkus);
          setExcludedBundleNames(merged.excludedBundleNames);
          if (d.lastSyncAt !== undefined) setLastSyncAt(d.lastSyncAt || null);
        }
      })
      .catch(() => {
        if (!cancel) {
          setSaving(false);
          flash("Could not save to disk — is the server running?");
        }
      });
    return () => {
      cancel = true;
    };
  }, [products, bundles, trash, excludedSkus, excludedBundleNames, ready]);

  const flash = (m) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };
  const showUndo = (label, restore) => {
    setUndo({ label, restore });
    setTimeout(() => setUndo((u) => (u && u.label === label ? null : u)), 6000);
  };
  // in-app replacement for window.confirm — returns a Promise<boolean>, resolved
  // when the user picks a button in <ConfirmModal/> (rendered once, below)
  const askConfirm = ({
    title,
    detail,
    confirmLabel = "Delete",
    danger = true,
  }) =>
    new Promise((resolve) =>
      setConfirmState({ title, detail, confirmLabel, danger, resolve }),
    );

  // take a full data doc from the server as the new truth
  function adoptData(d) {
    const merged = {
      products: d.products || [],
      bundles: d.bundles || [],
      trash: d.trash || [],
      excludedSkus: d.excludedSkus || [],
      excludedBundleNames: d.excludedBundleNames || [],
    };
    baselineRef.current = merged; // otherwise the next autosave would diff against a stale baseline
    setProducts(merged.products);
    setBundles(merged.bundles);
    setTrash(merged.trash);
    setExcludedSkus(merged.excludedSkus);
    setExcludedBundleNames(merged.excludedBundleNames);
    setLastSyncAt(d.lastSyncAt || null);
  }

  // "Sync with Shopify" — adds new products (active + SKU), new empty bundle
  // shells (active + no SKU), and refreshes stock on everything, in one call.
  // Throttled server-side to once/4h; syncEligible below mirrors that for the UI.
  async function syncNow() {
    setSyncing(true);
    try {
      const r = await fetch("/api/sync", { method: "POST" });
      // a platform error (e.g. Vercel's function timeout) comes back as plain
      // text, not JSON — show it rather than "is the server running?"
      const text = await r.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        flash(`Sync failed (${r.status}): ${text.slice(0, 200)}`);
        return;
      }
      if (r.status === 429) {
        const hrs = Math.ceil((j.retryAfterMs || 0) / 3600000);
        flash(`Already synced — try again in about ${hrs}h`);
        return;
      }
      if (!r.ok) {
        flash(
          [j.error || "Sync failed", j.detail].filter(Boolean).join(" — "),
        );
        return;
      }
      adoptData(j.data);
      const s = j.summary;
      flash(
        `Synced: +${s.addedProducts} products, +${s.addedBundles} bundles, stock updated on ${s.stockUpdated} (${s.totalOOS} out of stock)`,
      );
      return j.data;
    } catch (e) {
      flash("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  }
  const SYNC_COOLDOWN_MS = 4 * 60 * 60 * 1000;
  const syncEligible =
    !lastSyncAt ||
    Date.now() - new Date(lastSyncAt).getTime() >= SYNC_COOLDOWN_MS;

  // out-of-stock .docx: pull the freshest stock first — a full Shopify sync
  // when the 4h cooldown allows, otherwise whatever the server has now
  // (the scheduled stock check keeps that current)
  async function exportOOS(atelier) {
    let d = syncEligible ? await syncNow() : null;
    if (!d) {
      d = await apiGet();
      adoptData(d);
    }
    await downloadOOSDocx(d.products || [], d.bundles || [], atelier);
  }

  // push one item's price straight to its linked Shopify variant. Only ever
  // sends {id, price} to Shopify — see lib/shopifySync.js's pushVariantPrice.
  // Confirmed first since this is the only thing in the app that writes to
  // the live store rather than just this app's own data.
  async function pushPriceToShopify(kind, item) {
    const priceField = kind === "product" ? "price" : "storedPrice";
    const price = item[priceField] || 0;
    const ok = await askConfirm({
      title: `Push ${money(price)} to Shopify?`,
      detail: `Updates the live price for "${item.name}" on your Shopify store. Nothing else about it changes.`,
      confirmLabel: "Push to Shopify",
    });
    if (!ok) return;
    try {
      const r = await fetch("/api/push-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id: item.id, price }),
      });
      const j = await r.json();
      if (!r.ok) {
        flash(j.error || "Push failed");
        return;
      }
      if (kind === "product") {
        setProducts((cur) => cur.map((p) => (p.id === item.id ? j.item : p)));
        baselineRef.current = {
          ...baselineRef.current,
          products: baselineRef.current.products.map((p) =>
            p.id === item.id ? j.item : p,
          ),
        };
      } else {
        setBundles((cur) => cur.map((b) => (b.id === item.id ? j.item : b)));
        baselineRef.current = {
          ...baselineRef.current,
          bundles: baselineRef.current.bundles.map((b) =>
            b.id === item.id ? j.item : b,
          ),
        };
      }
      flash(`Pushed ${money(price)} to Shopify for "${item.name}"`);
    } catch (e) {
      flash("Push failed — is the server running?");
    }
  }

  // jump from a bundle's component straight to that product in Products,
  // pre-searched so it's the only (or top) match — no manual re-search needed
  function jumpToProduct(p) {
    setProductJumpQuery(p.sku || p.name);
    setTab("products");
  }

  // jump from a product's "in bundles" pill back to that specific bundle —
  // lands on Needs Updating if it's actually stale there, since that's
  // where you'd want to act on it; otherwise the Bundles tab
  function jumpToBundle(u) {
    const b = bundles.find((x) => x.id === u.id);
    const isStale = b ? compute(b).stale : false;
    setBundleJumpTarget(u);
    setTab(isStale ? "worklist" : "bundles");
  }

  // deletion also excludes the item from future Shopify syncs (by SKU for
  // products, by name for bundles) so it never silently comes back. Restoring
  // (via Undo here, or from Trash) clears the exclusion again.
  const excludeSku = (sku) => {
    const s = normSku(sku);
    if (!s) return;
    setExcludedSkus((cur) => (cur.includes(s) ? cur : [...cur, s]));
  };
  const unexcludeSku = (sku) => {
    const s = normSku(sku);
    setExcludedSkus((cur) => cur.filter((x) => x !== s));
  };
  const excludeBundleName = (name) => {
    const n = norm(name);
    if (!n) return;
    setExcludedBundleNames((cur) => (cur.includes(n) ? cur : [...cur, n]));
  };
  const unexcludeBundleName = (name) => {
    const n = norm(name);
    setExcludedBundleNames((cur) => cur.filter((x) => x !== n));
  };

  // delete a bundle -> trash + undo (recoverable, so no confirm — just Undo)
  function deleteBundle(b) {
    setBundles(bundles.filter((x) => x.id !== b.id));
    excludeBundleName(b.name);
    const entry = { kind: "bundle", item: b, at: new Date().toISOString() };
    setTrash((t) => [entry, ...t]);
    showUndo(`Deleted "${b.name}"`, () => {
      setBundles((cur) => [b, ...cur]);
      setTrash((t) => t.filter((e) => e !== entry));
      unexcludeBundleName(b.name);
    });
  }
  // delete a product -> trash + undo (recoverable, so no confirm — just Undo)
  function deleteProduct(p) {
    setProducts(products.filter((x) => x.id !== p.id));
    // a no-SKU product would only ever come back as a re-detected bundle
    // shell (matched by name), same as a deleted bundle — exclude by name
    if (p.sku) excludeSku(p.sku);
    else excludeBundleName(p.name);
    const entry = { kind: "product", item: p, at: new Date().toISOString() };
    setTrash((t) => [entry, ...t]);
    showUndo(`Deleted "${p.name}"`, () => {
      setProducts((cur) => [p, ...cur]);
      setTrash((t) => t.filter((e) => e !== entry));
      if (p.sku) unexcludeSku(p.sku);
      else unexcludeBundleName(p.name);
    });
  }
  function restoreFromTrash(entry) {
    if (entry.kind === "bundle") {
      setBundles((cur) => [entry.item, ...cur]);
      unexcludeBundleName(entry.item.name);
    } else {
      setProducts((cur) => [entry.item, ...cur]);
      if (entry.item.sku) unexcludeSku(entry.item.sku);
      else unexcludeBundleName(entry.item.name);
    }
    setTrash((t) => t.filter((e) => e !== entry));
    flash("Restored");
  }
  // permanently remove a single item from Trash (not recoverable)
  async function deleteFromTrash(entry) {
    const ok = await askConfirm({
      title: `Permanently delete "${entry.item.name}"?`,
      detail: "This can't be undone.",
      confirmLabel: "Delete permanently",
    });
    if (!ok) return;
    setTrash((t) => t.filter((e) => e !== entry));
    flash("Deleted for good");
  }
  async function emptyTrash() {
    const ok = await askConfirm({
      title: `Permanently delete all ${trash.length} item${trash.length > 1 ? "s" : ""} in Trash?`,
      detail: "This can't be undone.",
      confirmLabel: "Empty trash",
    });
    if (!ok) return;
    setTrash([]);
    flash("Trash emptied");
  }

  // promote a no-SKU bundle into the product list
  function promoteToProduct(b) {
    const c = compute(b);
    const np = {
      id: uid(),
      sku: "",
      name: b.name,
      price: c.empty ? b.storedPrice || 0 : c.target,
      active: true,
    };
    setProducts((cur) => [np, ...cur]);
    setBundles(bundles.filter((x) => x.id !== b.id));
    flash(`Moved "${b.name}" to Products`);
  }

  // skip / un-skip a bundle (keep it out of the worklist), with undo
  function skipBundle(b, skip) {
    setBundles((cur) =>
      cur.map((x) => (x.id === b.id ? { ...x, skipped: skip } : x)),
    );
    if (skip)
      showUndo(`Skipped "${b.name}"`, () =>
        setBundles((cur) =>
          cur.map((x) => (x.id === b.id ? { ...x, skipped: false } : x)),
        ),
      );
    else flash(`"${b.name}" back in the worklist`);
  }

  const byId = useMemo(() => {
    const m = {};
    (products || []).forEach((p) => (m[p.id] = p));
    return m;
  }, [products]);
  // bundles are matched by name (unlike products, which have SKU), so two
  // bundles sharing a name is a real ambiguity worth flagging — which one
  // does a Shopify listing / future sync actually mean?
  const bundleNameCounts = useMemo(() => {
    const m = {};
    (bundles || []).forEach((b) => {
      const n = norm(b.name);
      if (n) m[n] = (m[n] || 0) + 1;
    });
    return m;
  }, [bundles]);

  function compute(b) {
    let sum = 0,
      missing = false;
    const oosItems = [];
    // bundle's own sellable stock = least of its active, tracked components,
    // each divided by how many that one bundle needs — a component at 58
    // units but needed 9-per-bundle only supports 6 complete bundles, not 58.
    // null when no component has trackable stock (nothing to compare).
    let stock = null;
    b.items.forEach((it) => {
      const p = byId[it.productId];
      if (!p || !p.active) missing = true;
      else sum += p.price * it.qty;
      // only an active product's stock counts — an inactive/discontinued item
      // is already flagged via "missing" above, not as a stock blocker
      if (p && p.active && p.stockTracked && (p.stock || 0) <= 0)
        oosItems.push({ product: p, qty: it.qty });
      if (p && p.active && p.stockTracked) {
        const buildable = Math.floor((p.stock || 0) / (it.qty || 1));
        stock = stock === null ? buildable : Math.min(stock, buildable);
      }
    });
    const target = round2(sum);
    const empty = b.items.length === 0;
    const priceMismatch = Math.abs(target - (b.storedPrice || 0)) > 0.009;
    // "gift price included": the live price intentionally differs from the sum
    // (packaging / gift cost baked in), so a mismatch is NOT something to fix.
    const giftIncluded = !!b.giftIncluded;
    // "skipped": user has explicitly chosen not to track this bundle (e.g. a single
    // item + a box). Never flag it for updating, whatever the price says.
    const skipped = !!b.skipped;
    // an empty bundle isn't "stale" — it's just not built yet.
    // a gift-included bundle isn't "stale" on price either — only if an item is missing.
    const stale =
      !empty && !skipped && (missing || (priceMismatch && !giftIncluded));
    const hasOOS = oosItems.length > 0;
    const dupName = (bundleNameCounts[norm(b.name)] || 0) > 1;
    return {
      target,
      missing,
      stale,
      empty,
      giftIncluded,
      skipped,
      priceMismatch,
      diff: target - (b.storedPrice || 0),
      oosItems,
      hasOOS,
      stock,
      dupName,
    };
  }

  if (!ready)
    return (
      <div
        style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}
        className="serif"
      >
        Loading from disk…
      </div>
    );

  const staleList = bundles
    .filter((b) => b.active !== false)
    .map((b) => ({ b, c: compute(b) }))
    .filter((x) => x.c.stale);
  const oosList = bundles
    .filter((b) => b.active !== false)
    .map((b) => ({ b, c: compute(b) }))
    .filter((x) => x.c.hasOOS)
    .sort((a, b) => a.b.name.localeCompare(b.b.name));
  const discontinuedCount =
    products.filter((p) => !p.active).length +
    bundles.filter((b) => b.active === false).length;
  const reorderCount = Object.values(reorder.items || {}).filter(
    (r) => r.below,
  ).length;
  // freshest stock check across all products, for the "synced" indicator
  const stockUpdatedAt = products.reduce(
    (max, p) =>
      p.stockUpdatedAt && p.stockUpdatedAt > (max || "")
        ? p.stockUpdatedAt
        : max,
    null,
  );

  const openTab = (k) => {
    setTab(k);
    if (k === "products") setProductJumpQuery("");
    if (k === "worklist" || k === "bundles") setBundleJumpTarget(null);
  };
  const pageTitle =
    tab === "reorder"
      ? (ZOHO_TABLES.find(([k]) => k === zohoTable) || [, TAB_LABELS.reorder])[1]
      : TAB_LABELS[tab];

  return (
    <div className="shell">
      <Sidebar
        tab={tab}
        onTab={openTab}
        groups={[
          ["Inventory", [["reorder", reorderCount, true]]],
          ["Catalog", [["bundles"], ["products"], ["whereused"]]],
          [
            "Needs attention",
            [
              ["worklist", staleList.length, true],
              ["stock", oosList.length, true],
              ["discontinued", discontinuedCount],
              ["trash", trash.length],
            ],
          ],
        ]}
        sub={{
          under: "reorder",
          items: ZOHO_TABLES,
          counts: zohoCounts,
          value: zohoTable,
          onPick: (k) => {
            setZohoTable(k);
            setTab("reorder");
          },
        }}
      >
        <div className="sbStats">
          <b>{products.length}</b> products · <b>{bundles.length}</b> bundles
          <div className={saving ? "busy" : "ok"}>
            {saving ? "saving…" : "saved ✓"}
          </div>
          <div>
            stock{" "}
            {stockUpdatedAt ? `synced ${timeAgo(stockUpdatedAt)}` : "never synced"}
          </div>
        </div>
        <button
          className="sbSync"
          onClick={syncNow}
          disabled={syncing || !syncEligible}
          title={
            !syncEligible
              ? `Last synced ${timeAgo(lastSyncAt)} — available once every 4h`
              : "Pull new products, new bundle shells, and refresh stock from Shopify"
          }
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" />
            <path d="M18 3v4h-4M6 21v-4h4" />
          </svg>
          <span>
            {syncing
              ? "Syncing…"
              : lastSyncAt
                ? `Shopify · synced ${timeAgo(lastSyncAt)}`
                : "Sync with Shopify"}
          </span>
        </button>
      </Sidebar>

      {/* the open tab scrolls here, under the top bar; the sidebar stays put */}
      <main
        className="noScrollbar mainPad"
        style={{ flex: 1, minWidth: 0, overflowY: "auto" }}
      >
        <BarSlots.Provider value={barSlots}>
          <div>
            <TopBar
              crumb={tab === "reorder" ? "Zoho Inventory" : null}
              title={pageTitle}
              onHeight={setHeaderH}
              onSlots={setBarSlots}
            />
            {/* tabs without a search of their own get "search everything" */}
            {!["bundles", "products", "whereused", "reorder"].includes(tab) && (
              <InBar slot="search" key={"search:" + tab}>
                <GlobalSearch
                  products={products}
                  bundles={bundles}
                  onJumpToProduct={jumpToProduct}
                  onJumpToBundle={jumpToBundle}
                />
              </InBar>
            )}

      {/* keyed by tab so each one fades in when opened */}
      <div key={tab} style={{ animation: "fadeIn .18s ease" }}>
        {toast && (
          <div
            style={{
              position: "fixed",
              bottom: 18,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 30,
              background: "var(--ink)",
              color: "var(--paper)",
              padding: "10px 16px",
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              animation: "slideIn .2s ease",
            }}
          >
            {toast}
          </div>
        )}
        {undo && (
          <div
            style={{
              position: "fixed",
              bottom: 18,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 31,
              background: "var(--ink)",
              color: "var(--paper)",
              padding: "8px 10px 8px 16px",
              borderRadius: 6,
              fontSize: 13,
              display: "flex",
              alignItems: "center",
              gap: 14,
              animation: "slideIn .2s ease",
            }}
          >
            <span>{undo.label}</span>
            <button
              onClick={() => {
                undo.restore();
                setUndo(null);
              }}
              style={{
                background: "var(--clay)",
                color: "#fff",
                border: "none",
                padding: "6px 12px",
                borderRadius: 4,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Undo
            </button>
          </div>
        )}
        {confirmState && (
          <ConfirmModal
            {...confirmState}
            onClose={(result) => {
              confirmState.resolve(result);
              setConfirmState(null);
            }}
          />
        )}

        {tab === "worklist" && (
          <Worklist
            staleList={staleList}
            bundles={bundles}
            setBundles={setBundles}
            flash={flash}
            products={products}
            compute={compute}
            byId={byId}
            onDelete={deleteBundle}
            onPromote={promoteToProduct}
            onSkip={skipBundle}
            pushPrice={pushPriceToShopify}
            onJumpToProduct={jumpToProduct}
            initialOpenBundle={bundleJumpTarget}
          />
        )}
        {tab === "bundles" && (
          <Bundles
            bundles={bundles}
            setBundles={setBundles}
            products={products}
            compute={compute}
            byId={byId}
            onDelete={deleteBundle}
            onPromote={promoteToProduct}
            onSkip={skipBundle}
            stickyTop={headerH}
            pushPrice={pushPriceToShopify}
            onJumpToProduct={jumpToProduct}
            initialOpenBundle={bundleJumpTarget}
          />
        )}
        {tab === "products" && (
          <Products
            products={products}
            setProducts={setProducts}
            bundles={bundles}
            onDelete={deleteProduct}
            flash={flash}
            stickyTop={headerH}
            pushPrice={pushPriceToShopify}
            initialQuery={productJumpQuery}
            onJumpToBundle={jumpToBundle}
          />
        )}
        {tab === "whereused" && (
          <WhereUsed bundles={bundles} products={products} compute={compute} />
        )}
        {tab === "stock" && (
          <StockIssues
            oosList={oosList}
            bundles={bundles}
            setBundles={setBundles}
            byId={byId}
            products={products}
            compute={compute}
            onDelete={deleteBundle}
            onPromote={promoteToProduct}
            onSkip={skipBundle}
            pushPrice={pushPriceToShopify}
            onJumpToProduct={jumpToProduct}
            onExport={exportOOS}
          />
        )}
        {tab === "discontinued" && (
          <Discontinued
            products={products}
            setProducts={setProducts}
            bundles={bundles}
            setBundles={setBundles}
            onDeleteProduct={deleteProduct}
            onDeleteBundle={deleteBundle}
          />
        )}
        {tab === "reorder" && (
          <Reorder
            doc={reorder}
            setDoc={setReorder}
            table={zohoTable}
            setTable={setZohoTable}
            stickyTop={headerH}
            flash={flash}
            products={products}
          />
        )}
        {tab === "trash" && (
          <Trash
            trash={trash}
            onRestore={restoreFromTrash}
            onDelete={deleteFromTrash}
            onEmpty={emptyTrash}
          />
        )}
      </div>
          </div>
        </BarSlots.Provider>
      </main>
    </div>
  );
}

// Zoho Inventory's tables, listed under it in the sidebar (the team's
// /inventory page has no sidebar, so Reorder shows them as buttons there)
const ZOHO_TABLES = [
  ["items", "Items by warehouse"],
  ["composites", "Composite items"],
  ["marble", "Marble Atelier"],
  ["reorder", "Reorder list"],
  ["ceramitec", "Ceramitec bundles"],
];

// each tab's name: in the sidebar and as the page title
const TAB_LABELS = {
  reorder: "Zoho Inventory",
  bundles: "Bundles",
  products: "Products",
  whereused: "In bundles",
  worklist: "Needs updating",
  stock: "Out of stock",
  discontinued: "Discontinued",
  trash: "Trash",
};

const NAV_ICONS = {
  reorder: (
    <>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
      <path d="M3 8l9 5 9-5M12 13v8" />
    </>
  ),
  bundles: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </>
  ),
  products: <path d="M4 7h16M4 12h16M4 17h10" />,
  whereused: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  worklist: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  stock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 18L18 6" />
    </>
  ),
  discontinued: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
};

// the app's navigation, down the left so the whole height is left for the
// open tab. groups: [heading, [[key, count, needsAttention]]]; sub lists
// the Zoho tables under their tab. Collapses to icons (remembered in this
// browser, and always on narrow screens); the footer (children) holds the
// status and Sync button.
const NARROW = "(max-width: 760px)";
function Sidebar({ groups, tab, onTab, sub, children }) {
  const [slim, setSlim] = useState(() => {
    try {
      return localStorage.getItem("sidebarSlim") === "1";
    } catch {
      return false;
    }
  });
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const toggle = () => {
    try {
      localStorage.setItem("sidebarSlim", slim ? "0" : "1");
    } catch {}
    setSlim(!slim);
  };
  const collapsed = slim || narrow;
  // collapsed, the sub list (Zoho tables) opens as a pop-out beside the
  // rail — hover or click its icon — so collapsing never changes the page
  const [flyTop, setFlyTop] = useState(null); // px from the top, or null when shut
  const flyClose = useRef(null);
  const openFly = (wrap) => {
    clearTimeout(flyClose.current);
    setFlyTop(wrap.getBoundingClientRect().top);
  };
  const closeFlySoon = () => {
    flyClose.current = setTimeout(() => setFlyTop(null), 160);
  };
  useEffect(() => {
    if (!collapsed) setFlyTop(null);
  }, [collapsed]);
  useEffect(() => {
    if (flyTop == null) return;
    const away = (e) => !e.target.closest(".sbFlyWrap") && setFlyTop(null);
    const esc = (e) => e.key === "Escape" && setFlyTop(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [flyTop]);
  const subButtons = (k, after) =>
    sub.items.map(([sk, slabel]) => (
      <button
        key={sk}
        className={`sbItem${tab === k && sub.value === sk ? " on" : ""}`}
        onClick={() => {
          sub.onPick(sk);
          if (after) after();
        }}
      >
        <span className="sbLabel">{slabel}</span>
        {sub.counts[sk] != null && (
          <span className="sbSubCount">{sub.counts[sk]}</span>
        )}
      </button>
    ));
  return (
    <aside className={`sidebar${collapsed ? " slim" : ""}`}>
      <div className="sbBrand">
        <div className="sbMark serif">B</div>
        <div className="sbName serif">
          Bundle Price Manager
          <small>catalog ops</small>
        </div>
      </div>
      {groups.map(([heading, items]) => (
        <React.Fragment key={heading}>
          <div className="sbGroup">{heading}</div>
          {items.map(([k, n, hot]) => {
            const label = TAB_LABELS[k];
            const hasSub = sub && sub.under === k;
            const item = (
              <button
                className={`sbItem${tab === k ? " on" : ""}${hot && n ? " dot" : ""}`}
                onClick={(e) => {
                  onTab(k);
                  // only opens: on touch screens the tap's mouseenter has
                  // already opened it, and a toggle would shut it again.
                  // Picking a table, Escape or a click elsewhere closes it.
                  if (hasSub && collapsed) openFly(e.currentTarget.parentElement);
                }}
                title={n ? `${label} (${n})` : label}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  {NAV_ICONS[k]}
                </svg>
                <span className="sbLabel">{label}</span>
                {n ? (
                  <span className={`sbCount${hot ? " hot" : ""}`}>{n}</span>
                ) : null}
              </button>
            );
            if (!hasSub) return <React.Fragment key={k}>{item}</React.Fragment>;
            return (
              <div
                key={k}
                className="sbFlyWrap"
                onMouseEnter={collapsed ? (e) => openFly(e.currentTarget) : undefined}
                onMouseLeave={collapsed ? closeFlySoon : undefined}
              >
                {item}
                <div className="sbSub">{subButtons(k)}</div>
                {collapsed && flyTop != null && (
                  <div className="sbFly" style={{ top: flyTop }} aria-label={label}>
                    <div className="sbFlyHead">{label}</div>
                    {subButtons(k, () => setFlyTop(null))}
                  </div>
                )}
              </div>
            );
          })}
        </React.Fragment>
      ))}
      <div className="sbFoot">
        {children}
        {!narrow && (
          <button className="sbCollapse" onClick={toggle}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
            <span>{slim ? "Expand sidebar" : "Collapse sidebar"}</span>
          </button>
        )}
      </div>
    </aside>
  );
}

// page name on the left, the open tab's search in the middle and its buttons
// on the right. The tab fills those two through <InBar>, so its search state
// stays its own. "/" from anywhere jumps to the search box.
const BarSlots = React.createContext(null);
function TopBar({ crumb, title, onHeight, onSlots }) {
  const barRef = useRef(null);
  const searchRef = useRef(null);
  const actionsRef = useRef(null);
  // report the bar's height, kept current as the tab fills its slots, the
  // sidebar collapses, or the search wraps to its own row on narrow screens
  useEffect(() => {
    const el = barRef.current;
    const measure = () => onHeight(el.getBoundingClientRect().height);
    measure();
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  useEffect(() => {
    onSlots({ search: searchRef.current, actions: actionsRef.current });
    const onKey = (e) => {
      const t = e.target;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
      // not behind an open dialog or side panel
      if (document.querySelector('[aria-modal="true"]')) return;
      const box = searchRef.current && searchRef.current.querySelector("input");
      if (!box) return;
      e.preventDefault();
      box.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div ref={barRef} className="topBar">
      <div style={{ minWidth: 0 }}>
        {crumb && (
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 2.2,
              textTransform: "uppercase",
              color: "var(--brassInk)",
              marginBottom: 2,
            }}
          >
            {crumb}
          </div>
        )}
        <h1
          className="serif"
          style={{
            fontSize: 32,
            margin: 0,
            fontWeight: 600,
            lineHeight: 1.05,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </h1>
      </div>
      <div ref={searchRef} className="slotSearch" />
      <div ref={actionsRef} className="slotActions" />
    </div>
  );
}
// renders its children into the top bar's "search" or "actions" slot
function InBar({ slot, children }) {
  const slots = React.useContext(BarSlots);
  return slots && slots[slot]
    ? ReactDOM.createPortal(children, slots[slot])
    : null;
}

// in-app replacement for window.confirm — a centered modal matching the rest of
// the app's look, instead of the browser's native dialog. Escape or a backdrop
// click cancels, same as clicking Cancel.
function ConfirmModal({ title, detail, confirmLabel, danger, onClose }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={() => onClose(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(23,19,17,.45)",
        display: "grid",
        placeItems: "center",
        padding: 20,
        animation: "slideIn .15s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        style={{
          background: "var(--card)",
          borderRadius: 6,
          padding: "22px 24px",
          maxWidth: 380,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,.35)",
        }}
      >
        <h3
          className="serif"
          style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 600 }}
        >
          {title}
        </h3>
        {detail && (
          <p
            style={{
              margin: "0 0 20px",
              fontSize: 13.5,
              color: "var(--muted)",
              lineHeight: 1.5,
            }}
          >
            {detail}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={() => onClose(false)} style={btnSec}>
            Cancel
          </button>
          <button
            onClick={() => onClose(true)}
            autoFocus
            style={{
              ...btnPri,
              background: danger ? "var(--clay)" : "var(--ink)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// searches products AND bundles by name/SKU at once, so you don't have to
// know or care which tab something lives in before finding it — picking a
// result jumps straight to it there (same jump used elsewhere in the app)
function GlobalSearch({ products, bundles, onJumpToProduct, onJumpToBundle }) {
  const [q, setQ] = useState("");

  const results = useMemo(() => {
    if (!q.trim()) return [];
    const p = products
      .filter((x) => matchText(q, x.name + " " + (x.sku || "")))
      .map((x) => ({ type: "product", item: x }));
    const b = bundles
      .filter((x) => matchText(q, x.name + " " + (x.sku || "")))
      .map((x) => ({ type: "bundle", item: x }));
    return [...p, ...b].slice(0, 30);
  }, [q, products, bundles]);

  function pick(r) {
    if (r.type === "product") onJumpToProduct(r.item);
    else onJumpToBundle({ id: r.item.id, name: r.item.name });
    setQ("");
  }

  // sits in the top bar, so the results drop down over the page; a click
  // anywhere else hides them (the text stays, focusing it shows them again)
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => !boxRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div
      ref={boxRef}
      style={{ position: "relative", flex: 1, minWidth: 0, display: "flex" }}
    >
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setQ("")}
        placeholder="Search everything — products & bundles…"
        className="barSearch"
        style={barSearch}
      />
      {open && q.trim() && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            zIndex: 40,
            background: "var(--paper)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: "10px 10px 0",
            boxShadow: "0 12px 30px -12px rgba(0,0,0,.3)",
            animation: "slideIn .15s ease",
          }}
        >
          {results.length === 0 ? (
            <p style={note}>No matches.</p>
          ) : (
            <>
              <p style={note}>
                {results.length} match{results.length === 1 ? "" : "es"}
                {results.length === 30 ? " · showing first 30" : ""}
              </p>
              <div
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  overflow: "hidden",
                  maxHeight: 300,
                  overflowY: "auto",
                }}
              >
                {results.map((r) => (
                  <button
                    key={r.type + r.item.id}
                    onClick={() => pick(r)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "10px 14px",
                      background: "none",
                      border: "none",
                      borderBottom: "1px solid var(--line)",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        padding: "1px 6px",
                        borderRadius: 999,
                        color:
                          r.type === "bundle" ? "var(--amber)" : "var(--sage)",
                        border: `1px solid ${r.type === "bundle" ? "var(--amber)" : "var(--sage)"}`,
                        flexShrink: 0,
                      }}
                    >
                      {r.type}
                    </span>
                    <span style={{ fontSize: 14, flex: 1 }}>{r.item.name}</span>
                    {r.item.sku && (
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "var(--muted)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {r.item.sku}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Worklist({
  staleList,
  bundles,
  setBundles,
  flash,
  products,
  compute,
  byId,
  onDelete,
  onPromote,
  onSkip,
  pushPrice,
  onJumpToProduct,
  initialOpenBundle,
}) {
  const [view, setView] = useState("todo"); // todo | history
  // expanded row for inline editing — pre-opens the bundle jumped in from
  const [openId, setOpenId] = useState(initialOpenBundle?.id || null);
  const update = (id, patch) =>
    setBundles(bundles.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const fixOne = (b, t) =>
    setBundles(
      bundles.map((x) =>
        x.id === b.id
          ? {
              ...x,
              storedPrice: t,
              history: pushHistory(x, x.storedPrice || 0, t),
            }
          : x,
      ),
    );
  const fixAll = () => {
    const m = {};
    staleList
      .filter((x) => !x.c.missing)
      .forEach((x) => (m[x.b.id] = x.c.target));
    setBundles(
      bundles.map((b) =>
        m[b.id] != null
          ? {
              ...b,
              storedPrice: m[b.id],
              history: pushHistory(b, b.storedPrice || 0, m[b.id]),
            }
          : b,
      ),
    );
    flash(`Updated ${Object.keys(m).length} prices`);
  };
  const copyAll = () => {
    const rows = staleList
      .filter((x) => !x.c.missing)
      .map((x) => `${x.b.sku || x.b.name}\t${money(x.c.target)}`)
      .join("\n");
    navigator.clipboard?.writeText("name\tnew_price\n" + rows);
    flash("Copied to clipboard");
  };

  // flatten history across all bundles AND products, newest first
  const history = useMemo(() => {
    const all = [];
    bundles.forEach((b) =>
      (b.history || []).forEach((h) =>
        all.push({ kind: "bundle", name: b.name, sku: b.sku, ...h }),
      ),
    );
    (products || []).forEach((p) =>
      (p.history || []).forEach((h) =>
        all.push({ kind: "product", name: p.name, sku: p.sku, ...h }),
      ),
    );
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [bundles, products]);

  const Tabs = (
    <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
      {[
        [
          "todo",
          `To update${staleList.length ? ` (${staleList.length})` : ""}`,
        ],
        ["history", `History${history.length ? ` (${history.length})` : ""}`],
      ].map(([k, label]) => (
        <button
          key={k}
          onClick={() => setView(k)}
          style={{
            padding: "6px 12px",
            borderRadius: 999,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            border: `1px solid ${view === k ? "var(--ink)" : "var(--line)"}`,
            background: view === k ? "var(--ink)" : "#fff",
            color: view === k ? "var(--paper)" : "var(--muted)",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === "history")
    return (
      <div>
        {Tabs}
        {history.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: 14 }}>
            No price changes recorded yet. Product price edits and bundle price
            updates both log here.
          </p>
        ) : (
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 110px 90px 90px",
                gap: 10,
                padding: "10px 16px",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                color: "var(--muted)",
                fontWeight: 700,
                borderBottom: "1px solid var(--line)",
              }}
            >
              <span>Item</span>
              <span>When</span>
              <span style={{ textAlign: "right" }}>From</span>
              <span style={{ textAlign: "right" }}>To</span>
            </div>
            {history.map((h, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 110px 90px 90px",
                  gap: 10,
                  padding: "10px 16px",
                  alignItems: "center",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>
                  {h.name}
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      padding: "1px 6px",
                      borderRadius: 999,
                      verticalAlign: "middle",
                      whiteSpace: "nowrap",
                      color:
                        h.kind === "product" ? "var(--sage)" : "var(--amber)",
                      border: `1px solid ${h.kind === "product" ? "var(--sage)" : "var(--amber)"}`,
                    }}
                  >
                    {h.kind || "bundle"}
                  </span>
                </span>
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  {new Date(h.at).toLocaleDateString()}{" "}
                  {new Date(h.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span
                  style={{
                    textAlign: "right",
                    fontSize: 13,
                    color: "var(--muted)",
                  }}
                >
                  {money(h.from)}
                </span>
                <span
                  style={{ textAlign: "right", fontSize: 13, fontWeight: 700 }}
                >
                  {money(h.to)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );

  if (!staleList.length)
    return (
      <div>
        {Tabs}
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 999,
              background: "var(--sageDim)",
              color: "var(--sage)",
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              margin: "0 auto 14px",
            }}
          >
            ✓
          </div>
          <h2 className="serif" style={{ fontSize: 26, margin: "0 0 6px" }}>
            Everything's in sync
          </h2>
          <p
            style={{
              color: "var(--muted)",
              maxWidth: 380,
              margin: "0 auto",
              lineHeight: 1.5,
            }}
          >
            Change a product price and the affected bundles appear here with
            corrected prices.
          </p>
        </div>
      </div>
    );
  const broken = staleList.filter((x) => x.c.missing),
    priced = staleList.filter((x) => !x.c.missing);
  return (
    <div>
      {Tabs}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
          gap: 10,
        }}
      >
        <p style={{ margin: 0, fontSize: 14 }}>
          {staleList.length} bundle{staleList.length > 1 ? "s" : ""} out of
          sync.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={copyAll} style={btnSec}>
            Copy all
          </button>
          <button onClick={fixAll} style={btnPri}>
            Mark all updated
          </button>
        </div>
      </div>
      {broken.length > 0 && (
        <div
          style={{
            background: "var(--clayDim)",
            color: "var(--clay)",
            padding: "10px 14px",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          ⚠ {broken.length} bundle(s) use an inactive/missing product — fix in
          Bundles.
        </div>
      )}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            ...wlGrid,
            padding: "10px 16px",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--muted)",
            fontWeight: 700,
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span>Bundle</span>
          <span style={{ textAlign: "right" }}>Live now</span>
          <span style={{ textAlign: "right" }}>Should be</span>
          <span style={{ textAlign: "right" }}>Change</span>
          <span />
        </div>
        {priced.map(({ b, c }) => {
          const open = openId === b.id;
          return (
            <div key={b.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div
                style={{
                  ...wlGrid,
                  padding: "11px 16px",
                  alignItems: "center",
                }}
              >
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: 0,
                    font: "inherit",
                  }}
                >
                  <span
                    style={{ color: "var(--muted)", fontSize: 12, width: 10 }}
                  >
                    {open ? "▾" : "▸"}
                  </span>
                  <span>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {b.name}
                    </span>
                    {b.sku && (
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "var(--muted)",
                          marginLeft: 6,
                        }}
                      >
                        {b.sku}
                      </span>
                    )}
                  </span>
                </button>
                <span style={numCell}>{money(b.storedPrice)}</span>
                <span style={{ ...numCell, fontWeight: 700 }}>
                  {money(c.target)}
                </span>
                <span
                  style={{
                    ...numCell,
                    color: c.diff > 0 ? "var(--sage)" : "var(--clay)",
                  }}
                >
                  {c.diff > 0 ? "+" : ""}
                  {money(c.diff)}
                </span>
                <button onClick={() => fixOne(b, c.target)} style={btnFix}>
                  Mark done
                </button>
              </div>
              {open && (
                <div
                  style={{
                    background: "var(--paper)",
                    borderTop: "1px dashed var(--line)",
                    paddingTop: 12,
                  }}
                >
                  <BundleEditor
                    b={b}
                    update={update}
                    byId={byId}
                    products={products}
                    compute={compute}
                    onDelete={onDelete}
                    onPromote={onPromote}
                    onSkip={onSkip}
                    pushPrice={pushPrice}
                    onJumpToProduct={onJumpToProduct}
                  />
                </div>
              )}
            </div>
          );
        })}
        {broken.map(({ b }) => {
          const open = openId === b.id;
          return (
            <div key={b.id} style={{ borderBottom: "1px solid var(--line)" }}>
              <div
                style={{
                  ...wlGrid,
                  padding: "11px 16px",
                  alignItems: "center",
                  opacity: 0.85,
                }}
              >
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    padding: 0,
                    font: "inherit",
                  }}
                >
                  <span
                    style={{ color: "var(--muted)", fontSize: 12, width: 10 }}
                  >
                    {open ? "▾" : "▸"}
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>
                    {b.name}
                  </span>
                </button>
                <span
                  style={{
                    gridColumn: "2 / 6",
                    color: "var(--clay)",
                    fontSize: 13,
                    fontWeight: 600,
                    textAlign: "right",
                  }}
                >
                  Has a missing/inactive item — click to fix
                </span>
              </div>
              {open && (
                <div
                  style={{
                    background: "var(--paper)",
                    borderTop: "1px dashed var(--line)",
                    paddingTop: 12,
                  }}
                >
                  <BundleEditor
                    b={b}
                    update={update}
                    byId={byId}
                    products={products}
                    compute={compute}
                    onDelete={onDelete}
                    onPromote={onPromote}
                    onSkip={onSkip}
                    pushPrice={pushPrice}
                    onJumpToProduct={onJumpToProduct}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const CATS = [
  "plate",
  "bowl",
  "vase",
  "cup",
  "dinner",
  "spread",
  "setting",
  "serving",
  "gift",
  "dessert",
  "marble",
  "table",
  "lamp",
  "wall",
];
// bundles that are really just one product wearing a "bundle" hat — this
// store's marble-vase/tissue-box/tray listings, the "Diverge" vase line, and
// the "Lush" line are almost always a single component once built, not worth
// the usual per-item triage. Whole-word match so e.g. "Blush" doesn't
// false-positive on "lush".
const isSingleItemCandidate = (name) => {
  const words = norm(name).split(" ");
  return (
    words.includes("lush") ||
    words.includes("diverge") ||
    (words.includes("marble") && words.includes("vase"))
  );
};
function Bundles({
  bundles,
  setBundles,
  products,
  compute,
  byId,
  onDelete,
  onPromote,
  onSkip,
  stickyTop,
  pushPrice,
  onJumpToProduct,
  initialOpenBundle,
}) {
  const [q, setQ] = useState(initialOpenBundle?.name || "");
  const [openId, setOpenId] = useState(initialOpenBundle?.id || null);
  // all | empty | filled | oos | dup | single — jumping in needs to land on
  // "single" instead of "all" when the target bundle lives in that silo,
  // or it'd show no matches
  // opening the tab normally starts on out-of-stock; a jump stays on all/single
  const [show, setShow] = useState(() => {
    if (!initialOpenBundle) return "oos";
    const b = bundles.find((x) => x.id === initialOpenBundle.id);
    return b && isSingleItemCandidate(b.name) ? "single" : "all";
  });
  const [cat, setCat] = useState(""); // category word
  const [sortBy, setSortBy] = useState(null); // null | "name" | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = (col) =>
    sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const [visible, setVisible] = useState(60); // how many rows to show (Load more)
  const active = useMemo(() => products.filter((p) => p.active), [products]);
  // marble-vase/lush bundles are a separate silo — every other filter (all,
  // not built yet, built, out of stock, duplicate names) only ever looks at
  // "normal" bundles; they only appear once you explicitly pick their own pill.
  const normalBundles = useMemo(
    () =>
      bundles.filter(
        (b) => b.active !== false && !isSingleItemCandidate(b.name),
      ),
    [bundles],
  );
  const singleBundles = useMemo(
    () =>
      bundles.filter(
        (b) => b.active !== false && isSingleItemCandidate(b.name),
      ),
    [bundles],
  );
  const filtered = useMemo(() => {
    const pool = show === "single" ? singleBundles : normalBundles;
    return pool.filter((b) => {
      if (show === "empty" && b.items.length > 0) return false;
      if (show === "filled" && b.items.length === 0) return false;
      if (show === "oos" && !compute(b).hasOOS) return false;
      if (show === "dup" && !compute(b).dupName) return false;
      if (cat && !b.name.toLowerCase().includes(cat)) return false;
      if (!matchText(q, b.name + " " + (b.sku || ""))) return false;
      return true;
    });
  }, [normalBundles, singleBundles, products, q, show, cat]);
  const sorted = useMemo(() => {
    if (!sortBy) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortBy === "name") {
        return sortDir === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      }
      const ca = compute(a),
        cb = compute(b);
      if (sortBy === "price") {
        const av = ca.giftIncluded ? a.storedPrice || 0 : ca.target;
        const bv = cb.giftIncluded ? b.storedPrice || 0 : cb.target;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      // stock: bundles with no trackable component sink to the bottom either way
      const av = ca.stock,
        bv = cb.stock;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [filtered, products, sortBy, sortDir]);
  // reset the visible window whenever the filter set changes
  useEffect(() => {
    setVisible(60);
  }, [q, show, cat, sortBy, sortDir]);
  const shown = sorted.slice(0, visible);
  const emptyCount = useMemo(
    () => normalBundles.filter((b) => b.items.length === 0).length,
    [normalBundles],
  );
  // "Not built yet" / "Built" only mean something when both are non-zero —
  // otherwise one is empty and the other just repeats "All"
  const builtSplitUseless =
    emptyCount === 0 || emptyCount === normalBundles.length;
  const oosCount = useMemo(
    () => normalBundles.filter((b) => compute(b).hasOOS).length,
    [normalBundles, products],
  );
  const dupCount = useMemo(
    () => normalBundles.filter((b) => compute(b).dupName).length,
    [normalBundles],
  );
  const singleCount = singleBundles.length;
  // counts per category word — pills stay visible (and show their count) even at 0 matches.
  // counted within the current "show" sub-filter so the numbers reflect what you'd actually see.
  const catCounts = useMemo(() => {
    const pool = show === "single" ? singleBundles : normalBundles;
    const base = pool.filter((b) => {
      if (show === "empty" && b.items.length > 0) return false;
      if (show === "filled" && b.items.length === 0) return false;
      return true;
    });
    const m = {};
    CATS.forEach((w) => {
      m[w] = base.filter((b) => b.name.toLowerCase().includes(w)).length;
    });
    return { all: base.length, ...m };
  }, [normalBundles, singleBundles, show]);
  const update = (id, patch) =>
    setBundles(bundles.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const add = () => {
    const nb = {
      id: uid(),
      sku: "",
      name: "New bundle",
      items: [],
      storedPrice: 0,
    };
    setBundles([nb, ...bundles]);
    setOpenId(nb.id);
    setQ("");
    setShow("all"); // the new, empty bundle wouldn't show under "oos"
  };

  return (
    <div>
      <div
        style={{
          position: "sticky",
          top: stickyTop || 0,
          zIndex: 10,
          background: "var(--paper)",
          paddingTop: 2,
          paddingBottom: 6,
        }}
      >
        <InBar slot="search">
          <input
            placeholder="Search bundles…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="barSearch"
            style={barSearch}
          />
        </InBar>
        <InBar slot="actions">
          <button onClick={add} style={btnPri}>
            + New bundle
          </button>
        </InBar>
        <div
          style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}
        >
          {[
            ["all", `All (${normalBundles.length})`, false],
            ["empty", `Not built yet (${emptyCount})`, builtSplitUseless],
            ["filled", `Built (${normalBundles.length - emptyCount})`, builtSplitUseless],
            ["oos", `Out of stock (${oosCount})`, oosCount === 0],
            ["dup", `Duplicate names (${dupCount})`, dupCount === 0],
            [
              "single",
              `Marble vase / Lush / Diverge (${singleCount})`,
              singleCount === 0,
            ],
          ].map(([k, label, hideAtZero]) => {
            // status/candidate pills hide themselves when there's nothing to show —
            // no point cluttering the bar with "(0)" — but stay visible if selected
            if (hideAtZero && show !== k) return null;
            return (
              <button
                key={k}
                onClick={() => setShow(k)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${show === k ? "var(--ink)" : "var(--line)"}`,
                  background: show === k ? "var(--ink)" : "#fff",
                  color: show === k ? "var(--paper)" : "var(--muted)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button onClick={() => setCat("")} style={catPill(cat === "")}>
            All types ({catCounts.all})
          </button>
          {CATS.map((w) => {
            const n = catCounts[w] || 0;
            // hide a type pill when nothing matches it — but keep the currently
            // selected one visible so the bar doesn't jump out from under you.
            if (n === 0 && cat !== w) return null;
            return (
              <button
                key={w}
                onClick={() => setCat(cat === w ? "" : w)}
                style={catPill(cat === w)}
              >
                {w} ({n})
              </button>
            );
          })}
        </div>
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        {filtered.length} match{filtered.length === 1 ? "" : "es"}
        {filtered.length > shown.length ? ` · showing ${shown.length}` : ""}
      </p>
      {filtered.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "36px 20px",
            background: "var(--card)",
            border: "1px dashed var(--line)",
            borderRadius: 6,
            color: "var(--muted)",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 4,
            }}
          >
            No bundles match these filters
          </div>
          <div style={{ fontSize: 13, marginBottom: 14 }}>
            Try fewer words, or clear the filters to see everything.
          </div>
          <button
            onClick={() => {
              setQ("");
              setShow("all");
              setCat("");
            }}
            style={btnSec}
          >
            Clear filters
          </button>
        </div>
      )}
      {filtered.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px",
            marginBottom: 4,
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--muted)",
            fontWeight: 700,
          }}
        >
          <span style={{ width: 8, flexShrink: 0 }} />
          <span
            style={{ flex: 1, cursor: "pointer", userSelect: "none" }}
            onClick={() => toggleSort("name")}
            title="Sort by name"
          >
            Bundle{sortArrow("name")}
          </span>
          <span
            style={{
              width: 90,
              textAlign: "right",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => toggleSort("stock")}
            title="Sort by sellable stock"
          >
            Stock{sortArrow("stock")}
          </span>
          <span
            style={{
              width: 90,
              textAlign: "right",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => toggleSort("price")}
            title="Sort by price"
          >
            Price{sortArrow("price")}
          </span>
          <span style={{ width: 12, flexShrink: 0 }} />
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((b) => {
          const c = compute(b);
          const open = openId === b.id;
          return (
            <div
              key={b.id}
              style={{
                background: "var(--card)",
                border: `1px solid ${c.stale ? "var(--clay)" : "var(--line)"}`,
                borderLeft: `3px solid ${c.stale ? "var(--clay)" : "var(--sage)"}`,
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 14px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: c.empty
                        ? "var(--line)"
                        : c.stale
                          ? "var(--clay)"
                          : "var(--sage)",
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>
                    {b.name}
                    {c.dupName && (
                      <span
                        title="Another bundle has this exact same name — ambiguous for matching/syncing. Rename one of them."
                        style={{
                          marginLeft: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--amber)",
                          border: "1px solid var(--amber)",
                          borderRadius: 999,
                          padding: "1px 7px",
                          verticalAlign: "middle",
                        }}
                      >
                        dup name
                      </span>
                    )}
                    {c.hasOOS && (
                      <span
                        title={`Out of stock: ${c.oosItems.map((x) => x.product.name).join(", ")}`}
                        style={{
                          marginLeft: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--clay)",
                          border: "1px solid var(--clay)",
                          borderRadius: 999,
                          padding: "1px 7px",
                          verticalAlign: "middle",
                        }}
                      >
                        oos
                      </span>
                    )}
                    {b.giftIncluded && (
                      <span
                        title="Gift / packaging price included"
                        style={{
                          marginLeft: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--amber)",
                          border: "1px solid var(--amber)",
                          borderRadius: 999,
                          padding: "1px 7px",
                          verticalAlign: "middle",
                        }}
                      >
                        gift
                      </span>
                    )}
                    {b.skipped && (
                      <span
                        title="Skipped — kept out of the worklist"
                        style={{
                          marginLeft: 7,
                          fontSize: 11,
                          fontWeight: 700,
                          color: "var(--sage)",
                          border: "1px solid var(--sage)",
                          borderRadius: 999,
                          padding: "1px 7px",
                          verticalAlign: "middle",
                        }}
                      >
                        skipped
                      </span>
                    )}
                    {b.note && (
                      <span
                        title={b.note}
                        style={{
                          marginLeft: 6,
                          fontSize: 12,
                          color: "var(--muted)",
                          verticalAlign: "middle",
                        }}
                      >
                        ✎
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      width: 90,
                      flexShrink: 0,
                      textAlign: "right",
                      fontSize: 12.5,
                      fontWeight: 600,
                      color:
                        c.stock !== null && c.stock <= 0
                          ? "var(--clay)"
                          : "var(--muted)",
                    }}
                    title={
                      c.stock !== null
                        ? "Sellable stock — each component's stock ÷ qty needed, then the least of those"
                        : undefined
                    }
                  >
                    {!c.empty && c.stock !== null ? `${c.stock} in stock` : ""}
                  </span>
                  <span
                    style={{
                      width: 90,
                      flexShrink: 0,
                      textAlign: "right",
                      fontSize: 13,
                      color: "var(--muted)",
                    }}
                  >
                    {c.empty ? (
                      <span style={{ color: "var(--amber)" }}>
                        not built yet
                      </span>
                    ) : c.missing ? (
                      "needs item fix"
                    ) : (
                      money(c.giftIncluded ? b.storedPrice : c.target)
                    )}
                  </span>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>
                    {open ? "▾" : "▸"}
                  </span>
                </button>
                <button
                  onClick={() => onDelete(b)}
                  title="Delete bundle"
                  style={{ ...xBtn, marginRight: 10, flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
              {open && (
                <BundleEditor
                  b={b}
                  update={update}
                  byId={byId}
                  products={products}
                  compute={compute}
                  onDelete={onDelete}
                  onPromote={onPromote}
                  onSkip={onSkip}
                  pushPrice={pushPrice}
                  onJumpToProduct={onJumpToProduct}
                />
              )}
            </div>
          );
        })}
      </div>
      {filtered.length > shown.length && (
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 14 }}
        >
          <button onClick={() => setVisible((v) => v + 60)} style={btnSec}>
            Load more ({filtered.length - shown.length} more)
          </button>
        </div>
      )}
    </div>
  );
}

function BundleEditor({
  b,
  update,
  byId,
  products,
  compute,
  onDelete,
  onPromote,
  onSkip,
  pushPrice,
  onJumpToProduct,
}) {
  const c = compute(b);
  // price edits log to history; the old value is captured on focus so typing
  // doesn't create an entry per keystroke.
  const liveFocus = useRef(null);
  const logPatch = (from, to) => ({ history: pushHistory(b, from, to) });
  return (
    <div
      style={{
        padding: "0 14px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <label style={lbl}>
          Name
          <input
            value={b.name}
            onChange={(e) => update(b.id, { name: e.target.value })}
            style={inp}
          />
        </label>
        <label style={lbl}>
          Bundle SKU
          <input
            value={b.sku}
            onChange={(e) => update(b.id, { sku: e.target.value })}
            style={inp}
          />
        </label>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <QuickAdd
          products={products}
          byId={byId}
          onAdd={(productId, qty) => {
            const existing = b.items.findIndex(
              (it) => it.productId === productId,
            );
            let items;
            if (existing >= 0) {
              items = [...b.items];
              items[existing] = {
                ...items[existing],
                qty: items[existing].qty + qty,
              };
            } else items = [...b.items, { productId, qty }];
            update(b.id, { items });
          }}
        />
        {b.items.length === 0 && (
          <div
            style={{ fontSize: 13, color: "var(--muted)", fontStyle: "italic" }}
          >
            No items yet — use the bar above to add components fast.
          </div>
        )}
        {b.items.map((it, idx) => {
          const p = byId[it.productId];
          const broke = !p || !p.active;
          const oos = p && p.active && p.stockTracked && (p.stock || 0) <= 0;
          return (
            <div
              key={idx}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 0",
              }}
            >
              <input
                type="number"
                min="1"
                value={it.qty}
                onChange={(e) => {
                  const items = [...b.items];
                  items[idx] = {
                    ...it,
                    qty: Math.max(1, parseInt(e.target.value) || 1),
                  };
                  update(b.id, { items });
                }}
                style={{
                  width: 46,
                  padding: "6px",
                  borderRadius: 4,
                  border: "1px solid var(--line)",
                  fontSize: 13,
                  textAlign: "center",
                }}
              />
              <span style={{ color: "var(--muted)", fontSize: 13 }}>×</span>
              <span
                style={{
                  flex: 1,
                  fontSize: 14,
                  color: broke ? "var(--clay)" : "var(--ink)",
                }}
              >
                {p ? p.name : "(missing product)"}
                {p && onJumpToProduct && (
                  <button
                    onClick={() => onJumpToProduct(p)}
                    title={`Edit "${p.name}" in Products`}
                    style={{ ...xBtn, marginLeft: 4 }}
                  >
                    ↗
                  </button>
                )}
                {broke && p ? " (inactive)" : ""}
                {oos && (
                  <span
                    style={{
                      marginLeft: 7,
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: 0.4,
                      padding: "1px 6px",
                      borderRadius: 999,
                      verticalAlign: "middle",
                      color: "var(--clay)",
                      border: "1px solid var(--clay)",
                    }}
                  >
                    out of stock
                  </span>
                )}
              </span>
              <span
                style={{
                  width: 56,
                  textAlign: "right",
                  fontSize: 12.5,
                  color:
                    p && p.stockTracked
                      ? oos
                        ? "var(--clay)"
                        : "var(--muted)"
                      : "var(--line)",
                }}
                title={
                  p && p.stockTracked
                    ? `${p.stock} in stock`
                    : "stock not tracked"
                }
              >
                {p && p.stockTracked ? p.stock : "—"}
              </span>
              <span
                style={{
                  width: 78,
                  textAlign: "right",
                  fontSize: 13,
                  color: "var(--muted)",
                }}
              >
                {p && p.active ? money(p.price * it.qty) : "—"}
              </span>
              <button
                onClick={() =>
                  update(b.id, { items: b.items.filter((_, i) => i !== idx) })
                }
                style={xBtn}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
      <div
        style={{
          background: c.stale ? "var(--clayDim)" : "var(--sageDim)",
          borderRadius: 4,
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={vRow}>
          <span style={{ color: "var(--muted)" }}>Computed (sum of items)</span>
          <strong>{c.missing ? "—" : money(c.target)}</strong>
        </div>
        {c.stock !== null && (
          <div style={vRow}>
            <span style={{ color: "var(--muted)" }}>
              Sellable stock (stock ÷ qty, least component)
            </span>
            <strong
              style={{ color: c.stock <= 0 ? "var(--clay)" : "var(--ink)" }}
            >
              {c.stock}
            </strong>
          </div>
        )}
        <div style={vRow}>
          <span style={{ color: "var(--muted)" }}>Live on Shopify</span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="number"
              value={b.storedPrice}
              onFocus={(e) => {
                liveFocus.current = parseFloat(e.target.value) || 0;
              }}
              onChange={(e) =>
                update(b.id, { storedPrice: parseFloat(e.target.value) || 0 })
              }
              onBlur={(e) => {
                const from = liveFocus.current;
                liveFocus.current = null;
                const to = parseFloat(e.target.value) || 0;
                if (from != null && Math.abs(to - from) > 0.009)
                  update(b.id, { storedPrice: to, ...logPatch(from, to) });
              }}
              style={{
                width: 100,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--line)",
                fontSize: 14,
                textAlign: "right",
              }}
            />
            {b.shopifyVariantId && pushPrice && (
              <button
                onClick={() => pushPrice("bundle", b)}
                title="Push this price straight to your live Shopify store"
                style={{
                  background: "var(--ink)",
                  color: "var(--paper)",
                  border: "none",
                  borderRadius: 4,
                  padding: "5px 10px",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Push price to Shopify
              </button>
            )}
          </div>
        </div>
        {!c.missing && c.priceMismatch && (
          <label
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              fontSize: 13,
              cursor: "pointer",
              color: "var(--ink)",
              lineHeight: 1.4,
            }}
          >
            <input
              type="checkbox"
              checked={!!b.giftIncluded}
              onChange={(e) => update(b.id, { giftIncluded: e.target.checked })}
              style={{ marginTop: 2, cursor: "pointer" }}
            />
            <span>
              Gift / packaging price included — the live price is meant to
              differ from the item sum, so don't flag this for updating.
            </span>
          </label>
        )}
        {!c.missing && c.priceMismatch && b.giftIncluded && (
          <span style={{ color: "var(--sage)", fontWeight: 600, fontSize: 13 }}>
            ✓ In sync (gift price included, {c.diff < 0 ? "+" : "−"}
            {money(Math.abs(c.diff))} vs item sum)
          </span>
        )}
        {!c.missing && c.stale && (
          <button
            onClick={() =>
              update(b.id, {
                storedPrice: c.target,
                ...logPatch(b.storedPrice || 0, c.target),
              })
            }
            style={btnFix}
          >
            Set live → {money(c.target)}
          </button>
        )}
        {!c.stale && !c.giftIncluded && !c.skipped && (
          <span style={{ color: "var(--sage)", fontWeight: 600, fontSize: 13 }}>
            ✓ In sync
          </span>
        )}
      </div>
      <label style={{ ...lbl, marginTop: 2 }}>
        Note (optional)
        <textarea
          value={b.note || ""}
          onChange={(e) => update(b.id, { note: e.target.value })}
          placeholder="e.g. includes gift box (+₹150) · seasonal pricing · anything worth remembering"
          rows={2}
          style={{
            ...inp,
            resize: "vertical",
            fontFamily: "inherit",
            lineHeight: 1.4,
          }}
        />
      </label>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          background: b.skipped ? "var(--sageDim)" : "transparent",
          borderRadius: 4,
          padding: b.skipped ? "8px 12px" : "0",
        }}
      >
        <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.4 }}>
          {b.skipped ? (
            <span style={{ color: "var(--sage)", fontWeight: 600 }}>
              Skipped — kept out of “Needs updating”. Won't be flagged even if
              the price differs.
            </span>
          ) : (
            <span>
              Just one item + a box, or otherwise not worth syncing? Skip it to
              keep it off the worklist.
            </span>
          )}
        </div>
        <button
          onClick={() => onSkip(b, !b.skipped)}
          style={{
            ...btnSec,
            whiteSpace: "nowrap",
            ...(b.skipped
              ? { color: "var(--sage)", borderColor: "var(--sage)" }
              : {}),
          }}
        >
          {b.skipped ? "Un-skip" : "Skip this bundle"}
        </button>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
          background: b.active === false ? "var(--clayDim)" : "transparent",
          borderRadius: 4,
          padding: b.active === false ? "8px 12px" : "0",
        }}
      >
        <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.4 }}>
          {b.active === false ? (
            <span style={{ color: "var(--clay)", fontWeight: 600 }}>
              Discontinued — hidden from the main list and worklist. Find it in
              the Discontinued tab.
            </span>
          ) : (
            <span>
              No longer sold? Mark it discontinued instead of deleting — keeps
              it intact, out of your way, and restorable anytime.
            </span>
          )}
        </div>
        <button
          onClick={() => update(b.id, { active: b.active === false })}
          style={{
            ...btnSec,
            whiteSpace: "nowrap",
            ...(b.active === false
              ? { color: "var(--clay)", borderColor: "var(--clay)" }
              : {}),
          }}
        >
          {b.active === false ? "Restore" : "Mark discontinued"}
        </button>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderTop: "1px solid var(--line)",
          paddingTop: 10,
          marginTop: 2,
        }}
      >
        <button
          onClick={() => onPromote(b)}
          style={{
            background: "none",
            border: "1px solid var(--line)",
            color: "var(--muted)",
            padding: "6px 12px",
            borderRadius: 4,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
          title="This isn't a bundle — move it into the product list"
        >
          Not a bundle → move to Products
        </button>
        <button
          onClick={() => onDelete(b)}
          style={{
            background: "none",
            border: "none",
            color: "var(--clay)",
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Delete bundle
        </button>
      </div>
    </div>
  );
}

function QuickAdd({ products, byId, onAdd }) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState(1);
  const [hi, setHi] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef();

  const matches = useMemo(() => {
    if (!q.trim()) return [];
    return products
      .filter((p) => p.active && matchText(q, p.name + " " + (p.sku || "")))
      .slice(0, 8);
  }, [q, products]);

  useEffect(() => {
    setHi(0);
    setOpen(matches.length > 0);
  }, [q]);

  function commit(p) {
    if (!p) return;
    onAdd(p.id, Math.max(1, parseInt(qty) || 1));
    setQ("");
    setQty(1);
    setOpen(false);
    inputRef.current && inputRef.current.focus();
  }
  function onKey(e) {
    if (!open && e.key === "ArrowDown") {
      setOpen(matches.length > 0);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(matches[hi]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div style={{ position: "relative", marginBottom: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="number"
          min="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          title="quantity"
          style={{
            width: 52,
            padding: "9px 8px",
            borderRadius: 4,
            border: "1px solid var(--line)",
            fontSize: 14,
            textAlign: "center",
          }}
        />
        <span style={{ color: "var(--muted)", fontSize: 13 }}>×</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => setOpen(matches.length > 0)}
          placeholder="type to add a component — e.g. lunar nude plate, then Enter"
          style={{
            flex: 1,
            padding: "9px 12px",
            borderRadius: 4,
            border: "1px solid var(--clay)",
            fontSize: 14,
            background: "#fff",
          }}
        />
      </div>
      {open && matches.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 60,
            right: 0,
            zIndex: 30,
            marginTop: 4,
            background: "#fff",
            border: "1px solid var(--line)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,.12)",
            overflow: "hidden",
          }}
        >
          {matches.map((p, i) => (
            <div
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                commit(p);
              }}
              onMouseEnter={() => setHi(i)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                cursor: "pointer",
                background: i === hi ? "var(--sageDim)" : "#fff",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <span style={{ fontSize: 13.5 }}>{p.name}</span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--muted)",
                  whiteSpace: "nowrap",
                }}
              >
                {p.sku} · {money(p.price)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// products from the "Claude"/"Horizon"/"Arc"/"Pivot Marble" lines — kept as
// their own silo, same idea as the Bundles marble-vase/Lush/Diverge one, so
// they don't clutter the main product views by default.
const isMarbleAtelier = (name) => {
  const w = norm(name).split(" ");
  return (
    w.includes("claude") ||
    w.includes("horizon") ||
    w.includes("arc") ||
    (w.includes("pivot") && w.includes("marble"))
  );
};
// the Zoho Inventory page's Marble Atelier table — the Products tab's silo
// plus the Pivot stacking vases, whose names don't say "marble"
const isZohoMarble = (name) => {
  const w = norm(name).split(" ");
  return isMarbleAtelier(name) || (w.includes("pivot") && (w.includes("vase") || w.includes("vases")));
};
// the Out of stock tab's "Marble" split — wider than the Products tab's
// Marble Atelier silo: anything marble or vase, plus the Buoy coasters and
// Aura trivets
const isMarbleLine = (name) => {
  const w = norm(name).split(" ");
  return (
    isMarbleAtelier(name) ||
    ["marble", "vase", "vases", "buoy", "aura"].some((x) => w.includes(x))
  );
};
function Products({
  products,
  setProducts,
  bundles,
  onDelete,
  flash,
  stickyTop,
  pushPrice,
  initialQuery,
  onJumpToBundle,
}) {
  const [q, setQ] = useState(initialQuery || "");
  const [visible, setVisible] = useState(100);
  // all | used | unused | oos | atelier — jumping in from a bundle's
  // component needs to land on "atelier" instead of "all" when that's
  // where the target product actually lives, or it'd show no matches
  // opening the tab normally starts on out-of-stock; a jump stays on all/atelier
  const [usageFilter, setUsageFilter] = useState(() => {
    if (!initialQuery) return "oos";
    const match = products.find(
      (p) => (p.sku && p.sku === initialQuery) || p.name === initialQuery,
    );
    return match && isMarbleAtelier(match.name) ? "atelier" : "all";
  });
  const [sortBy, setSortBy] = useState(null); // null | "name" | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = (col) =>
    sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const isOOS = (p) => p.active && p.stockTracked && (p.stock || 0) <= 0;
  const normalProducts = useMemo(
    () => products.filter((p) => !isMarbleAtelier(p.name)),
    [products],
  );
  const atelierProducts = useMemo(
    () => products.filter((p) => isMarbleAtelier(p.name)),
    [products],
  );
  // product id whose bundle list is open — auto-open the jumped-to product's,
  // so "which bundles use this" is visible immediately, no extra click
  const [expanded, setExpanded] = useState(() => {
    if (!initialQuery) return null;
    const match = products.find(
      (p) => (p.sku && p.sku === initialQuery) || p.name === initialQuery,
    );
    return match ? match.id : null;
  });
  const priceFocus = useRef(null); // {id,value} captured when a price field gains focus
  // log a product price change on blur, so typing doesn't add an entry per keystroke
  const logPriceChange = (id, from, to) =>
    setProducts((cur) =>
      cur.map((p) =>
        p.id === id ? { ...p, history: pushHistory(p, from, to) } : p,
      ),
    );
  // map productId -> array of {name, sku} of bundles that use it
  const usage = useMemo(() => {
    const m = {};
    bundles.forEach((b) =>
      b.items.forEach((it) => {
        (m[it.productId] = m[it.productId] || []).push({
          id: b.id,
          name: b.name,
          sku: b.sku,
        });
      }),
    );
    return m;
  }, [bundles]);
  const usedCount = (p) => (usage[p.id] || []).length;
  const baseList = useMemo(
    () =>
      (usageFilter === "atelier" ? atelierProducts : normalProducts).filter(
        (p) => {
          if (usageFilter === "used" && usedCount(p) === 0) return false;
          if (usageFilter === "unused" && usedCount(p) > 0) return false;
          if (usageFilter === "oos" && !isOOS(p)) return false;
          if (usageFilter === "archived" && p.active) return false;
          return true;
        },
      ),
    [normalProducts, atelierProducts, usage, usageFilter],
  );
  const filtered = useMemo(() => {
    if (!q.trim()) return baseList;
    return baseList.filter((p) => matchText(q, p.name + " " + (p.sku || "")));
  }, [baseList, q]);
  const sorted = useMemo(() => {
    if (!sortBy) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortBy === "name") {
        return sortDir === "asc"
          ? a.name.localeCompare(b.name)
          : b.name.localeCompare(a.name);
      }
      if (sortBy === "price") {
        return sortDir === "asc" ? a.price - b.price : b.price - a.price;
      }
      // stock: products where Shopify isn't tracking inventory have no
      // value to sort by, so they always sink to the bottom either way
      const av = a.stockTracked ? a.stock || 0 : null;
      const bv = b.stockTracked ? b.stock || 0 : null;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [filtered, sortBy, sortDir]);
  useEffect(() => {
    setVisible(100);
  }, [q, usageFilter, sortBy, sortDir]);
  const shown = sorted.slice(0, visible);
  const update = (id, patch) =>
    setProducts(products.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = () => {
    const np = {
      id: uid(),
      sku: "",
      name: "New product",
      price: 0,
      active: true,
    };
    setProducts([np, ...products]);
    setQ("");
    setUsageFilter("all"); // the new product wouldn't show under "oos"
  };

  // counts for the filter pills
  const counts = useMemo(() => {
    let used = 0,
      unused = 0,
      oos = 0;
    normalProducts.forEach((p) => {
      usedCount(p) > 0 ? used++ : unused++;
      if (isOOS(p)) oos++;
    });
    const archived = normalProducts.filter((p) => !p.active).length;
    return {
      all: normalProducts.length,
      used,
      unused,
      oos,
      archived,
      atelier: atelierProducts.length,
    };
  }, [normalProducts, atelierProducts, usage]);

  return (
    <div>
      <div
        style={{
          position: "sticky",
          top: stickyTop || 0,
          zIndex: 10,
          background: "var(--paper)",
          paddingTop: 2,
          paddingBottom: 6,
        }}
      >
        <InBar slot="search">
          <input
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="barSearch"
            style={barSearch}
          />
        </InBar>
        <InBar slot="actions">
          <button onClick={add} style={btnPri}>
            + New product
          </button>
        </InBar>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {[
            ["all", `All (${counts.all})`, false],
            ["used", `In a bundle (${counts.used})`, false],
            ["unused", `Not in any bundle (${counts.unused})`, false],
            ["oos", `Out of stock (${counts.oos})`, counts.oos === 0],
            [
              "archived",
              `Archived (${counts.archived})`,
              counts.archived === 0,
            ],
            [
              "atelier",
              `Marble Atelier (${counts.atelier})`,
              counts.atelier === 0,
            ],
          ].map(([k, label, hideAtZero]) => {
            if (hideAtZero && usageFilter !== k) return null;
            return (
              <button
                key={k}
                onClick={() => setUsageFilter(k)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${usageFilter === k ? "var(--ink)" : "var(--line)"}`,
                  background: usageFilter === k ? "var(--ink)" : "#fff",
                  color: usageFilter === k ? "var(--paper)" : "var(--muted)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        {filtered.length} match{filtered.length === 1 ? "" : "es"}
        {filtered.length > shown.length
          ? ` · showing first ${shown.length}`
          : ""}{" "}
        · edit a price and every bundle using it updates
      </p>
      {filtered.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "36px 20px",
            background: "var(--card)",
            border: "1px dashed var(--line)",
            borderRadius: 6,
            color: "var(--muted)",
            marginBottom: 8,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 4,
            }}
          >
            {q.trim() ? `No products match “${q}”` : "No products in this view"}
          </div>
          <div style={{ fontSize: 13, marginBottom: 14 }}>
            {usageFilter !== "all"
              ? "Try the All filter, or "
              : "Try fewer words, or "}
            clear to see all {products.length} products.
          </div>
          <button
            onClick={() => {
              setQ("");
              setUsageFilter("all");
            }}
            style={btnSec}
          >
            Clear filters
          </button>
        </div>
      )}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            ...prodGrid,
            padding: "10px 14px",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--muted)",
            fontWeight: 700,
            borderBottom: "1px solid var(--line)",
          }}
        >
          <span
            style={{ cursor: "pointer", userSelect: "none" }}
            onClick={() => toggleSort("name")}
            title="Sort by name"
          >
            Product{sortArrow("name")}
          </span>
          <span>SKU</span>
          <span
            style={{
              textAlign: "right",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => toggleSort("price")}
            title="Sort by price"
          >
            Price{sortArrow("price")}
          </span>
          <span
            style={{
              textAlign: "right",
              cursor: "pointer",
              userSelect: "none",
            }}
            onClick={() => toggleSort("stock")}
            title="Sort by stock"
          >
            Stock{sortArrow("stock")}
          </span>
          <span style={{ textAlign: "center" }}>In bundles</span>
          <span style={{ textAlign: "center" }}>Active</span>
          <span />
        </div>
        {shown.map((p) => {
          const used = usage[p.id] || [];
          const isOpen = expanded === p.id;
          return (
            <div
              key={p.id}
              style={{
                borderBottom: "1px solid var(--line)",
                opacity: p.active ? 1 : 0.5,
              }}
            >
              <div
                style={{
                  ...prodGrid,
                  padding: "7px 14px",
                  alignItems: "center",
                }}
              >
                <input
                  value={p.name}
                  disabled={!p.active}
                  onChange={(e) => update(p.id, { name: e.target.value })}
                  style={{
                    border: "none",
                    background: "none",
                    fontSize: 14,
                    fontWeight: 500,
                    padding: "4px 0",
                  }}
                />
                <input
                  value={p.sku}
                  disabled={!p.active}
                  onChange={(e) => update(p.id, { sku: e.target.value })}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    padding: "5px 7px",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="number"
                    value={p.price}
                    disabled={!p.active}
                    onFocus={(e) => {
                      priceFocus.current = {
                        id: p.id,
                        value: parseFloat(e.target.value) || 0,
                      };
                    }}
                    onChange={(e) =>
                      update(p.id, { price: parseFloat(e.target.value) || 0 })
                    }
                    onBlur={(e) => {
                      const s = priceFocus.current;
                      priceFocus.current = null;
                      if (!s || s.id !== p.id) return;
                      const to = parseFloat(e.target.value) || 0;
                      if (Math.abs(to - s.value) > 0.009)
                        logPriceChange(p.id, s.value, to);
                    }}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      border: "1px solid var(--line)",
                      borderRadius: 6,
                      padding: "6px 6px",
                      fontSize: 14,
                      textAlign: "right",
                    }}
                  />
                  {p.active && p.shopifyVariantId && pushPrice && (
                    <button
                      onClick={() => pushPrice("product", p)}
                      title="Push this price straight to your live Shopify store"
                      style={{
                        border: "none",
                        background: "var(--ink)",
                        borderRadius: 6,
                        padding: "5px 7px",
                        fontSize: 11,
                        fontWeight: 600,
                        color: "var(--paper)",
                        cursor: "pointer",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      🛍️ Update
                    </button>
                  )}
                </div>
                {p.stockTracked ? (
                  <span
                    style={{
                      textAlign: "right",
                      fontSize: 13,
                      fontWeight: p.active && p.stock <= 0 ? 700 : 400,
                      color:
                        p.active && p.stock <= 0 ? "var(--clay)" : "var(--ink)",
                    }}
                  >
                    {p.stock}
                    {p.active && p.stock <= 0 ? " oos" : ""}
                  </span>
                ) : (
                  <span
                    style={{
                      textAlign: "right",
                      fontSize: 13,
                      color: "var(--line)",
                    }}
                    title="Stock not tracked in Shopify"
                  >
                    —
                  </span>
                )}
                {used.length > 0 ? (
                  <button
                    onClick={() => setExpanded(isOpen ? null : p.id)}
                    title="Show which bundles use this"
                    style={{
                      textAlign: "center",
                      fontSize: 13,
                      color: "var(--amber)",
                      fontWeight: 700,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    {used.length} {isOpen ? "▾" : "▸"}
                  </button>
                ) : (
                  <span
                    style={{
                      textAlign: "center",
                      fontSize: 13,
                      color: "var(--muted)",
                    }}
                  >
                    —
                  </span>
                )}
                <button
                  onClick={() => update(p.id, { active: !p.active })}
                  style={{
                    border: `1px solid ${p.active ? "var(--sage)" : "var(--line)"}`,
                    background: p.active ? "var(--sageDim)" : "#fff",
                    color: p.active ? "var(--sage)" : "var(--muted)",
                    borderRadius: 999,
                    padding: "5px 0",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {p.active ? "Active" : "Inactive"}
                </button>
                <button onClick={() => onDelete(p)} style={xBtn}>
                  ✕
                </button>
              </div>
              {isOpen && used.length > 0 && (
                <div
                  style={{
                    padding: "4px 14px 12px 14px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                  }}
                >
                  {used.map((u, i) => (
                    <button
                      key={i}
                      onClick={() => onJumpToBundle && onJumpToBundle(u)}
                      title={
                        onJumpToBundle
                          ? `Open "${u.name}" in Bundles`
                          : undefined
                      }
                      style={{
                        fontSize: 12.5,
                        background: "var(--sageDim)",
                        color: "var(--ink)",
                        borderRadius: 999,
                        padding: "3px 10px",
                        border: "1px solid var(--line)",
                        cursor: onJumpToBundle ? "pointer" : "default",
                      }}
                    >
                      {u.name}
                      {u.sku ? ` · ${u.sku}` : ""}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {filtered.length > shown.length && (
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 14 }}
        >
          <button onClick={() => setVisible((v) => v + 100)} style={btnSec}>
            Load more ({filtered.length - shown.length} more)
          </button>
        </div>
      )}
    </div>
  );
}

// "In bundles" — search a product, see every bundle that uses it.
// Groups results by matching product; a product with no bundles is left out.
function WhereUsed({ bundles, products, compute }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    if (!q.trim()) return null;
    return products
      .filter((p) => matchText(q, p.name + " " + (p.sku || "")))
      .map((p) => ({
        p,
        used: bundles.filter((b) =>
          b.items.some((it) => it.productId === p.id),
        ),
      }))
      .filter((x) => x.used.length > 0)
      .sort((a, b) => b.used.length - a.used.length);
  }, [q, products, bundles]);
  let totalBundles = 0;
  if (results) {
    const s = new Set();
    results.forEach((x) => x.used.forEach((b) => s.add(b.id)));
    totalBundles = s.size;
  }

  return (
    <div>
      <InBar slot="search">
        <input
          placeholder="Search a product — e.g. dot pink — to see its bundles…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="barSearch"
          style={barSearch}
        />
      </InBar>
      {!q.trim() && (
        <p style={{ ...note, marginTop: 4 }}>
          Type a product name or SKU. Every bundle that contains a matching
          product is listed below. Products that aren't in any bundle won't show
          up here.
        </p>
      )}
      {results && results.length === 0 && (
        <div
          style={{
            textAlign: "center",
            padding: "36px 20px",
            background: "var(--card)",
            border: "1px dashed var(--line)",
            borderRadius: 6,
            color: "var(--muted)",
            marginTop: 14,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--ink)",
              marginBottom: 4,
            }}
          >
            No bundle uses a product matching “{q}”
          </div>
          <div style={{ fontSize: 13 }}>
            The product may exist but isn't a component of any bundle yet.
          </div>
        </div>
      )}
      {results && results.length > 0 && (
        <p style={{ ...note, marginTop: 14 }}>
          {results.length} matching product{results.length > 1 ? "s" : ""} ·{" "}
          {totalBundles} bundle{totalBundles > 1 ? "s" : ""}
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {results &&
          results.map(({ p, used }) => (
            <div
              key={p.id}
              style={{
                background: "var(--card)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "11px 16px",
                  borderBottom: "1px solid var(--line)",
                }}
              >
                <span style={{ fontSize: 14.5, fontWeight: 700 }}>
                  {p.name}
                </span>
                {p.sku && (
                  <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                    {p.sku}
                  </span>
                )}
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 12.5,
                    color: "var(--muted)",
                  }}
                >
                  in {used.length} bundle{used.length > 1 ? "s" : ""}
                </span>
              </div>
              {used.map((b) => {
                const c = compute(b);
                const it = b.items.find((i) => i.productId === p.id);
                return (
                  <div
                    key={b.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 16px",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 999,
                        flexShrink: 0,
                        background: c.empty
                          ? "var(--line)"
                          : c.stale
                            ? "var(--clay)"
                            : "var(--sage)",
                      }}
                    />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>
                      {b.name}
                      {b.sku && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: "var(--muted)",
                            marginLeft: 6,
                          }}
                        >
                          {b.sku}
                        </span>
                      )}
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
                      qty {it ? it.qty : "—"}
                    </span>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 600,
                        minWidth: 70,
                        textAlign: "right",
                      }}
                    >
                      {c.empty
                        ? "—"
                        : money(c.giftIncluded ? b.storedPrice : c.target)}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
      </div>
    </div>
  );
}

// the docx library is only needed for the out-of-stock download, so it's
// pulled from the CDN on first use rather than on every page load
let docxLoading = null;
function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  if (!docxLoading)
    docxLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/docx@9.8.1/dist/index.umd.cjs";
      s.onload = () => resolve(window.docx);
      s.onerror = () => {
        docxLoading = null;
        reject(new Error("Couldn't load the Word export library"));
      };
      document.head.appendChild(s);
    });
  return docxLoading;
}

// one row per out-of-stock bundle (with the components that are out) and
// per out-of-stock single product (blank second column). `atelier` picks
// the marble line (see isMarbleLine) instead of everything else.
async function downloadOOSDocx(products, bundles, atelier) {
  const byId = Object.fromEntries(products.map((p) => [p.id, p]));
  const isOOS = (p) => p && p.active && p.stockTracked && (p.stock || 0) <= 0;
  const keep = (name) => isMarbleLine(name) === atelier;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const inBundleRows = new Set(); // products already named against a bundle
  const bundleRows = bundles
    .filter((b) => b.active !== false && keep(b.name))
    .map((b) => {
      const off = [
        ...new Set(b.items.map((it) => byId[it.productId]).filter(isOOS)),
      ];
      off.forEach((p) => inBundleRows.add(p.id));
      return { name: b.name, off: off.map((p) => p.name).join(", ") };
    })
    .filter((r) => r.off)
    .sort(byName);
  const productRows = products
    .filter((p) => isOOS(p) && keep(p.name) && !inBundleRows.has(p.id))
    .map((p) => ({ name: p.name, off: "" }))
    .sort(byName);

  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    HeadingLevel,
  } = await loadDocx();
  const cell = (text, bold) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
    });
  const rows = [...bundleRows, ...productRows];
  const title = `Out of stock — ${atelier ? "Marble" : "Ceramic"}`;
  const date = new Date().toISOString().slice(0, 10);
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({
            text: [
              date,
              bundleRows.length && `${bundleRows.length} bundles`,
              productRows.length && `${productRows.length} products`,
            ]
              .filter(Boolean)
              .join(" · "),
            spacing: { after: 200 },
          }),
          rows.length
            ? new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [
                  new TableRow({
                    tableHeader: true,
                    children: [cell("Name", true), cell("Out of stock", true)],
                  }),
                  ...rows.map(
                    (r) =>
                      new TableRow({ children: [cell(r.name), cell(r.off)] }),
                  ),
                ],
              })
            : new Paragraph("Nothing out of stock."),
        ],
      },
    ],
  });
  const blob = await Packer.toBlob(doc);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `out-of-stock-${atelier ? "marble" : "ceramic"}-${date}.docx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// "Out of stock" — every bundle that can't be fulfilled right now because at
// least one of its components has zero tracked stock in Shopify, and exactly
// which component(s) those are. Fed by the stock the fetch-stock script pulls in.
function StockIssues({
  oosList: allOosBundles,
  bundles,
  setBundles,
  byId,
  products,
  compute,
  onDelete,
  onPromote,
  onSkip,
  pushPrice,
  onJumpToProduct,
  onExport,
}) {
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState("main"); // main (ceramic) | atelier (marble line, see isMarbleLine)
  const [exporting, setExporting] = useState(false);
  // bundles start open; single products start collapsed to keep the scroll short
  const [openSec, setOpenSec] = useState({ bundles: true, products: false });
  // an empty section is hidden outright rather than shown as "0"
  const sectionHeader = (key, label, count) =>
    count > 0 && (
      <button
        onClick={() => setOpenSec({ ...openSec, [key]: !openSec[key] })}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 14px",
          marginTop: key === "products" && oosList.length ? 10 : 0,
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ color: "var(--muted)", fontSize: 12, width: 12 }}>
          {openSec[key] ? "▾" : "▸"}
        </span>
        <span className="serif" style={{ flex: 1, fontSize: 20 }}>
          {label}
        </span>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: "var(--clay)",
          }}
        >
          {count}
        </span>
      </button>
    );
  const update = (id, patch) =>
    setBundles(bundles.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  async function runExport() {
    setExporting(true);
    try {
      await onExport(view === "atelier");
    } catch (e) {
      alert(e.message || "Download failed");
    } finally {
      setExporting(false);
    }
  }

  // single products at zero tracked stock, each with how many live bundles
  // it's blocking — shown under the bundles so loose items aren't missed
  const allOosProducts = useMemo(() => {
    const usedIn = {};
    bundles
      .filter((b) => b.active !== false)
      .forEach((b) =>
        new Set(b.items.map((it) => it.productId)).forEach((id) => {
          usedIn[id] = (usedIn[id] || 0) + 1;
        }),
      );
    return products
      .filter((p) => p.active && p.stockTracked && (p.stock || 0) <= 0)
      .map((p) => ({ p, used: usedIn[p.id] || 0 }))
      .sort((a, b) => a.p.name.localeCompare(b.p.name));
  }, [products, bundles]);
  const inView = (name, v) => isMarbleLine(name) === (v === "atelier");
  // per view: its bundles, plus single products not already named as one
  // of those bundles' blockers (that would list the same thing twice)
  const viewLists = (v) => {
    const bs = allOosBundles.filter((x) => inView(x.b.name, v));
    const named = new Set(
      bs.flatMap(({ c }) => c.oosItems.map((x) => x.product.id)),
    );
    const ps = allOosProducts.filter(
      (x) => inView(x.p.name, v) && !named.has(x.p.id),
    );
    return [bs, ps];
  };
  const viewCount = (v) => viewLists(v).reduce((n, l) => n + l.length, 0);
  const [oosList, oosProducts] = viewLists(view);

  const toolbar = (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap",
        marginBottom: 12,
      }}
    >
      {[
        ["main", "Ceramic"],
        ["atelier", "Marble"],
      ].map(([k, label]) =>
        // a view with nothing out of stock isn't worth a pill (unless it's the one open)
        viewCount(k) === 0 && view !== k ? null : (
          <button
            key={k}
            onClick={() => {
              setView(k);
              setOpenId(null);
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${view === k ? "var(--ink)" : "var(--line)"}`,
              background: view === k ? "var(--ink)" : "#fff",
              color: view === k ? "var(--paper)" : "var(--muted)",
            }}
          >
            {label} ({viewCount(k)})
          </button>
        ),
      )}
      <span style={{ flex: 1 }} />
      <button
        onClick={runExport}
        disabled={exporting}
        title="Refreshes stock, then downloads a Word doc"
        style={{
          padding: "7px 12px",
          borderRadius: 4,
          border: "1px solid var(--line)",
          background: "var(--card)",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--ink)",
          cursor: exporting ? "default" : "pointer",
        }}
      >
        {exporting
          ? "Refreshing…"
          : view === "atelier"
            ? "⬇ Download OOS Marble (.docx)"
            : "⬇ Download OOS Ceramic (.docx)"}
      </button>
    </div>
  );

  if (!oosList.length && !oosProducts.length)
    return (
      <div>
        {toolbar}
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 6,
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 999,
              background: "var(--sageDim)",
              color: "var(--sage)",
              display: "grid",
              placeItems: "center",
              fontSize: 26,
              margin: "0 auto 14px",
            }}
          >
            ✓
          </div>
          <h2 className="serif" style={{ fontSize: 26, margin: "0 0 6px" }}>
            Nothing out of stock
          </h2>
          <p
            style={{
              color: "var(--muted)",
              maxWidth: 420,
              margin: "0 auto",
              lineHeight: 1.5,
            }}
          >
            Every product and bundle component has stock, as of the last sync.
            Run <code>npm run fetch-stock</code> (or wait for the scheduled
            check) to refresh.
          </p>
        </div>
      </div>
    );

  return (
    <div>
      {toolbar}
      {sectionHeader(
        "bundles",
        "Bundles blocked by an out-of-stock component",
        oosList.length,
      )}
      {openSec.bundles && oosList.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 6,
          }}
        >
          {oosList.map(({ b, c }) => {
            const open = openId === b.id;
            return (
              <div
                key={b.id}
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--clay)",
                  borderLeft: "3px solid var(--clay)",
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <button
                  onClick={() => setOpenId(open ? null : b.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "11px 14px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>
                    {b.name}
                    {b.sku && (
                      <span
                        style={{
                          fontSize: 11.5,
                          color: "var(--muted)",
                          marginLeft: 6,
                        }}
                      >
                        {b.sku}
                      </span>
                    )}
                  </span>
                  <span
                    style={{
                      fontSize: 13,
                      color: "var(--clay)",
                      fontWeight: 600,
                    }}
                  >
                    {c.oosItems.map((x) => x.product.name).join(", ")}
                  </span>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>
                    {open ? "▾" : "▸"}
                  </span>
                </button>
                {open && (
                  <BundleEditor
                    b={b}
                    update={update}
                    byId={byId}
                    products={products}
                    compute={compute}
                    onDelete={onDelete}
                    onPromote={onPromote}
                    onSkip={onSkip}
                    pushPrice={pushPrice}
                    onJumpToProduct={onJumpToProduct}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {sectionHeader(
        "products",
        "Single products at zero stock",
        oosProducts.length,
      )}
      {openSec.products && oosProducts.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginTop: 6,
          }}
        >
          {oosProducts.map(({ p, used }) => (
            <button
              key={p.id}
              onClick={() => onJumpToProduct(p)}
              title="Open in Products"
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "11px 14px",
                background: "var(--card)",
                border: "1px solid var(--line)",
                borderLeft: "3px solid var(--clay)",
                borderRadius: 6,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600 }}>
                {p.name}
                {p.sku && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--muted)",
                      marginLeft: 6,
                    }}
                  >
                    {p.sku}
                  </span>
                )}
              </span>
              {used > 0 && (
                <span style={{ fontSize: 12, color: "var(--muted)" }}>
                  in {used} bundle{used > 1 ? "s" : ""}
                </span>
              )}
              <span
                style={{
                  fontSize: 13,
                  color: "var(--clay)",
                  fontWeight: 700,
                }}
              >
                {p.stock || 0}
              </span>
              <span style={{ color: "var(--muted)", fontSize: 12 }}>↗</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// shared inline styles
// products/bundles marked no-longer-sold. Unlike Trash, these stay fully
// intact (price, history, bundle items) — "discontinued" just hides them
// from the active worklist/lists until restored, instead of deleting them.
function Discontinued({
  products,
  setProducts,
  bundles,
  setBundles,
  onDeleteProduct,
  onDeleteBundle,
}) {
  const discProducts = useMemo(
    () => products.filter((p) => !p.active),
    [products],
  );
  const discBundles = useMemo(
    () => bundles.filter((b) => b.active === false),
    [bundles],
  );
  const restoreProduct = (p) =>
    setProducts((cur) =>
      cur.map((x) => (x.id === p.id ? { ...x, active: true } : x)),
    );
  const restoreBundle = (b) =>
    setBundles((cur) =>
      cur.map((x) => (x.id === b.id ? { ...x, active: true } : x)),
    );

  if (!discProducts.length && !discBundles.length)
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 20px",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
        }}
      >
        <h2 className="serif" style={{ fontSize: 26, margin: "0 0 6px" }}>
          Nothing discontinued
        </h2>
        <p
          style={{
            color: "var(--muted)",
            maxWidth: 420,
            margin: "0 auto",
            lineHeight: 1.5,
          }}
        >
          Mark a product "Inactive" or a bundle "Discontinued" (from its edit
          panel) when it stops selling instead of deleting it — it'll show up
          here, still intact, restorable anytime.
        </p>
      </div>
    );

  const row = (name, sub, onRestore, onDelete) => (
    <div
      key={name + sub}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 10,
        padding: "11px 16px",
        borderBottom: "1px solid var(--line)",
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{name}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{sub}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onRestore} style={btnSec}>
          Restore
        </button>
        <button
          onClick={onDelete}
          style={{
            ...btnSec,
            color: "var(--clay)",
            borderColor: "var(--clayDim)",
          }}
        >
          Delete
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {!!discProducts.length && (
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>
            Products ({discProducts.length})
          </p>
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {discProducts.map((p) =>
              row(
                p.name,
                `${p.sku || "no SKU"} · ${money(p.price)}`,
                () => restoreProduct(p),
                () => onDeleteProduct(p),
              ),
            )}
          </div>
        </div>
      )}
      {!!discBundles.length && (
        <div>
          <p style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}>
            Bundles ({discBundles.length})
          </p>
          <div
            style={{
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {discBundles.map((b) =>
              row(
                b.name,
                `${b.sku || "no SKU"} · ${money(b.storedPrice || 0)} · ${b.items.length} item${b.items.length === 1 ? "" : "s"}`,
                () => restoreBundle(b),
                () => onDeleteBundle(b),
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Zoho Inventory items at/below their reorder level — nothing to do with the
// Shopify catalog. Numbers come from Zoho (Refresh button, or the 8-hourly
// workflow); "Expected by" and Notes are typed here and never overwritten by
// a refresh. Rows are never deleted: once an item is back above its reorder
// level it moves to "Restocked", notes intact. See lib/zohoReorder.js.
// Zoho stock per warehouse (see fetchWarehouseStock in lib/zohoReorder.js),
// split into the warehouse tables. Items are cut down to SKUs that are live
// on Shopify (active in the catalog); composites are every active one in
// Zoho; the Marble Atelier line gets its own table, out of both.
// how many rows each Zoho table holds (warehouse ones only once pulled)
function zohoTableCounts(tables, ws, below) {
  return {
    ...(ws
      ? {
          items: tables.items.length,
          composites: tables.composites.length,
          marble: tables.marble.length,
        }
      : {}),
    reorder: below,
    ceramitec: CERAMITEC_BUNDLE_SKUS.length,
  };
}

function splitWarehouseTables(ws, products) {
  const t = { items: [], composites: [], marble: [] };
  if (!ws) return t;
  const shopifySkus = new Set(
    (products || [])
      .filter((p) => p.active !== false && p.sku)
      .map((p) => normSku(p.sku)),
  );
  for (const r of ws.items)
    if (shopifySkus.has(normSku(r.sku)))
      t[isZohoMarble(r.name) ? "marble" : "items"].push(r);
  for (const r of ws.composites)
    t[isZohoMarble(r.name) ? "marble" : "composites"].push(r);
  return t;
}

// table / setTable: given when the sidebar picks the table (main app);
// without them (the /inventory page) it keeps its own and shows buttons
function Reorder({ doc, setDoc, stickyTop, flash, products, table: tableProp, setTable: setTableProp }) {
  const [q, setQ] = useState("");
  const [vendor, setVendor] = useState("Hollyhock");
  const [ownTable, setOwnTable] = useState("items"); // items | composites | marble | reorder | ceramitec
  const table = tableProp || ownTable;
  const setTable = setTableProp || setOwnTable;
  const [view, setView] = useState("below"); // reorder list filter: below | short | restocked | all
  const [sortBy, setSortBy] = useState("vendor"); // vendor | name | stock | receive | expected
  const [sortDir, setSortDir] = useState("asc");
  const [refreshing, setRefreshing] = useState(false);
  // the sticky header's height, so the warehouse tables can fill the rest of
  // the screen (it remounts when the table changes, hence a callback ref)
  const [hdrH, setHdrH] = useState(0);
  const hdrRo = useRef(null);
  const hdrRef = React.useCallback((el) => {
    if (hdrRo.current) hdrRo.current.disconnect();
    if (!el || !window.ResizeObserver) return;
    hdrRo.current = new ResizeObserver(() => setHdrH(el.offsetHeight));
    hdrRo.current.observe(el);
  }, []);
  // re-render every 30s so the cooldown countdown ticks and the button
  // re-enables on its own
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // counts from the last button press only (lastManualSyncAt) — the scheduled
  // refresh doesn't grey the button out
  const cooldownLeft = doc.lastManualSyncAt
    ? REORDER_COOLDOWN_MS - (Date.now() - new Date(doc.lastManualSyncAt).getTime())
    : 0;
  const coolingDown = cooldownLeft > 0;
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = (col) =>
    sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  const rows = useMemo(() => Object.values(doc.items || {}), [doc]);
  const inView = (r) =>
    view === "all"
      ? true
      : view === "below"
        ? r.below
        : view === "short"
          ? r.below && shortOf(r) > 0
          : !r.below;
  const vendors = useMemo(() => {
    const m = {};
    rows.filter(inView).forEach((r) => {
      const v = r.vendor || "No vendor";
      m[v] = (m[v] || 0) + 1;
    });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, view]);
  const counts = useMemo(
    () => ({
      below: rows.filter((r) => r.below).length,
      short: rows.filter((r) => r.below && shortOf(r) > 0).length,
      restocked: rows.filter((r) => !r.below).length,
      all: rows.length,
    }),
    [rows],
  );
  const shown = useMemo(() => {
    const list = rows.filter(
      (r) =>
        inView(r) &&
        (vendor === "all" || (r.vendor || "No vendor") === vendor) &&
        matchText(q, `${r.name} ${r.sku} ${r.notes || ""}`),
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const byName = (a, b) => a.name.localeCompare(b.name);
    list.sort((a, b) => {
      if (sortBy === "name") return dir * byName(a, b);
      if (sortBy === "stock")
        return dir * (a.stockOnHand - b.stockOnHand) || byName(a, b);
      if (sortBy === "receive")
        return dir * ((a.toReceive || 0) - (b.toReceive || 0)) || byName(a, b);
      if (sortBy === "short")
        return dir * (shortOf(a) - shortOf(b)) || byName(a, b);
      if (sortBy === "expected") {
        // rows with no date always sink to the bottom
        if (!a.expectedDate !== !b.expectedDate) return a.expectedDate ? -1 : 1;
        return (
          dir * (a.expectedDate || "").localeCompare(b.expectedDate || "") ||
          byName(a, b)
        );
      }
      return (
        dir * (a.vendor || "~").localeCompare(b.vendor || "~") || byName(a, b)
      );
    });
    return list;
  }, [rows, q, vendor, view, sortBy, sortDir]);

  // vendor picked no longer has rows in this view — fall back to all
  useEffect(() => {
    if (vendor !== "all" && !vendors.some(([v]) => v === vendor))
      setVendor("all");
  }, [vendors]);

  // Ceramitec ships some sets pre-packed; those are single Shopify products
  // with hand-entered stock, so their stock comes from the Shopify sync (the
  // product's `stock`), not from Zoho
  const ceramitec = useMemo(
    () =>
      CERAMITEC_BUNDLE_SKUS.map((sku) => ({
        sku,
        p: (products || []).find((x) => normSku(x.sku) === normSku(sku)),
      })).filter(
        ({ sku, p }) => matchText(q, `${p ? p.name : ""} ${sku}`),
      ),
    [products, q],
  );

  const ws = doc.warehouseStock;
  const whTables = useMemo(
    () => splitWarehouseTables(ws, products),
    [ws, products],
  );
  // Zoho's numbers for the Ceramitec sets, by SKU — most are composites, so
  // those win over a plain item with the same SKU
  const zohoBySku = useMemo(() => {
    const m = new Map();
    if (ws)
      for (const r of [...ws.composites, ...ws.items]) {
        const k = normSku(r.sku);
        if (k && !m.has(k)) m.set(k, whTotals(r, ws.warehouses));
      }
    return m;
  }, [ws]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/reorder", { method: "POST" });
      const j = await r.json();
      if (r.status === 429) {
        flash(
          `Refresh was used recently — try again in ${fmtLeft(j.retryAfterMs)}`,
        );
      } else if (!j.ok) {
        flash(`Zoho refresh failed: ${j.detail || j.error}`);
      } else {
        setDoc(j.data);
        const s = j.summary;
        flash(
          `Refreshed from Zoho · ${s.below} below reorder${s.added ? ` · ${s.added} new` : ""}`,
        );
      }
    } catch {
      flash("Zoho refresh failed — check your connection");
    }
    setRefreshing(false);
  };

  const saveRow = async (id, patch) => {
    // optimistic, so typing/picking feels instant
    setDoc((d) => ({
      ...d,
      items: { ...d.items, [id]: { ...d.items[id], ...patch } },
    }));
    try {
      const r = await fetch("/api/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setDoc((d) => ({ ...d, items: { ...d.items, [id]: j.row } }));
    } catch {
      flash("Couldn't save — check your connection and try again");
    }
  };

  // same as saveRow, for a Ceramitec bundle's hand-entered fields (by SKU)
  const saveManual = async (sku, patch) => {
    const key = sku.toUpperCase();
    setDoc((d) => ({
      ...d,
      manual: { ...(d.manual || {}), [key]: { ...(d.manual || {})[key], ...patch } },
    }));
    try {
      const r = await fetch("/api/reorder", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sku, ...patch }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setDoc((d) => ({ ...d, manual: { ...(d.manual || {}), [key]: j.row } }));
    } catch {
      flash("Couldn't save — check your connection and try again");
    }
  };

  // search/vendor and refresh go in the top bar; the sticky header holds
  // which table (only without the sidebar, which lists them), then that
  // table's own filters (passed in — the warehouse tables bring their own)
  const headerWith = (filters) => (
    <div
      ref={hdrRef}
      style={{
        position: "sticky",
        top: stickyTop || 0,
        zIndex: 10,
        background: "var(--paper)",
        paddingTop: filters ? 2 : 0,
        paddingBottom: filters ? 10 : 0,
      }}
    >
      {!tableProp && (
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
        {ZOHO_TABLES.map(([k, label]) => {
          const n = zohoTableCounts(whTables, ws, counts.below)[k];
          return (
            <button key={k} onClick={() => setTable(k)} style={tableTab(table === k)}>
              {label}
              {n != null && ` (${n})`}
            </button>
          );
        })}
      </div>
      )}
      <InBar slot="search">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={table === "reorder" ? "Search name, SKU or notes…" : "Search name or SKU…"}
          className="barSearch"
          style={barSearch}
        />
        {table === "reorder" && (
        <select
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          style={{ ...sel, padding: "10px 12px", fontSize: 14.5, borderRadius: 4 }}
        >
          <option value="all">All vendors</option>
          {vendors.map(([v, n]) => (
            <option key={v} value={v}>
              {v} ({n})
            </option>
          ))}
        </select>
        )}
      </InBar>
      <InBar slot="actions">
        <button
          onClick={refresh}
          disabled={refreshing || coolingDown}
          title={
            coolingDown
              ? `Updated ${timeAgo(doc.lastSyncAt)}. The button can be used once every 8h — available again in ${fmtLeft(cooldownLeft)}. It also refreshes on its own every 8h.`
              : "Pull the latest stock, reorder levels and open POs from Zoho. Your dates and notes are kept."
          }
          style={{
            ...btnSec,
            opacity: refreshing || coolingDown ? 0.55 : 1,
            cursor: refreshing || coolingDown ? "default" : "pointer",
          }}
        >
          {refreshing
            ? "Refreshing…"
            : coolingDown
              ? `Updated ${timeAgo(doc.lastSyncAt)} · refresh again in ${fmtLeft(cooldownLeft)}`
              : doc.lastSyncAt
                ? `Refresh from Zoho · ${timeAgo(doc.lastSyncAt)}`
                : "Refresh from Zoho"}
        </button>
      </InBar>
      {filters && (
        <div style={{ display: "flex", gap: 6, marginTop: tableProp ? 0 : 10, flexWrap: "wrap" }}>
          {filters}
        </div>
      )}
    </div>
  );
  const header = headerWith(
    [
      ["below", `Below reorder level (${counts.below})`],
      ["short", `Needs ordering (${counts.short})`],
      ["restocked", `Restocked (${counts.restocked})`],
      ["all", `All (${counts.all})`],
    ].map(([k, label]) => (
      <button
        key={k}
        onClick={() => setView(k)}
        style={{ ...catPill(view === k), textTransform: "none" }}
      >
        {label}
      </button>
    )),
  );

  if (table === "ceramitec")
    return (
      <div>
        {headerWith(null)}
        <CeramitecBundles
          rows={ceramitec}
          manual={doc.manual}
          onSave={saveManual}
          zoho={ws ? zohoBySku : null}
        />
      </div>
    );

  if (table in whTables)
    return (
      <WarehouseStock
        key={table}
        ws={ws}
        rows={whTables[table]}
        q={q}
        kind={table}
        headerWith={headerWith}
        topOffset={(stickyTop || 0) + hdrH}
      />
    );

  if (!doc.lastSyncAt)
    return (
      <div>
        {header}
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 6,
          }}
        >
          <h2 className="serif" style={{ fontSize: 26, margin: "0 0 6px" }}>
            Not pulled from Zoho yet
          </h2>
          <p
            style={{
              color: "var(--muted)",
              maxWidth: 440,
              margin: "0 auto",
              lineHeight: 1.5,
            }}
          >
            Click <b>Refresh from Zoho</b> to load every Zoho Inventory item
            that's below its reorder level, with stock on hand and what's still
            to be received on open purchase orders.
          </p>
        </div>
      </div>
    );

  // one vendor picked → every row would say the same name, so drop the column
  const showVendor = vendor === "all";
  const th = (label, col, align) => (
    <div
      onClick={col ? () => toggleSort(col) : undefined}
      style={{
        textAlign: align || "left",
        cursor: col ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {label}
      {col && sortArrow(col)}
    </div>
  );

  return (
    <div>
      {header}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: showVendor ? 1170 : 1030 }}>
          <div
            style={{
              ...reorderGrid(showVendor),
              padding: "10px 16px",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            {th("Name", "name")}
            {showVendor && th("Vendor", "vendor")}
            {th("Reorder level", null, "center")}
            {th("Stock on hand", "stock", "center")}
            {th("To be received", "receive", "center")}
            {th("Expected by", "expected")}
            {th("Notes")}
            {th("Still short", "short", "center")}
          </div>
          {!shown.length && (
            <div
              style={{
                padding: "30px 16px",
                textAlign: "center",
                color: "var(--muted)",
                fontSize: 14,
              }}
            >
              {view === "below" && !q && vendor === "all"
                ? "Nothing below its reorder level right now."
                : "No items match."}
            </div>
          )}
          {shown.map((r) => (
            <ReorderRow
              key={r.id}
              r={r}
              onSave={saveRow}
              showVendor={showVendor}
            />
          ))}
        </div>
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        {shown.length} item{shown.length === 1 ? "" : "s"} · numbers from Zoho
        Inventory (also refreshed automatically every 8 hours). "To be received"
        counts open purchase orders only. "Still short" = reorder level − stock
        on hand − to be received.
      </p>
    </div>
  );
}

// how many more to order once open POs land: reorder level − stock − incoming
const shortOf = (r) =>
  Math.max(
    0,
    (r.reorderLevel || 0) - (r.stockOnHand || 0) - (r.toReceive || 0),
  );

// "15 Oct" + a relative hint ("in 3 days" / "today" / "4 days late") for the
// Expected-by cell. Dates are plain yyyy-mm-dd, compared as local days.
function describeDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date - today) / 86400000);
  const label = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(y !== today.getFullYear() && { year: "numeric" }),
  });
  const rel =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : days > 0
          ? `in ${days} days`
          : days === -1
            ? "1 day late"
            : `${-days} days late`;
  return { label, rel, late: days < 0, days };
}

function ExpectedDateCell({ value, onChange }) {
  const ref = useRef(null);
  // the native picker opens straight from the text link — no always-visible
  // empty "dd-mm-yyyy" box on every row
  const open = () => {
    const el = ref.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
    }
  };
  const d = value ? describeDate(value) : null;
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <input
        ref={ref}
        type="date"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        tabIndex={-1}
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          width: 1,
          height: 1,
          opacity: 0,
          border: 0,
          padding: 0,
        }}
      />
      {d ? (
        <>
          <button
            onClick={open}
            title="Change date"
            style={{ ...cellLink, textAlign: "left" }}
          >
            <div
              style={{
                fontWeight: 600,
                color: d.late ? "var(--clay)" : "var(--ink)",
              }}
            >
              {d.label}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: d.late ? "var(--clay)" : "var(--muted)",
              }}
            >
              {d.rel}
            </div>
          </button>
          <button
            onClick={() => onChange("")}
            title="Clear date"
            style={{ ...xBtn, fontSize: 12 }}
          >
            ✕
          </button>
        </>
      ) : (
        <button
          onClick={open}
          style={{ ...cellLink, color: "var(--muted)", fontSize: 12.5 }}
        >
          + Add date
        </button>
      )}
    </div>
  );
}

// Ceramitec's pre-packed sets — single Shopify products, not Zoho items.
// Stock on hand is Shopify's (via the Shopify sync); to be received, expected
// date and notes are typed in here (doc.manual, keyed by SKU).
function CeramitecBundles({ rows, manual, onSave, zoho }) {
  return (
    <div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflowX: "auto",
        }}
      >
        <div style={{ minWidth: 940 }}>
          <div
            style={{
              ...ceramitecGrid,
              padding: "10px 16px",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            <div>Name</div>
            <div style={{ textAlign: "center" }}>Shopify stock</div>
            <div style={{ textAlign: "center" }} title="Available in Zoho (on hand − committed)">Zoho available</div>
            <div style={{ textAlign: "center" }}>To be received</div>
            <div>Expected by</div>
            <div>Notes</div>
          </div>
          {!rows.length && (
            <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--muted)", fontSize: 14 }}>
              No items match.
            </div>
          )}
          {rows.map(({ sku, p }) => {
            const m = (manual || {})[sku.toUpperCase()] || {};
            return (
              <div
                key={sku}
                style={{
                  ...ceramitecGrid,
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--line)",
                  alignItems: "center",
                  fontSize: 14,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: p ? "var(--ink)" : "var(--muted)" }}>
                    {p ? p.name : "Not in the catalog yet — run Sync with Shopify"}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{sku}</div>
                </div>
                <div
                  style={{
                    ...midCell,
                    fontWeight: 600,
                    color: !p || !p.stockTracked
                      ? "var(--muted)"
                      : (p.stock || 0) <= 0
                        ? "var(--clay)"
                        : p.stock < 10
                          ? "var(--amber)"
                          : "var(--sage)",
                  }}
                >
                  {!p ? "—" : p.stockTracked ? p.stock || 0 : "not tracked"}
                </div>
                <ZohoStockCell z={zoho && zoho.get(normSku(sku))} hasZoho={!!zoho} p={p} />
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <QtyCell value={m.toReceive} onSave={(v) => onSave(sku, { toReceive: v })} />
                </div>
                <ExpectedDateCell
                  value={m.expectedDate || ""}
                  onChange={(v) => onSave(sku, { expectedDate: v })}
                />
                <NotesCell value={m.notes} onSave={(v) => onSave(sku, { notes: v })} />
              </div>
            );
          })}
        </div>
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        Pre-packed Ceramitec sets, sold as single products on Shopify. Shopify
        stock is what's entered on Shopify (updated on every Shopify sync); Zoho
        available is on hand − committed in Zoho, flagged when the two
        disagree. To be received, dates and notes are filled in here.
      </p>
    </div>
  );
}

// one warehouse-stock row's totals (see fetchWarehouseStock). On hand is
// Zoho's total; rows stored before `total` was added → just the warehouses.
function whTotals(r, whs) {
  let inWarehouses = 0, committed = 0;
  for (const w of whs) {
    const [h, c] = r.byWarehouse[w.id] || [0, 0];
    inWarehouses += h;
    committed += c;
  }
  const onHand = r.total == null ? inWarehouses : r.total;
  const incoming = r.incoming || 0;
  const reorderLevel = r.reorderLevel || 0;
  // same rule as the Reorder list (see shortOf): below = on hand under the
  // reorder point; still short = what open POs don't cover
  const below = r.tracked && reorderLevel > 0 && onHand < reorderLevel;
  return {
    onHand,
    transit: onHand - inWarehouses,
    committed,
    available: onHand - committed,
    incoming,
    below,
    short: below ? Math.max(0, reorderLevel - onHand - incoming) : 0,
  };
}

// Zoho stock split by warehouse — on hand and committed per warehouse, then
// totals matching Zoho's "Accounting Stock" box. On hand is Zoho's total,
// which also counts stock on a transfer that's left one warehouse and not
// arrived at the other — shown as "in transit".
function WarehouseStock({ ws, rows, q, kind, headerWith, topOffset }) {
  const [filter, setFilter] = useState("all"); // all | oos | below | short | committed | transit
  const [sortBy, setSortBy] = useState("name"); // name | wh:<id> | transit | incoming | onHand | committed | available
  // the PO / TO opened from an Incoming / In transit cell:
  // {kind: "po" | "to", id, fromId} (fromId = the row clicked)
  const [openDoc, setOpenDoc] = useState(null);
  const onDoc = React.useCallback((kind, id, fromId) => setOpenDoc({ kind, id, fromId }), []);
  const [sortDir, setSortDir] = useState("asc");
  const whs = ws ? ws.warehouses : [];
  // typing in search stays snappy — the table catches up a beat later
  const dq = React.useDeferredValue(q);

  // hundreds of rows at once froze the page on every click / keystroke, so
  // they go in pages: the next one loads as "Show more" scrolls into view
  const [limit, setLimit] = useState(WH_PAGE);
  useEffect(() => setLimit(WH_PAGE), [filter, dq, sortBy, sortDir]);
  const moreRef = useRef(null);
  const boxRef = useRef(null); // the table's own scroll box
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !window.IntersectionObserver) return;
    const io = new IntersectionObserver((es) => {
      if (es[0].isIntersecting) setLimit((n) => n + WH_PAGE);
    }, { root: boxRef.current, rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  });

  const grid = useMemo(
    () => ({
      display: "grid",
      // … warehouses · in transit · incoming · on hand · committed · available
      // wide enough for each heading on one line ("WARE INNOVATIONS ↕")
      gridTemplateColumns: `minmax(120px,2fr) repeat(${whs.length}, minmax(128px,1fr)) ${WH_TOTALS_COLS}`,
      gap: 10,
    }),
    [whs.length],
  );

  const withTotals = useMemo(
    () => rows.map((r) => ({ ...r, ...whTotals(r, whs) })),
    [rows, whs],
  );
  // out of stock = nothing left to sell (committed can eat what's on hand)
  const isOos = (r) => r.tracked && r.available <= 0;
  const counts = useMemo(
    () => ({
      all: withTotals.length,
      oos: withTotals.filter(isOos).length,
      below: withTotals.filter((r) => r.below).length,
      short: withTotals.filter((r) => r.short > 0).length,
      committed: withTotals.filter((r) => r.committed > 0).length,
      transit: withTotals.filter((r) => r.transit !== 0).length,
    }),
    [withTotals],
  );
  const shown = useMemo(() => {
    const keep = {
      all: () => true,
      oos: isOos,
      below: (r) => r.below,
      short: (r) => r.short > 0,
      committed: (r) => r.committed > 0,
      transit: (r) => r.transit !== 0,
    }[filter];
    const list = withTotals.filter(
      (r) => keep(r) && matchText(dq, `${r.name} ${r.sku}`),
    );
    const dir = sortDir === "asc" ? 1 : -1;
    const byName = (a, b) => a.name.localeCompare(b.name);
    // "wh:<id>" sorts by that warehouse's on hand
    const val = sortBy.startsWith("wh:")
      ? (r) => (r.byWarehouse[sortBy.slice(3)] || [0])[0]
      : (r) => r[sortBy];
    list.sort((a, b) =>
      sortBy === "name"
        ? dir * byName(a, b)
        : dir * (val(a) - val(b)) || byName(a, b),
    );
    return list;
  }, [withTotals, filter, dq, sortBy, sortDir]);

  if (!ws)
    return (
      <div>
        {headerWith(null)}
        <div
          style={{
            textAlign: "center",
            padding: "60px 20px",
            background: "var(--card)",
            border: "1px solid var(--line)",
            borderRadius: 6,
            color: "var(--muted)",
            lineHeight: 1.5,
          }}
        >
          Not pulled yet — it comes in with the next <b>Refresh from Zoho</b>.
        </div>
      </div>
    );

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir(col === "name" ? "asc" : "desc");
    }
  };
  const th = (label, col, title) => (
    <div
      onClick={() => toggleSort(col)}
      title={title || (col === "name" ? "Sort A–Z" : "Click to sort — highest first, again for lowest")}
      style={{
        ...(col === "name" ? whStickyName : null),
        textAlign: col === "name" ? "left" : "center",
        whiteSpace: "nowrap",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      {label}
      {sortBy === col ? (
        sortDir === "asc" ? " ▲" : " ▼"
      ) : (
        <span style={{ opacity: 0.4 }}> ↕</span>
      )}
    </div>
  );
  // the group label over each block of columns
  const group = (label, span, color, line) => (
    <div
      style={{
        gridColumn: `span ${span}`,
        textAlign: "center",
        paddingBottom: 6,
        borderBottom: `2px solid ${line}`,
        color,
      }}
    >
      {label}
    </div>
  );
  return (
    // a touch darker grey / amber than the rest of the app: this tab is mostly
    // small numbers and labels, which the lighter shades made hard to read.
    // --plum marks transfer orders, so they don't read as POs (clay)
    <div style={{ "--muted": "#6f6658", "--amber": "#8a6112", "--plum": "#7a4a72" }}>
      {headerWith(
        <div style={whTiles}>
          {[
            ["all", "All items", "Every row in this table", "var(--ink)"],
            ["oos", "Out of stock", "Nothing left to sell", "var(--clay)"],
            ["below", "Below reorder", "On hand under the reorder point", "var(--amber)"],
            ["short", "Still short", "Even after open POs", "var(--clay)"],
            ["committed", "Has committed", "On sales orders, not shipped", "var(--amber)"],
            ["transit", "In transit", "On a transfer between warehouses", "var(--plum)"],
          ].map(([k, label, hint, color]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              aria-pressed={filter === k}
              title={hint}
              style={whTile(filter === k)}
            >
              <span style={{ fontWeight: 700, color: counts[k] ? color : "var(--muted)" }}>{counts[k]}</span>
              <span style={{ color: filter === k ? "var(--ink)" : "var(--muted)" }}>{label}</span>
            </button>
          ))}
        </div>,
      )}
      {/* scrolls on its own, filling the screen under the sticky header, so
          the column headings stay put and rows scroll from the first one */}
      <div
        ref={boxRef}
        className="noScrollbar"
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflow: "auto",
          maxHeight: `calc(var(--vh) - ${(topOffset || 0) + 16}px)`,
        }}
      >
        {/* = the grid's own minimum (columns + gaps + row padding), so it
            only scrolls sideways when the screen really is narrower */}
        <div style={{ minWidth: 120 + 472 + 6 * 10 + 32 + whs.length * 138 }}>
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: "var(--card)",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
          <div style={{ ...grid, padding: "10px 16px 0", fontSize: 10.5, letterSpacing: 1 }}>
            <div style={whStickyName} />
            {group("Stock by warehouse", whs.length, "var(--muted)", "var(--line)")}
            {group("On the way", 2, "var(--muted)", "var(--line)")}
            {group("Totals", 3, "var(--sage)", "var(--sageDim)")}
          </div>
          <div style={{ ...grid, padding: "10px 16px" }}>
            {th("Name", "name")}
            {whs.map((w) => (
              <React.Fragment key={w.id}>
                {th(w.name, `wh:${w.id}`, "On hand here, with committed (on sales orders, not shipped yet) under it — click to sort")}
              </React.Fragment>
            ))}
            {th("In transit", "transit", "On a transfer between your warehouses, not received yet — click a TO to see it — click to sort")}
            {th("Incoming", "incoming", "Still to come on open purchase orders — click a PO to see it — click to sort")}
            {th("On hand", "onHand")}
            {th("Committed", "committed")}
            {th("Available", "available")}
          </div>
          </div>
          {!shown.length && (
            <div style={{ padding: "30px 16px", textAlign: "center", color: "var(--muted)", fontSize: 14 }}>
              No items match.
            </div>
          )}
          {shown.slice(0, limit).map((r) => (
            <WarehouseRow key={r.id} r={r} whs={whs} grid={grid} pos={ws.pos} tos={ws.tos} onDoc={onDoc} />
          ))}
          {shown.length > limit && (
            <div ref={moreRef} style={{ textAlign: "center", padding: "12px 0" }}>
              <button onClick={() => setLimit((n) => n + WH_PAGE)} style={btnSec}>
                Show more ({shown.length - limit} left)
              </button>
            </div>
          )}
        </div>
      </div>
      <p style={{ ...note, marginTop: 10 }}>
        {kind === "items"
          ? "Zoho items whose SKU is live on Shopify (active in this catalog), apart from the Marble Atelier line. "
          : kind === "marble"
            ? "The Marble Atelier line (Claude, Horizon, Arc, Pivot marble and Pivot vases) — live-on-Shopify items plus any composites. "
            : "Every active composite item in Zoho, apart from the Marble Atelier line. "}
        Each warehouse shows stock on hand, with committed (on sales orders,
        not shipped yet) under it; a dash means zero. In transit is on a
        transfer between warehouses, not received yet; incoming is still to
        come on open POs (click a TO or PO number to see the whole
        order{ws.transferError ? " — TO links didn't load on the last refresh" : ""}). Under available: how short
        of the reorder point an item is after incoming, or ✓ when POs cover it.
        On hand, committed and available match
        Zoho's Accounting Stock, leaving out inactive warehouses (Studio,
        Design Office). Out of stock = nothing available. Updated with every Zoho
        refresh{ws.syncedAt ? ` · last ${timeAgo(ws.syncedAt)}` : ""}.
      </p>
      {openDoc && (
        <DocPanel
          ws={ws}
          kind={openDoc.kind}
          doc={((openDoc.kind === "to" ? ws.tos : ws.pos) || {})[openDoc.id]}
          fromId={openDoc.fromId}
          onClose={() => setOpenDoc(null)}
        />
      )}
    </div>
  );
}

// a transfer order's route, short enough for a table cell: "Aaj → Ware"
const shortRoute = (to) => `${to.from.split(" ")[0]} → ${to.to.split(" ")[0]}`;

// one open PO or in-transit TO, opened from a warehouse table's Incoming /
// In transit cell: a side panel (the table stays in view) with everything
// still to come on it
function DocPanel({ ws, kind, doc, fromId, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rowById = useMemo(() => {
    const m = new Map();
    for (const r of [...ws.items, ...ws.composites]) m.set(r.id, r);
    return m;
  }, [ws]);
  if (!doc) return null;
  const isTo = kind === "to";
  const total = doc.lines.reduce((n, l) => n + l.qty, 0);
  // TO: what's at the destination now; PO: what's available to sell now
  const nowOf = (l) => {
    const r = rowById.get(l.itemId);
    if (!r) return null;
    return isTo ? (r.byWarehouse[doc.toWarehouseId] || [0])[0] : whTotals(r, ws.warehouses).available;
  };
  const exp = !isTo && doc.expected && describeDate(doc.expected);
  const sentDays = isTo && doc.date ? -describeDate(doc.date).days : null;
  const url = isTo ? ws.toUrl : ws.poUrl;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(23,19,17,.4)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isTo ? `Transfer order ${doc.number}` : doc.number}
        style={{
          background: "var(--card)",
          width: "min(480px, 100%)",
          height: "100%",
          padding: "22px 24px",
          boxSizing: "border-box",
          overflowY: "auto",
          boxShadow: "-12px 0 40px rgba(0,0,0,.25)",
          display: "flex",
          flexDirection: "column",
          animation: "slideInRight .18s ease",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: isTo ? "var(--plum)" : "#a8401f" }}>
          {isTo ? "Transfer order · in transit" : `Purchase order${doc.status ? ` · ${doc.status.replace(/_/g, " ")}` : ""}`}
        </div>
        <h3 className="serif" style={{ margin: "2px 0 10px", fontSize: 26, fontWeight: 600 }}>
          {isTo ? `TO ${doc.number}` : doc.number}
        </h3>
        {isTo ? (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 14px",
                borderRadius: 6,
                background: "var(--paper)",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {doc.from}
              <span aria-hidden="true" style={{ color: "var(--plum)" }}>→</span>
              {doc.to}
            </div>
            <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5, marginTop: 8 }}>
              {doc.date
                ? `Sent ${describeDate(doc.date).label} · on the way ${
                    sentDays <= 0 ? "since today" : `${sentDays} day${sentDays === 1 ? "" : "s"}`
                  }`
                : "No date"}
              {" · "}left {doc.from}'s stock, not received yet
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.5 }}>
            {doc.vendor || "No vendor"}
            {doc.date && ` · ordered ${describeDate(doc.date).label}`}
            {" · "}
            {exp ? (
              <span style={{ color: exp.late ? "var(--clay)" : "var(--muted)" }}>
                expected {exp.label} ({exp.rel})
              </span>
            ) : (
              "no expected date"
            )}
          </div>
        )}
        <div style={{ fontSize: 13, margin: "14px 0 6px", fontWeight: 600 }}>
          {total} {isTo ? "on the way" : "still to come"}, {doc.lines.length} item{doc.lines.length === 1 ? "" : "s"}
        </div>
        <div style={{ border: "1px solid var(--line)", borderRadius: 6 }}>
          <div
            style={{
              ...poGrid,
              padding: "8px 12px",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            <div>Item</div>
            <div style={{ textAlign: "center" }}>{isTo ? "Moving" : "Coming"}</div>
            <div style={{ textAlign: "center" }}>
              {isTo ? `At ${doc.to.split(" ")[0]} now` : "Available now"}
            </div>
          </div>
          {doc.lines.map((l, i) => {
            const now = nowOf(l);
            return (
              <div
                key={i}
                style={{
                  ...poGrid,
                  padding: "8px 12px",
                  borderBottom: i < doc.lines.length - 1 ? "1px solid var(--line)" : "none",
                  alignItems: "center",
                  fontSize: 13.5,
                  background: l.itemId === fromId ? "var(--sageDim)" : "transparent",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{l.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{l.sku}</div>
                </div>
                <div style={{ textAlign: "center", fontWeight: 600 }}>{l.qty}</div>
                <div
                  style={{
                    textAlign: "center",
                    color: now == null ? "var(--muted)" : isTo ? whNum(now) : whAvailColor(now),
                  }}
                >
                  {now == null ? "—" : isTo ? dash(now) : now}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: "auto", paddingTop: 16 }}>
          {url && (
            <a
              href={url + doc.id}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...btnSec, textDecoration: "none", color: "var(--ink)" }}
            >
              Open in Zoho ↗
            </a>
          )}
          <button onClick={onClose} style={btnSec}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
const poGrid = { display: "grid", gridTemplateColumns: "1fr 80px 110px", gap: 10 };

const WH_PAGE = 100;
// in transit · incoming · on hand · committed · available
const WH_TOTALS_COLS = "120px 96px 76px 92px 88px";
// the filter tiles over the warehouse tables
const whTiles = { display: "flex", flexWrap: "wrap", gap: 6 };
const whTile = (on) => ({
  display: "inline-flex",
  alignItems: "baseline",
  gap: 6,
  padding: "6px 12px",
  cursor: "pointer",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 500,
  background: on ? "var(--card)" : "transparent",
  border: `1px solid ${on ? "var(--ink)" : "var(--line)"}`,
  color: "var(--ink)",
});
// 0 reads as a dash, so the real numbers stand out
const dash = (n) => (n === 0 ? "–" : n);
// a PO / TO number in a warehouse cell: a small tinted tag, clay for POs and
// plum for TOs, on a barely-there tint of the same colour
const docTag = (kind) => ({
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 600,
  lineHeight: 1.5,
  background: kind === "to" ? "#f8f1f6" : "#fbf1eb",
  color: kind === "to" ? "var(--plum)" : "#a8401f",
});
// the name stays put while the numbers scroll sideways (phones)
const whStickyName = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  background: "var(--card)",
  marginLeft: -16,
  paddingLeft: 16,
  minWidth: 0,
};
// a plain number: grey when 0, red when negative
const whNum = (n) => (n < 0 ? "var(--clay)" : n ? "var(--ink)" : "var(--muted)");
// Available: red when nothing's left to sell, amber when low, green otherwise
const whAvailColor = (n) =>
  n <= 0 ? "var(--clay)" : n < 10 ? "var(--amber)" : "var(--sage)";

// one WarehouseStock row — memo'd so a click elsewhere (a filter, the
// refresh countdown) doesn't redraw every row
const WarehouseRow = React.memo(function WarehouseRow({ r, whs, grid, pos, tos, onDoc }) {
  const poIds = (r.poIds || []).filter((id) => pos && pos[id]);
  const toIds = (r.toIds || []).filter((id) => tos && tos[id]);
  return (
    <div
      style={{
        ...grid,
        padding: "10px 16px",
        borderBottom: "1px solid var(--line)",
        alignItems: "center",
        fontSize: 14,
      }}
    >
      <div style={whStickyName}>
        <div style={{ fontWeight: 600 }}>{r.name}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{r.sku || "No SKU"}</div>
      </div>
      {whs.map((w) => {
        const [h, c] = r.byWarehouse[w.id] || [0, 0];
        return (
          <div key={w.id} style={midCell}>
            <div style={{ color: whNum(h) }}>{dash(h)}</div>
            {c !== 0 && (
              <div style={{ fontSize: 11.5, color: "var(--amber)" }} title="On sales orders, not shipped yet">{c} committed</div>
            )}
          </div>
        );
      })}
      {r.tracked ? (
        <>
          <div style={midCell}>
            <div style={{ color: r.transit > 0 ? "var(--plum)" : whNum(r.transit), fontWeight: r.transit ? 600 : 400 }}>
              {dash(r.transit)}
            </div>
            {toIds.slice(0, 2).map((id) => (
              <button
                key={id}
                onClick={() => onDoc("to", id, r.id)}
                title={`See everything on this transfer: ${tos[id].from} → ${tos[id].to}`}
                style={{ ...cellLink, padding: 0, display: "block", margin: "3px auto 0" }}
              >
                <span style={docTag("to")}>TO {tos[id].number}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 1 }}>{shortRoute(tos[id])}</span>
              </button>
            ))}
            {toIds.length > 2 && (
              <button
                onClick={() => onDoc("to", toIds[2], r.id)}
                title={toIds.slice(2).map((id) => `TO ${tos[id].number}`).join(", ")}
                style={{ ...cellLink, fontSize: 11.5, padding: 0, color: "var(--muted)" }}
              >
                +{toIds.length - 2} more
              </button>
            )}
          </div>
          <div style={midCell}>
            <div style={{ color: whNum(r.incoming), fontWeight: r.incoming ? 600 : 400 }}>{dash(r.incoming)}</div>
            {poIds.slice(0, 2).map((id) => (
              <button
                key={id}
                onClick={() => onDoc("po", id, r.id)}
                title="See everything coming on this PO"
                style={{ ...cellLink, padding: 0, display: "block", margin: "3px auto 0" }}
              >
                <span style={docTag("po")}>{pos[id].number}</span>
              </button>
            ))}
            {poIds.length > 2 && (
              <button
                onClick={() => onDoc("po", poIds[2], r.id)}
                title={poIds.slice(2).map((id) => pos[id].number).join(", ")}
                style={{ ...cellLink, fontSize: 11.5, padding: 0, color: "var(--muted)" }}
              >
                +{poIds.length - 2} more
              </button>
            )}
          </div>
          <div style={{ ...midCell, fontWeight: 600, color: whNum(r.onHand) }}>{dash(r.onHand)}</div>
          <div style={{ ...midCell, fontWeight: r.committed ? 600 : 400, color: r.committed ? "var(--amber)" : "var(--muted)" }}>
            {dash(r.committed)}
          </div>
          <div style={midCell} title={r.reorderLevel ? `Reorder point ${r.reorderLevel}` : undefined}>
            <div style={{ fontWeight: 600, color: whAvailColor(r.available) }}>{r.available}</div>
            {r.below && (
              <div style={{ fontSize: 11.5, color: r.short ? "var(--clay)" : "var(--sage)" }}>
                {r.short ? `short ${r.short}` : "✓ PO covers"}
              </div>
            )}
          </div>
        </>
      ) : (
        <div style={{ ...midCell, gridColumn: "span 5", color: "var(--muted)" }}>not tracked</div>
      )}
    </div>
  );
});

// a Ceramitec set's Zoho number, flagged when it doesn't match Shopify's
function ZohoStockCell({ z, hasZoho, p }) {
  if (!z)
    return (
      <div style={{ ...midCell, color: "var(--muted)" }}>
        {hasZoho ? "not in Zoho" : "—"}
      </div>
    );
  const differs = p && p.stockTracked && (p.stock || 0) !== z.available;
  return (
    <div
      style={midCell}
      title={`Zoho: ${z.onHand} on hand · ${z.committed} committed`}
    >
      <div style={{ fontWeight: 600, color: differs ? "var(--amber)" : "var(--ink)" }}>
        {z.available}
      </div>
      {differs && (
        <div style={{ fontSize: 11.5, color: "var(--amber)" }}>≠ Shopify</div>
      )}
    </div>
  );
}

// hand-typed quantity (e.g. Ceramitec "to be received") — reads as a number,
// box on hover/focus, saves on blur or Enter; empty clears it
function QtyCell({ value, onSave }) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const clean = draft.trim();
    if (clean === (value == null ? "" : String(value))) return;
    onSave(clean === "" ? "" : Math.max(0, Math.floor(Number(clean)) || 0));
  };
  return (
    <input
      className="cellEdit"
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
      placeholder="Add qty"
      style={{
        width: 90,
        textAlign: "center",
        fontSize: 14,
        padding: "5px 8px",
        borderRadius: 4,
        fontFamily: "inherit",
        color: "var(--ink)",
      }}
    />
  );
}

// in-table notes: reads as text, saves on blur (or Enter), not per keystroke;
// Shift+Enter = new line. Grows to fit so nothing gets cut off.
function NotesCell({ value, onSave }) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => setDraft(value || ""), [value]);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={ref}
      className="cellEdit"
      rows={1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== (value || "") && onSave(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.target.blur();
        }
      }}
      placeholder="Add a note…"
      style={{
        fontSize: 13,
        lineHeight: 1.4,
        padding: "5px 8px",
        width: "100%",
        borderRadius: 4,
        resize: "none",
        overflow: "hidden",
        fontFamily: "inherit",
        color: "var(--ink)",
      }}
    />
  );
}

function ReorderRow({ r, onSave, showVendor }) {
  // almost everything is in pcs, so the unit is only shown when it isn't
  const u = (r.unit || "").toLowerCase();
  const unit = u && u !== "pcs" ? ` ${u}` : "";
  const short = shortOf(r);
  return (
    <div
      style={{
        ...reorderGrid(showVendor),
        padding: "10px 16px",
        borderBottom: "1px solid var(--line)",
        alignItems: "center",
        fontSize: 14,
        opacity: r.missing ? 0.6 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{r.name}</div>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {r.sku || "no SKU"}
          {!!(r.openPOs || []).length &&
            ` · ${r.openPOs.map((p) => p.number).join(", ")}`}
          {r.missing && " · no longer in Zoho's reorder list"}
        </div>
      </div>
      {showVendor && (
        <div
          style={{
            fontSize: 13,
            color: r.vendor ? "var(--ink)" : "var(--muted)",
          }}
        >
          {r.vendor || "No vendor"}
        </div>
      )}
      <div style={midCell}>
        {r.reorderLevel}
        {unit}
      </div>
      <div
        style={{
          ...midCell,
          fontWeight: 600,
          color:
            r.stockOnHand <= 0
              ? "var(--clay)"
              : r.below
                ? "var(--amber)"
                : "var(--sage)",
        }}
      >
        {r.stockOnHand}
        {unit}
      </div>
      <div
        style={{
          ...midCell,
          color: r.toReceive ? "var(--ink)" : "var(--muted)",
        }}
      >
        {r.toReceive || 0}
        {unit}
      </div>
      <ExpectedDateCell
        value={r.expectedDate || ""}
        onChange={(v) => onSave(r.id, { expectedDate: v })}
      />
      <NotesCell value={r.notes} onSave={(v) => onSave(r.id, { notes: v })} />
      <div
        style={{
          ...midCell,
          fontWeight: 600,
          color: short ? "var(--clay)" : "var(--sage)",
        }}
      >
        {!r.below ? "—" : short ? `${short}${unit}` : "✓ covered"}
      </div>
    </div>
  );
}

function Trash({ trash, onRestore, onDelete, onEmpty }) {
  if (!trash.length)
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 20px",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
        }}
      >
        <h2 className="serif" style={{ fontSize: 26, margin: "0 0 6px" }}>
          Trash is empty
        </h2>
        <p
          style={{
            color: "var(--muted)",
            maxWidth: 380,
            margin: "0 auto",
            lineHeight: 1.5,
          }}
        >
          Deleted bundles and products land here. You can restore them anytime,
          or empty the trash to remove them for good.
        </p>
      </div>
    );
  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <p style={{ margin: 0, fontSize: 14 }}>
          {trash.length} deleted item{trash.length > 1 ? "s" : ""}.
        </p>
        <button
          onClick={onEmpty}
          style={{
            ...btnSec,
            color: "var(--clay)",
            borderColor: "var(--clayDim)",
          }}
        >
          Empty trash
        </button>
      </div>
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 6,
          overflow: "hidden",
        }}
      >
        {trash.map((e, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              padding: "11px 16px",
              borderBottom: "1px solid var(--line)",
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{e.item.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {e.kind} · deleted {new Date(e.at).toLocaleDateString()}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => onRestore(e)} style={btnSec}>
                Restore
              </button>
              <button
                onClick={() => onDelete(e)}
                style={{
                  ...btnSec,
                  color: "var(--clay)",
                  borderColor: "var(--clayDim)",
                }}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const btnPri = {
  background: "var(--ink)",
  color: "var(--paper)",
  border: "none",
  padding: "9px 15px",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
// Zoho Inventory's table switcher (Reorder list / Ceramitec / …) — bolder
// than catPill so it doesn't read as one more filter
const tableTab = (on) => ({
  padding: "7px 14px",
  borderRadius: 4,
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
  border: `1px solid ${on ? "var(--ink)" : "var(--line)"}`,
  background: on ? "var(--ink)" : "#fff",
  color: on ? "#fff" : "var(--ink)",
});
const catPill = (on) => ({
  padding: "4px 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textTransform: "capitalize",
  border: `1px solid ${on ? "var(--ink)" : "var(--line)"}`,
  background: on ? "var(--ink)" : "#fff",
  color: on ? "var(--paper)" : "var(--muted)",
});
const btnSec = {
  background: "#fff",
  color: "var(--ink)",
  border: "1px solid var(--line)",
  padding: "9px 15px",
  borderRadius: 4,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const btnFix = {
  background: "var(--clay)",
  color: "#fff",
  border: "none",
  padding: "7px 10px",
  borderRadius: 4,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};
const xBtn = {
  background: "none",
  border: "none",
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: 13,
  padding: 4,
};
// the top bar's search box — use with className="barSearch", which adds the
// white background with the magnifier icon
const barSearch = {
  flex: 1,
  minWidth: 0,
  padding: "10px 14px 10px 36px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  fontSize: 14.5,
};
const note = { fontSize: 12.5, color: "var(--muted)", margin: "0 0 14px" };
const lbl = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  color: "var(--muted)",
  fontWeight: 600,
};
const inp = {
  padding: "8px 10px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--ink)",
};
const sel = {
  padding: "7px 9px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  background: "#fff",
  fontSize: 13,
};
const vRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 14,
};
const wlGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 100px 100px 90px 110px",
  gap: 10,
};
const numCell = { textAlign: "right", fontSize: 14 };
// matches REFRESH_COOLDOWN_MS in lib/zohoReorder.js (the server enforces it)
const REORDER_COOLDOWN_MS = 8 * 60 * 60 * 1000;
// "45m" / "3h" / "3h 20m" for the cooldown countdown
const fmtLeft = (ms) => {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};
// name · [vendor] · reorder · stock · to receive · expected · notes · short
const reorderGrid = (showVendor) => ({
  display: "grid",
  gridTemplateColumns: `minmax(240px,2fr) ${showVendor ? "130px " : ""}90px 100px 110px 120px minmax(160px,1fr) 100px`,
  gap: 12,
});
const midCell = { textAlign: "center", fontSize: 14 };
// name · Shopify stock · Zoho available · to be received · expected · notes
const ceramitecGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(260px,2fr) 110px 110px 120px 130px minmax(200px,1.5fr)",
  gap: 12,
};
// Ceramitec sets that arrive pre-packed — shown under "Ceramitec bundles" on
// the Zoho Inventory page. Add/remove SKUs here.
const CERAMITEC_BUNDLE_SKUS = [
  "CER04TS063", // Morya Table Setting (4 Pieces)
  "CER13TS284", // Rangoli Table Setting Pink (13 Pieces)
  "CER083TS104", // Rangoli Table Settings Lilac (13 pieces)
  "CER04TS068", // Raya Table Setting (4 Pieces)
  "CER05TS047", // Heart Beat Table Setting Pink (5 Pieces)
  "CER082TS105", // Bites and Delights Lime Green
  "CER080TS102", // The Sushi Dimsum set Pink + Aqua
];
// a plain-text button used for in-cell actions ("+ Add date", a set date)
const cellLink = {
  background: "none",
  border: "none",
  padding: "2px 0",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
  lineHeight: 1.3,
};
const prodGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 120px 166px 66px 80px 84px 30px",
  gap: 8,
};

// The team's page (/inventory): just the Zoho table, none of the other tabs.
// Same site login as the main app — it hides the rest, it doesn't lock it.
function InventoryApp() {
  const [doc, setDoc] = useState(null);
  const [toast, setToast] = useState(null);
  const flash = (m) => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };
  const [headerH, setHeaderH] = useState(0);
  const [barSlots, setBarSlots] = useState(null);
  // catalog products — only for the Ceramitec bundles' Shopify stock
  const [products, setProducts] = useState([]);
  useEffect(() => {
    fetch("/api/reorder")
      .then((r) => r.json())
      .then((d) => setDoc(d && d.items ? d : { items: {}, lastSyncAt: null }))
      .catch(() => setDoc({ items: {}, lastSyncAt: null }));
    fetch("/api/data")
      .then((r) => r.json())
      .then((d) => setProducts((d && d.products) || []))
      .catch(() => {});
  }, []);
  return (
    <BarSlots.Provider value={barSlots}>
    <div className="mainPad">
      <TopBar
        crumb="Ware Innovations"
        title="Zoho Inventory"
        onHeight={setHeaderH}
        onSlots={setBarSlots}
      />
      {!doc ? (
        <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Loading…</div>
      ) : (
        <Reorder
          doc={doc}
          setDoc={setDoc}
          stickyTop={headerH}
          flash={flash}
          products={products}
        />
      )}
      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 18,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 30,
            background: "var(--ink)",
            color: "var(--paper)",
            padding: "10px 16px",
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {toast}
        </div>
      )}
    </div>
    </BarSlots.Provider>
  );
}

// inventory.html sets window.APP_VIEW = "inventory" before loading this file
ReactDOM.createRoot(document.getElementById("root")).render(
  window.APP_VIEW === "inventory" ? <InventoryApp /> : <App />,
);
