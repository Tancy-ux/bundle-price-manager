// Gets an offline Admin API token for the custom-bundle Shopify app through
// the browser approval round-trip (authorization code grant), checks it
// against the store, and copies it to the clipboard for pasting into
// SHOPIFY_ADMIN_TOKEN (Vercel env vars + GitHub Actions secrets). The token
// is never printed.
//
// Why this and not client ID + secret: the app lives in a different Dev
// Dashboard organization from the store, so Shopify refuses the client
// credentials grant (shop_not_permitted). The approval round-trip works
// regardless.
//
// Run it again whenever the app is uninstalled/reinstalled — uninstalling
// revokes the old token.
//
// Usage (PowerShell), with the app's keys from Dev Dashboard > custom-bundle
// > Settings:
//   $env:SHOPIFY_CLIENT_ID="..."; $env:SHOPIFY_CLIENT_SECRET="..."
//   node scripts/shopify-token.mjs
// Then approve in the browser window that opens.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawnSync, exec } from "node:child_process";

const SHOP = "ware-innovations-mumbai.myshopify.com";
const PORT = 8787; // must match the app's allowed redirect URL
const REDIRECT = `http://localhost:${PORT}/callback`;
// The app's full scope list, so approving doesn't change what the app
// already has on the store (this tool only needs write_products +
// read_inventory; the rest are for the bundles extension).
const SCOPES = process.env.SHOPIFY_SCOPES ??
  "read_cart_transforms,write_cart_transforms,write_inventory,read_inventory,write_metaobject_definitions,write_metaobjects,write_products";

const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET first (see the top of this file).");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const authorizeUrl = `https://${SHOP}/admin/oauth/authorize?${new URLSearchParams({
  client_id: clientId,
  scope: SCOPES,
  redirect_uri: REDIRECT,
  state,
})}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const finish = (status, message) => {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(message);
    server.close();
  };
  if (url.searchParams.get("state") !== state) {
    finish(400, "State didn't match. Run the script again.");
    console.error("State didn't match; stopped.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    finish(400, "No code from Shopify. Run the script again.");
    return;
  }

  const tokenRes = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const data = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !data.access_token) {
    finish(500, "Shopify didn't return a token. See the terminal.");
    console.error("Token exchange failed:", tokenRes.status, JSON.stringify(data).slice(0, 300));
    return;
  }
  // Shopify drops read_x from the granted list when write_x is granted
  const granted = String(data.scope ?? "").split(",");
  const has = (s) => granted.includes(s) || granted.includes(s.replace(/^read_/, "write_"));
  const missing = ["write_products", "read_inventory"].filter((s) => !has(s));
  if (missing.length) {
    console.warn(`Warning: the token's scopes are "${data.scope}", missing ${missing.join(", ")}.`);
  }

  // same call the sync makes, so a working token here means a working sync
  const check = await fetch(`https://${SHOP}/admin/api/2025-01/products.json?limit=1&fields=id`, {
    headers: { "X-Shopify-Access-Token": data.access_token },
  });
  if (!check.ok) {
    finish(500, "Got a token, but Shopify rejected it. See the terminal.");
    console.error(`Test call failed: Shopify API ${check.status}`);
    return;
  }

  // Onto the clipboard, never shown on screen.
  const copied = spawnSync("clip", { input: data.access_token, shell: true });
  if (copied.status === 0) {
    finish(200, "Done! The token is on your clipboard. You can close this tab.");
    console.log(`Token works and is on your clipboard (scopes: ${data.scope}).`);
    console.log("Paste it as SHOPIFY_ADMIN_TOKEN in Vercel (then Redeploy) and in GitHub Actions secrets.");
    if (data.expires_in) {
      console.log(`Note: this token expires in about ${Math.round(data.expires_in / 3600)} hours.`);
    }
  } else {
    finish(500, "Couldn't copy the token to the clipboard. See the terminal.");
    console.error("Copying to the clipboard failed.");
  }
});

server.listen(PORT, () => {
  console.log("Opening Shopify to approve the app. If nothing opens, visit:\n" + authorizeUrl);
  const opener = process.platform === "win32" ? `start "" "${authorizeUrl}"` : `open "${authorizeUrl}"`;
  exec(opener);
});
