// HTTP Basic Auth for the whole hosted app (Vercel Edge Middleware).
// Active only when BOTH env vars are set — otherwise the site is open, same as
// the local server. Set these in the Vercel project's Environment Variables:
//   BASIC_AUTH_USER
//   BASIC_AUTH_PASS

import { next } from "@vercel/edge";

export default function middleware(req) {
  const USER = process.env.BASIC_AUTH_USER;
  const PASS = process.env.BASIC_AUTH_PASS;
  if (!USER || !PASS) return next();

  const [scheme, encoded] = (req.headers.get("authorization") || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = atob(encoded).split(":");
    if (user === USER && pass === PASS) return next();
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Bundle Price Manager"' },
  });
}
