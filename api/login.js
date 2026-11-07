// Admin sign-in. POST {password} sets the session cookie (see lib/auth.js).
import { passwordMatches, sessionCookie } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!(await passwordMatches(req.body?.password))) {
    // slows down password guessing
    await new Promise((ok) => setTimeout(ok, 800));
    return res.status(401).json({ error: "Wrong password" });
  }
  res.setHeader("Set-Cookie", await sessionCookie());
  return res.status(200).json({ ok: true });
}
