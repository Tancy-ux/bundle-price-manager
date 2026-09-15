// Shared Shopify sync logic for the in-app "Sync with Shopify" button.
// Used by api/sync.js (hosted, Vercel) and the matching route in server.js
// (local dev). Fetches the full product/variant list from Shopify ONCE and
// derives all three operations from it in a single pass:
//   1. new products   — active, has a SKU, not already in the catalog by SKU
//   2. new bundle shells — active, no SKU, name not already a bundle/product
//      (mirrors scripts/import-bundle-shells.js, including its exclusion list)
//   3. stock refresh  — every product matched by SKU gets stock/stockTracked updated
//      (mirrors scripts/fetch-stock.js)
//
// SAFE BY DESIGN: only ever adds new products/bundles and updates stock fields.
// Never edits or deletes an existing product/bundle, never touches prices,
// items, or history.

const API_VERSION = "2025-01";

const uid = () => Math.random().toString(36).slice(2, 9);
export const normSku = (s) => (s || "").trim().toLowerCase();
export const normName = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// same shape/cap as the frontend's pushHistory (public/app.src.jsx) — kept
// separately since the frontend can't be imported into a server context
const MAX_HISTORY = 50;
export const pushHistory = (item, from, to) =>
  [{ at: new Date().toISOString(), from, to }, ...(item.history || [])].slice(0, MAX_HISTORY);

// not bundles — gift cards, payment/testing artifacts (same list as
// scripts/import-bundle-shells.js)
const EXCLUDE_BUNDLE_KEYWORDS = ["gift card", "voucher", "partial payment", "bogus"];
const isExcludedBundleName = (name) => {
  const n = normName(name);
  return EXCLUDE_BUNDLE_KEYWORDS.some((k) => n.includes(k));
};

// paginated fetch of every variant, flattened, with status + inventory info
export async function fetchShopifyCatalog({ store, token }) {
  if (!store || !token) {
    throw new Error("Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN");
  }
  let url = `https://${store}/admin/api/${API_VERSION}/products.json?limit=250&fields=id,title,status,variants`;
  const out = [];
  while (url) {
    const res = await fetch(url, { headers: { "X-Shopify-Access-Token": token } });
    if (!res.ok) throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    for (const p of body.products || []) {
      for (const v of p.variants || []) {
        const variantName =
          v.title && v.title !== "Default Title" ? `${p.title} ${v.title}` : p.title;
        const tracked = v.inventory_management === "shopify";
        out.push({
          variantId: v.id,
          name: variantName,
          sku: (v.sku || "").trim(),
          price: parseFloat(v.price) || 0,
          status: p.status,
          inventoryTracked: tracked,
          inventoryQty: tracked ? Number(v.inventory_quantity) || 0 : null,
        });
      }
    }
    const link = res.headers.get("link") || "";
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  return out;
}

// pure function: given the current {products,bundles,...} doc and the fetched
// Shopify variants, returns the merged doc plus a summary of what changed
export function computeSync(base, shopifyVariants) {
  const now = new Date().toISOString();
  const products = base.products || [];
  const bundles = base.bundles || [];
  // SKUs/bundle-names the user has deliberately deleted (still in Trash, or
  // permanently deleted) — never re-add these, restoring from Trash clears them
  const excludedSkus = new Set(base.excludedSkus || []);
  const excludedBundleNames = new Set(base.excludedBundleNames || []);

  const bySku = new Map();
  products.forEach((p) => { const s = normSku(p.sku); if (s) bySku.set(s, p); });
  const productNames = new Set(products.map((p) => normName(p.name)));
  const bundleNames = new Set(bundles.map((b) => normName(b.name)));

  // dedupe incoming: by SKU when present, else by normalised name
  const seen = new Set();
  const incoming = shopifyVariants.filter((v) => {
    const key = normSku(v.sku) ? "s:" + normSku(v.sku) : "n:" + normName(v.name);
    if (key === "n:" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 1) new products — active, has SKU, not already in the catalog by SKU,
  // and not a SKU the user deliberately deleted before
  const newProducts = [];
  let skippedExcludedProducts = 0;
  for (const v of incoming) {
    const s = normSku(v.sku);
    if (!s || v.status !== "active" || bySku.has(s)) continue;
    if (excludedSkus.has(s)) { skippedExcludedProducts++; continue; }
    newProducts.push({ id: uid(), sku: v.sku, name: v.name, price: v.price, active: true, shopifyVariantId: v.variantId });
  }

  // 2) new bundle shells — active, no SKU, name not already tracked here,
  // and not a name the user deliberately deleted before
  const newBundles = [];
  let skippedExcludedBundles = 0;
  for (const v of incoming) {
    if (normSku(v.sku) || v.status !== "active") continue;
    if (isExcludedBundleName(v.name)) continue;
    const n = normName(v.name);
    if (!n || bundleNames.has(n) || productNames.has(n)) continue;
    if (excludedBundleNames.has(n)) { skippedExcludedBundles++; continue; }
    bundleNames.add(n); // guard against dupes within this same run
    newBundles.push({ id: uid(), sku: "", name: v.name, items: [], storedPrice: v.price, shopifyVariantId: v.variantId });
  }

  // 3) stock refresh — match every product (existing + just-added) by SKU.
  // Also (re)links the Shopify variant ID here — needed for the "push price
  // to Shopify" button, which only ever writes to a variant this app has
  // actually matched, never by guessing a name/handle at push-time.
  const stockBySku = new Map();
  incoming.forEach((v) => { const s = normSku(v.sku); if (s) stockBySku.set(s, v); });

  let stockUpdated = 0, wentOOS = 0, backInStock = 0;
  const mergedProducts = [...products, ...newProducts].map((p) => {
    const s = normSku(p.sku);
    const hit = s && stockBySku.get(s);
    if (!hit) return p;
    const wasOOS = p.stockTracked && (p.stock || 0) <= 0;
    const isOOS = hit.inventoryTracked && (hit.inventoryQty || 0) <= 0;
    if (!wasOOS && isOOS) wentOOS++;
    if (wasOOS && !isOOS) backInStock++;
    if (hit.inventoryTracked !== p.stockTracked || hit.inventoryQty !== p.stock) stockUpdated++;
    return { ...p, stock: hit.inventoryQty, stockTracked: hit.inventoryTracked, stockUpdatedAt: now, shopifyVariantId: hit.variantId };
  });

  // link existing bundles to their Shopify variant by name — but only when
  // exactly one incoming no-SKU listing has that name. A name collision
  // (like the real draft+active duplicate this store had) means "don't
  // guess", so it's left unlinked rather than risking a wrong-target push.
  const noSkuByName = new Map();
  incoming.forEach((v) => {
    if (normSku(v.sku)) return;
    const n = normName(v.name);
    if (!n) return;
    noSkuByName.set(n, noSkuByName.has(n) ? "AMBIGUOUS" : v);
  });
  let bundlesLinked = 0;
  const mergedBundles = [...bundles, ...newBundles].map((b) => {
    const hit = noSkuByName.get(normName(b.name));
    if (!hit || hit === "AMBIGUOUS" || hit.variantId === b.shopifyVariantId) return b;
    bundlesLinked++;
    return { ...b, shopifyVariantId: hit.variantId };
  });

  const merged = {
    ...base,
    products: mergedProducts,
    bundles: mergedBundles,
    lastSyncAt: now,
  };

  const summary = {
    addedProducts: newProducts.length,
    addedBundles: newBundles.length,
    skippedExcludedProducts,
    skippedExcludedBundles,
    stockUpdated,
    wentOOS,
    backInStock,
    bundlesLinked,
    totalOOS: mergedProducts.filter((p) => p.stockTracked && (p.stock || 0) <= 0).length,
    at: now,
  };

  return { merged, summary };
}

// Push ONE variant's price to Shopify. Only ever sends {id, price} in the
// request body — Shopify's REST variant-update endpoint is field-scoped, so
// nothing else on that variant or its parent product (title, images,
// inventory, status) is touched by this call.
export async function pushVariantPrice({ store, token, variantId, price }) {
  if (!store || !token) {
    throw new Error("Shopify not configured — set SHOPIFY_STORE and SHOPIFY_ADMIN_TOKEN");
  }
  if (!variantId) {
    throw new Error("Not linked to a Shopify variant yet — run a sync first");
  }
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/variants/${variantId}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ variant: { id: variantId, price: String(price) } }),
  });
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.variant;
}
