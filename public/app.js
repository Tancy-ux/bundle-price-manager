function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;

// the no-password view (/inventory): no Trash or Shopify pushes, and only prices
// can be edited in the catalog. This only tidies the screen; middleware.js and
// lib/teamRules.js enforce the limits.
const IS_TEAM = window.APP_VIEW === "team";
const money = n => isNaN(n) || n == null ? "—" : new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}).format(n);
const round2 = n => Math.round(n * 100) / 100;
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
const pushHistory = (item, from, to) => [{
  at: new Date().toISOString(),
  from,
  to
}, ...(item.history || [])].slice(0, MAX_HISTORY);

// Token search: every word in the query must appear somewhere in the haystack,
// in any order. So "plate lunar" matches "Lunar Nude Plate", and "lun pla"
// matches it too (partial words). Punctuation/extra spaces are ignored.
const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normSku = s => (s || "").trim().toLowerCase();
function matchText(query, haystack) {
  const q = norm(query);
  if (!q) return true;
  const hay = norm(haystack);
  return q.split(" ").every(w => hay.includes(w));
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
  const baseMap = new Map(baseline.map(x => [x.id, x]));
  const curMap = new Map(current.map(x => [x.id, x]));
  const upserts = [];
  curMap.forEach((item, id) => {
    const prev = baseMap.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) upserts.push(item);
  });
  const deletes = [];
  baseMap.forEach((_, id) => {
    if (!curMap.has(id)) deletes.push(id);
  });
  return {
    upserts,
    deletes
  };
}
// trash entries have no id of their own — keyed by the nested item's id
function diffTrash(baseline, current) {
  const baseMap = new Map(baseline.map(x => [x.item?.id, x]));
  const curMap = new Map(current.map(x => [x.item?.id, x]));
  const upserts = [];
  curMap.forEach((item, id) => {
    const prev = baseMap.get(id);
    if (!prev || JSON.stringify(prev) !== JSON.stringify(item)) upserts.push(item);
  });
  const deletes = [];
  baseMap.forEach((_, id) => {
    if (!curMap.has(id)) deletes.push(id);
  });
  return {
    upserts,
    deletes
  };
}
function diffSet(baseline, current) {
  const baseSet = new Set(baseline || []),
    curSet = new Set(current || []);
  return {
    added: [...curSet].filter(x => !baseSet.has(x)),
    removed: [...baseSet].filter(x => !curSet.has(x))
  };
}
const SAVE_DELAY_MS = 600;
async function apiPutDiff(diff) {
  const r = await fetch("/api/data", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(IS_TEAM ? {} : {
        "X-App-View": "admin"
      })
    },
    body: JSON.stringify(diff)
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
  const [tab, setTab] = useState("zoho");
  // which Zoho table the Stock page shows
  const [zohoTable, setZohoTable] = useState("items");
  // the switch at the top of To do and Archive
  const [todoView, setTodoView] = useState("prices");
  const [archiveView, setArchiveView] = useState("discontinued");
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
  const [reorder, setReorder] = useState({
    items: {},
    lastSyncAt: null
  });
  const firstLoad = useRef(true);
  // an edit waiting to be saved / a save on its way to the server
  const pendingSaveRef = useRef(false);
  const saveInFlightRef = useRef(false);
  // last confirmed-saved state, used to compute what actually changed —
  // see diffById/apiPutDiff above and lib/mergeData.js for why
  const baselineRef = useRef({
    products: [],
    bundles: [],
    trash: [],
    excludedSkus: [],
    excludedBundleNames: []
  });
  // the sticky top bar's height (TopBar reports it), so each tab's own
  // filter row can stick right below it instead of scrolling away
  const [headerH, setHeaderH] = useState(0);
  // per-table counts for the sidebar's Zoho Inventory list
  const zohoCounts = useMemo(() => {
    const ws = reorder.warehouseStock;
    return zohoTableCounts(splitWarehouseTables(ws, products), ws);
  }, [reorder, products]);
  useEffect(() => {
    (async () => {
      const d = await apiGet();
      const initial = {
        products: d.products || [],
        bundles: d.bundles || [],
        trash: d.trash || [],
        excludedSkus: d.excludedSkus || [],
        excludedBundleNames: d.excludedBundleNames || []
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
    fetch("/api/reorder").then(r => r.json()).then(d => d && d.items && setReorder(d)).catch(() => {});
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
    const excludedBundleNamesDiff = diffSet(baseline.excludedBundleNames, excludedBundleNames);
    const nothingChanged = !productsDiff.upserts.length && !productsDiff.deletes.length && !bundlesDiff.upserts.length && !bundlesDiff.deletes.length && !trashDiff.upserts.length && !trashDiff.deletes.length && !excludedSkusDiff.added.length && !excludedSkusDiff.removed.length && !excludedBundleNamesDiff.added.length && !excludedBundleNamesDiff.removed.length;
    if (nothingChanged) {
      pendingSaveRef.current = false;
      if (!saveInFlightRef.current) setSaving(false);
      return;
    }
    if (IS_TEAM) {
      // the price this tab last saw, so the server can refuse a change made on
      // top of a price someone else has since changed
      const seen = (list, field) => new Map(list.map(x => [x.id, x[field] || 0]));
      const productWas = seen(baseline.products, "price");
      const bundleWas = seen(baseline.bundles, "storedPrice");
      productsDiff.upserts = productsDiff.upserts.map(u => ({
        ...u,
        _was: productWas.get(u.id)
      }));
      bundlesDiff.upserts = bundlesDiff.upserts.map(u => ({
        ...u,
        _was: bundleWas.get(u.id)
      }));
    }
    let cancel = false;
    // wait for a pause in typing, so one edit is one save (and one history
    // entry), and never send a save while the last is still on its way, so
    // they can't arrive out of order
    pendingSaveRef.current = true;
    setSaving(true);
    let timer;
    const send = () => {
      if (saveInFlightRef.current) {
        timer = setTimeout(send, 250);
        return;
      }
      saveInFlightRef.current = true;
      apiPutDiff({
        productsDiff,
        bundlesDiff,
        trashDiff,
        excludedSkusDiff,
        excludedBundleNamesDiff
      }).then(res => {
        saveInFlightRef.current = false;
        if (cancel) {
          if (!pendingSaveRef.current) setSaving(false);
          return;
        }
        pendingSaveRef.current = false;
        setSaving(false);
        if (res && res.ok && res.data) {
          const d = res.data;
          const merged = {
            products: d.products || [],
            bundles: d.bundles || [],
            trash: d.trash || [],
            excludedSkus: d.excludedSkus || [],
            excludedBundleNames: d.excludedBundleNames || []
          };
          baselineRef.current = merged;
          setProducts(merged.products);
          setBundles(merged.bundles);
          setTrash(merged.trash);
          setExcludedSkus(merged.excludedSkus);
          setExcludedBundleNames(merged.excludedBundleNames);
          if (d.lastSyncAt !== undefined) setLastSyncAt(d.lastSyncAt || null);
          if (res.stale) flash("Someone changed that price just before you. The latest is shown, so change it again if needed.");
        } else if (res && res.signin) {
          // say the change wasn't kept before leaving for the sign-in page
          pendingSaveRef.current = false;
          flash("You've been signed out, so your last change wasn't saved. Taking you to sign in…");
          setTimeout(() => location.assign("/login"), 2500);
        } else if (res && res.error) {
          flash(res.error);
        }
      }).catch(() => {
        saveInFlightRef.current = false;
        if (!cancel) {
          pendingSaveRef.current = false;
          setSaving(false);
          flash("Could not save to disk — is the server running?");
        }
      });
    };
    timer = setTimeout(send, SAVE_DELAY_MS);
    return () => {
      cancel = true;
      clearTimeout(timer);
    };
  }, [products, bundles, trash, excludedSkus, excludedBundleNames, ready]);

  // closing the tab with an edit not saved yet asks first
  useEffect(() => {
    const warn = e => {
      if (!pendingSaveRef.current && !saveInFlightRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const flash = m => {
    setToast(m);
    setTimeout(() => setToast(null), 2600);
  };
  const showUndo = (label, restore) => {
    setUndo({
      label,
      restore
    });
    setTimeout(() => setUndo(u => u && u.label === label ? null : u), 6000);
  };
  // in-app replacement for window.confirm — returns a Promise<boolean>, resolved
  // when the user picks a button in <ConfirmModal/> (rendered once, below)
  const askConfirm = ({
    title,
    detail,
    confirmLabel = "Delete",
    danger = true
  }) => new Promise(resolve => setConfirmState({
    title,
    detail,
    confirmLabel,
    danger,
    resolve
  }));

  // take a full data doc from the server as the new truth
  function adoptData(d) {
    const merged = {
      products: d.products || [],
      bundles: d.bundles || [],
      trash: d.trash || [],
      excludedSkus: d.excludedSkus || [],
      excludedBundleNames: d.excludedBundleNames || []
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
  // Throttled server-side to once/2h; syncEligible below mirrors that for the UI.
  // an edit typed just before Sync or an export is saved first, so taking the
  // server's copy afterwards can't drop it
  async function waitForSave() {
    for (let i = 0; i < 50 && (pendingSaveRef.current || saveInFlightRef.current); i++) await new Promise(ok => setTimeout(ok, 100));
  }
  async function syncNow() {
    await waitForSave();
    setSyncing(true);
    try {
      const r = await fetch("/api/sync", {
        method: "POST"
      });
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
        flash([j.error || "Sync failed", j.detail].filter(Boolean).join(" — "));
        return;
      }
      adoptData(j.data);
      const s = j.summary;
      flash(`Synced: +${s.addedProducts} products, +${s.addedBundles} bundles, stock updated on ${s.stockUpdated} (${s.totalOOS} out of stock)`);
      return j.data;
    } catch (e) {
      flash("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  }
  const SYNC_COOLDOWN_MS = 2 * 60 * 60 * 1000;
  const syncEligible = !lastSyncAt || Date.now() - new Date(lastSyncAt).getTime() >= SYNC_COOLDOWN_MS;

  // out-of-stock .docx: pull the freshest stock first — a full Shopify sync
  // when the 2h cooldown allows, otherwise whatever the server has now
  // (the scheduled stock check keeps that current)
  async function exportOOS(atelier) {
    await waitForSave();
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
      confirmLabel: "Push to Shopify"
    });
    if (!ok) return;
    try {
      const r = await fetch("/api/push-price", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          kind,
          id: item.id,
          price
        })
      });
      const j = await r.json();
      if (!r.ok) {
        flash(j.error || "Push failed");
        return;
      }
      if (kind === "product") {
        setProducts(cur => cur.map(p => p.id === item.id ? j.item : p));
        baselineRef.current = {
          ...baselineRef.current,
          products: baselineRef.current.products.map(p => p.id === item.id ? j.item : p)
        };
      } else {
        setBundles(cur => cur.map(b => b.id === item.id ? j.item : b));
        baselineRef.current = {
          ...baselineRef.current,
          bundles: baselineRef.current.bundles.map(b => b.id === item.id ? j.item : b)
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
    const b = bundles.find(x => x.id === u.id);
    const isStale = b ? compute(b).stale : false;
    setBundleJumpTarget(u);
    if (isStale) setTodoView("prices");
    setTab(isStale ? "todo" : "bundles");
  }

  // deletion also excludes the item from future Shopify syncs (by SKU for
  // products, by name for bundles) so it never silently comes back. Restoring
  // (via Undo here, or from Trash) clears the exclusion again.
  const excludeSku = sku => {
    const s = normSku(sku);
    if (!s) return;
    setExcludedSkus(cur => cur.includes(s) ? cur : [...cur, s]);
  };
  const unexcludeSku = sku => {
    const s = normSku(sku);
    setExcludedSkus(cur => cur.filter(x => x !== s));
  };
  const excludeBundleName = name => {
    const n = norm(name);
    if (!n) return;
    setExcludedBundleNames(cur => cur.includes(n) ? cur : [...cur, n]);
  };
  const unexcludeBundleName = name => {
    const n = norm(name);
    setExcludedBundleNames(cur => cur.filter(x => x !== n));
  };

  // delete a bundle -> trash + undo (recoverable, so no confirm — just Undo)
  function deleteBundle(b) {
    setBundles(bundles.filter(x => x.id !== b.id));
    excludeBundleName(b.name);
    const entry = {
      kind: "bundle",
      item: b,
      at: new Date().toISOString()
    };
    setTrash(t => [entry, ...t]);
    showUndo(`Deleted "${b.name}"`, () => {
      setBundles(cur => [b, ...cur]);
      setTrash(t => t.filter(e => e !== entry));
      unexcludeBundleName(b.name);
    });
  }
  // delete a product -> trash + undo (recoverable, so no confirm — just Undo)
  function deleteProduct(p) {
    setProducts(products.filter(x => x.id !== p.id));
    // a no-SKU product would only ever come back as a re-detected bundle
    // shell (matched by name), same as a deleted bundle — exclude by name
    if (p.sku) excludeSku(p.sku);else excludeBundleName(p.name);
    const entry = {
      kind: "product",
      item: p,
      at: new Date().toISOString()
    };
    setTrash(t => [entry, ...t]);
    showUndo(`Deleted "${p.name}"`, () => {
      setProducts(cur => [p, ...cur]);
      setTrash(t => t.filter(e => e !== entry));
      if (p.sku) unexcludeSku(p.sku);else unexcludeBundleName(p.name);
    });
  }
  function restoreFromTrash(entry) {
    if (entry.kind === "bundle") {
      setBundles(cur => [entry.item, ...cur]);
      unexcludeBundleName(entry.item.name);
    } else {
      setProducts(cur => [entry.item, ...cur]);
      if (entry.item.sku) unexcludeSku(entry.item.sku);else unexcludeBundleName(entry.item.name);
    }
    setTrash(t => t.filter(e => e !== entry));
    flash("Restored");
  }
  // permanently remove a single item from Trash (not recoverable)
  async function deleteFromTrash(entry) {
    const ok = await askConfirm({
      title: `Permanently delete "${entry.item.name}"?`,
      detail: "This can't be undone.",
      confirmLabel: "Delete permanently"
    });
    if (!ok) return;
    setTrash(t => t.filter(e => e !== entry));
    flash("Deleted for good");
  }
  async function emptyTrash() {
    const ok = await askConfirm({
      title: `Permanently delete all ${trash.length} item${trash.length > 1 ? "s" : ""} in Trash?`,
      detail: "This can't be undone.",
      confirmLabel: "Empty trash"
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
      active: true
    };
    setProducts(cur => [np, ...cur]);
    setBundles(bundles.filter(x => x.id !== b.id));
    flash(`Moved "${b.name}" to Products`);
  }

  // skip / un-skip a bundle (keep it out of the worklist), with undo
  function skipBundle(b, skip) {
    setBundles(cur => cur.map(x => x.id === b.id ? {
      ...x,
      skipped: skip
    } : x));
    if (skip) showUndo(`Skipped "${b.name}"`, () => setBundles(cur => cur.map(x => x.id === b.id ? {
      ...x,
      skipped: false
    } : x)));else flash(`"${b.name}" back in the worklist`);
  }
  const byId = useMemo(() => {
    const m = {};
    (products || []).forEach(p => m[p.id] = p);
    return m;
  }, [products]);
  // bundles are matched by name (unlike products, which have SKU), so two
  // bundles sharing a name is a real ambiguity worth flagging — which one
  // does a Shopify listing / future sync actually mean?
  const bundleNameCounts = useMemo(() => {
    const m = {};
    (bundles || []).forEach(b => {
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
    b.items.forEach(it => {
      const p = byId[it.productId];
      if (!p || !p.active) missing = true;else sum += p.price * it.qty;
      // only an active product's stock counts — an inactive/discontinued item
      // is already flagged via "missing" above, not as a stock blocker
      if (p && p.active && p.stockTracked && (p.stock || 0) <= 0) oosItems.push({
        product: p,
        qty: it.qty
      });
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
    const stale = !empty && !skipped && (missing || priceMismatch && !giftIncluded);
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
      dupName
    };
  }
  if (!ready) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: "center",
      color: "var(--muted)"
    },
    className: "serif"
  }, "Loading from disk\u2026");
  const staleList = bundles.filter(b => b.active !== false).map(b => ({
    b,
    c: compute(b)
  })).filter(x => x.c.stale);
  const oosList = bundles.filter(b => b.active !== false).map(b => ({
    b,
    c: compute(b)
  })).filter(x => x.c.hasOOS).sort((a, b) => a.b.name.localeCompare(b.b.name));
  const discontinuedCount = products.filter(p => !p.active).length + bundles.filter(b => b.active === false).length;
  // freshest stock check across all products, for the "synced" indicator
  const stockUpdatedAt = products.reduce((max, p) => p.stockUpdatedAt && p.stockUpdatedAt > (max || "") ? p.stockUpdatedAt : max, null);
  const openTab = k => {
    setTab(k);
    if (k === "products") setProductJumpQuery("");
    if (k === "todo" || k === "bundles") setBundleJumpTarget(null);
  };
  const pageTitle = TAB_LABELS[tab];
  // items at or below their reorder level, for the Reorder list tab
  const belowCount = Object.values(reorder.items || {}).filter(r => r.below).length;
  return /*#__PURE__*/React.createElement("div", {
    className: "shell"
  }, /*#__PURE__*/React.createElement(Sidebar, {
    tab: tab,
    onTab: openTab,
    groups: [["Inventory", [["zoho"], ...(IS_TEAM ? [] : [["sales"]])]], ["Catalog", [["products"], ["bundles"]]], ["Upkeep", [["todo", staleList.length + oosList.length, true], ["archive"]]]]
  }, /*#__PURE__*/React.createElement("div", {
    className: "sbStats"
  }, /*#__PURE__*/React.createElement("b", null, products.length), " products \xB7 ", /*#__PURE__*/React.createElement("b", null, bundles.length), " bundles", /*#__PURE__*/React.createElement("div", {
    className: saving ? "busy" : "ok"
  }, saving ? "saving…" : "saved ✓"), /*#__PURE__*/React.createElement("div", null, "stock", " ", stockUpdatedAt ? `synced ${timeAgo(stockUpdatedAt)}` : "never synced")), /*#__PURE__*/React.createElement("button", {
    className: "sbSync",
    onClick: syncNow,
    disabled: syncing || !syncEligible,
    title: !syncEligible ? `Last synced ${timeAgo(lastSyncAt)} — available once every 2h` : "Pull new products, new bundle shells, and refresh stock from Shopify"
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M18 3v4h-4M6 21v-4h4"
  })), /*#__PURE__*/React.createElement("span", null, syncing ? "Syncing…" : lastSyncAt ? `Shopify · synced ${timeAgo(lastSyncAt)}` : "Sync with Shopify")), IS_TEAM && /*#__PURE__*/React.createElement("button", {
    className: "sbSync",
    title: "Admin sign in",
    onClick: () => location.assign("/login")
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M14 4h5v16h-5M4 12h11M11 8l4 4-4 4"
  })), /*#__PURE__*/React.createElement("span", null, "Admin sign in")), !IS_TEAM && location.protocol === "https:" && /*#__PURE__*/React.createElement("button", {
    className: "sbSync",
    title: "Sign out",
    onClick: async () => {
      await fetch("/api/logout", {
        method: "POST"
      }).catch(() => {});
      location.replace("/login");
    }
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M10 4H5v16h5M9 12h11M16 8l4 4-4 4"
  })), /*#__PURE__*/React.createElement("span", null, "Sign out"))), /*#__PURE__*/React.createElement("main", {
    className: "noScrollbar mainPad",
    style: {
      flex: 1,
      minWidth: 0,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement(BarSlots.Provider, {
    value: barSlots
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(TopBar, {
    crumb: tab === "zoho" || tab === "sales" ? "Zoho Inventory" : null,
    title: pageTitle,
    onHeight: setHeaderH,
    onSlots: setBarSlots
  }), !["bundles", "products", "zoho", "sales"].includes(tab) && /*#__PURE__*/React.createElement(InBar, {
    slot: "search",
    key: "search:" + tab
  }, /*#__PURE__*/React.createElement(GlobalSearch, {
    products: products,
    bundles: bundles,
    onJumpToProduct: jumpToProduct,
    onJumpToBundle: jumpToBundle
  })), /*#__PURE__*/React.createElement("div", {
    key: tab,
    style: {
      animation: "fadeIn .18s ease"
    }
  }, toast && /*#__PURE__*/React.createElement("div", {
    style: {
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
      animation: "slideIn .2s ease"
    }
  }, toast), undo && /*#__PURE__*/React.createElement("div", {
    style: {
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
      animation: "slideIn .2s ease"
    }
  }, /*#__PURE__*/React.createElement("span", null, undo.label), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      undo.restore();
      setUndo(null);
    },
    style: {
      background: "var(--clay)",
      color: "#fff",
      border: "none",
      padding: "6px 12px",
      borderRadius: 4,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Undo")), confirmState && /*#__PURE__*/React.createElement(ConfirmModal, _extends({}, confirmState, {
    onClose: result => {
      confirmState.resolve(result);
      setConfirmState(null);
    }
  })), tab === "todo" && /*#__PURE__*/React.createElement(PageSwitch, {
    value: todoView,
    onChange: setTodoView,
    options: [["prices", `Prices to update (${staleList.length})`], ["stock", `Out of stock (${oosList.length})`]]
  }), tab === "todo" && todoView === "prices" && /*#__PURE__*/React.createElement(Worklist, {
    staleList: staleList,
    bundles: bundles,
    setBundles: setBundles,
    flash: flash,
    products: products,
    compute: compute,
    byId: byId,
    onDelete: deleteBundle,
    onPromote: promoteToProduct,
    onSkip: skipBundle,
    pushPrice: IS_TEAM ? null : pushPriceToShopify,
    onJumpToProduct: jumpToProduct,
    initialOpenBundle: bundleJumpTarget
  }), tab === "bundles" && /*#__PURE__*/React.createElement(Bundles, {
    bundles: bundles,
    setBundles: setBundles,
    products: products,
    compute: compute,
    byId: byId,
    onDelete: deleteBundle,
    onPromote: promoteToProduct,
    onSkip: skipBundle,
    stickyTop: headerH,
    pushPrice: IS_TEAM ? null : pushPriceToShopify,
    onJumpToProduct: jumpToProduct,
    initialOpenBundle: bundleJumpTarget
  }), tab === "products" && /*#__PURE__*/React.createElement(Products, {
    products: products,
    setProducts: setProducts,
    bundles: bundles,
    onDelete: deleteProduct,
    flash: flash,
    stickyTop: headerH,
    pushPrice: IS_TEAM ? null : pushPriceToShopify,
    initialQuery: productJumpQuery,
    onJumpToBundle: jumpToBundle
  }), tab === "todo" && todoView === "stock" && /*#__PURE__*/React.createElement(StockIssues, {
    oosList: oosList,
    bundles: bundles,
    setBundles: setBundles,
    byId: byId,
    products: products,
    compute: compute,
    onDelete: deleteBundle,
    onPromote: promoteToProduct,
    onSkip: skipBundle,
    pushPrice: IS_TEAM ? null : pushPriceToShopify,
    onJumpToProduct: jumpToProduct,
    onExport: exportOOS
  }), tab === "archive" && !IS_TEAM && /*#__PURE__*/React.createElement(PageSwitch, {
    value: archiveView,
    onChange: setArchiveView,
    options: [["discontinued", `Discontinued (${discontinuedCount})`], ["trash", `Trash (${trash.length})`]]
  }), tab === "archive" && (IS_TEAM || archiveView === "discontinued") && /*#__PURE__*/React.createElement(Discontinued, {
    products: products,
    setProducts: setProducts,
    bundles: bundles,
    setBundles: setBundles,
    onDeleteProduct: deleteProduct,
    onDeleteBundle: deleteBundle
  }), tab === "zoho" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(PageSwitch, {
    value: zohoTable,
    onChange: setZohoTable,
    options: ZOHO_TABLES.map(([k, label]) => {
      const n = k === "reorder" ? belowCount : zohoCounts[k];
      return [k, n != null ? `${label} (${n})` : label];
    })
  }), /*#__PURE__*/React.createElement(Reorder, {
    key: zohoTable,
    doc: reorder,
    setDoc: setReorder,
    table: zohoTable,
    stickyTop: headerH,
    flash: flash,
    products: products
  })), tab === "sales" && !IS_TEAM && /*#__PURE__*/React.createElement(Reorder, {
    doc: reorder,
    setDoc: setReorder,
    table: "sales",
    stickyTop: headerH,
    flash: flash,
    products: products
  }), tab === "archive" && !IS_TEAM && archiveView === "trash" && /*#__PURE__*/React.createElement(Trash, {
    trash: trash,
    onRestore: restoreFromTrash,
    onDelete: deleteFromTrash,
    onEmpty: emptyTrash
  }))))));
}

// the Stock page's tables, picked with the switch at its top
const ZOHO_TABLES = [["items", "Items by warehouse"], ["composites", "Composite items"], ["marble", "Marble Atelier"], ["ceramitec", "Ceramitec bundles"], ["reorder", "Reorder list"]];

// picks what a page shows. Underlined tabs, so it doesn't read as one more
// row of filter pills (same look on every page)
function PageSwitch({
  options,
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    style: {
      display: "flex",
      gap: 20,
      flexWrap: "wrap",
      borderBottom: "1px solid var(--line)",
      marginBottom: 14
    }
  }, options.map(([k, label]) => {
    const on = value === k;
    return /*#__PURE__*/React.createElement("button", {
      key: k,
      role: "tab",
      "aria-selected": on,
      onClick: () => onChange(k),
      style: {
        background: "none",
        border: "none",
        borderBottom: `2px solid ${on ? "var(--ink)" : "transparent"}`,
        marginBottom: -1,
        padding: "6px 1px 9px",
        fontSize: 14,
        fontWeight: on ? 700 : 500,
        color: on ? "var(--ink)" : "var(--muted)",
        cursor: "pointer"
      }
    }, label);
  }));
}

// each tab's name: in the sidebar and as the page title
const TAB_LABELS = {
  zoho: "Stock",
  sales: "Sales",
  products: "Products",
  bundles: "Bundles",
  todo: "To do",
  archive: "Archive"
};
const NAV_ICONS = {
  zoho: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: "M3 8l9-5 9 5v8l-9 5-9-5z"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M3 8l9 5 9-5M12 13v8"
  })),
  sales: /*#__PURE__*/React.createElement("path", {
    d: "M4 20V11M10 20V5M16 20v-6M2 20h20"
  }),
  products: /*#__PURE__*/React.createElement("path", {
    d: "M4 7h16M4 12h16M4 17h10"
  }),
  bundles: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "3",
    width: "8",
    height: "8",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "13",
    y: "3",
    width: "8",
    height: "8",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "13",
    width: "8",
    height: "8",
    rx: "1.5"
  }), /*#__PURE__*/React.createElement("rect", {
    x: "13",
    y: "13",
    width: "8",
    height: "8",
    rx: "1.5"
  })),
  todo: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
    cx: "12",
    cy: "12",
    r: "9"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M8 12l3 3 5-6"
  })),
  archive: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
    x: "3",
    y: "4",
    width: "18",
    height: "5",
    rx: "1"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M5 9v10h14V9M10 13h4"
  }))
};

// the app's navigation, down the left so the whole height is left for the
// open tab. groups: [heading, [[key, count, needsAttention]]]. Collapses to
// icons (remembered in this browser, and always on narrow screens); the footer
// (children) holds the status and Sync button.
const NARROW = "(max-width: 760px)";
function Sidebar({
  groups,
  tab,
  onTab,
  children
}) {
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
  return /*#__PURE__*/React.createElement("aside", {
    className: `sidebar${collapsed ? " slim" : ""}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "sbBrand"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sbMark serif"
  }, "B"), /*#__PURE__*/React.createElement("div", {
    className: "sbName serif"
  }, "Bundle Price Manager", /*#__PURE__*/React.createElement("small", null, "catalog ops"))), groups.map(([heading, items]) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: heading
  }, /*#__PURE__*/React.createElement("div", {
    className: "sbGroup"
  }, heading), items.map(([k, n, hot]) => {
    const label = TAB_LABELS[k];
    return /*#__PURE__*/React.createElement("button", {
      key: k,
      className: `sbItem${tab === k ? " on" : ""}${hot && n ? " dot" : ""}`,
      onClick: () => onTab(k),
      title: n ? `${label} (${n})` : label
    }, /*#__PURE__*/React.createElement("svg", {
      viewBox: "0 0 24 24",
      "aria-hidden": "true"
    }, NAV_ICONS[k]), /*#__PURE__*/React.createElement("span", {
      className: "sbLabel"
    }, label), n ? /*#__PURE__*/React.createElement("span", {
      className: `sbCount${hot ? " hot" : ""}`
    }, n) : null);
  }))), /*#__PURE__*/React.createElement("div", {
    className: "sbFoot"
  }, children, !narrow && /*#__PURE__*/React.createElement("button", {
    className: "sbCollapse",
    onClick: toggle
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 24 24",
    "aria-hidden": "true"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M15 6l-6 6 6 6"
  })), /*#__PURE__*/React.createElement("span", null, slim ? "Expand sidebar" : "Collapse sidebar"))));
}

// page name on the left, the open tab's search in the middle and its buttons
// on the right. The tab fills those two through <InBar>, so its search state
// stays its own. "/" from anywhere jumps to the search box.
const BarSlots = React.createContext(null);
function TopBar({
  crumb,
  title,
  onHeight,
  onSlots
}) {
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
    onSlots({
      search: searchRef.current,
      actions: actionsRef.current
    });
    const onKey = e => {
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
  return /*#__PURE__*/React.createElement("div", {
    ref: barRef,
    className: "topBar"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, crumb && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 2.2,
      textTransform: "uppercase",
      color: "var(--brassInk)",
      marginBottom: 2
    }
  }, crumb), /*#__PURE__*/React.createElement("h1", {
    className: "serif",
    style: {
      fontSize: 32,
      margin: 0,
      fontWeight: 600,
      lineHeight: 1.05,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, title)), /*#__PURE__*/React.createElement("div", {
    ref: searchRef,
    className: "slotSearch"
  }), /*#__PURE__*/React.createElement("div", {
    ref: actionsRef,
    className: "slotActions"
  }));
}
// renders its children into the top bar's "search" or "actions" slot
function InBar({
  slot,
  children
}) {
  const slots = React.useContext(BarSlots);
  return slots && slots[slot] ? ReactDOM.createPortal(children, slots[slot]) : null;
}

// in-app replacement for window.confirm — a centered modal matching the rest of
// the app's look, instead of the browser's native dialog. Escape or a backdrop
// click cancels, same as clicking Cancel.
function ConfirmModal({
  title,
  detail,
  confirmLabel,
  danger,
  onClose
}) {
  useEffect(() => {
    const onKey = e => {
      if (e.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return /*#__PURE__*/React.createElement("div", {
    onClick: () => onClose(false),
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 50,
      background: "rgba(23,19,17,.45)",
      display: "grid",
      placeItems: "center",
      padding: 20,
      animation: "slideIn .15s ease"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    role: "alertdialog",
    "aria-modal": "true",
    style: {
      background: "var(--card)",
      borderRadius: 6,
      padding: "22px 24px",
      maxWidth: 380,
      width: "100%",
      boxShadow: "0 20px 60px rgba(0,0,0,.35)"
    }
  }, /*#__PURE__*/React.createElement("h3", {
    className: "serif",
    style: {
      margin: "0 0 8px",
      fontSize: 22,
      fontWeight: 600
    }
  }, title), detail && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 20px",
      fontSize: 13.5,
      color: "var(--muted)",
      lineHeight: 1.5
    }
  }, detail), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onClose(false),
    style: btnSec
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onClose(true),
    autoFocus: true,
    style: {
      ...btnPri,
      background: danger ? "var(--clay)" : "var(--ink)"
    }
  }, confirmLabel))));
}

// searches products AND bundles by name/SKU at once, so you don't have to
// know or care which tab something lives in before finding it — picking a
// result jumps straight to it there (same jump used elsewhere in the app)
function GlobalSearch({
  products,
  bundles,
  onJumpToProduct,
  onJumpToBundle
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    if (!q.trim()) return [];
    const p = products.filter(x => matchText(q, x.name + " " + (x.sku || ""))).map(x => ({
      type: "product",
      item: x
    }));
    const b = bundles.filter(x => matchText(q, x.name + " " + (x.sku || ""))).map(x => ({
      type: "bundle",
      item: x
    }));
    return [...p, ...b].slice(0, 30);
  }, [q, products, bundles]);
  function pick(r) {
    if (r.type === "product") onJumpToProduct(r.item);else onJumpToBundle({
      id: r.item.id,
      name: r.item.name
    });
    setQ("");
  }

  // sits in the top bar, so the results drop down over the page; a click
  // anywhere else hides them (the text stays, focusing it shows them again)
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = e => !boxRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  return /*#__PURE__*/React.createElement("div", {
    ref: boxRef,
    style: {
      position: "relative",
      flex: 1,
      minWidth: 0,
      display: "flex"
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => {
      setQ(e.target.value);
      setOpen(true);
    },
    onFocus: () => setOpen(true),
    onKeyDown: e => e.key === "Escape" && setQ(""),
    placeholder: "Search everything \u2014 products & bundles\u2026",
    className: "barSearch",
    style: barSearch
  }), open && q.trim() && /*#__PURE__*/React.createElement("div", {
    style: {
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
      animation: "slideIn .15s ease"
    }
  }, results.length === 0 ? /*#__PURE__*/React.createElement("p", {
    style: note
  }, "No matches.") : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("p", {
    style: note
  }, results.length, " match", results.length === 1 ? "" : "es", results.length === 30 ? " · showing first 30" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden",
      maxHeight: 300,
      overflowY: "auto"
    }
  }, results.map(r => /*#__PURE__*/React.createElement("button", {
    key: r.type + r.item.id,
    onClick: () => pick(r),
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "10px 14px",
      background: "none",
      border: "none",
      borderBottom: "1px solid var(--line)",
      cursor: "pointer",
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      padding: "1px 6px",
      borderRadius: 999,
      color: r.type === "bundle" ? "var(--amber)" : "var(--sage)",
      border: `1px solid ${r.type === "bundle" ? "var(--amber)" : "var(--sage)"}`,
      flexShrink: 0
    }
  }, r.type), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      flex: 1
    }
  }, r.item.name), r.item.sku && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)",
      whiteSpace: "nowrap"
    }
  }, r.item.sku)))))));
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
  initialOpenBundle
}) {
  const [view, setView] = useState("todo"); // todo | history
  // expanded row for inline editing — pre-opens the bundle jumped in from
  const [openId, setOpenId] = useState(initialOpenBundle?.id || null);
  const update = (id, patch) => setBundles(bundles.map(b => b.id === id ? {
    ...b,
    ...patch
  } : b));
  const fixOne = (b, t) => setBundles(bundles.map(x => x.id === b.id ? {
    ...x,
    storedPrice: t,
    history: pushHistory(x, x.storedPrice || 0, t)
  } : x));
  const fixAll = () => {
    const m = {};
    staleList.filter(x => !x.c.missing).forEach(x => m[x.b.id] = x.c.target);
    setBundles(bundles.map(b => m[b.id] != null ? {
      ...b,
      storedPrice: m[b.id],
      history: pushHistory(b, b.storedPrice || 0, m[b.id])
    } : b));
    flash(`Updated ${Object.keys(m).length} prices`);
  };
  const copyAll = () => {
    const rows = staleList.filter(x => !x.c.missing).map(x => `${x.b.sku || x.b.name}\t${money(x.c.target)}`).join("\n");
    navigator.clipboard?.writeText("name\tnew_price\n" + rows);
    flash("Copied to clipboard");
  };

  // flatten history across all bundles AND products, newest first
  const history = useMemo(() => {
    const all = [];
    bundles.forEach(b => (b.history || []).forEach(h => all.push({
      kind: "bundle",
      name: b.name,
      sku: b.sku,
      ...h
    })));
    (products || []).forEach(p => (p.history || []).forEach(h => all.push({
      kind: "product",
      name: p.name,
      sku: p.sku,
      ...h
    })));
    return all.sort((a, b) => b.at.localeCompare(a.at));
  }, [bundles, products]);
  const Tabs = /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 14
    }
  }, [["todo", `To update${staleList.length ? ` (${staleList.length})` : ""}`], ["history", `History${history.length ? ` (${history.length})` : ""}`]].map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setView(k),
    style: {
      padding: "6px 12px",
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer",
      border: `1px solid ${view === k ? "var(--ink)" : "var(--line)"}`,
      background: view === k ? "var(--ink)" : "#fff",
      color: view === k ? "var(--paper)" : "var(--muted)"
    }
  }, label)));
  if (view === "history") return /*#__PURE__*/React.createElement("div", null, Tabs, history.length === 0 ? /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      fontSize: 14
    }
  }, "No price changes recorded yet. Product price edits and bundle price updates both log here.") : /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 110px 90px 90px",
      gap: 10,
      padding: "10px 16px",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      color: "var(--muted)",
      fontWeight: 700,
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Item"), /*#__PURE__*/React.createElement("span", null, "When"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "From"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "To")), history.map((h, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 110px 90px 90px",
      gap: 10,
      padding: "10px 16px",
      alignItems: "center",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13.5,
      fontWeight: 500
    }
  }, h.name, /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 6,
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      padding: "1px 6px",
      borderRadius: 999,
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      color: h.kind === "product" ? "var(--sage)" : "var(--amber)",
      border: `1px solid ${h.kind === "product" ? "var(--sage)" : "var(--amber)"}`
    }
  }, h.kind || "bundle"), h.by === "team" && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 6,
      fontSize: 10,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      padding: "1px 6px",
      borderRadius: 999,
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      color: "var(--clay)",
      border: "1px solid var(--clay)"
    }
  }, "Team edited")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)"
    }
  }, new Date(h.at).toLocaleDateString(), " ", new Date(h.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right",
      fontSize: 13,
      color: "var(--muted)"
    }
  }, money(h.from)), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right",
      fontSize: 13,
      fontWeight: 700
    }
  }, money(h.to))))));
  if (!staleList.length) return /*#__PURE__*/React.createElement("div", null, Tabs, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 52,
      height: 52,
      borderRadius: 999,
      background: "var(--sageDim)",
      color: "var(--sage)",
      display: "grid",
      placeItems: "center",
      fontSize: 26,
      margin: "0 auto 14px"
    }
  }, "\u2713"), /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 26,
      margin: "0 0 6px"
    }
  }, "Everything's in sync"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      maxWidth: 380,
      margin: "0 auto",
      lineHeight: 1.5
    }
  }, "Change a product price and the affected bundles appear here with corrected prices.")));
  const broken = staleList.filter(x => x.c.missing),
    priced = staleList.filter(x => !x.c.missing);
  return /*#__PURE__*/React.createElement("div", null, Tabs, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12,
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 14
    }
  }, staleList.length, " bundle", staleList.length > 1 ? "s" : "", " out of sync."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: copyAll,
    style: btnSec
  }, "Copy all"), /*#__PURE__*/React.createElement("button", {
    onClick: fixAll,
    style: btnPri
  }, "Mark all updated"))), broken.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--clayDim)",
      color: "var(--clay)",
      padding: "10px 14px",
      borderRadius: 4,
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 12
    }
  }, "\u26A0 ", broken.length, " bundle(s) use an inactive/missing product \u2014 fix in Bundles."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...wlGrid,
      padding: "10px 16px",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      color: "var(--muted)",
      fontWeight: 700,
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Bundle"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "Live now"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "Should be"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "Change"), /*#__PURE__*/React.createElement("span", null)), priced.map(({
    b,
    c
  }) => {
    const open = openId === b.id;
    return /*#__PURE__*/React.createElement("div", {
      key: b.id,
      style: {
        borderBottom: "1px solid var(--line)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...wlGrid,
        padding: "11px 16px",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenId(open ? null : b.id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        padding: 0,
        font: "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 12,
        width: 10
      }
    }, open ? "▾" : "▸"), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        fontWeight: 600
      }
    }, b.name), b.sku && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        color: "var(--muted)",
        marginLeft: 6
      }
    }, b.sku))), /*#__PURE__*/React.createElement("span", {
      style: numCell
    }, money(b.storedPrice)), /*#__PURE__*/React.createElement("span", {
      style: {
        ...numCell,
        fontWeight: 700
      }
    }, money(c.target)), /*#__PURE__*/React.createElement("span", {
      style: {
        ...numCell,
        color: c.diff > 0 ? "var(--sage)" : "var(--clay)"
      }
    }, c.diff > 0 ? "+" : "", money(c.diff)), /*#__PURE__*/React.createElement("button", {
      onClick: () => fixOne(b, c.target),
      style: btnFix
    }, "Mark done")), open && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "var(--paper)",
        borderTop: "1px dashed var(--line)",
        paddingTop: 12
      }
    }, /*#__PURE__*/React.createElement(BundleEditor, {
      b: b,
      update: update,
      byId: byId,
      products: products,
      compute: compute,
      onDelete: onDelete,
      onPromote: onPromote,
      onSkip: onSkip,
      pushPrice: pushPrice,
      onJumpToProduct: onJumpToProduct
    })));
  }), broken.map(({
    b
  }) => {
    const open = openId === b.id;
    return /*#__PURE__*/React.createElement("div", {
      key: b.id,
      style: {
        borderBottom: "1px solid var(--line)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...wlGrid,
        padding: "11px 16px",
        alignItems: "center",
        opacity: 0.85
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenId(open ? null : b.id),
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        padding: 0,
        font: "inherit"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 12,
        width: 10
      }
    }, open ? "▾" : "▸"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 14,
        fontWeight: 600
      }
    }, b.name)), /*#__PURE__*/React.createElement("span", {
      style: {
        gridColumn: "2 / 6",
        color: "var(--clay)",
        fontSize: 13,
        fontWeight: 600,
        textAlign: "right"
      }
    }, "Has a missing/inactive item \u2014 click to fix")), open && /*#__PURE__*/React.createElement("div", {
      style: {
        background: "var(--paper)",
        borderTop: "1px dashed var(--line)",
        paddingTop: 12
      }
    }, /*#__PURE__*/React.createElement(BundleEditor, {
      b: b,
      update: update,
      byId: byId,
      products: products,
      compute: compute,
      onDelete: onDelete,
      onPromote: onPromote,
      onSkip: onSkip,
      pushPrice: pushPrice,
      onJumpToProduct: onJumpToProduct
    })));
  })));
}
const CATS = ["plate", "bowl", "vase", "cup", "dinner", "spread", "setting", "serving", "gift", "dessert", "marble", "table", "lamp", "wall"];
// bundles that are really just one product wearing a "bundle" hat — this
// store's marble-vase/tissue-box/tray listings, the "Diverge" vase line, and
// the "Lush" line are almost always a single component once built, not worth
// the usual per-item triage. Whole-word match so e.g. "Blush" doesn't
// false-positive on "lush".
const isSingleItemCandidate = name => {
  const words = norm(name).split(" ");
  return words.includes("lush") || words.includes("diverge") || words.includes("marble") && words.includes("vase");
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
  initialOpenBundle
}) {
  const [q, setQ] = useState(initialOpenBundle?.name || "");
  const [openId, setOpenId] = useState(initialOpenBundle?.id || null);
  // all | empty | filled | oos | dup | single — jumping in needs to land on
  // "single" instead of "all" when the target bundle lives in that silo,
  // or it'd show no matches
  // opening the tab normally starts on out-of-stock; a jump stays on all/single
  const [show, setShow] = useState(() => {
    if (!initialOpenBundle) return "oos";
    const b = bundles.find(x => x.id === initialOpenBundle.id);
    return b && isSingleItemCandidate(b.name) ? "single" : "all";
  });
  const [cat, setCat] = useState(""); // category word
  const [sortBy, setSortBy] = useState(null); // null | "name" | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = col => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = col => sortBy === col ? sortDir === "asc" ? " ▲" : " ▼" : "";
  const [visible, setVisible] = useState(60); // how many rows to show (Load more)
  const active = useMemo(() => products.filter(p => p.active), [products]);
  // marble-vase/lush bundles are a separate silo — every other filter (all,
  // not built yet, built, out of stock, duplicate names) only ever looks at
  // "normal" bundles; they only appear once you explicitly pick their own pill.
  const normalBundles = useMemo(() => bundles.filter(b => b.active !== false && !isSingleItemCandidate(b.name)), [bundles]);
  const singleBundles = useMemo(() => bundles.filter(b => b.active !== false && isSingleItemCandidate(b.name)), [bundles]);
  const filtered = useMemo(() => {
    const pool = show === "single" ? singleBundles : normalBundles;
    return pool.filter(b => {
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
        return sortDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
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
  const emptyCount = useMemo(() => normalBundles.filter(b => b.items.length === 0).length, [normalBundles]);
  // "Not built yet" / "Built" only mean something when both are non-zero —
  // otherwise one is empty and the other just repeats "All"
  const builtSplitUseless = emptyCount === 0 || emptyCount === normalBundles.length;
  const oosCount = useMemo(() => normalBundles.filter(b => compute(b).hasOOS).length, [normalBundles, products]);
  const dupCount = useMemo(() => normalBundles.filter(b => compute(b).dupName).length, [normalBundles]);
  const singleCount = singleBundles.length;
  // counts per category word — pills stay visible (and show their count) even at 0 matches.
  // counted within the current "show" sub-filter so the numbers reflect what you'd actually see.
  const catCounts = useMemo(() => {
    const pool = show === "single" ? singleBundles : normalBundles;
    const base = pool.filter(b => {
      if (show === "empty" && b.items.length > 0) return false;
      if (show === "filled" && b.items.length === 0) return false;
      return true;
    });
    const m = {};
    CATS.forEach(w => {
      m[w] = base.filter(b => b.name.toLowerCase().includes(w)).length;
    });
    return {
      all: base.length,
      ...m
    };
  }, [normalBundles, singleBundles, show]);
  const update = (id, patch) => setBundles(bundles.map(b => b.id === id ? {
    ...b,
    ...patch
  } : b));
  const add = () => {
    const nb = {
      id: uid(),
      sku: "",
      name: "New bundle",
      items: [],
      storedPrice: 0
    };
    setBundles([nb, ...bundles]);
    setOpenId(nb.id);
    setQ("");
    setShow("all"); // the new, empty bundle wouldn't show under "oos"
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "sticky",
      top: stickyTop || 0,
      zIndex: 10,
      background: "var(--paper)",
      paddingTop: 2,
      paddingBottom: 6
    }
  }, /*#__PURE__*/React.createElement(InBar, {
    slot: "search"
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Search bundles\u2026",
    value: q,
    onChange: e => setQ(e.target.value),
    className: "barSearch",
    style: barSearch
  })), /*#__PURE__*/React.createElement(InBar, {
    slot: "actions"
  }, !IS_TEAM && /*#__PURE__*/React.createElement("button", {
    onClick: add,
    style: btnPri
  }, "+ New bundle")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 8,
      flexWrap: "wrap"
    }
  }, [["all", `All (${normalBundles.length})`, false], ["empty", `Not built yet (${emptyCount})`, builtSplitUseless], ["filled", `Built (${normalBundles.length - emptyCount})`, builtSplitUseless], ["oos", `Out of stock (${oosCount})`, oosCount === 0], ["dup", `Duplicate names (${dupCount})`, dupCount === 0], ["single", `Marble vase / Lush / Diverge (${singleCount})`, singleCount === 0]].map(([k, label, hideAtZero]) => {
    // status/candidate pills hide themselves when there's nothing to show —
    // no point cluttering the bar with "(0)" — but stay visible if selected
    if (hideAtZero && show !== k) return null;
    return /*#__PURE__*/React.createElement("button", {
      key: k,
      onClick: () => setShow(k),
      style: {
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${show === k ? "var(--ink)" : "var(--line)"}`,
        background: show === k ? "var(--ink)" : "#fff",
        color: show === k ? "var(--paper)" : "var(--muted)"
      }
    }, label);
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setCat(""),
    style: catPill(cat === "")
  }, "All types (", catCounts.all, ")"), CATS.map(w => {
    const n = catCounts[w] || 0;
    // hide a type pill when nothing matches it — but keep the currently
    // selected one visible so the bar doesn't jump out from under you.
    if (n === 0 && cat !== w) return null;
    return /*#__PURE__*/React.createElement("button", {
      key: w,
      onClick: () => setCat(cat === w ? "" : w),
      style: catPill(cat === w)
    }, w, " (", n, ")");
  }))), /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 10
    }
  }, filtered.length, " match", filtered.length === 1 ? "" : "es", filtered.length > shown.length ? ` · showing ${shown.length}` : ""), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "36px 20px",
      background: "var(--card)",
      border: "1px dashed var(--line)",
      borderRadius: 6,
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--ink)",
      marginBottom: 4
    }
  }, "No bundles match these filters"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      marginBottom: 14
    }
  }, "Try fewer words, or clear the filters to see everything."), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setQ("");
      setShow("all");
      setCat("");
    },
    style: btnSec
  }, "Clear filters")), filtered.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "0 14px",
      marginBottom: 4,
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      color: "var(--muted)",
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("name"),
    title: "Sort by name"
  }, "Bundle", sortArrow("name")), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 90,
      textAlign: "right",
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("stock"),
    title: "Sort by sellable stock"
  }, "Stock", sortArrow("stock")), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 90,
      textAlign: "right",
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("price"),
    title: "Sort by price"
  }, "Price", sortArrow("price")), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 12,
      flexShrink: 0
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, shown.map(b => {
    const c = compute(b);
    const open = openId === b.id;
    return /*#__PURE__*/React.createElement("div", {
      key: b.id,
      style: {
        background: "var(--card)",
        border: `1px solid ${c.stale ? "var(--clay)" : "var(--line)"}`,
        borderLeft: `3px solid ${c.stale ? "var(--clay)" : "var(--sage)"}`,
        borderRadius: 6,
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenId(open ? null : b.id),
      style: {
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 8,
        height: 8,
        borderRadius: 999,
        background: c.empty ? "var(--line)" : c.stale ? "var(--clay)" : "var(--sage)",
        flexShrink: 0
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14.5,
        fontWeight: 600
      }
    }, b.name, c.dupName && /*#__PURE__*/React.createElement("span", {
      title: "Another bundle has this exact same name \u2014 ambiguous for matching/syncing. Rename one of them.",
      style: {
        marginLeft: 7,
        fontSize: 11,
        fontWeight: 700,
        color: "var(--amber)",
        border: "1px solid var(--amber)",
        borderRadius: 999,
        padding: "1px 7px",
        verticalAlign: "middle"
      }
    }, "dup name"), c.hasOOS && /*#__PURE__*/React.createElement("span", {
      title: `Out of stock: ${c.oosItems.map(x => x.product.name).join(", ")}`,
      style: {
        marginLeft: 7,
        fontSize: 11,
        fontWeight: 700,
        color: "var(--clay)",
        border: "1px solid var(--clay)",
        borderRadius: 999,
        padding: "1px 7px",
        verticalAlign: "middle"
      }
    }, "oos"), b.giftIncluded && /*#__PURE__*/React.createElement("span", {
      title: "Gift / packaging price included",
      style: {
        marginLeft: 7,
        fontSize: 11,
        fontWeight: 700,
        color: "var(--amber)",
        border: "1px solid var(--amber)",
        borderRadius: 999,
        padding: "1px 7px",
        verticalAlign: "middle"
      }
    }, "gift"), b.skipped && /*#__PURE__*/React.createElement("span", {
      title: "Skipped \u2014 kept out of the worklist",
      style: {
        marginLeft: 7,
        fontSize: 11,
        fontWeight: 700,
        color: "var(--sage)",
        border: "1px solid var(--sage)",
        borderRadius: 999,
        padding: "1px 7px",
        verticalAlign: "middle"
      }
    }, "skipped"), b.note && /*#__PURE__*/React.createElement("span", {
      title: b.note,
      style: {
        marginLeft: 6,
        fontSize: 12,
        color: "var(--muted)",
        verticalAlign: "middle"
      }
    }, "\u270E")), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 90,
        flexShrink: 0,
        textAlign: "right",
        fontSize: 12.5,
        fontWeight: 600,
        color: c.stock !== null && c.stock <= 0 ? "var(--clay)" : "var(--muted)"
      },
      title: c.stock !== null ? "Sellable stock — each component's stock ÷ qty needed, then the least of those" : undefined
    }, !c.empty && c.stock !== null ? `${c.stock} in stock` : ""), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 90,
        flexShrink: 0,
        textAlign: "right",
        fontSize: 13,
        color: "var(--muted)"
      }
    }, c.empty ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--amber)"
      }
    }, "not built yet") : c.missing ? "needs item fix" : money(c.giftIncluded ? b.storedPrice : c.target)), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 12
      }
    }, open ? "▾" : "▸")), /*#__PURE__*/React.createElement("button", {
      disabled: IS_TEAM,
      onClick: () => onDelete(b),
      title: "Delete bundle",
      style: {
        ...xBtn,
        marginRight: 10,
        flexShrink: 0
      }
    }, "\u2715")), open && /*#__PURE__*/React.createElement(BundleEditor, {
      b: b,
      update: update,
      byId: byId,
      products: products,
      compute: compute,
      onDelete: onDelete,
      onPromote: onPromote,
      onSkip: onSkip,
      pushPrice: pushPrice,
      onJumpToProduct: onJumpToProduct
    }));
  })), filtered.length > shown.length && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setVisible(v => v + 60),
    style: btnSec
  }, "Load more (", filtered.length - shown.length, " more)")));
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
  onJumpToProduct
}) {
  const c = compute(b);
  // price edits log to history; the old value is captured on focus so typing
  // doesn't create an entry per keystroke.
  const liveFocus = useRef(null);
  const logPatch = (from, to) => ({
    history: pushHistory(b, from, to)
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 14px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("label", {
    style: lbl
  }, "Name", /*#__PURE__*/React.createElement("input", {
    value: b.name,
    disabled: IS_TEAM,
    onChange: e => update(b.id, {
      name: e.target.value
    }),
    style: inp
  })), /*#__PURE__*/React.createElement("label", {
    style: lbl
  }, "Bundle SKU", /*#__PURE__*/React.createElement("input", {
    value: b.sku,
    disabled: IS_TEAM,
    onChange: e => update(b.id, {
      sku: e.target.value
    }),
    style: inp
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(QuickAdd, {
    products: products,
    byId: byId,
    onAdd: (productId, qty) => {
      const existing = b.items.findIndex(it => it.productId === productId);
      let items;
      if (existing >= 0) {
        items = [...b.items];
        items[existing] = {
          ...items[existing],
          qty: items[existing].qty + qty
        };
      } else items = [...b.items, {
        productId,
        qty
      }];
      update(b.id, {
        items
      });
    }
  }), b.items.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "var(--muted)",
      fontStyle: "italic"
    }
  }, "No items yet \u2014 use the bar above to add components fast."), b.items.map((it, idx) => {
    const p = byId[it.productId];
    const broke = !p || !p.active;
    const oos = p && p.active && p.stockTracked && (p.stock || 0) <= 0;
    return /*#__PURE__*/React.createElement("div", {
      key: idx,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0"
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "number",
      min: "1",
      value: it.qty,
      disabled: IS_TEAM,
      onChange: e => {
        const items = [...b.items];
        items[idx] = {
          ...it,
          qty: Math.max(1, parseInt(e.target.value) || 1)
        };
        update(b.id, {
          items
        });
      },
      style: {
        width: 46,
        padding: "6px",
        borderRadius: 4,
        border: "1px solid var(--line)",
        fontSize: 13,
        textAlign: "center"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 13
      }
    }, "\xD7"), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
        color: broke ? "var(--clay)" : "var(--ink)"
      }
    }, p ? p.name : "(missing product)", p && onJumpToProduct && /*#__PURE__*/React.createElement("button", {
      onClick: () => onJumpToProduct(p),
      title: `Edit "${p.name}" in Products`,
      style: {
        ...xBtn,
        marginLeft: 4
      }
    }, "\u2197"), broke && p ? " (inactive)" : "", oos && /*#__PURE__*/React.createElement("span", {
      style: {
        marginLeft: 7,
        fontSize: 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        padding: "1px 6px",
        borderRadius: 999,
        verticalAlign: "middle",
        color: "var(--clay)",
        border: "1px solid var(--clay)"
      }
    }, "out of stock")), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 56,
        textAlign: "right",
        fontSize: 12.5,
        color: p && p.stockTracked ? oos ? "var(--clay)" : "var(--muted)" : "var(--line)"
      },
      title: p && p.stockTracked ? `${p.stock} in stock` : "stock not tracked"
    }, p && p.stockTracked ? p.stock : "—"), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 78,
        textAlign: "right",
        fontSize: 13,
        color: "var(--muted)"
      }
    }, p && p.active ? money(p.price * it.qty) : "—"), /*#__PURE__*/React.createElement("button", {
      disabled: IS_TEAM,
      onClick: () => update(b.id, {
        items: b.items.filter((_, i) => i !== idx)
      }),
      style: xBtn
    }, "\u2715"));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: c.stale ? "var(--clayDim)" : "var(--sageDim)",
      borderRadius: 4,
      padding: "12px 14px",
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: vRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "Computed (sum of items)"), /*#__PURE__*/React.createElement("strong", null, c.missing ? "—" : money(c.target))), c.stock !== null && /*#__PURE__*/React.createElement("div", {
    style: vRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "Sellable stock (stock \xF7 qty, least component)"), /*#__PURE__*/React.createElement("strong", {
    style: {
      color: c.stock <= 0 ? "var(--clay)" : "var(--ink)"
    }
  }, c.stock)), /*#__PURE__*/React.createElement("div", {
    style: vRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "Live on Shopify"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    value: b.storedPrice,
    onFocus: e => {
      liveFocus.current = parseFloat(e.target.value) || 0;
    },
    onChange: e => update(b.id, {
      storedPrice: parseFloat(e.target.value) || 0
    }),
    onBlur: e => {
      const from = liveFocus.current;
      liveFocus.current = null;
      const to = parseFloat(e.target.value) || 0;
      if (from != null && Math.abs(to - from) > 0.009) update(b.id, {
        storedPrice: to,
        ...logPatch(from, to)
      });
    },
    style: {
      width: 100,
      padding: "6px 8px",
      borderRadius: 6,
      border: "1px solid var(--line)",
      fontSize: 14,
      textAlign: "right"
    }
  }), b.shopifyVariantId && pushPrice && /*#__PURE__*/React.createElement("button", {
    onClick: () => pushPrice("bundle", b),
    title: "Push this price straight to your live Shopify store",
    style: {
      background: "var(--ink)",
      color: "var(--paper)",
      border: "none",
      borderRadius: 4,
      padding: "5px 10px",
      fontSize: 11.5,
      fontWeight: 600,
      cursor: "pointer",
      whiteSpace: "nowrap"
    }
  }, "Push price to Shopify"))), !c.missing && c.priceMismatch && /*#__PURE__*/React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      fontSize: 13,
      cursor: "pointer",
      color: "var(--ink)",
      lineHeight: 1.4
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!b.giftIncluded,
    disabled: IS_TEAM,
    onChange: e => update(b.id, {
      giftIncluded: e.target.checked
    }),
    style: {
      marginTop: 2,
      cursor: "pointer"
    }
  }), /*#__PURE__*/React.createElement("span", null, "Gift / packaging price included \u2014 the live price is meant to differ from the item sum, so don't flag this for updating.")), !c.missing && c.priceMismatch && b.giftIncluded && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--sage)",
      fontWeight: 600,
      fontSize: 13
    }
  }, "\u2713 In sync (gift price included, ", c.diff < 0 ? "+" : "−", money(Math.abs(c.diff)), " vs item sum)"), !c.missing && c.stale && /*#__PURE__*/React.createElement("button", {
    onClick: () => update(b.id, {
      storedPrice: c.target,
      ...logPatch(b.storedPrice || 0, c.target)
    }),
    style: btnFix
  }, "Set live \u2192 ", money(c.target)), !c.stale && !c.giftIncluded && !c.skipped && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--sage)",
      fontWeight: 600,
      fontSize: 13
    }
  }, "\u2713 In sync")), /*#__PURE__*/React.createElement("label", {
    style: {
      ...lbl,
      marginTop: 2
    }
  }, "Note (optional)", /*#__PURE__*/React.createElement("textarea", {
    value: b.note || "",
    disabled: IS_TEAM,
    onChange: e => update(b.id, {
      note: e.target.value
    }),
    placeholder: "e.g. includes gift box (+\u20B9150) \xB7 seasonal pricing \xB7 anything worth remembering",
    rows: 2,
    style: {
      ...inp,
      resize: "vertical",
      fontFamily: "inherit",
      lineHeight: 1.4
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
      background: b.skipped ? "var(--sageDim)" : "transparent",
      borderRadius: 4,
      padding: b.skipped ? "8px 12px" : "0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "var(--muted)",
      lineHeight: 1.4
    }
  }, b.skipped ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--sage)",
      fontWeight: 600
    }
  }, "Skipped \u2014 kept out of \u201CNeeds updating\u201D. Won't be flagged even if the price differs.") : /*#__PURE__*/React.createElement("span", null, "Just one item + a box, or otherwise not worth syncing? Skip it to keep it off the worklist.")), /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: () => onSkip(b, !b.skipped),
    style: {
      ...btnSec,
      whiteSpace: "nowrap",
      ...(b.skipped ? {
        color: "var(--sage)",
        borderColor: "var(--sage)"
      } : {})
    }
  }, b.skipped ? "Un-skip" : "Skip this bundle")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
      background: b.active === false ? "var(--clayDim)" : "transparent",
      borderRadius: 4,
      padding: b.active === false ? "8px 12px" : "0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "var(--muted)",
      lineHeight: 1.4
    }
  }, b.active === false ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--clay)",
      fontWeight: 600
    }
  }, "Discontinued \u2014 hidden from the main list and worklist. Find it in the Discontinued tab.") : /*#__PURE__*/React.createElement("span", null, "No longer sold? Mark it discontinued instead of deleting \u2014 keeps it intact, out of your way, and restorable anytime.")), /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: () => update(b.id, {
      active: b.active === false
    }),
    style: {
      ...btnSec,
      whiteSpace: "nowrap",
      ...(b.active === false ? {
        color: "var(--clay)",
        borderColor: "var(--clay)"
      } : {})
    }
  }, b.active === false ? "Restore" : "Mark discontinued")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      borderTop: "1px solid var(--line)",
      paddingTop: 10,
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: () => onPromote(b),
    style: {
      background: "none",
      border: "1px solid var(--line)",
      color: "var(--muted)",
      padding: "6px 12px",
      borderRadius: 4,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer"
    },
    title: "This isn't a bundle \u2014 move it into the product list"
  }, "Not a bundle \u2192 move to Products"), /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: () => onDelete(b),
    style: {
      background: "none",
      border: "none",
      color: "var(--clay)",
      padding: "6px 10px",
      borderRadius: 4,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Delete bundle")));
}
function QuickAdd({
  products,
  byId,
  onAdd
}) {
  if (IS_TEAM) return null;
  const [q, setQ] = useState("");
  const [qty, setQty] = useState(1);
  const [hi, setHi] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef();
  const matches = useMemo(() => {
    if (!q.trim()) return [];
    return products.filter(p => p.active && matchText(q, p.name + " " + (p.sku || ""))).slice(0, 8);
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
      setHi(h => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(h => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(matches[hi]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: "1",
    value: qty,
    onChange: e => setQty(e.target.value),
    title: "quantity",
    style: {
      width: 52,
      padding: "9px 8px",
      borderRadius: 4,
      border: "1px solid var(--line)",
      fontSize: 14,
      textAlign: "center"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 13
    }
  }, "\xD7"), /*#__PURE__*/React.createElement("input", {
    ref: inputRef,
    value: q,
    onChange: e => setQ(e.target.value),
    onKeyDown: onKey,
    onFocus: () => setOpen(matches.length > 0),
    placeholder: "type to add a component \u2014 e.g. lunar nude plate, then Enter",
    style: {
      flex: 1,
      padding: "9px 12px",
      borderRadius: 4,
      border: "1px solid var(--clay)",
      fontSize: 14,
      background: "#fff"
    }
  })), open && matches.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
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
      overflow: "hidden"
    }
  }, matches.map((p, i) => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    onMouseDown: e => {
      e.preventDefault();
      commit(p);
    },
    onMouseEnter: () => setHi(i),
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
      padding: "9px 12px",
      cursor: "pointer",
      background: i === hi ? "var(--sageDim)" : "#fff",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13.5
    }
  }, p.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)",
      whiteSpace: "nowrap"
    }
  }, p.sku, " \xB7 ", money(p.price))))));
}

// products from the "Claude"/"Horizon"/"Arc"/"Pivot Marble" lines — kept as
// their own silo, same idea as the Bundles marble-vase/Lush/Diverge one, so
// they don't clutter the main product views by default.
const isMarbleAtelier = name => {
  const w = norm(name).split(" ");
  return w.includes("claude") || w.includes("horizon") || w.includes("arc") || w.includes("pivot") && w.includes("marble");
};
// the Zoho Inventory page's Marble Atelier table — the Products tab's silo
// plus the Pivot stacking vases, whose names don't say "marble"
const isZohoMarble = name => {
  const w = norm(name).split(" ");
  return isMarbleAtelier(name) || w.includes("pivot") && (w.includes("vase") || w.includes("vases"));
};
// the Out of stock tab's "Marble" split — wider than the Products tab's
// Marble Atelier silo: anything marble or vase, plus the Buoy coasters and
// Aura trivets
const isMarbleLine = name => {
  const w = norm(name).split(" ");
  return isMarbleAtelier(name) || ["marble", "vase", "vases", "buoy", "aura"].some(x => w.includes(x));
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
  onJumpToBundle
}) {
  const [q, setQ] = useState(initialQuery || "");
  const [visible, setVisible] = useState(100);
  // all | used | unused | oos | atelier — jumping in from a bundle's
  // component needs to land on "atelier" instead of "all" when that's
  // where the target product actually lives, or it'd show no matches
  // opening the tab normally starts on out-of-stock; a jump stays on all/atelier
  const [usageFilter, setUsageFilter] = useState(() => {
    if (!initialQuery) return "oos";
    const match = products.find(p => p.sku && p.sku === initialQuery || p.name === initialQuery);
    return match && isMarbleAtelier(match.name) ? "atelier" : "all";
  });
  const [sortBy, setSortBy] = useState(null); // null | "name" | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = col => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = col => sortBy === col ? sortDir === "asc" ? " ▲" : " ▼" : "";
  const isOOS = p => p.active && p.stockTracked && (p.stock || 0) <= 0;
  const normalProducts = useMemo(() => products.filter(p => !isMarbleAtelier(p.name)), [products]);
  const atelierProducts = useMemo(() => products.filter(p => isMarbleAtelier(p.name)), [products]);
  // product id whose bundle list is open — auto-open the jumped-to product's,
  // so "which bundles use this" is visible immediately, no extra click
  const [expanded, setExpanded] = useState(() => {
    if (!initialQuery) return null;
    const match = products.find(p => p.sku && p.sku === initialQuery || p.name === initialQuery);
    return match ? match.id : null;
  });
  const priceFocus = useRef(null); // {id,value} captured when a price field gains focus
  // log a product price change on blur, so typing doesn't add an entry per keystroke
  const logPriceChange = (id, from, to) => setProducts(cur => cur.map(p => p.id === id ? {
    ...p,
    history: pushHistory(p, from, to)
  } : p));
  // map productId -> array of {name, sku} of bundles that use it
  const usage = useMemo(() => {
    const m = {};
    bundles.forEach(b => b.items.forEach(it => {
      (m[it.productId] = m[it.productId] || []).push({
        id: b.id,
        name: b.name,
        sku: b.sku
      });
    }));
    return m;
  }, [bundles]);
  const usedCount = p => (usage[p.id] || []).length;
  const baseList = useMemo(() => (usageFilter === "atelier" ? atelierProducts : normalProducts).filter(p => {
    if (usageFilter === "used" && usedCount(p) === 0) return false;
    if (usageFilter === "unused" && usedCount(p) > 0) return false;
    if (usageFilter === "oos" && !isOOS(p)) return false;
    if (usageFilter === "archived" && p.active) return false;
    return true;
  }), [normalProducts, atelierProducts, usage, usageFilter]);
  const filtered = useMemo(() => {
    if (!q.trim()) return baseList;
    return baseList.filter(p => matchText(q, p.name + " " + (p.sku || "")));
  }, [baseList, q]);
  const sorted = useMemo(() => {
    if (!sortBy) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sortBy === "name") {
        return sortDir === "asc" ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
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
  const update = (id, patch) => setProducts(products.map(p => p.id === id ? {
    ...p,
    ...patch
  } : p));
  const add = () => {
    const np = {
      id: uid(),
      sku: "",
      name: "New product",
      price: 0,
      active: true
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
    normalProducts.forEach(p => {
      usedCount(p) > 0 ? used++ : unused++;
      if (isOOS(p)) oos++;
    });
    const archived = normalProducts.filter(p => !p.active).length;
    return {
      all: normalProducts.length,
      used,
      unused,
      oos,
      archived,
      atelier: atelierProducts.length
    };
  }, [normalProducts, atelierProducts, usage]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "sticky",
      top: stickyTop || 0,
      zIndex: 10,
      background: "var(--paper)",
      paddingTop: 2,
      paddingBottom: 6
    }
  }, /*#__PURE__*/React.createElement(InBar, {
    slot: "search"
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Search products\u2026",
    value: q,
    onChange: e => setQ(e.target.value),
    className: "barSearch",
    style: barSearch
  })), /*#__PURE__*/React.createElement(InBar, {
    slot: "actions"
  }, !IS_TEAM && /*#__PURE__*/React.createElement("button", {
    onClick: add,
    style: btnPri
  }, "+ New product")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, [["all", `All (${counts.all})`, false], ["used", `In a bundle (${counts.used})`, false], ["unused", `Not in any bundle (${counts.unused})`, false], ["oos", `Out of stock (${counts.oos})`, counts.oos === 0], ["archived", `Archived (${counts.archived})`, counts.archived === 0], ["atelier", `Marble Atelier (${counts.atelier})`, counts.atelier === 0]].map(([k, label, hideAtZero]) => {
    if (hideAtZero && usageFilter !== k) return null;
    return /*#__PURE__*/React.createElement("button", {
      key: k,
      onClick: () => setUsageFilter(k),
      style: {
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12.5,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${usageFilter === k ? "var(--ink)" : "var(--line)"}`,
        background: usageFilter === k ? "var(--ink)" : "#fff",
        color: usageFilter === k ? "var(--paper)" : "var(--muted)"
      }
    }, label);
  }))), /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 10
    }
  }, filtered.length, " match", filtered.length === 1 ? "" : "es", filtered.length > shown.length ? ` · showing first ${shown.length}` : "", " ", "\xB7 edit a price and every bundle using it updates"), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "36px 20px",
      background: "var(--card)",
      border: "1px dashed var(--line)",
      borderRadius: 6,
      color: "var(--muted)",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--ink)",
      marginBottom: 4
    }
  }, q.trim() ? `No products match “${q}”` : "No products in this view"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      marginBottom: 14
    }
  }, usageFilter !== "all" ? "Try the All filter, or " : "Try fewer words, or ", "clear to see all ", products.length, " products."), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setQ("");
      setUsageFilter("all");
    },
    style: btnSec
  }, "Clear filters")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...prodGrid,
      padding: "10px 14px",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: 0.4,
      color: "var(--muted)",
      fontWeight: 700,
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("name"),
    title: "Sort by name"
  }, "Product", sortArrow("name")), /*#__PURE__*/React.createElement("span", null, "SKU"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right",
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("price"),
    title: "Sort by price"
  }, "Price", sortArrow("price")), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right",
      cursor: "pointer",
      userSelect: "none"
    },
    onClick: () => toggleSort("stock"),
    title: "Sort by stock"
  }, "Stock", sortArrow("stock")), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "center"
    }
  }, "In bundles"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "center"
    }
  }, "Active"), /*#__PURE__*/React.createElement("span", null)), shown.map(p => {
    const used = usage[p.id] || [];
    const isOpen = expanded === p.id;
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      style: {
        borderBottom: "1px solid var(--line)",
        opacity: p.active ? 1 : 0.5
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...prodGrid,
        padding: "7px 14px",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: p.name,
      disabled: !p.active || IS_TEAM,
      onChange: e => update(p.id, {
        name: e.target.value
      }),
      style: {
        border: "none",
        background: "none",
        fontSize: 14,
        fontWeight: 500,
        padding: "4px 0"
      }
    }), /*#__PURE__*/React.createElement("input", {
      value: p.sku,
      disabled: !p.active || IS_TEAM,
      onChange: e => update(p.id, {
        sku: e.target.value
      }),
      style: {
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "5px 7px",
        fontSize: 12,
        color: "var(--muted)"
      }
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: p.price,
      disabled: !p.active,
      onFocus: e => {
        priceFocus.current = {
          id: p.id,
          value: parseFloat(e.target.value) || 0
        };
      },
      onChange: e => update(p.id, {
        price: parseFloat(e.target.value) || 0
      }),
      onBlur: e => {
        const s = priceFocus.current;
        priceFocus.current = null;
        if (!s || s.id !== p.id) return;
        const to = parseFloat(e.target.value) || 0;
        if (Math.abs(to - s.value) > 0.009) logPriceChange(p.id, s.value, to);
      },
      style: {
        flex: 1,
        minWidth: 0,
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "6px 6px",
        fontSize: 14,
        textAlign: "right"
      }
    }), p.active && p.shopifyVariantId && pushPrice && /*#__PURE__*/React.createElement("button", {
      onClick: () => pushPrice("product", p),
      title: "Push this price straight to your live Shopify store",
      style: {
        border: "none",
        background: "var(--ink)",
        borderRadius: 6,
        padding: "5px 7px",
        fontSize: 11,
        fontWeight: 600,
        color: "var(--paper)",
        cursor: "pointer",
        flexShrink: 0,
        whiteSpace: "nowrap"
      }
    }, "\uD83D\uDECD\uFE0F Update")), p.stockTracked ? /*#__PURE__*/React.createElement("span", {
      style: {
        textAlign: "right",
        fontSize: 13,
        fontWeight: p.active && p.stock <= 0 ? 700 : 400,
        color: p.active && p.stock <= 0 ? "var(--clay)" : "var(--ink)"
      }
    }, p.stock, p.active && p.stock <= 0 ? " oos" : "") : /*#__PURE__*/React.createElement("span", {
      style: {
        textAlign: "right",
        fontSize: 13,
        color: "var(--line)"
      },
      title: "Stock not tracked in Shopify"
    }, "\u2014"), used.length > 0 ? /*#__PURE__*/React.createElement("button", {
      onClick: () => setExpanded(isOpen ? null : p.id),
      title: "Show which bundles use this",
      style: {
        textAlign: "center",
        fontSize: 13,
        color: "var(--amber)",
        fontWeight: 700,
        background: "none",
        border: "none",
        cursor: "pointer",
        textDecoration: "underline",
        textUnderlineOffset: 2
      }
    }, used.length, " ", isOpen ? "▾" : "▸") : /*#__PURE__*/React.createElement("span", {
      style: {
        textAlign: "center",
        fontSize: 13,
        color: "var(--muted)"
      }
    }, "\u2014"), /*#__PURE__*/React.createElement("button", {
      disabled: IS_TEAM,
      onClick: () => update(p.id, {
        active: !p.active
      }),
      style: {
        border: `1px solid ${p.active ? "var(--sage)" : "var(--line)"}`,
        background: p.active ? "var(--sageDim)" : "#fff",
        color: p.active ? "var(--sage)" : "var(--muted)",
        borderRadius: 999,
        padding: "5px 0",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer"
      }
    }, p.active ? "Active" : "Inactive"), /*#__PURE__*/React.createElement("button", {
      disabled: IS_TEAM,
      onClick: () => onDelete(p),
      style: xBtn
    }, "\u2715")), isOpen && used.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "4px 14px 12px 14px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6
      }
    }, used.map((u, i) => /*#__PURE__*/React.createElement("button", {
      key: i,
      onClick: () => onJumpToBundle && onJumpToBundle(u),
      title: onJumpToBundle ? `Open "${u.name}" in Bundles` : undefined,
      style: {
        fontSize: 12.5,
        background: "var(--sageDim)",
        color: "var(--ink)",
        borderRadius: 999,
        padding: "3px 10px",
        border: "1px solid var(--line)",
        cursor: onJumpToBundle ? "pointer" : "default"
      }
    }, u.name, u.sku ? ` · ${u.sku}` : ""))));
  })), filtered.length > shown.length && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setVisible(v => v + 100),
    style: btnSec
  }, "Load more (", filtered.length - shown.length, " more)")));
}

// the docx library is only needed for the out-of-stock download, so it's
// pulled from the CDN on first use rather than on every page load
let docxLoading = null;
function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  if (!docxLoading) docxLoading = new Promise((resolve, reject) => {
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
  const byId = Object.fromEntries(products.map(p => [p.id, p]));
  const isOOS = p => p && p.active && p.stockTracked && (p.stock || 0) <= 0;
  const keep = name => isMarbleLine(name) === atelier;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const inBundleRows = new Set(); // products already named against a bundle
  const bundleRows = bundles.filter(b => b.active !== false && keep(b.name)).map(b => {
    const off = [...new Set(b.items.map(it => byId[it.productId]).filter(isOOS))];
    off.forEach(p => inBundleRows.add(p.id));
    return {
      name: b.name,
      off: off.map(p => p.name).join(", ")
    };
  }).filter(r => r.off).sort(byName);
  const productRows = products.filter(p => isOOS(p) && keep(p.name) && !inBundleRows.has(p.id)).map(p => ({
    name: p.name,
    off: ""
  })).sort(byName);
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    HeadingLevel
  } = await loadDocx();
  const cell = (text, bold) => new TableCell({
    children: [new Paragraph({
      children: [new TextRun({
        text,
        bold
      })]
    })]
  });
  const rows = [...bundleRows, ...productRows];
  const title = `Out of stock — ${atelier ? "Marble" : "Ceramic"}`;
  const date = new Date().toISOString().slice(0, 10);
  const doc = new Document({
    sections: [{
      children: [new Paragraph({
        text: title,
        heading: HeadingLevel.HEADING_1
      }), new Paragraph({
        text: [date, bundleRows.length && `${bundleRows.length} bundles`, productRows.length && `${productRows.length} products`].filter(Boolean).join(" · "),
        spacing: {
          after: 200
        }
      }), rows.length ? new Table({
        width: {
          size: 100,
          type: WidthType.PERCENTAGE
        },
        rows: [new TableRow({
          tableHeader: true,
          children: [cell("Name", true), cell("Out of stock", true)]
        }), ...rows.map(r => new TableRow({
          children: [cell(r.name), cell(r.off)]
        }))]
      }) : new Paragraph("Nothing out of stock.")]
    }]
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
  onExport
}) {
  const [openId, setOpenId] = useState(null);
  const [view, setView] = useState("main"); // main (ceramic) | atelier (marble line, see isMarbleLine)
  const [exporting, setExporting] = useState(false);
  // bundles start open; single products start collapsed to keep the scroll short
  const [openSec, setOpenSec] = useState({
    bundles: true,
    products: false
  });
  // an empty section is hidden outright rather than shown as "0"
  const sectionHeader = (key, label, count) => count > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setOpenSec({
      ...openSec,
      [key]: !openSec[key]
    }),
    style: {
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
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 12,
      width: 12
    }
  }, openSec[key] ? "▾" : "▸"), /*#__PURE__*/React.createElement("span", {
    className: "serif",
    style: {
      flex: 1,
      fontSize: 20
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      fontWeight: 700,
      color: "var(--clay)"
    }
  }, count));
  const update = (id, patch) => setBundles(bundles.map(b => b.id === id ? {
    ...b,
    ...patch
  } : b));
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
    bundles.filter(b => b.active !== false).forEach(b => new Set(b.items.map(it => it.productId)).forEach(id => {
      usedIn[id] = (usedIn[id] || 0) + 1;
    }));
    return products.filter(p => p.active && p.stockTracked && (p.stock || 0) <= 0).map(p => ({
      p,
      used: usedIn[p.id] || 0
    })).sort((a, b) => a.p.name.localeCompare(b.p.name));
  }, [products, bundles]);
  const inView = (name, v) => isMarbleLine(name) === (v === "atelier");
  // per view: its bundles, plus single products not already named as one
  // of those bundles' blockers (that would list the same thing twice)
  const viewLists = v => {
    const bs = allOosBundles.filter(x => inView(x.b.name, v));
    const named = new Set(bs.flatMap(({
      c
    }) => c.oosItems.map(x => x.product.id)));
    const ps = allOosProducts.filter(x => inView(x.p.name, v) && !named.has(x.p.id));
    return [bs, ps];
  };
  const viewCount = v => viewLists(v).reduce((n, l) => n + l.length, 0);
  const [oosList, oosProducts] = viewLists(view);
  const toolbar = /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center",
      flexWrap: "wrap",
      marginBottom: 12
    }
  }, [["main", "Ceramic"], ["atelier", "Marble"]].map(([k, label]) =>
  // a view with nothing out of stock isn't worth a pill (unless it's the one open)
  viewCount(k) === 0 && view !== k ? null : /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => {
      setView(k);
      setOpenId(null);
    },
    style: {
      padding: "6px 12px",
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer",
      border: `1px solid ${view === k ? "var(--ink)" : "var(--line)"}`,
      background: view === k ? "var(--ink)" : "#fff",
      color: view === k ? "var(--paper)" : "var(--muted)"
    }
  }, label, " (", viewCount(k), ")")), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: runExport,
    disabled: exporting,
    title: "Refreshes stock, then downloads a Word doc",
    style: {
      padding: "7px 12px",
      borderRadius: 4,
      border: "1px solid var(--line)",
      background: "var(--card)",
      fontSize: 12.5,
      fontWeight: 600,
      color: "var(--ink)",
      cursor: exporting ? "default" : "pointer"
    }
  }, exporting ? "Refreshing…" : view === "atelier" ? "⬇ Download OOS Marble (.docx)" : "⬇ Download OOS Ceramic (.docx)"));
  if (!oosList.length && !oosProducts.length) return /*#__PURE__*/React.createElement("div", null, toolbar, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 52,
      height: 52,
      borderRadius: 999,
      background: "var(--sageDim)",
      color: "var(--sage)",
      display: "grid",
      placeItems: "center",
      fontSize: 26,
      margin: "0 auto 14px"
    }
  }, "\u2713"), /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 26,
      margin: "0 0 6px"
    }
  }, "Nothing out of stock"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      maxWidth: 420,
      margin: "0 auto",
      lineHeight: 1.5
    }
  }, "Every product and bundle component has stock, as of the last sync. Run ", /*#__PURE__*/React.createElement("code", null, "npm run fetch-stock"), " (or wait for the scheduled check) to refresh.")));
  return /*#__PURE__*/React.createElement("div", null, toolbar, sectionHeader("bundles", "Bundles blocked by an out-of-stock component", oosList.length), openSec.bundles && oosList.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      marginTop: 6
    }
  }, oosList.map(({
    b,
    c
  }) => {
    const open = openId === b.id;
    return /*#__PURE__*/React.createElement("div", {
      key: b.id,
      style: {
        background: "var(--card)",
        border: "1px solid var(--clay)",
        borderLeft: "3px solid var(--clay)",
        borderRadius: 6,
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setOpenId(open ? null : b.id),
      style: {
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 14px",
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14.5,
        fontWeight: 600
      }
    }, b.name, b.sku && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 11.5,
        color: "var(--muted)",
        marginLeft: 6
      }
    }, b.sku)), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        color: "var(--clay)",
        fontWeight: 600
      }
    }, c.oosItems.map(x => x.product.name).join(", ")), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 12
      }
    }, open ? "▾" : "▸")), open && /*#__PURE__*/React.createElement(BundleEditor, {
      b: b,
      update: update,
      byId: byId,
      products: products,
      compute: compute,
      onDelete: onDelete,
      onPromote: onPromote,
      onSkip: onSkip,
      pushPrice: pushPrice,
      onJumpToProduct: onJumpToProduct
    }));
  })), sectionHeader("products", "Single products at zero stock", oosProducts.length), openSec.products && oosProducts.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6,
      marginTop: 6
    }
  }, oosProducts.map(({
    p,
    used
  }) => /*#__PURE__*/React.createElement("button", {
    key: p.id,
    onClick: () => onJumpToProduct(p),
    title: "Open in Products",
    style: {
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
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      fontSize: 14.5,
      fontWeight: 600
    }
  }, p.name, p.sku && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)",
      marginLeft: 6
    }
  }, p.sku)), used > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "in ", used, " bundle", used > 1 ? "s" : ""), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--clay)",
      fontWeight: 700
    }
  }, p.stock || 0), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 12
    }
  }, "\u2197")))));
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
  onDeleteBundle
}) {
  const discProducts = useMemo(() => products.filter(p => !p.active), [products]);
  const discBundles = useMemo(() => bundles.filter(b => b.active === false), [bundles]);
  const restoreProduct = p => setProducts(cur => cur.map(x => x.id === p.id ? {
    ...x,
    active: true
  } : x));
  const restoreBundle = b => setBundles(cur => cur.map(x => x.id === b.id ? {
    ...x,
    active: true
  } : x));
  if (!discProducts.length && !discBundles.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 26,
      margin: "0 0 6px"
    }
  }, "Nothing discontinued"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      maxWidth: 420,
      margin: "0 auto",
      lineHeight: 1.5
    }
  }, "Mark a product \"Inactive\" or a bundle \"Discontinued\" (from its edit panel) when it stops selling instead of deleting it \u2014 it'll show up here, still intact, restorable anytime."));
  const row = (name, sub, onRestore, onDelete) => /*#__PURE__*/React.createElement("div", {
    key: name + sub,
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
      padding: "11px 16px",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, sub)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: onRestore,
    style: btnSec
  }, "Restore"), /*#__PURE__*/React.createElement("button", {
    disabled: IS_TEAM,
    onClick: onDelete,
    style: {
      ...btnSec,
      color: "var(--clay)",
      borderColor: "var(--clayDim)"
    }
  }, "Delete")));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 20
    }
  }, !!discProducts.length && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 8px",
      fontSize: 14,
      fontWeight: 600
    }
  }, "Products (", discProducts.length, ")"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, discProducts.map(p => row(p.name, `${p.sku || "no SKU"} · ${money(p.price)}`, () => restoreProduct(p), () => onDeleteProduct(p))))), !!discBundles.length && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 8px",
      fontSize: 14,
      fontWeight: 600
    }
  }, "Bundles (", discBundles.length, ")"), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, discBundles.map(b => row(b.name, `${b.sku || "no SKU"} · ${money(b.storedPrice || 0)} · ${b.items.length} item${b.items.length === 1 ? "" : "s"}`, () => restoreBundle(b), () => onDeleteBundle(b))))));
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
function zohoTableCounts(tables, ws) {
  return {
    ...(ws ? {
      items: tables.items.length,
      composites: tables.composites.length,
      marble: tables.marble.length
    } : {}),
    ceramitec: CERAMITEC_BUNDLE_SKUS.length
  };
}
function splitWarehouseTables(ws, products) {
  const t = {
    items: [],
    composites: [],
    marble: []
  };
  if (!ws) return t;
  const shopifySkus = new Set((products || []).filter(p => p.active !== false && p.sku).map(p => normSku(p.sku)));
  for (const r of ws.items) if (shopifySkus.has(normSku(r.sku))) t[isZohoMarble(r.name) ? "marble" : "items"].push(r);
  for (const r of ws.composites) t[isZohoMarble(r.name) ? "marble" : "composites"].push(r);
  return t;
}

// table: which Zoho table is open, picked in the sidebar
function Reorder({
  doc,
  setDoc,
  stickyTop,
  flash,
  products,
  table
}) {
  const [q, setQ] = useState("");
  // pieces sold per Zoho item (admin only), shown beside "still short"
  const [salesById, setSalesById] = useState(null);
  useEffect(() => {
    if (IS_TEAM || table !== "reorder") return;
    fetch("/api/sales?rows=1").then(r => r.ok ? r.json() : null)
    // empty or half-loaded sales would read as "sold nothing", so wait for all of it
    .then(d => d && d.rows && d.rows.length && (d.yearComplete ?? !d.pending) && setSalesById(new Map(d.rows.map(x => [x.id, x])))).catch(() => {});
  }, [table]);
  const [vendor, setVendor] = useState("Hollyhock");
  const [view, setView] = useState("below"); // reorder list filter: below | short | restocked | all
  const [sortBy, setSortBy] = useState("vendor"); // vendor | name | stock | receive | expected
  const [sortDir, setSortDir] = useState("asc");
  const [refreshing, setRefreshing] = useState(false);
  // the sticky header's height, so the warehouse tables can fill the rest of
  // the screen (it remounts when the table changes, hence a callback ref)
  const [hdrH, setHdrH] = useState(0);
  const hdrRo = useRef(null);
  const hdrRef = React.useCallback(el => {
    if (hdrRo.current) hdrRo.current.disconnect();
    if (!el || !window.ResizeObserver) return;
    hdrRo.current = new ResizeObserver(() => setHdrH(el.offsetHeight));
    hdrRo.current.observe(el);
  }, []);
  // re-render every 30s so the cooldown countdown ticks and the button
  // re-enables on its own
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  // counts from the last button press only (lastManualSyncAt) — the scheduled
  // refresh doesn't grey the button out
  const cooldownLeft = doc.lastManualSyncAt ? REORDER_COOLDOWN_MS - (Date.now() - new Date(doc.lastManualSyncAt).getTime()) : 0;
  const coolingDown = cooldownLeft > 0;
  const toggleSort = col => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");else {
      setSortBy(col);
      setSortDir("asc");
    }
  };
  const sortArrow = col => sortBy === col ? sortDir === "asc" ? " ▲" : " ▼" : "";
  const rows = useMemo(() => Object.values(doc.items || {}), [doc]);
  const inView = r => view === "all" ? true : view === "below" ? r.below : view === "short" ? r.below && shortOf(r) > 0 : !r.below;
  const vendors = useMemo(() => {
    const m = {};
    rows.filter(inView).forEach(r => {
      const v = r.vendor || "No vendor";
      m[v] = (m[v] || 0) + 1;
    });
    return Object.entries(m).sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, view]);
  const counts = useMemo(() => ({
    below: rows.filter(r => r.below).length,
    short: rows.filter(r => r.below && shortOf(r) > 0).length,
    restocked: rows.filter(r => !r.below).length,
    all: rows.length
  }), [rows]);
  const shown = useMemo(() => {
    const list = rows.filter(r => inView(r) && (vendor === "all" || (r.vendor || "No vendor") === vendor) && matchText(q, `${r.name} ${r.sku} ${r.notes || ""}`));
    const dir = sortDir === "asc" ? 1 : -1;
    const byName = (a, b) => a.name.localeCompare(b.name);
    list.sort((a, b) => {
      if (sortBy === "name") return dir * byName(a, b);
      if (sortBy === "stock") return dir * (a.stockOnHand - b.stockOnHand) || byName(a, b);
      if (sortBy === "receive") return dir * ((a.toReceive || 0) - (b.toReceive || 0)) || byName(a, b);
      if (sortBy === "short") return dir * (shortOf(a) - shortOf(b)) || byName(a, b);
      if (sortBy === "expected") {
        // rows with no date always sink to the bottom
        if (!a.expectedDate !== !b.expectedDate) return a.expectedDate ? -1 : 1;
        return dir * (a.expectedDate || "").localeCompare(b.expectedDate || "") || byName(a, b);
      }
      return dir * (a.vendor || "~").localeCompare(b.vendor || "~") || byName(a, b);
    });
    return list;
  }, [rows, q, vendor, view, sortBy, sortDir]);

  // vendor picked no longer has rows in this view — fall back to all
  useEffect(() => {
    if (vendor !== "all" && !vendors.some(([v]) => v === vendor)) setVendor("all");
  }, [vendors]);

  // Ceramitec ships some sets pre-packed; those are single Shopify products
  // with hand-entered stock, so their stock comes from the Shopify sync (the
  // product's `stock`), not from Zoho
  const ceramitec = useMemo(() => CERAMITEC_BUNDLE_SKUS.map(sku => ({
    sku,
    p: (products || []).find(x => normSku(x.sku) === normSku(sku))
  })).filter(({
    sku,
    p
  }) => matchText(q, `${p ? p.name : ""} ${sku}`)), [products, q]);
  const ws = doc.warehouseStock;
  const whTables = useMemo(() => splitWarehouseTables(ws, products), [ws, products]);
  // Zoho's numbers for the Ceramitec sets, by SKU — most are composites, so
  // those win over a plain item with the same SKU
  const zohoBySku = useMemo(() => {
    const m = new Map();
    if (ws) for (const r of [...ws.composites, ...ws.items]) {
      const k = normSku(r.sku);
      if (k && !m.has(k)) m.set(k, whTotals(r, ws.warehouses));
    }
    return m;
  }, [ws]);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/reorder", {
        method: "POST"
      });
      const j = await r.json();
      if (r.status === 429) {
        flash(`Refresh was used recently — try again in ${fmtLeft(j.retryAfterMs)}`);
      } else if (!j.ok) {
        flash(`Zoho refresh failed: ${j.detail || j.error}`);
      } else {
        setDoc(j.data);
        const s = j.summary;
        flash(`Refreshed from Zoho · ${s.below} below reorder${s.added ? ` · ${s.added} new` : ""}`);
      }
    } catch {
      flash("Zoho refresh failed — check your connection");
    }
    setRefreshing(false);
  };
  const saveRow = async (id, patch) => {
    // optimistic, so typing/picking feels instant
    setDoc(d => ({
      ...d,
      items: {
        ...d.items,
        [id]: {
          ...d.items[id],
          ...patch
        }
      }
    }));
    try {
      const r = await fetch("/api/reorder", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id,
          ...patch
        })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setDoc(d => ({
        ...d,
        items: {
          ...d.items,
          [id]: j.row
        }
      }));
    } catch {
      flash("Couldn't save — check your connection and try again");
    }
  };

  // same as saveRow, for a Ceramitec bundle's hand-entered fields (by SKU)
  const saveManual = async (sku, patch) => {
    const key = sku.toUpperCase();
    setDoc(d => ({
      ...d,
      manual: {
        ...(d.manual || {}),
        [key]: {
          ...(d.manual || {})[key],
          ...patch
        }
      }
    }));
    try {
      const r = await fetch("/api/reorder", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sku,
          ...patch
        })
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setDoc(d => ({
        ...d,
        manual: {
          ...(d.manual || {}),
          [key]: j.row
        }
      }));
    } catch {
      flash("Couldn't save — check your connection and try again");
    }
  };

  // search/vendor and refresh go in the top bar; the sticky header holds
  // which table (only without the sidebar, which lists them), then that
  // table's own filters (passed in — the warehouse tables bring their own)
  const headerWith = filters => /*#__PURE__*/React.createElement("div", {
    ref: hdrRef,
    style: {
      position: "sticky",
      top: stickyTop || 0,
      zIndex: 10,
      background: "var(--paper)",
      paddingTop: filters ? 2 : 0,
      paddingBottom: filters ? 10 : 0
    }
  }, /*#__PURE__*/React.createElement(InBar, {
    slot: "search"
  }, /*#__PURE__*/React.createElement("input", {
    value: q,
    onChange: e => setQ(e.target.value),
    placeholder: table === "reorder" ? "Search name, SKU or notes…" : "Search name or SKU…",
    className: "barSearch",
    style: barSearch
  }), table === "reorder" && /*#__PURE__*/React.createElement("select", {
    value: vendor,
    onChange: e => setVendor(e.target.value),
    style: {
      ...sel,
      padding: "10px 12px",
      fontSize: 14.5,
      borderRadius: 4
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "all"
  }, "All vendors"), vendors.map(([v, n]) => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v, " (", n, ")")))), /*#__PURE__*/React.createElement(InBar, {
    slot: "actions"
  }, table !== "sales" && /*#__PURE__*/React.createElement("button", {
    onClick: refresh,
    disabled: refreshing || coolingDown,
    title: coolingDown ? `Updated ${timeAgo(doc.lastSyncAt)}. The button can be used once every 2h — available again in ${fmtLeft(cooldownLeft)}. It also refreshes on its own every 8h.` : "Pull the latest stock, reorder levels and open POs from Zoho. Your dates and notes are kept.",
    style: {
      ...btnSec,
      opacity: refreshing || coolingDown ? 0.55 : 1,
      cursor: refreshing || coolingDown ? "default" : "pointer"
    }
  }, refreshing ? "Refreshing…" : coolingDown ? `Updated ${timeAgo(doc.lastSyncAt)} · refresh again in ${fmtLeft(cooldownLeft)}` : doc.lastSyncAt ? `Refresh from Zoho · ${timeAgo(doc.lastSyncAt)}` : "Refresh from Zoho")), filters && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap"
    }
  }, filters));
  const header = headerWith([["below", `Below reorder level (${counts.below})`], ["short", `Needs ordering (${counts.short})`], ["restocked", `Restocked (${counts.restocked})`], ["all", `All (${counts.all})`]].map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setView(k),
    style: {
      ...catPill(view === k),
      textTransform: "none"
    }
  }, label)));
  if (table === "sales") return /*#__PURE__*/React.createElement("div", null, headerWith(null), /*#__PURE__*/React.createElement(SalesTable, {
    q: q
  }));
  if (table === "ceramitec") return /*#__PURE__*/React.createElement("div", null, headerWith(null), /*#__PURE__*/React.createElement(CeramitecBundles, {
    rows: ceramitec,
    manual: doc.manual,
    onSave: saveManual,
    zoho: ws ? zohoBySku : null
  }));
  if (table in whTables) return /*#__PURE__*/React.createElement(WarehouseStock, {
    key: table,
    ws: ws,
    rows: whTables[table],
    q: q,
    kind: table,
    headerWith: headerWith,
    topOffset: (stickyTop || 0) + hdrH
  });
  if (!doc.lastSyncAt) return /*#__PURE__*/React.createElement("div", null, header, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 26,
      margin: "0 0 6px"
    }
  }, "Not pulled from Zoho yet"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      maxWidth: 440,
      margin: "0 auto",
      lineHeight: 1.5
    }
  }, "Click ", /*#__PURE__*/React.createElement("b", null, "Refresh from Zoho"), " to load every Zoho Inventory item that's below its reorder level, with stock on hand and what's still to be received on open purchase orders.")));

  // one vendor picked → every row would say the same name, so drop the column
  const showVendor = vendor === "all";
  const th = (label, col, align) => /*#__PURE__*/React.createElement("div", {
    onClick: col ? () => toggleSort(col) : undefined,
    style: {
      textAlign: align || "left",
      cursor: col ? "pointer" : "default",
      userSelect: "none"
    }
  }, label, col && sortArrow(col));
  return /*#__PURE__*/React.createElement("div", null, header, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: (showVendor ? 1170 : 1030) + (salesById ? 42 : 0)
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...reorderGrid(showVendor, !!salesById),
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: "var(--muted)"
    }
  }, th("Name", "name"), showVendor && th("Vendor", "vendor"), th("Reorder level", null, "center"), th("Stock on hand", "stock", "center"), th("To be received", "receive", "center"), th("Expected by", "expected"), th("Notes"), th("Still short", "short", "center"), salesById && th("Sold (1 yr)", null, "center")), !shown.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "30px 16px",
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 14
    }
  }, view === "below" && !q && vendor === "all" ? "Nothing below its reorder level right now." : "No items match."), shown.map(r => /*#__PURE__*/React.createElement(ReorderRow, {
    key: r.id,
    r: r,
    onSave: saveRow,
    showVendor: showVendor,
    sold: salesById ? salesById.get(r.id) || null : undefined
  })))), /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 10
    }
  }, shown.length, " item", shown.length === 1 ? "" : "s", " \xB7 numbers from Zoho Inventory (also refreshed automatically every 8 hours). \"To be received\" counts open purchase orders only. \"Still short\" = reorder level \u2212 stock on hand \u2212 to be received."));
}

// how many more to order once open POs land: reorder level − stock − incoming
const shortOf = r => Math.max(0, (r.reorderLevel || 0) - (r.stockOnHand || 0) - (r.toReceive || 0));

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
    ...(y !== today.getFullYear() && {
      year: "numeric"
    })
  });
  const rel = days === 0 ? "today" : days === 1 ? "tomorrow" : days > 0 ? `in ${days} days` : days === -1 ? "1 day late" : `${-days} days late`;
  return {
    label,
    rel,
    late: days < 0,
    days
  };
}
function ExpectedDateCell({
  value,
  onChange
}) {
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
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    ref: ref,
    type: "date",
    value: value || "",
    onChange: e => onChange(e.target.value),
    tabIndex: -1,
    "aria-hidden": "true",
    style: {
      position: "absolute",
      left: 0,
      bottom: 0,
      width: 1,
      height: 1,
      opacity: 0,
      border: 0,
      padding: 0
    }
  }), d ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: open,
    title: "Change date",
    style: {
      ...cellLink,
      textAlign: "left"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      color: d.late ? "var(--clay)" : "var(--ink)"
    }
  }, d.label), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: d.late ? "var(--clay)" : "var(--muted)"
    }
  }, d.rel)), /*#__PURE__*/React.createElement("button", {
    onClick: () => onChange(""),
    title: "Clear date",
    style: {
      ...xBtn,
      fontSize: 12
    }
  }, "\u2715")) : /*#__PURE__*/React.createElement("button", {
    onClick: open,
    style: {
      ...cellLink,
      color: "var(--muted)",
      fontSize: 12.5
    }
  }, "+ Add date"));
}

// Pieces sold and their value per item over any dates, optionally beside the
// same dates a year earlier. scripts/zoho-sales.js sends per-day totals by
// item (see lib/zohoSales.js for what counts as a sale), so any range adds up
// here without another call.
const rupees = n => "₹" + Math.round(n || 0).toLocaleString("en-IN");
// big rupee amounts in lakh / crore, for the summary tiles
const rupeesShort = n => n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : rupees(n);
const pcs = n => Math.round(n || 0).toLocaleString("en-IN");
// packaging: never charged for and named like packaging, so a real product
// that only went out free still counts as a product
const PACKAGING_WORDS = /\b(box(es)?|cutouts?|bags?|envelopes?|cartons?)\b/i;
const isPackaging = (name, everValue) => everValue === 0 && PACKAGING_WORDS.test(name || "");
// "2026-03-31" less 1 month → "2026-02-28" (same rule as lib/zohoSales.js)
function monthsBackISO(date, months) {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}
const SALES_PRESETS = [["1m", "1 month", 1], ["3m", "3 months", 3], ["6m", "6 months", 6], ["1y", "1 year", 12]];
const fmtDay = d => new Date(d + "T00:00:00").toLocaleDateString("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric"
});
// what the chosen dates are compared with
const COMPARE_MODES = [["off", "Off"], ["prev", "Previous period"], ["year", "Last year"], ["2y", "2 years ago"]];
const COMPARE_SHORT = {
  prev: "previous period",
  year: "last year",
  "2y": "2 years ago"
};
const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
// prev: the same number of days just before; year / 2y: the same dates back
function compareRange(range, mode) {
  if (!range || mode === "off") return null;
  if (mode === "prev") {
    const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / DAY_MS) + 1;
    return {
      from: addDays(range.from, -days),
      to: addDays(range.from, -1)
    };
  }
  const back = mode === "2y" ? 24 : 12;
  return {
    from: monthsBackISO(range.from, back),
    to: monthsBackISO(range.to, back)
  };
}
const changePct = (now, before) => before ? Math.round((now - before) / before * 100) : null;
// how an item moved against last year, for the filter above the table
const trendOf = r => !r.lastPieces ? "new" : !r.pieces ? "stopped" : r.pieces > r.lastPieces ? "up" : r.pieces < r.lastPieces ? "down" : "same";
const TRENDS = [["all", "All"], ["up", "Selling more"], ["down", "Selling less"], ["new", "New"], ["stopped", "Stopped"]];
const dateInput = {
  padding: "5px 8px",
  border: "1px solid var(--line)",
  borderRadius: 4,
  font: "inherit",
  fontSize: 13,
  background: "#fff",
  color: "var(--ink)"
};

// the 12 calendar months ending this month, as "2026-11"
const lastTwelveMonths = today => {
  const out = [];
  for (let i = 11; i >= 0; i--) out.push(monthsBackISO(today, i).slice(0, 7));
  return out;
};
// the current month is only part-way through, so it's marked
const monthName = (m, today) => new Date(m + "-01T00:00:00").toLocaleDateString("en-IN", {
  month: "short"
}) + (m === today.slice(0, 7) ? " (so far)" : "");

// an item's pieces per month as a line, the latest month marked
function Sparkline({
  series,
  months,
  today,
  width = 110,
  height = 28
}) {
  const max = Math.max(1, ...series);
  const step = width / (series.length - 1);
  const yOf = v => (height - 3 - v / max * (height - 6)).toFixed(1);
  const points = series.map((v, i) => `${(i * step).toFixed(1)},${yOf(v)}`).join(" ");
  return /*#__PURE__*/React.createElement("svg", {
    width: width,
    height: height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": "Pieces per month"
  }, /*#__PURE__*/React.createElement("title", null, months.map((m, i) => `${monthName(m, today)}: ${pcs(series[i])}`).join("\n")), /*#__PURE__*/React.createElement("polyline", {
    points: points,
    fill: "none",
    stroke: "var(--muted)",
    strokeOpacity: "0.55",
    strokeWidth: "2",
    strokeLinejoin: "round",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: width - 1,
    cy: yOf(series[series.length - 1]),
    r: "3",
    fill: "var(--ink)"
  }));
}

// light to dark brass: one hue, so darker simply means more
const HEAT_RAMP = ["#f6efe1", "#ead8b4", "#d9bd85", "#c29f5a", "#a8843f", "#7f6128", "#5a4417"];
// items down, months across; each row shaded against its own busiest month, so
// it shows when an item peaks rather than which item sells most. before: the
// label for the earlier year when comparing ("a year before"), else null, and
// each box then shows that year's same month underneath
function SeasonMap({
  rows,
  months,
  today,
  before
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      fontSize: 12.5,
      color: "var(--muted)",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      marginRight: 4
    }
  }, "Quieter month"), HEAT_RAMP.map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    style: {
      width: 14,
      height: 12,
      borderRadius: 2,
      background: c,
      display: "inline-block"
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 4
    }
  }, "Busier month")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 10px",
      fontSize: 12.5,
      color: "var(--muted)",
      lineHeight: 1.5
    }
  }, "Each box is the pieces of that item sold in that month, over the last 12 months whatever dates are picked above. Darker boxes are that item's busiest months, so you can see when it peaks and order ahead.", before ? ` The small number underneath is the same month ${before}.` : " Turn on Compare to see the same months a year or two before."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("table", {
    style: {
      width: "100%",
      minWidth: 860,
      borderCollapse: "collapse",
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      ...heatHead,
      textAlign: "left",
      padding: "10px 14px"
    }
  }, "Item"), months.map(m => /*#__PURE__*/React.createElement("th", {
    key: m,
    style: heatHead
  }, monthName(m, today))), /*#__PURE__*/React.createElement("th", {
    style: {
      ...heatHead,
      textAlign: "right",
      padding: "10px 14px"
    }
  }, "12 months"))), /*#__PURE__*/React.createElement("tbody", null, !rows.length && /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("td", {
    colSpan: 14,
    style: {
      padding: "30px 16px",
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "No items match.")), rows.map(r => {
    const max = Math.max(1, ...r.series);
    return /*#__PURE__*/React.createElement("tr", {
      key: r.id
    }, /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 14px",
        borderBottom: "1px solid var(--line)",
        fontWeight: 600,
        minWidth: 180,
        maxWidth: 260,
        lineHeight: 1.3
      }
    }, r.name), r.series.map((v, i) => {
      const step = v ? Math.min(HEAT_RAMP.length - 1, 1 + Math.floor(v / max * (HEAT_RAMP.length - 1.01))) : 0;
      return /*#__PURE__*/React.createElement("td", {
        key: i,
        title: `${r.name} · ${monthName(months[i], today)}: ${pcs(v)} pcs${before ? ` (same month ${before}: ${pcs(r.beforeSeries[i])})` : ""}`,
        style: {
          background: HEAT_RAMP[step],
          color: step >= 4 ? "#fff" : "var(--ink)",
          border: "2px solid var(--card)",
          height: before ? 38 : 30,
          lineHeight: 1.15,
          minWidth: 44,
          textAlign: "center",
          fontSize: 11.5,
          fontVariantNumeric: "tabular-nums"
        }
      }, v ? pcs(v) : "", before && /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 10,
          opacity: 0.75
        }
      }, r.beforeSeries[i] ? pcs(r.beforeSeries[i]) : "–"));
    }), /*#__PURE__*/React.createElement("td", {
      style: {
        padding: "6px 14px",
        borderBottom: "1px solid var(--line)",
        textAlign: "right",
        fontWeight: 700
      }
    }, pcs(r.series.reduce((a, b) => a + b, 0)), before && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        fontWeight: 500,
        color: "var(--muted)"
      }
    }, pcs(r.beforeSeries.reduce((a, b) => a + b, 0)), " before")));
  })))));
}
const heatHead = {
  fontSize: 11,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--muted)",
  fontWeight: 700,
  padding: "10px 2px",
  textAlign: "center",
  borderBottom: "1px solid var(--line)",
  whiteSpace: "nowrap"
};

// ▲ 7% / ▼ 32%. Green and red look alike to colour-blind readers, so the arrow
// and sign carry the direction and the colour only repeats it
function Delta({
  pct,
  size = 12.5
}) {
  if (pct == null) return null;
  const up = pct >= 0;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: size,
      fontWeight: 600,
      whiteSpace: "nowrap",
      color: "var(--ink)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: up ? "var(--sage)" : "var(--clay)"
    }
  }, up ? "▲" : "▼"), " ", Math.abs(pct), "%");
}

// a headline number, against the compared dates
function StatTile({
  label,
  now,
  last,
  format,
  partial,
  against
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 180px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      padding: "12px 14px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted)",
      fontWeight: 600
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 24,
      fontWeight: 700,
      color: "var(--ink)"
    }
  }, format(now)), !partial && /*#__PURE__*/React.createElement(Delta, {
    pct: changePct(now, last),
    size: 13.5
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: "var(--muted)",
      marginTop: 2
    }
  }, partial ? `${against}: incomplete` : `${against}: ${format(last)}`));
}

// change against the compared dates: the difference in pieces and the %
function ChangeBar({
  r
}) {
  const pct = changePct(r.pieces, r.lastPieces);
  const diff = r.pieces - r.lastPieces;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 8
    },
    title: `${pcs(r.pieces)} pcs vs ${pcs(r.lastPieces)} pcs before`
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--ink)",
      fontWeight: 600,
      whiteSpace: "nowrap"
    }
  }, diff > 0 ? "+" : diff < 0 ? "−" : "", pcs(Math.abs(diff))), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 54,
      textAlign: "left"
    }
  }, pct == null ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "new") : /*#__PURE__*/React.createElement(Delta, {
    pct: pct
  })));
}
function SalesTable({
  q
}) {
  const [doc, setDoc] = useState(null);
  const [preset, setPreset] = useState("1y");
  const [custom, setCustom] = useState({
    from: "",
    to: ""
  });
  const [view, setView] = useState("list"); // list | season
  const [compareMode, setCompareMode] = useState("off");
  const compare = compareMode !== "off";
  const [trend, setTrend] = useState("all");
  const [sortBy, setSortBy] = useState("pieces");
  const [ascending, setAscending] = useState(false);
  // what went out at ₹0 is kept apart from what's sold
  const [packaging, setPackaging] = useState(false);
  useEffect(() => {
    fetch("/api/sales").then(r => r.ok ? r.json() : Promise.reject(r.status)).then(setDoc).catch(status => setDoc({
      rows: [],
      failed: status === 401 ? "signin" : "error"
    }));
  }, []);
  const today = doc && doc.today;
  const range = useMemo(() => {
    if (!today) return null;
    if (preset === "custom") {
      const from = custom.from || monthsBackISO(today, 1);
      const to = custom.to || today;
      return from <= to ? {
        from,
        to
      } : {
        from: to,
        to: from
      };
    }
    // the day after "n months ago", so the range is exactly n months and the
    // compared dates a year back don't share its first day
    return {
      from: addDays(monthsBackISO(today, SALES_PRESETS.find(p => p[0] === preset)[2]), 1),
      to: today
    };
  }, [today, preset, custom]);
  const lastYear = compareRange(range, compareMode);
  const against = COMPARE_SHORT[compareMode];
  // the compared dates start before the first order kept, so their numbers are low
  // while older orders are still loading, only what's in so far counts as kept
  const keptFrom = doc && (doc.pending > 0 ? doc.firstKept || doc.keptFrom : doc.keptFrom || doc.firstKept);
  const lastYearPartial = !!(compare && keptFrom && lastYear && lastYear.from < keptFrom);
  const months = useMemo(() => today ? lastTwelveMonths(today) : [], [today]);
  // the season map's earlier year: two years back for "2 years ago", else one
  const seasonBack = compareMode === "2y" ? 24 : 12;
  const beforeMonths = useMemo(() => months.map(m => monthsBackISO(m + "-01", seasonBack).slice(0, 7)), [months, seasonBack]);
  const everything = useMemo(() => {
    if (!doc || !doc.daily || !range) return [];
    const monthIndex = new Map(months.map((m, i) => [m, i]));
    const beforeIndex = new Map(beforeMonths.map((m, i) => [m, i]));
    const out = [];
    for (const [id, days] of Object.entries(doc.daily)) {
      const item = doc.items[id] || {};
      let pieces = 0,
        value = 0,
        lastPieces = 0,
        lastValue = 0,
        ever = 0;
      const series = months.map(() => 0);
      const beforeSeries = months.map(() => 0);
      for (const [d, p, v] of days) {
        ever += v;
        const mi = monthIndex.get(d.slice(0, 7));
        if (mi != null) series[mi] += p;
        const bi = beforeIndex.get(d.slice(0, 7));
        if (bi != null) beforeSeries[bi] += p;
        if (d >= range.from && d <= range.to) {
          pieces += p;
          value += v;
        }
        if (lastYear && d >= lastYear.from && d <= lastYear.to) {
          lastPieces += p;
          lastValue += v;
        }
      }
      const inRange = !!(pieces || compare && lastPieces);
      const seasonTotal = series.reduce((a, b) => a + b, 0);
      if (!inRange && !seasonTotal) continue;
      out.push({
        inRange,
        seasonTotal,
        id,
        name: item.name || id,
        sku: item.sku || "",
        pieces,
        value,
        lastPieces,
        lastValue,
        delta: pieces - lastPieces,
        change: changePct(pieces, lastPieces),
        valueChange: changePct(value, lastValue),
        packaging: isPackaging(item.name, ever),
        series,
        beforeSeries
      });
    }
    return out;
  }, [doc, range, compareMode, months, beforeMonths]);
  const all = useMemo(() => everything.filter(r => r.inRange), [everything]);
  const seasonRows = useMemo(() => everything.filter(r => r.seasonTotal > 0 && r.packaging === packaging && matchText(q, `${r.name} ${r.sku}`)).sort((a, b) => b.seasonTotal - a.seasonTotal || a.name.localeCompare(b.name)), [everything, packaging, q]);
  const inTab = useMemo(() => all.filter(r => r.packaging === packaging), [all, packaging]);
  const trendCounts = useMemo(() => {
    const c = {
      all: inTab.length
    };
    for (const r of inTab) c[trendOf(r)] = (c[trendOf(r)] || 0) + 1;
    return c;
  }, [inTab]);
  const useTrend = compare && !lastYearPartial ? trend : "all";
  const shown = useMemo(() => {
    const rows = inTab.filter(r => (useTrend === "all" || trendOf(r) === useTrend) && matchText(q, `${r.name} ${r.sku}`));
    const dir = ascending ? 1 : -1;
    const byName = (a, b) => a.name.localeCompare(b.name);
    return rows.sort((a, b) => {
      if (sortBy === "name") return dir * byName(a, b);
      // items with nothing to compare always go last
      if (a[sortBy] == null !== (b[sortBy] == null)) return a[sortBy] == null ? 1 : -1;
      return dir * ((a[sortBy] || 0) - (b[sortBy] || 0)) || byName(a, b);
    });
  }, [inTab, q, sortBy, ascending, useTrend]);
  const totals = useMemo(() => inTab.reduce((t, r) => ({
    pieces: t.pieces + r.pieces,
    value: t.value + r.value,
    lastPieces: t.lastPieces + r.lastPieces,
    lastValue: t.lastValue + r.lastValue
  }), {
    pieces: 0,
    value: 0,
    lastPieces: 0,
    lastValue: 0
  }), [inTab]);
  const packagingCount = useMemo(() => all.filter(r => r.packaging).length, [all]);
  if (!doc) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Loading\u2026");
  if (doc.failed) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: "center",
      color: "var(--clay)"
    }
  }, doc.failed === "signin" ? "You've been signed out. Sign in again to see sales." : "Couldn't load sales. Try again in a minute.");
  if (!doc.daily) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: "center",
      color: "var(--muted)"
    }
  }, "Sales are being updated for custom dates. Check back after the next sales refresh.");
  const cols = compare ? "28px minmax(200px, 1fr) 116px 100px 130px 120px 70px" : "28px minmax(220px, 1fr) 116px 110px 130px";
  const head = (label, key, align, title) => /*#__PURE__*/React.createElement("div", {
    title: title,
    onClick: () => {
      setAscending(sortBy === key ? !ascending : key === "name");
      setSortBy(key);
    },
    style: {
      textAlign: align,
      cursor: "pointer",
      userSelect: "none"
    }
  }, label, sortBy === key && (ascending ? " ▲" : " ▼"));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 12px",
      fontSize: 12.5,
      color: "var(--muted)"
    }
  }, `From Zoho sales orders, updated ${timeAgo(doc.lastSyncAt)}. Values exclude tax and shipping.`, doc.pending > 0 && ` Still loading ${doc.pending} older orders, so some numbers are low for now.`), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center",
      marginBottom: 10
    }
  }, SALES_PRESETS.map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setPreset(k),
    style: catPill(preset === k)
  }, label)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      if (!custom.from && range) setCustom({
        from: range.from,
        to: range.to
      });
      setPreset("custom");
    },
    style: catPill(preset === "custom")
  }, "Custom"), preset === "custom" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("input", {
    type: "date",
    "aria-label": "From",
    value: custom.from,
    min: keptFrom || undefined,
    max: today,
    onChange: e => setCustom(c => ({
      ...c,
      from: e.target.value
    })),
    style: dateInput
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 13
    }
  }, "to"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    "aria-label": "To",
    value: custom.to,
    min: keptFrom || undefined,
    max: today,
    onChange: e => setCustom(c => ({
      ...c,
      to: e.target.value
    })),
    style: dateInput
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center",
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--muted)",
      marginRight: 2
    }
  }, "Compare with"), COMPARE_MODES.map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => {
      setCompareMode(k);
      // comparing is about what moved, so lead with the biggest change
      if (k === "off" !== (compareMode === "off")) {
        setSortBy(k === "off" ? "pieces" : "delta");
        setAscending(false);
      }
      setTrend("all");
    },
    style: catPill(compareMode === k)
  }, label))), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "0 0 12px",
      fontSize: 13.5
    }
  }, /*#__PURE__*/React.createElement("b", null, fmtDay(range.from), " \u2013 ", fmtDay(range.to)), compare ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, ` vs ${fmtDay(lastYear.from)} – ${fmtDay(lastYear.to)}`) : `: ${pcs(totals.pieces)} pcs · ${rupees(totals.value)}`, lastYearPartial && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 12,
      color: "var(--amber)",
      marginTop: 2
    }
  }, "Orders are only kept from ", fmtDay(keptFrom), ", so the ", against, " numbers are incomplete.")), compare && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap",
      marginBottom: 14
    }
  }, /*#__PURE__*/React.createElement(StatTile, {
    label: "Pieces sold",
    now: totals.pieces,
    last: totals.lastPieces,
    format: pcs,
    partial: lastYearPartial,
    against: against
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Value",
    now: totals.value,
    last: totals.lastValue,
    format: rupeesShort,
    partial: lastYearPartial,
    against: against
  }), /*#__PURE__*/React.createElement(StatTile, {
    label: "Value per piece",
    now: totals.pieces ? totals.value / totals.pieces : 0,
    last: totals.lastPieces ? totals.lastValue / totals.lastPieces : 0,
    format: rupees,
    partial: lastYearPartial,
    against: against
  })), /*#__PURE__*/React.createElement(PageSwitch, {
    value: view,
    onChange: setView,
    options: [["list", "Ranked list"], ["season", "Season map"]]
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center",
      marginBottom: 10
    }
  }, [[false, `Products (${(all.length - packagingCount).toLocaleString("en-IN")})`], [true, `Packaging (${packagingCount.toLocaleString("en-IN")})`]].map(([on, label]) => /*#__PURE__*/React.createElement("button", {
    key: label,
    onClick: () => setPackaging(on),
    style: catPill(packaging === on)
  }, label)), compare && !lastYearPartial && view === "list" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 1,
      height: 20,
      background: "var(--line)",
      margin: "0 6px"
    }
  }), TRENDS.map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setTrend(k),
    style: catPill(trend === k)
  }, label, " (", (trendCounts[k] || 0).toLocaleString("en-IN"), ")")))), view === "season" ? /*#__PURE__*/React.createElement(SeasonMap, {
    rows: seasonRows,
    months: months,
    today: today,
    before: compare ? seasonBack === 24 ? "2 years before" : "a year before" : null
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: compare ? 830 : 640
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: cols,
      gap: 10,
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement("div", null, "#"), head("Name", "name", "left"), /*#__PURE__*/React.createElement("div", {
    title: "Pieces per month"
  }, "Last 12 months"), head("Pieces", "pieces", "right"), compare && head("Change", "delta", "right", `Difference in pieces against the ${against}`), head("Value", "value", "right"), compare && head("Value ±", "valueChange", "right", `Change in value against the ${against}`)), !shown.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "30px 16px",
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 14
    }
  }, "Nothing sold in these dates."), shown.map((r, i) => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      display: "grid",
      gridTemplateColumns: cols,
      gap: 10,
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      alignItems: "center",
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "var(--muted)"
    }
  }, i + 1), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, r.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, r.sku)), /*#__PURE__*/React.createElement(Sparkline, {
    series: r.series,
    months: months,
    today: today
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, pcs(r.pieces)), compare && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, pcs(r.lastPieces), " before")), compare && (lastYearPartial ? /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right",
      color: "var(--muted)"
    }
  }, "\u2014") : /*#__PURE__*/React.createElement(ChangeBar, {
    r: r
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", null, rupees(r.value)), compare && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, rupees(r.lastValue), " before")), compare && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "right"
    }
  }, lastYearPartial ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "\u2014") : r.valueChange == null ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)"
    }
  }, "new") : /*#__PURE__*/React.createElement(Delta, {
    pct: r.valueChange
  })))))));
}

// Ceramitec's pre-packed sets — single Shopify products, not Zoho items.
// Stock on hand is Shopify's (via the Shopify sync); to be received, expected
// date and notes are typed in here (doc.manual, keyed by SKU).
function CeramitecBundles({
  rows,
  manual,
  onSave,
  zoho
}) {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflowX: "auto"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 940
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...ceramitecGrid,
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement("div", null, "Name"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, "Shopify stock"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    },
    title: "Available in Zoho (on hand \u2212 committed)"
  }, "Zoho available"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, "To be received"), /*#__PURE__*/React.createElement("div", null, "Expected by"), /*#__PURE__*/React.createElement("div", null, "Notes")), !rows.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "30px 16px",
      textAlign: "center",
      color: "var(--muted)",
      fontSize: 14
    }
  }, "No items match."), rows.map(({
    sku,
    p
  }) => {
    const m = (manual || {})[sku.toUpperCase()] || {};
    return /*#__PURE__*/React.createElement("div", {
      key: sku,
      style: {
        ...ceramitecGrid,
        padding: "10px 16px",
        borderBottom: "1px solid var(--line)",
        alignItems: "center",
        fontSize: 14
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 600,
        color: p ? "var(--ink)" : "var(--muted)"
      }
    }, p ? p.name : "Not in the catalog yet — run Sync with Shopify"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "var(--muted)"
      }
    }, sku)), /*#__PURE__*/React.createElement("div", {
      style: {
        ...midCell,
        fontWeight: 600,
        color: !p || !p.stockTracked ? "var(--muted)" : (p.stock || 0) <= 0 ? "var(--clay)" : p.stock < 10 ? "var(--amber)" : "var(--sage)"
      }
    }, !p ? "—" : p.stockTracked ? p.stock || 0 : "not tracked"), /*#__PURE__*/React.createElement(ZohoStockCell, {
      z: zoho && zoho.get(normSku(sku)),
      hasZoho: !!zoho,
      p: p
    }), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement(QtyCell, {
      value: m.toReceive,
      onSave: v => onSave(sku, {
        toReceive: v
      })
    })), /*#__PURE__*/React.createElement(ExpectedDateCell, {
      value: m.expectedDate || "",
      onChange: v => onSave(sku, {
        expectedDate: v
      })
    }), /*#__PURE__*/React.createElement(NotesCell, {
      value: m.notes,
      onSave: v => onSave(sku, {
        notes: v
      })
    }));
  }))), /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 10
    }
  }, "Pre-packed Ceramitec sets, sold as single products on Shopify. Shopify stock is what's entered on Shopify (updated on every Shopify sync); Zoho available is on hand \u2212 committed in Zoho, flagged when the two disagree. To be received, dates and notes are filled in here."));
}

// one warehouse-stock row's totals (see fetchWarehouseStock). On hand is
// Zoho's total; rows stored before `total` was added → just the warehouses.
function whTotals(r, whs) {
  let inWarehouses = 0,
    committed = 0;
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
    short: below ? Math.max(0, reorderLevel - onHand - incoming) : 0
  };
}

// Zoho stock split by warehouse — on hand and committed per warehouse, then
// totals matching Zoho's "Accounting Stock" box. On hand is Zoho's total,
// which also counts stock on a transfer that's left one warehouse and not
// arrived at the other — shown as "in transit".
function WarehouseStock({
  ws,
  rows,
  q,
  kind,
  headerWith,
  topOffset
}) {
  const [filter, setFilter] = useState("all"); // all | oos | below | short | committed | transit
  const [sortBy, setSortBy] = useState("name"); // name | wh:<id> | transit | incoming | onHand | committed | available
  // the PO / TO opened from an Incoming / In transit cell:
  // {kind: "po" | "to", id, fromId} (fromId = the row clicked)
  const [openDoc, setOpenDoc] = useState(null);
  const onDoc = React.useCallback((kind, id, fromId) => setOpenDoc({
    kind,
    id,
    fromId
  }), []);
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
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) setLimit(n => n + WH_PAGE);
    }, {
      root: boxRef.current,
      rootMargin: "400px"
    });
    io.observe(el);
    return () => io.disconnect();
  });
  const grid = useMemo(() => ({
    display: "grid",
    // … warehouses · in transit · incoming · on hand · committed · available
    // wide enough for each heading on one line ("WARE INNOVATIONS ↕")
    gridTemplateColumns: `minmax(120px,2fr) repeat(${whs.length}, minmax(128px,1fr)) ${WH_TOTALS_COLS}`,
    gap: 10
  }), [whs.length]);
  const withTotals = useMemo(() => rows.map(r => ({
    ...r,
    ...whTotals(r, whs)
  })), [rows, whs]);
  // out of stock = nothing left to sell (committed can eat what's on hand)
  const isOos = r => r.tracked && r.available <= 0;
  const counts = useMemo(() => ({
    all: withTotals.length,
    oos: withTotals.filter(isOos).length,
    below: withTotals.filter(r => r.below).length,
    short: withTotals.filter(r => r.short > 0).length,
    committed: withTotals.filter(r => r.committed > 0).length,
    transit: withTotals.filter(r => r.transit !== 0).length
  }), [withTotals]);
  const shown = useMemo(() => {
    const keep = {
      all: () => true,
      oos: isOos,
      below: r => r.below,
      short: r => r.short > 0,
      committed: r => r.committed > 0,
      transit: r => r.transit !== 0
    }[filter];
    const list = withTotals.filter(r => keep(r) && matchText(dq, `${r.name} ${r.sku}`));
    const dir = sortDir === "asc" ? 1 : -1;
    const byName = (a, b) => a.name.localeCompare(b.name);
    // "wh:<id>" sorts by that warehouse's on hand
    const val = sortBy.startsWith("wh:") ? r => (r.byWarehouse[sortBy.slice(3)] || [0])[0] : r => r[sortBy];
    list.sort((a, b) => sortBy === "name" ? dir * byName(a, b) : dir * (val(a) - val(b)) || byName(a, b));
    return list;
  }, [withTotals, filter, dq, sortBy, sortDir]);
  if (!ws) return /*#__PURE__*/React.createElement("div", null, headerWith(null), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      color: "var(--muted)",
      lineHeight: 1.5
    }
  }, "Not pulled yet \u2014 it comes in with the next ", /*#__PURE__*/React.createElement("b", null, "Refresh from Zoho"), "."));
  const toggleSort = col => {
    if (sortBy === col) setSortDir(d => d === "asc" ? "desc" : "asc");else {
      setSortBy(col);
      setSortDir(col === "name" ? "asc" : "desc");
    }
  };
  const th = (label, col, title) => /*#__PURE__*/React.createElement("div", {
    onClick: () => toggleSort(col),
    title: title || (col === "name" ? "Sort A–Z" : "Click to sort — highest first, again for lowest"),
    style: {
      ...(col === "name" ? whStickyName : null),
      textAlign: col === "name" ? "left" : "center",
      whiteSpace: "nowrap",
      cursor: "pointer",
      userSelect: "none"
    }
  }, label, sortBy === col ? sortDir === "asc" ? " ▲" : " ▼" : /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.4
    }
  }, " \u2195"));
  // the group label over each block of columns
  const group = (label, span, color, line) => /*#__PURE__*/React.createElement("div", {
    style: {
      gridColumn: `span ${span}`,
      textAlign: "center",
      paddingBottom: 6,
      borderBottom: `2px solid ${line}`,
      color
    }
  }, label);
  return (
    /*#__PURE__*/
    // a touch darker grey / amber than the rest of the app: this tab is mostly
    // small numbers and labels, which the lighter shades made hard to read.
    // --plum marks transfer orders, so they don't read as POs (clay)
    React.createElement("div", {
      style: {
        "--muted": "#6f6658",
        "--amber": "#8a6112",
        "--plum": "#7a4a72"
      }
    }, headerWith(/*#__PURE__*/React.createElement("div", {
      style: whTiles
    }, [["all", "All items", "Every row in this table", "var(--ink)"], ["oos", "Out of stock", "Nothing left to sell", "var(--clay)"], ["below", "Below reorder", "On hand under the reorder point", "var(--amber)"], ["short", "Still short", "Even after open POs", "var(--clay)"], ["committed", "Has committed", "On sales orders, not shipped", "var(--amber)"], ["transit", "In transit", "On a transfer between warehouses", "var(--plum)"]].map(([k, label, hint, color]) => /*#__PURE__*/React.createElement("button", {
      key: k,
      onClick: () => setFilter(k),
      "aria-pressed": filter === k,
      title: hint,
      style: whTile(filter === k)
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontWeight: 700,
        color: counts[k] ? color : "var(--muted)"
      }
    }, counts[k]), /*#__PURE__*/React.createElement("span", {
      style: {
        color: filter === k ? "var(--ink)" : "var(--muted)"
      }
    }, label))))), /*#__PURE__*/React.createElement("div", {
      ref: boxRef,
      className: "noScrollbar",
      style: {
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        overflow: "auto",
        maxHeight: `calc(var(--vh) - ${(topOffset || 0) + 16}px)`
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 120 + 472 + 6 * 10 + 32 + whs.length * 138
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        position: "sticky",
        top: 0,
        zIndex: 2,
        background: "var(--card)",
        borderBottom: "1px solid var(--line)",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--muted)"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...grid,
        padding: "10px 16px 0",
        fontSize: 10.5,
        letterSpacing: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: whStickyName
    }), group("Stock by warehouse", whs.length, "var(--muted)", "var(--line)"), group("On the way", 2, "var(--muted)", "var(--line)"), group("Totals", 3, "var(--sage)", "var(--sageDim)")), /*#__PURE__*/React.createElement("div", {
      style: {
        ...grid,
        padding: "10px 16px"
      }
    }, th("Name", "name"), whs.map(w => /*#__PURE__*/React.createElement(React.Fragment, {
      key: w.id
    }, th(w.name, `wh:${w.id}`, "On hand here, with committed (on sales orders, not shipped yet) under it — click to sort"))), th("In transit", "transit", "On a transfer between your warehouses, not received yet — click a TO to see it — click to sort"), th("Incoming", "incoming", "Still to come on open purchase orders — click a PO to see it — click to sort"), th("On hand", "onHand"), th("Committed", "committed"), th("Available", "available"))), !shown.length && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "30px 16px",
        textAlign: "center",
        color: "var(--muted)",
        fontSize: 14
      }
    }, "No items match."), shown.slice(0, limit).map(r => /*#__PURE__*/React.createElement(WarehouseRow, {
      key: r.id,
      r: r,
      whs: whs,
      grid: grid,
      pos: ws.pos,
      tos: ws.tos,
      onDoc: onDoc
    })), shown.length > limit && /*#__PURE__*/React.createElement("div", {
      ref: moreRef,
      style: {
        textAlign: "center",
        padding: "12px 0"
      }
    }, /*#__PURE__*/React.createElement("button", {
      onClick: () => setLimit(n => n + WH_PAGE),
      style: btnSec
    }, "Show more (", shown.length - limit, " left)")))), /*#__PURE__*/React.createElement("p", {
      style: {
        ...note,
        marginTop: 10
      }
    }, kind === "items" ? "Zoho items whose SKU is live on Shopify (active in this catalog), apart from the Marble Atelier line. " : kind === "marble" ? "The Marble Atelier line (Claude, Horizon, Arc, Pivot marble and Pivot vases) — live-on-Shopify items plus any composites. " : "Every active composite item in Zoho, apart from the Marble Atelier line. ", "Each warehouse shows stock on hand, with committed (on sales orders, not shipped yet) under it; a dash means zero. In transit is on a transfer between warehouses, not received yet; incoming is still to come on open POs (click a TO or PO number to see the whole order", ws.transferError ? " — TO links didn't load on the last refresh" : "", "). Under available: how short of the reorder point an item is after incoming, or \u2713 when POs cover it. On hand, committed and available match Zoho's Accounting Stock, leaving out inactive warehouses (Studio, Design Office). Out of stock = nothing available. Updated with every Zoho refresh", ws.syncedAt ? ` · last ${timeAgo(ws.syncedAt)}` : "", "."), openDoc && /*#__PURE__*/React.createElement(DocPanel, {
      ws: ws,
      kind: openDoc.kind,
      doc: ((openDoc.kind === "to" ? ws.tos : ws.pos) || {})[openDoc.id],
      fromId: openDoc.fromId,
      onClose: () => setOpenDoc(null)
    }))
  );
}

// a transfer order's route, short enough for a table cell: "Aaj → Ware"
const shortRoute = to => `${to.from.split(" ")[0]} → ${to.to.split(" ")[0]}`;

// one open PO or in-transit TO, opened from a warehouse table's Incoming /
// In transit cell: a side panel (the table stays in view) with everything
// still to come on it
function DocPanel({
  ws,
  kind,
  doc,
  fromId,
  onClose
}) {
  useEffect(() => {
    const onKey = e => e.key === "Escape" && onClose();
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
  const nowOf = l => {
    const r = rowById.get(l.itemId);
    if (!r) return null;
    return isTo ? (r.byWarehouse[doc.toWarehouseId] || [0])[0] : whTotals(r, ws.warehouses).available;
  };
  const exp = !isTo && doc.expected && describeDate(doc.expected);
  const sentDays = isTo && doc.date ? -describeDate(doc.date).days : null;
  const url = isTo ? ws.toUrl : ws.poUrl;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 50,
      background: "rgba(23,19,17,.4)",
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    role: "dialog",
    "aria-modal": "true",
    "aria-label": isTo ? `Transfer order ${doc.number}` : doc.number,
    style: {
      background: "var(--card)",
      width: "min(480px, 100%)",
      height: "100%",
      padding: "22px 24px",
      boxSizing: "border-box",
      overflowY: "auto",
      boxShadow: "-12px 0 40px rgba(0,0,0,.25)",
      display: "flex",
      flexDirection: "column",
      animation: "slideInRight .18s ease"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      color: isTo ? "var(--plum)" : "#a8401f"
    }
  }, isTo ? "Transfer order · in transit" : `Purchase order${doc.status ? ` · ${doc.status.replace(/_/g, " ")}` : ""}`), /*#__PURE__*/React.createElement("h3", {
    className: "serif",
    style: {
      margin: "2px 0 10px",
      fontSize: 26,
      fontWeight: 600
    }
  }, isTo ? `TO ${doc.number}` : doc.number), isTo ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 14px",
      borderRadius: 6,
      background: "var(--paper)",
      fontSize: 14,
      fontWeight: 600
    }
  }, doc.from, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      color: "var(--plum)"
    }
  }, "\u2192"), doc.to), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      color: "var(--muted)",
      lineHeight: 1.5,
      marginTop: 8
    }
  }, doc.date ? `Sent ${describeDate(doc.date).label} · on the way ${sentDays <= 0 ? "since today" : `${sentDays} day${sentDays === 1 ? "" : "s"}`}` : "No date", " · ", "left ", doc.from, "'s stock, not received yet")) : /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13.5,
      color: "var(--muted)",
      lineHeight: 1.5
    }
  }, doc.vendor || "No vendor", doc.date && ` · ordered ${describeDate(doc.date).label}`, " · ", exp ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: exp.late ? "var(--clay)" : "var(--muted)"
    }
  }, "expected ", exp.label, " (", exp.rel, ")") : "no expected date"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      margin: "14px 0 6px",
      fontWeight: 600
    }
  }, total, " ", isTo ? "on the way" : "still to come", ", ", doc.lines.length, " item", doc.lines.length === 1 ? "" : "s"), /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...poGrid,
      padding: "8px 12px",
      borderBottom: "1px solid var(--line)",
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: "var(--muted)"
    }
  }, /*#__PURE__*/React.createElement("div", null, "Item"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, isTo ? "Moving" : "Coming"), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center"
    }
  }, isTo ? `At ${doc.to.split(" ")[0]} now` : "Available now")), doc.lines.map((l, i) => {
    const now = nowOf(l);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        ...poGrid,
        padding: "8px 12px",
        borderBottom: i < doc.lines.length - 1 ? "1px solid var(--line)" : "none",
        alignItems: "center",
        fontSize: 13.5,
        background: l.itemId === fromId ? "var(--sageDim)" : "transparent"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontWeight: 600
      }
    }, l.name), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "var(--muted)"
      }
    }, l.sku)), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        fontWeight: 600
      }
    }, l.qty), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        color: now == null ? "var(--muted)" : isTo ? whNum(now) : whAvailColor(now)
      }
    }, now == null ? "—" : isTo ? dash(now) : now));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 10,
      marginTop: "auto",
      paddingTop: 16
    }
  }, url && /*#__PURE__*/React.createElement("a", {
    href: url + doc.id,
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      ...btnSec,
      textDecoration: "none",
      color: "var(--ink)"
    }
  }, "Open in Zoho \u2197"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    style: btnSec
  }, "Close"))));
}
const poGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 80px 110px",
  gap: 10
};
const WH_PAGE = 100;
// in transit · incoming · on hand · committed · available
const WH_TOTALS_COLS = "120px 96px 76px 92px 88px";
// the filter tiles over the warehouse tables
const whTiles = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6
};
const whTile = on => ({
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
  color: "var(--ink)"
});
// 0 reads as a dash, so the real numbers stand out
const dash = n => n === 0 ? "–" : n;
// a PO / TO number in a warehouse cell: a small tinted tag, clay for POs and
// plum for TOs, on a barely-there tint of the same colour
const docTag = kind => ({
  display: "inline-block",
  padding: "1px 8px",
  borderRadius: 999,
  fontSize: 11.5,
  fontWeight: 600,
  lineHeight: 1.5,
  background: kind === "to" ? "#f8f1f6" : "#fbf1eb",
  color: kind === "to" ? "var(--plum)" : "#a8401f"
});
// the name stays put while the numbers scroll sideways (phones)
const whStickyName = {
  position: "sticky",
  left: 0,
  zIndex: 1,
  background: "var(--card)",
  marginLeft: -16,
  paddingLeft: 16,
  minWidth: 0
};
// a plain number: grey when 0, red when negative
const whNum = n => n < 0 ? "var(--clay)" : n ? "var(--ink)" : "var(--muted)";
// Available: red when nothing's left to sell, amber when low, green otherwise
const whAvailColor = n => n <= 0 ? "var(--clay)" : n < 10 ? "var(--amber)" : "var(--sage)";

// one WarehouseStock row — memo'd so a click elsewhere (a filter, the
// refresh countdown) doesn't redraw every row
const WarehouseRow = React.memo(function WarehouseRow({
  r,
  whs,
  grid,
  pos,
  tos,
  onDoc
}) {
  const poIds = (r.poIds || []).filter(id => pos && pos[id]);
  const toIds = (r.toIds || []).filter(id => tos && tos[id]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      ...grid,
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      alignItems: "center",
      fontSize: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: whStickyName
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, r.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, r.sku || "No SKU")), whs.map(w => {
    const [h, c] = r.byWarehouse[w.id] || [0, 0];
    return /*#__PURE__*/React.createElement("div", {
      key: w.id,
      style: midCell
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        color: whNum(h)
      }
    }, dash(h)), c !== 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11.5,
        color: "var(--amber)"
      },
      title: "On sales orders, not shipped yet"
    }, c, " committed"));
  }), r.tracked ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: midCell
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: r.transit > 0 ? "var(--plum)" : whNum(r.transit),
      fontWeight: r.transit ? 600 : 400
    }
  }, dash(r.transit)), toIds.slice(0, 2).map(id => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => onDoc("to", id, r.id),
    title: `See everything on this transfer: ${tos[id].from} → ${tos[id].to}`,
    style: {
      ...cellLink,
      padding: 0,
      display: "block",
      margin: "3px auto 0"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: docTag("to")
  }, "TO ", tos[id].number), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 11,
      color: "var(--muted)",
      marginTop: 1
    }
  }, shortRoute(tos[id])))), toIds.length > 2 && /*#__PURE__*/React.createElement("button", {
    onClick: () => onDoc("to", toIds[2], r.id),
    title: toIds.slice(2).map(id => `TO ${tos[id].number}`).join(", "),
    style: {
      ...cellLink,
      fontSize: 11.5,
      padding: 0,
      color: "var(--muted)"
    }
  }, "+", toIds.length - 2, " more")), /*#__PURE__*/React.createElement("div", {
    style: midCell
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: whNum(r.incoming),
      fontWeight: r.incoming ? 600 : 400
    }
  }, dash(r.incoming)), poIds.slice(0, 2).map(id => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => onDoc("po", id, r.id),
    title: "See everything coming on this PO",
    style: {
      ...cellLink,
      padding: 0,
      display: "block",
      margin: "3px auto 0"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: docTag("po")
  }, pos[id].number))), poIds.length > 2 && /*#__PURE__*/React.createElement("button", {
    onClick: () => onDoc("po", poIds[2], r.id),
    title: poIds.slice(2).map(id => pos[id].number).join(", "),
    style: {
      ...cellLink,
      fontSize: 11.5,
      padding: 0,
      color: "var(--muted)"
    }
  }, "+", poIds.length - 2, " more")), /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      fontWeight: 600,
      color: whNum(r.onHand)
    }
  }, dash(r.onHand)), /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      fontWeight: r.committed ? 600 : 400,
      color: r.committed ? "var(--amber)" : "var(--muted)"
    }
  }, dash(r.committed)), /*#__PURE__*/React.createElement("div", {
    style: midCell,
    title: r.reorderLevel ? `Reorder point ${r.reorderLevel}` : undefined
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      color: whAvailColor(r.available)
    }
  }, r.available), r.below && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: r.short ? "var(--clay)" : "var(--sage)"
    }
  }, r.short ? `short ${r.short}` : "✓ PO covers"))) : /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      gridColumn: "span 5",
      color: "var(--muted)"
    }
  }, "not tracked"));
});

// a Ceramitec set's Zoho number, flagged when it doesn't match Shopify's
function ZohoStockCell({
  z,
  hasZoho,
  p
}) {
  if (!z) return /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      color: "var(--muted)"
    }
  }, hasZoho ? "not in Zoho" : "—");
  const differs = p && p.stockTracked && (p.stock || 0) !== z.available;
  return /*#__PURE__*/React.createElement("div", {
    style: midCell,
    title: `Zoho: ${z.onHand} on hand · ${z.committed} committed`
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600,
      color: differs ? "var(--amber)" : "var(--ink)"
    }
  }, z.available), differs && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--amber)"
    }
  }, "\u2260 Shopify"));
}

// hand-typed quantity (e.g. Ceramitec "to be received") — reads as a number,
// box on hover/focus, saves on blur or Enter; empty clears it
function QtyCell({
  value,
  onSave
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    const clean = draft.trim();
    if (clean === (value == null ? "" : String(value))) return;
    onSave(clean === "" ? "" : Math.max(0, Math.floor(Number(clean)) || 0));
  };
  return /*#__PURE__*/React.createElement("input", {
    className: "cellEdit",
    inputMode: "numeric",
    value: draft,
    onChange: e => setDraft(e.target.value.replace(/[^0-9]/g, "")),
    onBlur: commit,
    onKeyDown: e => e.key === "Enter" && e.target.blur(),
    placeholder: "Add qty",
    style: {
      width: 90,
      textAlign: "center",
      fontSize: 14,
      padding: "5px 8px",
      borderRadius: 4,
      fontFamily: "inherit",
      color: "var(--ink)"
    }
  });
}

// in-table notes: reads as text, saves on blur (or Enter), not per keystroke;
// Shift+Enter = new line. Grows to fit so nothing gets cut off.
function NotesCell({
  value,
  onSave
}) {
  const [draft, setDraft] = useState(value || "");
  useEffect(() => setDraft(value || ""), [value]);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  return /*#__PURE__*/React.createElement("textarea", {
    ref: ref,
    className: "cellEdit",
    rows: 1,
    value: draft,
    onChange: e => setDraft(e.target.value),
    onBlur: () => draft !== (value || "") && onSave(draft),
    onKeyDown: e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.target.blur();
      }
    },
    placeholder: "Add a note\u2026",
    style: {
      fontSize: 13,
      lineHeight: 1.4,
      padding: "5px 8px",
      width: "100%",
      borderRadius: 4,
      resize: "none",
      overflow: "hidden",
      fontFamily: "inherit",
      color: "var(--ink)"
    }
  });
}

// sold: that item's sales (null: none in the last year; undefined: not shown)
function ReorderRow({
  r,
  onSave,
  showVendor,
  sold
}) {
  // almost everything is in pcs, so the unit is only shown when it isn't
  const u = (r.unit || "").toLowerCase();
  const unit = u && u !== "pcs" ? ` ${u}` : "";
  const short = shortOf(r);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      ...reorderGrid(showVendor, sold !== undefined),
      padding: "10px 16px",
      borderBottom: "1px solid var(--line)",
      alignItems: "center",
      fontSize: 14,
      opacity: r.missing ? 0.6 : 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, r.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, r.sku || "no SKU", !!(r.openPOs || []).length && ` · ${r.openPOs.map(p => p.number).join(", ")}`, r.missing && " · no longer in Zoho's reorder list")), showVendor && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: r.vendor ? "var(--ink)" : "var(--muted)"
    }
  }, r.vendor || "No vendor"), /*#__PURE__*/React.createElement("div", {
    style: midCell
  }, r.reorderLevel, unit), /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      fontWeight: 600,
      color: r.stockOnHand <= 0 ? "var(--clay)" : r.below ? "var(--amber)" : "var(--sage)"
    }
  }, r.stockOnHand, unit), /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      color: r.toReceive ? "var(--ink)" : "var(--muted)"
    }
  }, r.toReceive || 0, unit), /*#__PURE__*/React.createElement(ExpectedDateCell, {
    value: r.expectedDate || "",
    onChange: v => onSave(r.id, {
      expectedDate: v
    })
  }), /*#__PURE__*/React.createElement(NotesCell, {
    value: r.notes,
    onSave: v => onSave(r.id, {
      notes: v
    })
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      ...midCell,
      fontWeight: 600,
      color: short ? "var(--clay)" : "var(--sage)"
    }
  }, !r.below ? "—" : short ? `${short}${unit}` : "✓ covered"), sold !== undefined && /*#__PURE__*/React.createElement("div", {
    style: midCell
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 600
    }
  }, sold ? sold.year.pieces : 0), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, sold ? sold.month.pieces : 0, " last month")));
}
function Trash({
  trash,
  onRestore,
  onDelete,
  onEmpty
}) {
  if (!trash.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "60px 20px",
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 26,
      margin: "0 0 6px"
    }
  }, "Trash is empty"), /*#__PURE__*/React.createElement("p", {
    style: {
      color: "var(--muted)",
      maxWidth: 380,
      margin: "0 auto",
      lineHeight: 1.5
    }
  }, "Deleted bundles and products land here. You can restore them anytime, or empty the trash to remove them for good."));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 14
    }
  }, trash.length, " deleted item", trash.length > 1 ? "s" : "", "."), /*#__PURE__*/React.createElement("button", {
    onClick: onEmpty,
    style: {
      ...btnSec,
      color: "var(--clay)",
      borderColor: "var(--clayDim)"
    }
  }, "Empty trash")), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 6,
      overflow: "hidden"
    }
  }, trash.map((e, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 10,
      padding: "11px 16px",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, e.item.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, e.kind, " \xB7 deleted ", new Date(e.at).toLocaleDateString())), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onRestore(e),
    style: btnSec
  }, "Restore"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelete(e),
    style: {
      ...btnSec,
      color: "var(--clay)",
      borderColor: "var(--clayDim)"
    }
  }, "Delete"))))));
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
  whiteSpace: "nowrap"
};
const catPill = on => ({
  padding: "4px 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textTransform: "capitalize",
  border: `1px solid ${on ? "var(--ink)" : "var(--line)"}`,
  background: on ? "var(--ink)" : "#fff",
  color: on ? "var(--paper)" : "var(--muted)"
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
  whiteSpace: "nowrap"
};
const btnFix = {
  background: "var(--clay)",
  color: "#fff",
  border: "none",
  padding: "7px 10px",
  borderRadius: 4,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer"
};
const xBtn = {
  background: "none",
  border: "none",
  color: "var(--muted)",
  cursor: "pointer",
  fontSize: 13,
  padding: 4
};
// the top bar's search box — use with className="barSearch", which adds the
// white background with the magnifier icon
const barSearch = {
  flex: 1,
  minWidth: 0,
  padding: "10px 14px 10px 36px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  fontSize: 14.5
};
const note = {
  fontSize: 12.5,
  color: "var(--muted)",
  margin: "0 0 14px"
};
const lbl = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  color: "var(--muted)",
  fontWeight: 600
};
const inp = {
  padding: "8px 10px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--ink)"
};
const sel = {
  padding: "7px 9px",
  borderRadius: 4,
  border: "1px solid var(--line)",
  background: "#fff",
  fontSize: 13
};
const vRow = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  fontSize: 14
};
const wlGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 100px 100px 90px 110px",
  gap: 10
};
const numCell = {
  textAlign: "right",
  fontSize: 14
};
// matches REFRESH_COOLDOWN_MS in lib/zohoReorder.js (the server enforces it)
const REORDER_COOLDOWN_MS = 2 * 60 * 60 * 1000;
// "45m" / "3h" / "3h 20m" for the cooldown countdown
const fmtLeft = ms => {
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60),
    m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};
// name · [vendor] · reorder · stock · to receive · expected · notes · short
const reorderGrid = (showVendor, showSold) => ({
  display: "grid",
  gridTemplateColumns: showSold ? `minmax(200px,2fr) ${showVendor ? "130px " : ""}90px 100px 110px 120px minmax(130px,1fr) 100px 100px` : `minmax(240px,2fr) ${showVendor ? "130px " : ""}90px 100px 110px 120px minmax(160px,1fr) 100px`,
  gap: 12
});
const midCell = {
  textAlign: "center",
  fontSize: 14
};
// name · Shopify stock · Zoho available · to be received · expected · notes
const ceramitecGrid = {
  display: "grid",
  gridTemplateColumns: "minmax(260px,2fr) 110px 110px 120px 130px minmax(200px,1.5fr)",
  gap: 12
};
// Ceramitec sets that arrive pre-packed — shown under "Ceramitec bundles" on
// the Zoho Inventory page. Add/remove SKUs here.
const CERAMITEC_BUNDLE_SKUS = ["CER04TS063",
// Morya Table Setting (4 Pieces)
"CER13TS284",
// Rangoli Table Setting Pink (13 Pieces)
"CER083TS104",
// Rangoli Table Settings Lilac (13 pieces)
"CER04TS068",
// Raya Table Setting (4 Pieces)
"CER05TS047",
// Heart Beat Table Setting Pink (5 Pieces)
"CER082TS105",
// Bites and Delights Lime Green
"CER080TS102" // The Sushi Dimsum set Pink + Aqua
];
// a plain-text button used for in-cell actions ("+ Add date", a set date)
const cellLink = {
  background: "none",
  border: "none",
  padding: "2px 0",
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
  lineHeight: 1.3
};
const prodGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 120px 166px 66px 80px 84px 30px",
  gap: 8
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
