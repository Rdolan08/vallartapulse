/**
 * airbnb-prune.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Verify-and-prune pass for Airbnb listings.
 *
 * The spike found that ~76% of "active" Airbnb listings now return the
 * 2,671-byte delisted template (raw-fetch.rawFetchLooksUnusable). This pass
 * fetches every active Airbnb listing, applies the predicate, and (when
 * --apply is passed) marks delisted ones is_active=false /
 * lifecycle_status='delisted' / last_seen_at=now().
 *
 * Default mode: DRY-RUN. Prints counts + a sample so the operator can
 * eyeball the result before committing the writes.
 *
 * Usage:
 *   # Dry run (default; safe, no writes):
 *   pnpm --filter @workspace/scripts run prune:airbnb
 *
 *   # Actually apply:
 *   pnpm --filter @workspace/scripts run prune:airbnb -- --apply
 *
 *   # Against prod:
 *   DATABASE_URL=$RAILWAY_DATABASE_URL pnpm --filter @workspace/scripts run prune:airbnb -- --apply
 *
 * Env:
 *   DATABASE_URL          required
 *   PROXY_URL             required (Decodo, used by raw-fetch)
 *   PRUNE_CONCURRENCY     default 4
 *   PRUNE_MAX             optional cap (default: all)
 */

import { sql, eq, and, inArray } from "drizzle-orm";
import { db, pool, rentalListingsTable } from "@workspace/db";
import {
  fetchAirbnbRaw,
  rawFetchLooksUnusable,
} from "../../artifacts/api-server/src/lib/ingest/raw-fetch.js";

const SOURCE_PLATFORM = "airbnb";
const CONCURRENCY = parseInt(process.env.PRUNE_CONCURRENCY ?? "4", 10);
const MAX = process.env.PRUNE_MAX ? parseInt(process.env.PRUNE_MAX, 10) : null;
const MIN_DELAY_MS = 250;
const APPLY = process.argv.includes("--apply");

interface ListingRow {
  id: number;
  sourceUrl: string;
}

type Verdict = "live" | "delisted" | "fetch_error";

interface PerListingResult {
  listing: ListingRow;
  verdict: Verdict;
  reason?: string;
  status?: number;
  bytes?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadActive(): Promise<ListingRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      sourceUrl: rentalListingsTable.sourceUrl,
    })
    .from(rentalListingsTable)
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        eq(rentalListingsTable.isActive, true),
      ),
    );
  return rows.filter((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0);
}

async function checkOne(listing: ListingRow): Promise<PerListingResult> {
  try {
    const r = await fetchAirbnbRaw(listing.sourceUrl, { timeoutMs: 25_000 });
    const bytes = r.html.length;
    const u = rawFetchLooksUnusable(r.html, r.status);
    if (u.unusable) {
      return {
        listing,
        verdict: "delisted",
        reason: u.reason,
        status: r.status,
        bytes,
      };
    }
    return { listing, verdict: "live", status: r.status, bytes };
  } catch (e) {
    return {
      listing,
      verdict: "fetch_error",
      reason: (e as Error).message.slice(0, 160),
    };
  }
}

async function runPool<T>(items: T[], worker: (t: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
      await sleep(MIN_DELAY_MS);
    }
  });
  await Promise.all(runners);
}

async function applyPrune(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const CHUNK = 500;
  let total = 0;
  const now = new Date();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const res = await db
      .update(rentalListingsTable)
      .set({
        isActive: false,
        lifecycleStatus: "delisted",
        lastSeenAt: now,
      })
      .where(inArray(rentalListingsTable.id, slice));
    // node-postgres returns rowCount via the underlying result; drizzle exposes
    // it as `rowCount` on the response.
    total += (res as unknown as { rowCount?: number }).rowCount ?? slice.length;
  }
  return total;
}

async function main(): Promise<void> {
  console.log(
    `[airbnb-prune] start  apply=${APPLY ? "YES (writes)" : "NO (dry-run)"}` +
      `  concurrency=${CONCURRENCY}`,
  );
  const all = await loadActive();
  const listings = MAX ? all.slice(0, MAX) : all;
  console.log(`[airbnb-prune] loaded  active_airbnb=${all.length}  processing=${listings.length}`);

  const results: PerListingResult[] = [];
  let done = 0;
  await runPool(listings, async (l) => {
    const r = await checkOne(l);
    results.push(r);
    done++;
    if (done % 25 === 0 || done === listings.length) {
      const live = results.filter((x) => x.verdict === "live").length;
      const delisted = results.filter((x) => x.verdict === "delisted").length;
      const errors = results.filter((x) => x.verdict === "fetch_error").length;
      console.log(
        `[${done}/${listings.length}] live=${live}  delisted=${delisted}  errors=${errors}`,
      );
    }
  });

  const live = results.filter((r) => r.verdict === "live");
  const delisted = results.filter((r) => r.verdict === "delisted");
  const errors = results.filter((r) => r.verdict === "fetch_error");

  console.log("─".repeat(72));
  console.log(`[airbnb-prune] SCAN COMPLETE`);
  console.log(`  total_checked  : ${results.length}`);
  console.log(`  live           : ${live.length}`);
  console.log(`  delisted       : ${delisted.length}`);
  console.log(`  fetch_errors   : ${errors.length}`);
  if (delisted.length > 0) {
    console.log(`  delisted sample (first 10):`);
    for (const d of delisted.slice(0, 10)) {
      console.log(
        `    id=${d.listing.id}  bytes=${d.bytes}  status=${d.status}  reason=${d.reason}  ${d.listing.sourceUrl}`,
      );
    }
  }
  if (errors.length > 0) {
    console.log(`  fetch_errors sample (first 5):`);
    for (const e of errors.slice(0, 5)) {
      console.log(`    id=${e.listing.id}  reason=${e.reason}  ${e.listing.sourceUrl}`);
    }
  }

  if (APPLY) {
    const ids = delisted.map((d) => d.listing.id);
    console.log(`[airbnb-prune] APPLY: marking ${ids.length} listings delisted ...`);
    const updated = await applyPrune(ids);
    console.log(`[airbnb-prune] APPLY: rows_updated=${updated}`);
  } else {
    console.log(`[airbnb-prune] DRY-RUN — no writes. Re-run with -- --apply to commit.`);
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error("[airbnb-prune] FATAL", e);
    await pool.end();
    process.exit(1);
  });
