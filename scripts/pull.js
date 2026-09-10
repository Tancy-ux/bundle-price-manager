// Download the current live catalog from Upstash to local files.
// Use it as a backup, or to inspect what's actually live before a sync.
//
//   npm run pull

import fs from "fs";
import { pull } from "./_store.js";

const data = await pull();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const snap = new URL(`../data/live-${stamp}.json`, import.meta.url);
fs.writeFileSync(snap, JSON.stringify(data, null, 2));
fs.writeFileSync(new URL("../data/data.json", import.meta.url), JSON.stringify(data, null, 2));

console.log(
  `Pulled ${data.products.length} products / ${data.bundles.length} bundles / ` +
    `${(data.trash || []).length} trash.`
);
console.log(`Wrote data/live-${stamp}.json and refreshed data/data.json`);
