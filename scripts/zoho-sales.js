// Refresh sales per item from Zoho (the app's Sales table). See lib/zohoSales.js.
// Read-only on Zoho's side. The first run takes about 20 minutes; later runs
// fetch only new or changed orders.
//
//   npm run zoho-sales -- --apply    save to Upstash
//   npm run zoho-sales -- --local    save to data/ for the local server

import fs from "fs";
import { redis } from "./_store.js";
import {
  SALES_KEY,
  SALES_CACHE_KEY,
  EMPTY_SALES_CACHE,
  syncSales,
  summarizeSales,
} from "../lib/zohoSales.js";

const local = process.argv.includes("--local");
if (!local && !process.argv.includes("--apply")) {
  console.error("Pass --apply to save to Upstash, or --local to save to data/");
  process.exit(1);
}

const cacheFile = new URL("../data/sales-cache.json", import.meta.url);
const salesFile = new URL("../data/sales.json", import.meta.url);

const store = local
  ? {
      read: () => (fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : null),
      write: (cache, summary) => {
        fs.writeFileSync(cacheFile, JSON.stringify(cache));
        fs.writeFileSync(salesFile, JSON.stringify(summary));
      },
    }
  : (() => {
      const r = redis();
      return {
        read: () => r.get(SALES_CACHE_KEY),
        write: async (cache, summary) => {
          await r.set(SALES_CACHE_KEY, cache);
          await r.set(SALES_KEY, summary);
        },
      };
    })();

const prev = (await store.read()) || EMPTY_SALES_CACHE;
const { cache, fetched, pending, total } = await syncSales(prev, {
  onProgress: async (c, done, of) => {
    console.log(`${done} of ${of} orders fetched`);
    await store.write(c, summarizeSales(c, { pending: of - done }));
  },
});

const summary = summarizeSales(cache, { pending });
await store.write(cache, summary);
console.log(`${total} orders in the last year, ${fetched} fetched this run, ${pending} still to fetch`);
console.log(`${summary.rows.length} items sold, first order ${summary.firstOrder}`);
