// Admin sign-in. POST {password} sets the session cookie (see lib/auth.js).
// Wrong passwords are limited per address, so the password can't be guessed
// by sending many tries at once.
import { Redis } from "@upstash/redis";
import { passwordMatches, sessionCookie } from "../lib/auth.js";

const MAX_FAILS = 10;
const WINDOW_S = 15 * 60;

function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? new Redis({ url, token }) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  const ip = req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const key = `bundle-manager:login-fails:${ip}`;
  // every try is counted before the password is checked (one atomic step), so
  // many tries sent at once can't all get in under the limit. A right password
  // clears the count. If Redis is unreachable the limit is skipped, not sign-in
  let r = redis();
  let tries = 0;
  if (r) {
    try {
      tries = await r.incr(key);
      // set on every try, so one lost expiry can't lock an address out for good
      await r.expire(key, WINDOW_S);
    } catch (e) {
      console.error("sign-in limit unavailable:", e);
      r = null;
    }
  }
  if (tries > MAX_FAILS) {
    return res.status(429).json({ error: "Too many wrong tries. Wait 15 minutes." });
  }
  if (!(await passwordMatches(req.body?.password))) {
    await new Promise((ok) => setTimeout(ok, 800));
    return res.status(401).json({ error: "Wrong password" });
  }
  if (r) await r.del(key).catch(() => {});
  res.setHeader("Set-Cookie", await sessionCookie());
  return res.status(200).json({ ok: true });
}
