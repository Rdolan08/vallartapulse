/**
 * airroi-pricing-refresh.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Forward-rate + availability refresh for the active Airbnb cohort, via
 * AirROI's `/listings/future/rates` endpoint.
 *
 * Replaces the AVAILABILITY half of `scrape:airbnb-calendar` AND the
 * pricing half of `scrape:airbnb-pricing` (broken since 2026-04-19) for
 * the Airbnb cohort. Single HTTPS call per listing, no proxy, no
 * headless browser. Writes only `rental_prices_by_date` (AirROI lacks
 * fee breakdowns, so `listing_price_quotes` continues to be owned by
 * the GraphQL quote pipeline whenever that's restored).
 *
 * Cost model (April 2026 observed): ~$0.015 per successful call.
 *   - Full 504-listing refresh ≈ $7.56 / run
 *   - Daily   = ~$227/mo  (NOT recommended for hobby budget)
 *   - Weekly  = ~$32/mo   (sustainable; recommended baseline)
 *   - Top-50 daily + weekly full = ~$54/mo (hybrid)
 *
 * Defaults err on the side of cheap-and-safe:
 *   AIRROI_MAX_LISTINGS=10
 *   AIRROI_CONCURRENCY=2
 *   AIRROI_DRY_RUN unset (live)
 *
 * Usage:
 *   AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:refresh
 *
 *   # Smoke test (5 listings, ~$0.08):
 *   AIRROI_MAX_LISTINGS=5 \
 *     AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:refresh
 *
 *   # Full cohort:
 *   AIRROI_MAX_LISTINGS=600 \
 *     AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:refresh
 *
 *   # Dry-run any cohort size (no DB writes; AirROI calls still bill):
 *   AIRROI_DRY_RUN=1 AIRROI_MAX_LISTINGS=5 \
 *     AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:refresh
 *
 * Env:
 *   AIRROI_API_KEY              required
 *   DATABASE_URL                required (use $RAILWAY_DATABASE_URL for prod)
 *   AIRROI_MAX_LISTINGS         default 10  (BUDGET CAP — process at most N listings)
 *   AIRROI_CONCURRENCY          default 2   (gentle on AirROI cold-starts)
 *   AIRROI_DRY_RUN              "1" → skip DB writes (AirROI billing still applies)
 *   AIRROI_CURRENCY             default "usd"
 *
 * Exit codes:
 *   0 = success (failure rate below threshold)
 *   1 = aggregate failure (>= 75% listings failed; cron alert trigger)
 *   2 = config error (missing env, no listings, etc.)
 */

import { sql, eq, and, isNotNull, asc } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  rentalPricesByDateTable,
  type InsertRentalPriceByDate,
} from "@workspace/db";
import {
  fetchAirroiCalendar,
  mapAirroiToInsertRows,
  AirroiFetchError,
} from "../../artifacts/api-server/src/lib/ingest/airroi-adapter.js";
import { runPool } from "./lib/concurrency.js";

const SOURCE_PLATFORM = "airbnb";
const CONCURRENCY = parseInt(process.env.AIRROI_CONCURRENCY ?? "2", 10);
const MAX_LISTINGS = parseInt(process.env.AIRROI_MAX_LISTINGS ?? "10", 10);
const HARD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per listing (covers retry chain)
const MIN_DELAY_MS = 500;
const FAILURE_RATE_FAIL_THRESHOLD = 0.75;
const CURRENCY = process.env.AIRROI_CURRENCY ?? "usd";
const DRY_RUN = process.env.AIRROI_DRY_RUN === "1";
/**
 * Listing ordering for the cohort selection. Two modes:
 *   "id"      — ORDER BY id ASC (default; deterministic for repeatable smoke tests)
 *   "reviews" — ORDER BY review_count DESC NULLS LAST, id ASC
 *               (popular-first; maximizes coverage hit-rate against AirROI,
 *                and produces the "top-N daily refresh" cohort directly)
 */
const ORDER = (process.env.AIRROI_ORDER ?? "id").toLowerCase();

interface ListingRow {
  id: number;
  externalId: string;
  title: string | null;
}

interface PerListingStats {
  listingId: number;
  externalId: string;
  ok: boolean;
  daysReturned: number;
  daysAvailable: number;
  daysWithRate: number;
  rowsWritten: number;
  totalElapsedMs: number;
  attemptCount: number;
  error?: string;
}

async function loadActiveListings(): Promise<ListingRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      externalId: rentalListingsTable.externalId,
      title: rentalListingsTable.title,
    })
    .from(rentalListingsTable)
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        eq(rentalListingsTable.isActive, true),
        isNotNull(rentalListingsTable.externalId),
      ),
    )
    .orderBy(
      ...(ORDER === "reviews"
        ? [sql`${rentalListingsTable.reviewCount} DESC NULLS LAST`, asc(rentalListingsTable.id)]
        : [asc(rentalListingsTable.id)]),
    );
  // Numeric externalId only — AirROI requires it.
  const out: ListingRow[] = [];
  for (const r of rows) {
    const ext = r.externalId;
    if (typeof ext !== "string") continue;
    if (!/^\d+$/.test(ext)) continue;
    out.push({ id: r.id, externalId: ext, title: r.title });
  }
  return out;
}

async function upsertDays(rows: InsertRentalPriceByDate[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Match the chunk size used by airbnb-calendar-scrape (Postgres parameter
  // limit headroom: 6 values/row × 1000 = 6k params, comfortable).
  const CHUNK = 1000;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db
      .insert(rentalPricesByDateTable)
      .values(slice)
      .onConflictDoUpdate({
        target: [rentalPricesByDateTable.listingId, rentalPricesByDateTable.date],
        set: {
          nightlyPriceUsd: sql`EXCLUDED.nightly_price_usd`,
          availabilityStatus: sql`EXCLUDED.availability_status`,
          minimumNights: sql`EXCLUDED.minimum_nights`,
          scrapedAt: sql`EXCLUDED.scraped_at`,
        },
      });
    total += slice.length;
  }
  return total;
}

async function processOne(
  listing: ListingRow,
  apiKey: string,
): Promise<PerListingStats> {
  const stats: PerListingStats = {
    listingId: listing.id,
    externalId: listing.externalId,
    ok: false,
    daysReturned: 0,
    daysAvailable: 0,
    daysWithRate: 0,
    rowsWritten: 0,
    totalElapsedMs: 0,
    attemptCount: 0,
  };
  try {
    const result = await fetchAirroiCalendar(listing.externalId, {
      apiKey,
      currency: CURRENCY,
      // Defaults: 3 attempts, 5s/15s backoff, 60s per-attempt timeout
    });
    stats.daysReturned = result.days.length;
    stats.daysAvailable = result.days.filter((d) => d.available).length;
    stats.daysWithRate = result.days.filter((d) => d.rate != null).length;
    stats.totalElapsedMs = result.totalElapsedMs;
    stats.attemptCount = result.attemptCount;

    const scrapedAt = new Date();
    const rows = mapAirroiToInsertRows(listing.id, result, scrapedAt);
    if (DRY_RUN) {
      stats.rowsWritten = 0;
    } else {
      stats.rowsWritten = await upsertDays(rows);
    }
    stats.ok = true;
  } catch (e) {
    if (e instanceof AirroiFetchError) {
      stats.totalElapsedMs = e.attempts.reduce((a, x) => a + x.elapsedMs, 0);
      stats.attemptCount = e.attempts.length;
      stats.error = `airroi:${e.lastStatus ?? "neterr"} attempts=${e.attempts.length}`;
    } else {
      stats.error = `unknown:${(e as Error).message}`;
    }
  }
  return stats;
}

async function main(): Promise<number> {
  const apiKey = process.env.AIRROI_API_KEY;
  if (!apiKey) {
    console.error("ERROR: AIRROI_API_KEY env var not set.");
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL env var not set (use $RAILWAY_DATABASE_URL for prod).");
    return 2;
  }

  console.log(
    `[airroi-refresh] start  max=${MAX_LISTINGS}  concurrency=${CONCURRENCY}  dryRun=${DRY_RUN}  currency=${CURRENCY}`,
  );

  const all = await loadActiveListings();
  const listings = all.slice(0, MAX_LISTINGS);
  console.log(
    `[airroi-refresh] selected ${listings.length} of ${all.length} active Airbnb listings (cap=${MAX_LISTINGS})`,
  );
  if (listings.length === 0) {
    console.error("[airroi-refresh] no listings to process");
    return 2;
  }

  const stats: PerListingStats[] = [];
  let done = 0;
  await runPool(
    listings,
    { concurrency: CONCURRENCY, hardTimeoutMs: HARD_TIMEOUT_MS, delayBetweenMs: MIN_DELAY_MS },
    async (l) => {
      const s = await processOne(l, apiKey);
      stats.push(s);
      done++;
      const tag = s.ok ? "ok " : "ERR";
      const ms = `${(s.totalElapsedMs / 1000).toFixed(1)}s`;
      console.log(
        `[${done}/${listings.length}] ${tag} listing=${l.id} ext=${l.externalId}` +
          `  days=${s.daysReturned}  avail=${s.daysAvailable}  rated=${s.daysWithRate}` +
          `  written=${s.rowsWritten}  attempts=${s.attemptCount}  elapsed=${ms}` +
          (s.error ? `  ERROR=${s.error}` : ""),
      );
    },
  );

  const ok = stats.filter((s) => s.ok);
  const failed = stats.filter((s) => !s.ok);
  const totalRows = stats.reduce((a, s) => a + s.rowsWritten, 0);
  const totalAvail = stats.reduce((a, s) => a + s.daysAvailable, 0);
  const totalRated = stats.reduce((a, s) => a + s.daysWithRate, 0);
  const totalAttempts = stats.reduce((a, s) => a + s.attemptCount, 0);
  const totalElapsedMs = stats.reduce((a, s) => a + s.totalElapsedMs, 0);
  const failureRate = stats.length === 0 ? 0 : failed.length / stats.length;

  console.log("─".repeat(72));
  console.log(`[airroi-refresh] DONE`);
  console.log(`  listings_processed : ${stats.length}`);
  console.log(`  ok                 : ${ok.length}`);
  console.log(`  failed             : ${failed.length}`);
  console.log(`  failure_rate       : ${(failureRate * 100).toFixed(1)}%`);
  console.log(`  rows_written       : ${totalRows}${DRY_RUN ? "  (DRY_RUN; nothing actually written)" : ""}`);
  console.log(`  days_available     : ${totalAvail}`);
  console.log(`  days_with_rate     : ${totalRated}`);
  console.log(`  airroi_attempts    : ${totalAttempts}  (≈$${(totalAttempts * 0.015).toFixed(2)} burn @ $0.015/call)`);
  console.log(`  total_fetch_secs   : ${(totalElapsedMs / 1000).toFixed(1)}s (sum across listings)`);
  if (failed.length > 0) {
    console.log(`  failures (first 10):`);
    for (const f of failed.slice(0, 10)) {
      console.log(`    listing=${f.listingId}  ext=${f.externalId}  error=${f.error}`);
    }
  }

  if (failureRate >= FAILURE_RATE_FAIL_THRESHOLD) {
    console.error(
      `[airroi-refresh] FAIL: failure_rate=${(failureRate * 100).toFixed(1)}%` +
        ` >= threshold=${(FAILURE_RATE_FAIL_THRESHOLD * 100).toFixed(0)}%`,
    );
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error("[airroi-refresh] fatal", err);
    try {
      await pool.end();
    } catch {
      // ignore
    }
    process.exit(1);
  });
