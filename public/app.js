const {
  useState,
  useEffect,
  useMemo,
  useRef
} = React;
const money = n => isNaN(n) || n == null ? "—" : new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}).format(n);
const round2 = n => Math.round(n * 100) / 100;
const uid = () => Math.random().toString(36).slice(2, 9);

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
async function apiPut(products, bundles, trash) {
  const r = await fetch("/api/data", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      products,
      bundles,
      trash: trash || []
    })
  });
  return r.json();
}
function App() {
  const [products, setProducts] = useState(null);
  const [bundles, setBundles] = useState(null);
  const [trash, setTrash] = useState([]); // {kind, item, at}
  const [tab, setTab] = useState("worklist");
  const [toast, setToast] = useState(null);
  const [undo, setUndo] = useState(null); // {label, restore}
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(false);
  const firstLoad = useRef(true);
  useEffect(() => {
    (async () => {
      const d = await apiGet();
      setProducts(d.products || []);
      setBundles(d.bundles || []);
      setTrash(d.trash || []);
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
    apiPut(products, bundles, trash).then(() => {
      if (!cancel) {
        setSaving(false);
      }
    }).catch(() => {
      if (!cancel) {
        setSaving(false);
        flash("Could not save to disk — is the server running?");
      }
    });
    return () => {
      cancel = true;
    };
  }, [products, bundles, trash, ready]);
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

  // delete a bundle -> trash + undo
  function deleteBundle(b) {
    if (!window.confirm(`Delete "${b.name}"?\n\nIt moves to Trash — you can restore it from there.`)) return;
    setBundles(bundles.filter(x => x.id !== b.id));
    const entry = {
      kind: "bundle",
      item: b,
      at: new Date().toISOString()
    };
    setTrash(t => [entry, ...t]);
    showUndo(`Deleted "${b.name}"`, () => {
      setBundles(cur => [b, ...cur]);
      setTrash(t => t.filter(e => e !== entry));
    });
  }
  // delete a product -> trash + undo
  function deleteProduct(p) {
    if (!window.confirm(`Delete "${p.name}"?\n\nIt moves to Trash — you can restore it from there.`)) return;
    setProducts(products.filter(x => x.id !== p.id));
    const entry = {
      kind: "product",
      item: p,
      at: new Date().toISOString()
    };
    setTrash(t => [entry, ...t]);
    showUndo(`Deleted "${p.name}"`, () => {
      setProducts(cur => [p, ...cur]);
      setTrash(t => t.filter(e => e !== entry));
    });
  }
  function restoreFromTrash(entry) {
    if (entry.kind === "bundle") setBundles(cur => [entry.item, ...cur]);else setProducts(cur => [entry.item, ...cur]);
    setTrash(t => t.filter(e => e !== entry));
    flash("Restored");
  }
  // permanently remove a single item from Trash (not recoverable)
  function deleteFromTrash(entry) {
    if (!window.confirm(`Permanently delete "${entry.item.name}"?\n\nThis can't be undone.`)) return;
    setTrash(t => t.filter(e => e !== entry));
    flash("Deleted for good");
  }
  function emptyTrash() {
    if (!window.confirm(`Permanently delete all ${trash.length} item${trash.length > 1 ? "s" : ""} in Trash?\n\nThis can't be undone.`)) return;
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
  function compute(b) {
    let sum = 0,
      missing = false;
    b.items.forEach(it => {
      const p = byId[it.productId];
      if (!p || !p.active) missing = true;else sum += p.price * it.qty;
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
    return {
      target,
      missing,
      stale,
      empty,
      giftIncluded,
      skipped,
      priceMismatch,
      diff: target - (b.storedPrice || 0)
    };
  }
  if (!ready) return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 40,
      textAlign: "center",
      color: "var(--muted)"
    },
    className: "serif"
  }, "Loading from disk…");
  const staleList = bundles.map(b => ({
    b,
    c: compute(b)
  })).filter(x => x.c.stale);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 880,
      margin: "0 auto",
      padding: "0 20px 60px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "sticky",
      top: 0,
      zIndex: 15,
      background: "var(--paper)",
      paddingTop: 26,
      boxShadow: "0 6px 16px -12px rgba(0,0,0,.25)"
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-end",
      flexWrap: "wrap",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      letterSpacing: 3,
      textTransform: "uppercase",
      color: "var(--clay)",
      fontWeight: 700
    }
  }, "catalog ops · local"), /*#__PURE__*/React.createElement("h1", {
    className: "serif",
    style: {
      fontSize: 32,
      margin: "6px 0 0",
      fontWeight: 600,
      letterSpacing: -0.5
    }
  }, "Bundle Price Manager")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "var(--muted)",
      textAlign: "right"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--ink)"
    }
  }, products.length), " products · ", /*#__PURE__*/React.createElement("b", {
    style: {
      color: "var(--ink)"
    }
  }, bundles.length), " bundles"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      marginTop: 2,
      color: saving ? "var(--amber)" : "var(--sage)"
    }
  }, saving ? "saving…" : "saved to disk ✓"))), /*#__PURE__*/React.createElement("nav", {
    style: {
      display: "flex",
      gap: 2,
      margin: "18px 0 0",
      borderBottom: "1px solid var(--line)",
      flexWrap: "wrap"
    }
  }, [["worklist", `Needs updating${staleList.length ? ` (${staleList.length})` : ""}`], ["bundles", "Bundles"], ["products", "Products"], ["whereused", "In bundles"], ["trash", `Trash${trash.length ? ` (${trash.length})` : ""}`]].map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setTab(k),
    style: {
      background: "none",
      border: "none",
      padding: "10px 14px",
      fontSize: 13.5,
      fontWeight: 600,
      cursor: "pointer",
      color: tab === k ? "var(--ink)" : k === "worklist" && staleList.length ? "var(--clay)" : "var(--muted)",
      borderBottom: `2px solid ${tab === k ? "var(--clay)" : "transparent"}`,
      marginBottom: -1
    }
  }, label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingTop: 18
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
      borderRadius: 8,
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
      borderRadius: 10,
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
      borderRadius: 7,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Undo")), tab === "worklist" && /*#__PURE__*/React.createElement(Worklist, {
    staleList: staleList,
    bundles: bundles,
    setBundles: setBundles,
    flash: flash,
    products: products,
    compute: compute,
    byId: byId,
    onDelete: deleteBundle,
    onPromote: promoteToProduct,
    onSkip: skipBundle
  }), tab === "bundles" && /*#__PURE__*/React.createElement(Bundles, {
    bundles: bundles,
    setBundles: setBundles,
    products: products,
    compute: compute,
    byId: byId,
    onDelete: deleteBundle,
    onPromote: promoteToProduct,
    onSkip: skipBundle
  }), tab === "products" && /*#__PURE__*/React.createElement(Products, {
    products: products,
    setProducts: setProducts,
    bundles: bundles,
    onDelete: deleteProduct,
    showUndo: showUndo,
    flash: flash
  }), tab === "whereused" && /*#__PURE__*/React.createElement(WhereUsed, {
    bundles: bundles,
    products: products,
    compute: compute
  }), tab === "trash" && /*#__PURE__*/React.createElement(Trash, {
    trash: trash,
    onRestore: restoreFromTrash,
    onDelete: deleteFromTrash,
    onEmpty: emptyTrash
  })));
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
  onSkip
}) {
  const [view, setView] = useState("todo"); // todo | history
  const [openId, setOpenId] = useState(null); // expanded row for inline editing
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
      border: `1px solid ${view === k ? "var(--clay)" : "var(--line)"}`,
      background: view === k ? "var(--clayDim)" : "#fff",
      color: view === k ? "var(--clay)" : "var(--muted)"
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
      borderRadius: 12,
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
      letterSpacing: .5,
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
      letterSpacing: .4,
      padding: "1px 6px",
      borderRadius: 999,
      verticalAlign: "middle",
      whiteSpace: "nowrap",
      color: h.kind === "product" ? "var(--sage)" : "var(--amber)",
      border: `1px solid ${h.kind === "product" ? "var(--sage)" : "var(--amber)"}`
    }
  }, h.kind || "bundle")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--muted)"
    }
  }, new Date(h.at).toLocaleDateString(), " ", new Date(h.at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
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
      borderRadius: 14
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
  }, "✓"), /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 22,
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
      borderRadius: 8,
      fontSize: 13,
      fontWeight: 600,
      marginBottom: 12
    }
  }, "⚠ ", broken.length, " bundle(s) use an inactive/missing product — fix in Bundles."), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 12,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...wlGrid,
      padding: "10px 16px",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: .5,
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
      onSkip: onSkip
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
        opacity: .85
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
    }, "Has a missing/inactive item — click to fix")), open && /*#__PURE__*/React.createElement("div", {
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
      onSkip: onSkip
    })));
  })));
}
const CATS = ["plate", "bowl", "vase", "cup", "dinner", "spread", "setting", "serving", "gift", "dessert", "marble", "table", "lamp", "wall"];
function Bundles({
  bundles,
  setBundles,
  products,
  compute,
  byId,
  onDelete,
  onPromote,
  onSkip
}) {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState(null);
  const [show, setShow] = useState("all"); // all | empty | filled
  const [cat, setCat] = useState(""); // category word
  const [visible, setVisible] = useState(60); // how many rows to show (Load more)
  const active = useMemo(() => products.filter(p => p.active), [products]);
  const filtered = useMemo(() => {
    return bundles.filter(b => {
      if (show === "empty" && b.items.length > 0) return false;
      if (show === "filled" && b.items.length === 0) return false;
      if (cat && !b.name.toLowerCase().includes(cat)) return false;
      if (!matchText(q, b.name + " " + (b.sku || ""))) return false;
      return true;
    });
  }, [bundles, q, show, cat]);
  // reset the visible window whenever the filter set changes
  useEffect(() => {
    setVisible(60);
  }, [q, show, cat]);
  const shown = filtered.slice(0, visible);
  const emptyCount = useMemo(() => bundles.filter(b => b.items.length === 0).length, [bundles]);
  // counts per category word — pills stay visible (and show their count) even at 0 matches.
  // counted within the current "show" sub-filter so the numbers reflect what you'd actually see.
  const catCounts = useMemo(() => {
    const base = bundles.filter(b => {
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
  }, [bundles, show]);
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
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Search bundles…",
    value: q,
    onChange: e => setQ(e.target.value),
    style: search
  }), /*#__PURE__*/React.createElement("button", {
    onClick: add,
    style: btnPri
  }, "+ New")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 8
    }
  }, [["all", `All (${bundles.length})`], ["empty", `Not built yet (${emptyCount})`], ["filled", `Built (${bundles.length - emptyCount})`]].map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setShow(k),
    style: {
      padding: "6px 12px",
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer",
      border: `1px solid ${show === k ? "var(--clay)" : "var(--line)"}`,
      background: show === k ? "var(--clayDim)" : "#fff",
      color: show === k ? "var(--clay)" : "var(--muted)"
    }
  }, label))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 10,
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
  })), /*#__PURE__*/React.createElement("p", {
    style: note
  }, filtered.length, " match", filtered.length === 1 ? "" : "es", filtered.length > shown.length ? ` · showing ${shown.length}` : ""), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "36px 20px",
      background: "var(--card)",
      border: "1px dashed var(--line)",
      borderRadius: 12,
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
  }, "Clear filters")), /*#__PURE__*/React.createElement("div", {
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
        borderRadius: 10,
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
    }, b.name, b.giftIncluded && /*#__PURE__*/React.createElement("span", {
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
      title: "Skipped — kept out of the worklist",
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
    }, "✎")), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        color: "var(--muted)"
      }
    }, c.empty ? /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--amber)"
      }
    }, "not built yet") : c.missing ? "needs item fix" : money(c.target)), /*#__PURE__*/React.createElement("span", {
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
      onSkip: onSkip
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
  onSkip
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
    onChange: e => update(b.id, {
      name: e.target.value
    }),
    style: inp
  })), /*#__PURE__*/React.createElement("label", {
    style: lbl
  }, "Bundle SKU", /*#__PURE__*/React.createElement("input", {
    value: b.sku,
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
  }, "No items yet — use the bar above to add components fast."), b.items.map((it, idx) => {
    const p = byId[it.productId];
    const broke = !p || !p.active;
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
        borderRadius: 7,
        border: "1px solid var(--line)",
        fontSize: 13,
        textAlign: "center"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted)",
        fontSize: 13
      }
    }, "×"), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
        color: broke ? "var(--clay)" : "var(--ink)"
      }
    }, p ? p.name : "(missing product)", broke && p ? " (inactive)" : ""), /*#__PURE__*/React.createElement("span", {
      style: {
        width: 78,
        textAlign: "right",
        fontSize: 13,
        color: "var(--muted)"
      }
    }, p && p.active ? money(p.price * it.qty) : "—"), /*#__PURE__*/React.createElement("button", {
      onClick: () => update(b.id, {
        items: b.items.filter((_, i) => i !== idx)
      }),
      style: xBtn
    }, "✕"));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: c.stale ? "var(--clayDim)" : "var(--sageDim)",
      borderRadius: 9,
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
  }, "Computed (sum of items)"), /*#__PURE__*/React.createElement("strong", null, c.missing ? "—" : money(c.target))), /*#__PURE__*/React.createElement("div", {
    style: vRow
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)"
    }
  }, "Live on Shopify"), /*#__PURE__*/React.createElement("input", {
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
  })), !c.missing && c.priceMismatch && /*#__PURE__*/React.createElement("label", {
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
    onChange: e => update(b.id, {
      giftIncluded: e.target.checked
    }),
    style: {
      marginTop: 2,
      cursor: "pointer"
    }
  }), /*#__PURE__*/React.createElement("span", null, "Gift / packaging price included — the live price is meant to differ from the item sum, so don't flag this for updating.")), !c.missing && c.priceMismatch && b.giftIncluded && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--sage)",
      fontWeight: 600,
      fontSize: 13
    }
  }, "✓ In sync (gift price included, ", c.diff < 0 ? "+" : "−", money(Math.abs(c.diff)), " vs item sum)"), !c.missing && c.stale && /*#__PURE__*/React.createElement("button", {
    onClick: () => update(b.id, {
      storedPrice: c.target,
      ...logPatch(b.storedPrice || 0, c.target)
    }),
    style: btnFix
  }, "Set live → ", money(c.target)), !c.stale && !c.giftIncluded && !c.skipped && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--sage)",
      fontWeight: 600,
      fontSize: 13
    }
  }, "✓ In sync")), /*#__PURE__*/React.createElement("label", {
    style: {
      ...lbl,
      marginTop: 2
    }
  }, "Note (optional)", /*#__PURE__*/React.createElement("textarea", {
    value: b.note || "",
    onChange: e => update(b.id, {
      note: e.target.value
    }),
    placeholder: "e.g. includes gift box (+₹150) · seasonal pricing · anything worth remembering",
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
      borderRadius: 8,
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
  }, "Skipped — kept out of “Needs updating”. Won't be flagged even if the price differs.") : /*#__PURE__*/React.createElement("span", null, "Just one item + a box, or otherwise not worth syncing? Skip it to keep it off the worklist.")), /*#__PURE__*/React.createElement("button", {
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
      borderTop: "1px solid var(--line)",
      paddingTop: 10,
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onPromote(b),
    style: {
      background: "none",
      border: "1px solid var(--line)",
      color: "var(--muted)",
      padding: "6px 12px",
      borderRadius: 7,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer"
    },
    title: "This isn't a bundle — move it into the product list"
  }, "Not a bundle → move to Products"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onDelete(b),
    style: {
      background: "none",
      border: "none",
      color: "var(--clay)",
      padding: "6px 10px",
      borderRadius: 7,
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
      borderRadius: 8,
      border: "1px solid var(--line)",
      fontSize: 14,
      textAlign: "center"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted)",
      fontSize: 13
    }
  }, "×"), /*#__PURE__*/React.createElement("input", {
    ref: inputRef,
    value: q,
    onChange: e => setQ(e.target.value),
    onKeyDown: onKey,
    onFocus: () => setOpen(matches.length > 0),
    placeholder: "type to add a component — e.g. lunar nude plate, then Enter",
    style: {
      flex: 1,
      padding: "9px 12px",
      borderRadius: 8,
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
      borderRadius: 10,
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
  }, p.sku, " · ", money(p.price))))));
}
function Products({
  products,
  setProducts,
  bundles,
  onDelete,
  showUndo,
  flash
}) {
  const [q, setQ] = useState("");
  const [visible, setVisible] = useState(100);
  const [usageFilter, setUsageFilter] = useState("all"); // all | used | unused
  const [expanded, setExpanded] = useState(null); // product id whose bundle list is open
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
        name: b.name,
        sku: b.sku
      });
    }));
    return m;
  }, [bundles]);
  const usedCount = p => (usage[p.id] || []).length;
  const baseList = useMemo(() => products.filter(p => {
    if (usageFilter === "used" && usedCount(p) === 0) return false;
    if (usageFilter === "unused" && usedCount(p) > 0) return false;
    return true;
  }), [products, usage, usageFilter]);
  const filtered = useMemo(() => {
    if (!q.trim()) return baseList;
    return baseList.filter(p => matchText(q, p.name + " " + (p.sku || "")));
  }, [baseList, q]);
  useEffect(() => {
    setVisible(100);
  }, [q, usageFilter]);
  const shown = filtered.slice(0, visible);
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
  };

  // counts for the filter pills
  const counts = useMemo(() => {
    let used = 0,
      unused = 0;
    products.forEach(p => usedCount(p) > 0 ? used++ : unused++);
    return {
      all: products.length,
      used,
      unused
    };
  }, [products, usage]);
  // bulk: deactivate every currently-shown product that isn't in any bundle (with undo)
  const unusedShownActive = filtered.filter(p => usedCount(p) === 0 && p.active);
  const archiveUnused = () => {
    const ids = new Set(unusedShownActive.map(p => p.id));
    if (!ids.size) return;
    if (!window.confirm(`Archive ${ids.size} unused product${ids.size > 1 ? "s" : ""}?\n\nThey'll be set to Inactive. You can undo right after.`)) return;
    setProducts(products.map(p => ids.has(p.id) ? {
      ...p,
      active: false
    } : p));
    showUndo(`Archived ${ids.size} unused product${ids.size > 1 ? "s" : ""}`, () => setProducts(cur => cur.map(p => ids.has(p.id) ? {
      ...p,
      active: true
    } : p)));
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    placeholder: "Search products…",
    value: q,
    onChange: e => setQ(e.target.value),
    style: search
  }), /*#__PURE__*/React.createElement("button", {
    onClick: add,
    style: btnPri
  }, "+ New")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      marginBottom: 8,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, [["all", `All (${counts.all})`], ["used", `In a bundle (${counts.used})`], ["unused", `Not in any bundle (${counts.unused})`]].map(([k, label]) => /*#__PURE__*/React.createElement("button", {
    key: k,
    onClick: () => setUsageFilter(k),
    style: {
      padding: "6px 12px",
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 600,
      cursor: "pointer",
      border: `1px solid ${usageFilter === k ? "var(--clay)" : "var(--line)"}`,
      background: usageFilter === k ? "var(--clayDim)" : "#fff",
      color: usageFilter === k ? "var(--clay)" : "var(--muted)"
    }
  }, label)), unusedShownActive.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: archiveUnused,
    style: {
      ...btnSec,
      marginLeft: "auto",
      color: "var(--clay)",
      borderColor: "var(--clayDim)"
    },
    title: "Set every active product here that isn't used in any bundle to Inactive"
  }, "Archive ", unusedShownActive.length, " unused →")), /*#__PURE__*/React.createElement("p", {
    style: note
  }, filtered.length, " match", filtered.length === 1 ? "" : "es", filtered.length > shown.length ? ` · showing first ${shown.length}` : "", " · edit a price and every bundle using it updates"), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "36px 20px",
      background: "var(--card)",
      border: "1px dashed var(--line)",
      borderRadius: 12,
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
      borderRadius: 12,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...prodGrid,
      padding: "10px 14px",
      fontSize: 11,
      textTransform: "uppercase",
      letterSpacing: .4,
      color: "var(--muted)",
      fontWeight: 700,
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "Product"), /*#__PURE__*/React.createElement("span", null, "SKU"), /*#__PURE__*/React.createElement("span", {
    style: {
      textAlign: "right"
    }
  }, "Price"), /*#__PURE__*/React.createElement("span", {
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
        opacity: p.active ? 1 : .5
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        ...prodGrid,
        padding: "7px 14px",
        alignItems: "center"
      }
    }, /*#__PURE__*/React.createElement("input", {
      value: p.name,
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
    }), /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: p.price,
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
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "6px 8px",
        fontSize: 14,
        textAlign: "right"
      }
    }), used.length > 0 ? /*#__PURE__*/React.createElement("button", {
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
    }, "—"), /*#__PURE__*/React.createElement("button", {
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
      onClick: () => onDelete(p),
      style: xBtn
    }, "✕")), isOpen && used.length > 0 && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "4px 14px 12px 14px",
        display: "flex",
        flexWrap: "wrap",
        gap: 6
      }
    }, used.map((u, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      style: {
        fontSize: 12.5,
        background: "var(--sageDim)",
        color: "var(--ink)",
        borderRadius: 999,
        padding: "3px 10px",
        border: "1px solid var(--line)"
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

// shared inline styles
// "In bundles" — search a product, see every bundle that uses it.
// Groups results by matching product; a product with no bundles is left out.
function WhereUsed({
  bundles,
  products,
  compute
}) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    if (!q.trim()) return null;
    return products.filter(p => matchText(q, p.name + " " + (p.sku || ""))).map(p => ({
      p,
      used: bundles.filter(b => b.items.some(it => it.productId === p.id))
    })).filter(x => x.used.length > 0).sort((a, b) => b.used.length - a.used.length);
  }, [q, products, bundles]);
  let totalBundles = 0;
  if (results) {
    const s = new Set();
    results.forEach(x => x.used.forEach(b => s.add(b.id)));
    totalBundles = s.size;
  }
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("input", {
    placeholder: "Search a product — e.g. dot pink — to see its bundles…",
    value: q,
    onChange: e => setQ(e.target.value),
    style: search
  }), !q.trim() && /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 14
    }
  }, "Type a product name or SKU. Every bundle that contains a matching product is listed below. Products that aren't in any bundle won't show up here."), results && results.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      padding: "36px 20px",
      background: "var(--card)",
      border: "1px dashed var(--line)",
      borderRadius: 12,
      color: "var(--muted)",
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--ink)",
      marginBottom: 4
    }
  }, "No bundle uses a product matching “", q, "”"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13
    }
  }, "The product may exist but isn't a component of any bundle yet.")), results && results.length > 0 && /*#__PURE__*/React.createElement("p", {
    style: {
      ...note,
      marginTop: 14
    }
  }, results.length, " matching product", results.length > 1 ? "s" : "", " · ", totalBundles, " bundle", totalBundles > 1 ? "s" : ""), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 16
    }
  }, results && results.map(({
    p,
    used
  }) => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: {
      background: "var(--card)",
      border: "1px solid var(--line)",
      borderRadius: 12,
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 8,
      padding: "11px 16px",
      borderBottom: "1px solid var(--line)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14.5,
      fontWeight: 700
    }
  }, p.name), p.sku && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      color: "var(--muted)"
    }
  }, p.sku), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontSize: 12.5,
      color: "var(--muted)"
    }
  }, "in ", used.length, " bundle", used.length > 1 ? "s" : "")), used.map(b => {
    const c = compute(b);
    const it = b.items.find(i => i.productId === p.id);
    return /*#__PURE__*/React.createElement("div", {
      key: b.id,
      style: {
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 16px",
        borderBottom: "1px solid var(--line)"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
        background: c.empty ? "var(--line)" : c.stale ? "var(--clay)" : "var(--sage)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        fontSize: 14,
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
        fontSize: 12.5,
        color: "var(--muted)"
      }
    }, "qty ", it ? it.qty : "—"), /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 13,
        fontWeight: 600,
        minWidth: 70,
        textAlign: "right"
      }
    }, c.empty ? "—" : money(c.target)));
  })))));
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
      borderRadius: 14
    }
  }, /*#__PURE__*/React.createElement("h2", {
    className: "serif",
    style: {
      fontSize: 22,
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
      borderRadius: 12,
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
  }, e.kind, " · deleted ", new Date(e.at).toLocaleDateString())), /*#__PURE__*/React.createElement("div", {
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
  borderRadius: 8,
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
  border: `1px solid ${on ? "var(--sage)" : "var(--line)"}`,
  background: on ? "var(--sageDim)" : "#fff",
  color: on ? "var(--sage)" : "var(--muted)"
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
  whiteSpace: "nowrap"
};
const btnFix = {
  background: "var(--clay)",
  color: "#fff",
  border: "none",
  padding: "7px 10px",
  borderRadius: 7,
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
const search = {
  flex: 1,
  padding: "9px 12px",
  borderRadius: 8,
  border: "1px solid var(--line)",
  fontSize: 14,
  background: "#fff"
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
  borderRadius: 7,
  border: "1px solid var(--line)",
  fontSize: 14,
  fontWeight: 400,
  color: "var(--ink)"
};
const sel = {
  padding: "7px 9px",
  borderRadius: 7,
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
const prodGrid = {
  display: "grid",
  gridTemplateColumns: "1fr 120px 90px 80px 84px 30px",
  gap: 8
};
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));