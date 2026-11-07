// Hosted persistence for the Bundle Price Manager (Vercel serverless function).
// Stores the whole {products, bundles, trash} document as one JSON value in
// Upstash Redis, mirroring what server.js does with data/data.json locally.
//
// PUT is diff-based, not a full replace — see lib/mergeData.js for why: it
// lets two people with the app open at once edit different items without
// one person's save silently overwriting the other's.
//
// Env vars (set by the Upstash + Vercel integration, either naming works):
//   UPSTASH_REDIS_REST_URL   / KV_REST_API_URL
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN

import { Redis } from "@upstash/redis";
import { mergeUpserts, mergeTrash, mergeSet } from "../lib/mergeData.js";
import { applyTeamSave, keepTeamEdits } from "../lib/teamRules.js";
import { isAdmin } from "../lib/auth.js";

let _redis;
function getRedis() {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error(
        "Upstash Redis is not configured — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN"
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

const KEY = "bundle-manager:data";
const BACKUPS = "bundle-manager:backups";
const TEAM_BACKUP_LOCK = "bundle-manager:team-backup-lock";
const MAX_BACKUPS = 20;
const TEAM_BACKUP_EVERY_S = 60 * 60;

const EMPTY = { products: [], bundles: [], trash: [], updatedAt: null };

// what the no-password team view gets: everything but Trash
export const forTeam = (doc) => ({ ...doc, trash: [] });

export default async function handler(req, res) {
  try {
    const redis = getRedis();
    const admin = await isAdmin(req.headers.cookie);

    if (req.method === "GET") {
      const data = (await redis.get(KEY)) || EMPTY;
      return res.status(200).json(admin ? data : forTeam(data));
    }

    if (req.method === "PUT") {
      // the admin page says so, so an expired sign-in can't save as the team
      if (req.headers["x-app-view"] === "admin" && !admin) {
        return res.status(401).json({ error: "Signed out, sign in again", signin: true });
      }
      const { productsDiff, bundlesDiff, trashDiff, excludedSkusDiff, excludedBundleNamesDiff } = req.body || {};
      if (!productsDiff || !bundlesDiff) {
        return res.status(400).json({ error: "productsDiff and bundlesDiff are required" });
      }

      // read fresh — not the client's idea of what was there, so a
      // concurrent edit from someone else isn't silently discarded
      const prev = (await redis.get(KEY)) || EMPTY;

      if (!admin) {
        const { doc, changed, stale } = applyTeamSave(prev, req.body);
        if (!changed) return res.status(200).json({ ok: true, data: forTeam(prev), stale });
        // at most one backup an hour, so team saves can't push out the rest
        if (await redis.set(TEAM_BACKUP_LOCK, "1", { nx: true, ex: TEAM_BACKUP_EVERY_S })) {
          await redis.lpush(BACKUPS, JSON.stringify({ at: new Date().toISOString(), data: prev }));
          await redis.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);
        }
        await redis.set(KEY, doc);
        return res.status(200).json({ ok: true, data: forTeam(doc), stale });
      }

      // rolling backup of the previous version (last 20 kept)
      await redis.lpush(BACKUPS, JSON.stringify({ at: new Date().toISOString(), data: prev }));
      await redis.ltrim(BACKUPS, 0, MAX_BACKUPS - 1);

      const saved = {
        ...prev,
        products: mergeUpserts(prev.products || [], keepTeamEdits(prev.products, productsDiff.upserts, "price"), productsDiff.deletes),
        bundles: mergeUpserts(prev.bundles || [], keepTeamEdits(prev.bundles, bundlesDiff.upserts, "storedPrice"), bundlesDiff.deletes),
        trash: mergeTrash(prev.trash || [], trashDiff?.upserts, trashDiff?.deletes),
        excludedSkus: mergeSet(prev.excludedSkus, excludedSkusDiff?.added, excludedSkusDiff?.removed),
        excludedBundleNames: mergeSet(prev.excludedBundleNames, excludedBundleNamesDiff?.added, excludedBundleNamesDiff?.removed),
        updatedAt: new Date().toISOString(),
      };
      await redis.set(KEY, saved);
      // return the full merged doc so the client can adopt it — this is
      // also how a client picks up anyone else's concurrent changes
      return res.status(200).json({ ok: true, data: saved });
    }

    res.setHeader("Allow", "GET, PUT");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    console.error("storage error:", e);
    return res.status(500).json({ error: "storage error", detail: String(e?.message || e) });
  }
}
