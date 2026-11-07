// Admin sign-in for the hosted app. Signing in sets a cookie holding an expiry
// and an HMAC of it, keyed on BASIC_AUTH_PASS, so changing the password signs
// everyone out. With no password set (local use) everyone counts as admin.
// Web Crypto only: this runs in both Edge middleware and Node functions.

export const COOKIE = "bpm_admin";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

export const authEnabled = () => !!process.env.BASIC_AUTH_PASS;

async function sign(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// compares HMACs so the check doesn't depend on where the guess first differs
export async function passwordMatches(password) {
  const secret = process.env.BASIC_AUTH_PASS;
  if (!secret || typeof password !== "string") return false;
  return sameText(await sign(password, secret), await sign(secret, secret));
}

export async function sessionCookie() {
  const exp = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
  const sig = await sign(`admin.${exp}`, process.env.BASIC_AUTH_PASS);
  return `${COOKIE}=${exp}.${sig}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export const clearedCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// cookieHeader: the raw Cookie request header
export async function isAdmin(cookieHeader) {
  if (!authEnabled()) return true;
  const entry = (cookieHeader || "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!entry) return false;
  const [exp, sig] = entry.slice(COOKIE.length + 1).split(".");
  if (!exp || !sig || Number(exp) * 1000 <= Date.now()) return false;
  return sameText(sig, await sign(`admin.${exp}`, process.env.BASIC_AUTH_PASS));
}
