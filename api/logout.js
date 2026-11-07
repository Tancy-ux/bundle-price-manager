// Admin sign-out: clears the session cookie.
import { clearedCookie } from "../lib/auth.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  res.setHeader("Set-Cookie", clearedCookie());
  return res.status(200).json({ ok: true });
}
