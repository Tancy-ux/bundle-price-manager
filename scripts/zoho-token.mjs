// Swap a Zoho Self Client code for a new refresh token and save it in .env.
// Generate the code at api-console.zoho.in (Self Client → Generate Code), then:
//
//   node --env-file=.env scripts/zoho-token.mjs <code>
//
// Vercel and GitHub Actions keep their own copy of ZOHO_REFRESH_TOKEN, so update
// those by hand when a change that needs the new scopes goes live.

import fs from "fs";

const code = process.argv[2];
if (!code) {
  console.error("Usage: node --env-file=.env scripts/zoho-token.mjs <code>");
  process.exit(1);
}

const accountsUrl = process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.in";
const body = new URLSearchParams({
  code,
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  grant_type: "authorization_code",
});
const j = await (await fetch(`${accountsUrl}/oauth/v2/token`, { method: "POST", body })).json();
if (!j.refresh_token) {
  console.error(`Zoho didn't return a refresh token: ${j.error || "unknown error"}`);
  console.error("Codes expire within minutes and work once, so generate a fresh one and retry.");
  process.exit(1);
}

const envFile = new URL("../.env", import.meta.url);
const env = fs.readFileSync(envFile, "utf8");
const line = `ZOHO_REFRESH_TOKEN=${j.refresh_token}`;
fs.writeFileSync(envFile, env.replace(/^ZOHO_REFRESH_TOKEN=.*$/m, () => line));

console.log("Saved the new refresh token to .env");
console.log(`Scopes: ${j.scope}`);
