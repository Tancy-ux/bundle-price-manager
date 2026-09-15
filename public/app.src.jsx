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
async function apiPut(
  products,
  bundles,
  trash,
  excludedSkus,
  excludedBundleNames,
) {
  const r = await fetch("/api/data", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      products,
      bundles,
      trash: trash || [],
      excludedSkus: excludedSkus || [],
      excludedBundleNames: excludedBundleNames || [],
    }),
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
  const [tab, setTab] = useState("worklist");
  const [toast, setToast] = useState(null);
  const [undo, setUndo] = useState(null); // {label, restore}
  const [confirmState, setConfirmState] = useState(null); // {title, detail, confirmLabel, danger, resolve}
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const firstLoad = useRef(true);
  // measure the sticky header+nav so each tab's own search/filter row can
  // stick right below it too, instead of scrolling away with the list
  const headerRef = useRef(null);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    if (!headerRef.current) return;
    const measure = () =>
      setHeaderH(headerRef.current.getBoundingClientRect().height);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ready, tab]);

  useEffect(() => {
    (async () => {
      const d = await apiGet();
      setProducts(d.products || []);
      setBundles(d.bundles || []);
      setTrash(d.trash || []);
      setExcludedSkus(d.excludedSkus || []);
      setExcludedBundleNames(d.excludedBundleNames || []);
      setLastSyncAt(d.lastSyncAt || null);
      setReady(true);
    })();
  }, []);

  // autosave to disk on any change (skip the initial load)
  useEffect(() => {
    if (!ready) return;
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    let cancel = false;
    setSaving(true);
    apiPut(products, bundles, trash, excludedSkus, excludedBundleNames)
      .then(() => {
        if (!cancel) {
          setSaving(false);
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

  // "Sync with Shopify" — adds new products (active + SKU), new empty bundle
  // shells (active + no SKU), and refreshes stock on everything, in one call.
  // Throttled server-side to once/24h; syncEligible below mirrors that for the UI.
  async function syncNow() {
    setSyncing(true);
    try {
      const r = await fetch("/api/sync", { method: "POST" });
      const j = await r.json();
      if (r.status === 429) {
        const hrs = Math.ceil((j.retryAfterMs || 0) / 3600000);
        flash(`Already synced — try again in about ${hrs}h`);
        return;
      }
      if (!r.ok) {
        flash(j.error || "Sync failed");
        return;
      }
      setProducts(j.data.products || []);
      setBundles(j.data.bundles || []);
      setLastSyncAt(j.data.lastSyncAt || null);
      const s = j.summary;
      flash(
        `Synced: +${s.addedProducts} products, +${s.addedBundles} bundles, stock updated on ${s.stockUpdated} (${s.totalOOS} out of stock)`,
      );
    } catch (e) {
      flash("Sync failed — is the server running?");
    } finally {
      setSyncing(false);
    }
  }
  const SYNC_COOLDOWN_MS = 24 * 60 * 60 * 1000;
  const syncEligible =
    !lastSyncAt ||
    Date.now() - new Date(lastSyncAt).getTime() >= SYNC_COOLDOWN_MS;

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
    .map((b) => ({ b, c: compute(b) }))
    .filter((x) => x.c.stale);
  const oosList = bundles
    .map((b) => ({ b, c: compute(b) }))
    .filter((x) => x.c.hasOOS)
    .sort((a, b) => a.b.name.localeCompare(b.b.name));
  // freshest stock check across all products, for the "synced" indicator
  const stockUpdatedAt = products.reduce(
    (max, p) =>
      p.stockUpdatedAt && p.stockUpdatedAt > (max || "")
        ? p.stockUpdatedAt
        : max,
    null,
  );

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "0 20px 60px" }}>
      <div
        ref={headerRef}
        style={{
          position: "sticky",
          top: 0,
          zIndex: 15,
          background: "var(--paper)",
          paddingTop: 26,
          boxShadow: "0 6px 16px -12px rgba(0,0,0,.25)",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 11,
                letterSpacing: 3,
                textTransform: "uppercase",
                color: "var(--clay)",
                fontWeight: 700,
              }}
            >
              catalog ops · local
            </div>
            <h1
              className="serif"
              style={{
                fontSize: 32,
                margin: "6px 0 0",
                fontWeight: 600,
                letterSpacing: -0.5,
              }}
            >
              Bundle Price Manager
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14 }}>
            <div
              style={{
                fontSize: 13,
                color: "var(--muted)",
                textAlign: "right",
              }}
            >
              <div>
                <b style={{ color: "var(--ink)" }}>{products.length}</b>{" "}
                products ·{" "}
                <b style={{ color: "var(--ink)" }}>{bundles.length}</b> bundles
              </div>
              <div
                style={{
                  fontSize: 11,
                  marginTop: 2,
                  color: saving ? "var(--amber)" : "var(--sage)",
                }}
              >
                {saving ? "saving…" : "saved to disk ✓"}
              </div>
              <div
                style={{ fontSize: 11, marginTop: 2, color: "var(--muted)" }}
              >
                stock{" "}
                {stockUpdatedAt
                  ? `synced ${timeAgo(stockUpdatedAt)}`
                  : "never synced"}
              </div>
            </div>
            <button
              onClick={syncNow}
              disabled={syncing || !syncEligible}
              title={
                !syncEligible
                  ? `Last synced ${timeAgo(lastSyncAt)} — available once every 24h`
                  : "Pull new products, new bundle shells, and refresh stock from Shopify"
              }
              style={{
                ...btnSec,
                opacity: syncing || !syncEligible ? 0.55 : 1,
                cursor: syncing || !syncEligible ? "default" : "pointer",
              }}
            >
              {syncing
                ? "Syncing…"
                : lastSyncAt
                  ? `Sync with Shopify · synced ${timeAgo(lastSyncAt)}`
                  : "Sync with Shopify"}
            </button>
          </div>
        </header>
        <nav
          style={{
            display: "flex",
            gap: 2,
            margin: "18px 0 0",
            borderBottom: "1px solid var(--line)",
            flexWrap: "wrap",
          }}
        >
          {[
            [
              "worklist",
              `Needs updating${staleList.length ? ` (${staleList.length})` : ""}`,
            ],
            ["bundles", "Bundles"],
            ["products", "Products"],
            ["whereused", "In bundles"],
            [
              "stock",
              `Out of stock${oosList.length ? ` (${oosList.length})` : ""}`,
            ],
            ["trash", `Trash${trash.length ? ` (${trash.length})` : ""}`],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                background: "none",
                border: "none",
                padding: "10px 14px",
                fontSize: 13.5,
                fontWeight: 600,
                cursor: "pointer",
                color:
                  tab === k
                    ? "var(--ink)"
                    : (k === "worklist" && staleList.length) ||
                        (k === "stock" && oosList.length)
                      ? "var(--clay)"
                      : "var(--muted)",
                borderBottom: `2px solid ${tab === k ? "var(--clay)" : "transparent"}`,
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <div style={{ paddingTop: 18 }}>
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
              borderRadius: 8,
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
              borderRadius: 10,
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
                borderRadius: 7,
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
  );
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
          borderRadius: 14,
          padding: "22px 24px",
          maxWidth: 380,
          width: "100%",
          boxShadow: "0 20px 60px rgba(0,0,0,.35)",
        }}
      >
        <h3
          className="serif"
          style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 600 }}
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
}) {
  const [view, setView] = useState("todo"); // todo | history
  const [openId, setOpenId] = useState(null); // expanded row for inline editing
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
            border: `1px solid ${view === k ? "var(--clay)" : "var(--line)"}`,
            background: view === k ? "var(--clayDim)" : "#fff",
            color: view === k ? "var(--clay)" : "var(--muted)",
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
              borderRadius: 12,
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
            borderRadius: 14,
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
          <h2 className="serif" style={{ fontSize: 22, margin: "0 0 6px" }}>
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
            borderRadius: 8,
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
          borderRadius: 12,
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
}) {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);
  const [show, setShow] = useState("all"); // all | empty | filled | oos | dup | single
  const [cat, setCat] = useState(""); // category word
  const [sortBy, setSortBy] = useState(null); // null | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  };
  const sortArrow = (col) => (sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const [visible, setVisible] = useState(60); // how many rows to show (Load more)
  const active = useMemo(() => products.filter((p) => p.active), [products]);
  // marble-vase/lush bundles are a separate silo — every other filter (all,
  // not built yet, built, out of stock, duplicate names) only ever looks at
  // "normal" bundles; they only appear once you explicitly pick their own pill.
  const normalBundles = useMemo(
    () => bundles.filter((b) => !isSingleItemCandidate(b.name)),
    [bundles],
  );
  const singleBundles = useMemo(
    () => bundles.filter((b) => isSingleItemCandidate(b.name)),
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
      const ca = compute(a), cb = compute(b);
      if (sortBy === "price") {
        const av = ca.giftIncluded ? a.storedPrice || 0 : ca.target;
        const bv = cb.giftIncluded ? b.storedPrice || 0 : cb.target;
        return sortDir === "asc" ? av - bv : bv - av;
      }
      // stock: bundles with no trackable component sink to the bottom either way
      const av = ca.stock, bv = cb.stock;
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
        <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
          <input
            placeholder="Search bundles…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={search}
          />
          <button onClick={add} style={btnPri}>
            + New
          </button>
        </div>
        <div
          style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}
        >
          {[
            ["all", `All (${normalBundles.length})`, false],
            ["empty", `Not built yet (${emptyCount})`, false],
            ["filled", `Built (${normalBundles.length - emptyCount})`, false],
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
                  border: `1px solid ${show === k ? "var(--clay)" : "var(--line)"}`,
                  background: show === k ? "var(--clayDim)" : "#fff",
                  color: show === k ? "var(--clay)" : "var(--muted)",
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
            borderRadius: 12,
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
          <span style={{ flex: 1 }}>Bundle</span>
          <span
            style={{ width: 90, textAlign: "right", cursor: "pointer", userSelect: "none" }}
            onClick={() => toggleSort("stock")}
            title="Sort by sellable stock"
          >
            Stock{sortArrow("stock")}
          </span>
          <span
            style={{ width: 90, textAlign: "right", cursor: "pointer", userSelect: "none" }}
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
                borderRadius: 10,
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
                    color: c.stock !== null && c.stock <= 0 ? "var(--clay)" : "var(--muted)",
                  }}
                  title={c.stock !== null ? "Sellable stock — each component's stock ÷ qty needed, then the least of those" : undefined}
                >
                  {!c.empty && c.stock !== null ? `${c.stock} in stock` : ""}
                </span>
                <span style={{ width: 90, flexShrink: 0, textAlign: "right", fontSize: 13, color: "var(--muted)" }}>
                  {c.empty ? (
                    <span style={{ color: "var(--amber)" }}>not built yet</span>
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
                  borderRadius: 7,
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
          borderRadius: 9,
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
          borderRadius: 8,
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
            borderRadius: 7,
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
            borderRadius: 7,
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
            borderRadius: 8,
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
            borderRadius: 8,
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
            borderRadius: 10,
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
function Products({
  products,
  setProducts,
  bundles,
  onDelete,
  flash,
  stickyTop,
}) {
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(100);
  const [usageFilter, setUsageFilter] = useState("all"); // all | used | unused | oos | atelier
  const [sortBy, setSortBy] = useState(null); // null | "price" | "stock"
  const [sortDir, setSortDir] = useState("asc"); // "asc" | "desc"
  const toggleSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortBy(col); setSortDir("asc"); }
  };
  const sortArrow = (col) => (sortBy === col ? (sortDir === "asc" ? " ▲" : " ▼") : "");
  const isOOS = (p) => p.active && p.stockTracked && (p.stock || 0) <= 0;
  const normalProducts = useMemo(
    () => products.filter((p) => !isMarbleAtelier(p.name)),
    [products],
  );
  const atelierProducts = useMemo(
    () => products.filter((p) => isMarbleAtelier(p.name)),
    [products],
  );
  const [expanded, setExpanded] = useState(null); // product id whose bundle list is open
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
    return { all: normalProducts.length, used, unused, oos, archived, atelier: atelierProducts.length };
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
        <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
          <input
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={search}
          />
          <button onClick={add} style={btnPri}>
            + New
          </button>
        </div>
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
            ["archived", `Archived (${counts.archived})`, counts.archived === 0],
            ["atelier", `Marble Atelier (${counts.atelier})`, counts.atelier === 0],
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
                  border: `1px solid ${usageFilter === k ? "var(--clay)" : "var(--line)"}`,
                  background: usageFilter === k ? "var(--clayDim)" : "#fff",
                  color: usageFilter === k ? "var(--clay)" : "var(--muted)",
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
            borderRadius: 12,
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
          borderRadius: 12,
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
          <span>Product</span>
          <span>SKU</span>
          <span
            style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}
            onClick={() => toggleSort("price")}
            title="Sort by price"
          >
            Price{sortArrow("price")}
          </span>
          <span
            style={{ textAlign: "right", cursor: "pointer", userSelect: "none" }}
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
                  onChange={(e) => update(p.id, { sku: e.target.value })}
                  style={{
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    padding: "5px 7px",
                    fontSize: 12,
                    color: "var(--muted)",
                  }}
                />
                <input
                  type="number"
                  value={p.price}
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
                    border: "1px solid var(--line)",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontSize: 14,
                    textAlign: "right",
                  }}
                />
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
                    <span
                      key={i}
                      style={{
                        fontSize: 12.5,
                        background: "var(--sageDim)",
                        color: "var(--ink)",
                        borderRadius: 999,
                        padding: "3px 10px",
                        border: "1px solid var(--line)",
                      }}
                    >
                      {u.name}
                      {u.sku ? ` · ${u.sku}` : ""}
                    </span>
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
      <input
        placeholder="Search a product — e.g. dot pink — to see its bundles…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={search}
      />
      {!q.trim() && (
        <p style={{ ...note, marginTop: 14 }}>
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
            borderRadius: 12,
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
                borderRadius: 12,
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

// "Out of stock" — every bundle that can't be fulfilled right now because at
// least one of its components has zero tracked stock in Shopify, and exactly
// which component(s) those are. Fed by the stock the fetch-stock script pulls in.
function StockIssues({
  oosList,
  bundles,
  setBundles,
  byId,
  products,
  compute,
  onDelete,
  onPromote,
  onSkip,
}) {
  const [openId, setOpenId] = useState(null);
  const update = (id, patch) =>
    setBundles(bundles.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  if (!oosList.length)
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 20px",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 14,
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
        <h2 className="serif" style={{ fontSize: 22, margin: "0 0 6px" }}>
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
          Every bundle's components have stock, as of the last sync. Run{" "}
          <code>npm run fetch-stock</code> (or wait for the scheduled check) to
          refresh.
        </p>
      </div>
    );

  return (
    <div>
      <p style={note}>
        {oosList.length} bundle{oosList.length > 1 ? "s" : ""} blocked by an
        out-of-stock component.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {oosList.map(({ b, c }) => {
          const open = openId === b.id;
          return (
            <div
              key={b.id}
              style={{
                background: "var(--card)",
                border: "1px solid var(--clay)",
                borderLeft: "3px solid var(--clay)",
                borderRadius: 10,
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
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// shared inline styles
function Trash({ trash, onRestore, onDelete, onEmpty }) {
  if (!trash.length)
    return (
      <div
        style={{
          textAlign: "center",
          padding: "60px 20px",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 14,
        }}
      >
        <h2 className="serif" style={{ fontSize: 22, margin: "0 0 6px" }}>
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
          borderRadius: 12,
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
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
const catPill = (on) => ({
  padding: "4px 11px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textTransform: "capitalize",
  border: `1px solid ${on ? "var(--sage)" : "var(--line)"}`,
  background: on ? "var(--sageDim)" : "#fff",
  color: on ? "var(--sage)" : "var(--muted)",
});
const btnSec = {
  background: "#fff",
  color: "var(--ink)",
  border: "1px solid var(--line)",
  padding: "9px 15px",
  borderRadius: 8,
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
  borderRadius: 7,
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
const search = {
  flex: 1,
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  fontSize: 14,
  background: "#fff",
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
  borderRadius: 7,
  border: "1px solid var(--line)",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--ink)",
};
const sel = {
  padding: "7px 9px",
  borderRadius: 7,
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
const prodGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 120px 90px 66px 80px 84px 30px",
  gap: 8,
};

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
