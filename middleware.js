// Decides who reaches what on the hosted app (Vercel Edge Middleware).
//   Team (no password): /inventory, plus the data calls it needs.
//   Admin (signed in at /login): everything.
// api/data.js narrows what the team's data calls can read and change.
// Active only when BASIC_AUTH_PASS is set. Otherwise the site is open, same as
// the local server.

import { next } from "@vercel/edge";
import { authEnabled, isAdmin } from "./lib/auth.js";

const OPEN_PATHS = new Set([
  "/login",
  "/login.html",
  "/api/login",
  "/api/logout",
  "/inventory",
  "/inventory.html",
  "/app.js",
  "/theme.css",
]);

const TEAM_CALLS = {
  "/api/data": ["GET", "PUT"],
  "/api/reorder": ["GET", "POST", "PATCH"],
  "/api/sync": ["POST"],
};

export default async function middleware(req) {
  if (!authEnabled()) return next();

  const url = new URL(req.url);
  const path = url.pathname;
  if (OPEN_PATHS.has(path) || TEAM_CALLS[path]?.includes(req.method)) return next();
  if (await isAdmin(req.headers.get("cookie"))) return next();

  if (path.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "admin sign-in required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return Response.redirect(new URL("/login", url), 302);
}
