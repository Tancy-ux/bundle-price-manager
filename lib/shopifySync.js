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

  // 1) new products — active, has SKU, not already in the catalog by SKU
  const newProducts = [];
  for (const v of incoming) {
    const s = normSku(v.sku);
    if (!s || v.status !== "active" || bySku.has(s)) continue;
    newProducts.push({ id: uid(), sku: v.sku, name: v.name, price: v.price, active: true });
  }

  // 2) new bundle shells — active, no SKU, name not already tracked here
  const newBundles = [];
  for (const v of incoming) {
    if (normSku(v.sku) || v.status !== "active") continue;
    if (isExcludedBundleName(v.name)) continue;
    const n = normName(v.name);
    if (!n || bundleNames.has(n) || productNames.has(n)) continue;
    bundleNames.add(n); // guard against dupes within this same run
    newBundles.push({ id: uid(), sku: "", name: v.name, items: [], storedPrice: v.price });
  }

  // 3) stock refresh — match every product (existing + just-added) by SKU
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
    return { ...p, stock: hit.inventoryQty, stockTracked: hit.inventoryTracked, stockUpdatedAt: now };
  });

  const merged = {
    ...base,
    products: mergedProducts,
    bundles: [...bundles, ...newBundles],
    lastSyncAt: now,
  };

  const summary = {
    addedProducts: newProducts.length,
    addedBundles: newBundles.length,
    stockUpdated,
    wentOOS,
    backInStock,
    totalOOS: mergedProducts.filter((p) => p.stockTracked && (p.stock || 0) <= 0).length,
    at: now,
  };

  return { merged, summary };
}
