/**
 * calendar-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily forward-window pricing+availability scraper for VallartaPulse.
 *
 * Phase 1 (this file): PVRPV only. Airbnb checkpoints + VV seasonal text
 * land in follow-on tasks (T013, T014).
 *
 * For every active PVRPV listing in `rental_listings`, fetches its calendar
 * via fetchPvrpvCalendar (rates table + paginated minicalendar = full
 * 365-day forward window in 2 HTTP fetches), then UPSERTs one row per day
 * into `rental_prices_by_date` keyed on (listing_id, date).
 *
 * Idempotent. Re-running refreshes prices/availability for every covered
 * day. UPSERT target is the unique index `idx_rpbd_unique`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run scrape:calendar
 *   # or against prod:
 *   DATABASE_URL=$RAILWAY_DATABASE_URL pnpm --filter @workspace/scripts run scrape:calendar
 *
 * Env:
 *   DATABASE_URL              required
 *   CALENDAR_MAX_LISTINGS     optional cap (default: all active PVRPV listings)
 *   CALENDAR_CONCURRENCY      default 3
 */

import { sql, eq, and } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  rentalPricesByDateTable,
  type InsertRentalPriceByDate,
} from "@workspace/db";
import {
  fetchPvrpvCalendar,
  type PvrpvCalendarResult,
} from "../../artifacts/api-server/src/lib/ingest/pvrpv-calendar-adapter.js";
import { runPool } from "./lib/concurrency.js";

const SOURCE_PLATFORM = "pvrpv";
const CONCURRENCY = parseInt(process.env.CALENDAR_CONCURRENCY ?? "3", 10);
const MAX_LISTINGS = process.env.CALENDAR_MAX_LISTINGS
  ? parseInt(process.env.CALENDAR_MAX_LISTINGS, 10)
  : null;
const MIN_DELAY_MS = 250;
/** Per-listing hard timeout. PVRPV calendar fetches typically complete in <5s; 60s is generous. */
const HARD_TIMEOUT_MS = 60_000;
/** Fail the run (exit non-zero) when failure rate exceeds this fraction. */
const FAILURE_RATE_FAIL_THRESHOLD = 0.5;

interface ListingRow {
  id: number;
  sourceUrl: string;
  title: string | null;
}

interface PerListingStats {
  listingId: number;
  url: string;
  ok: boolean;
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  rowsWritten: number;
  error?: string;
}

async function loadActiveListings(): Promise<ListingRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      sourceUrl: rentalListingsTable.sourceUrl,
      title: rentalListingsTable.title,
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

function toInsertRows(
  listingId: number,
  result: PvrpvCalendarResult,
  scrapedAt: Date,
): InsertRentalPriceByDate[] {
  return result.days.map((d) => ({
    listingId,
    date: d.date, // YYYY-MM-DD; drizzle `date` accepts string
    nightlyPriceUsd: d.nightlyPriceUsd,
    availabilityStatus: d.availabilityStatus, // "available" | "unavailable" | "unknown"
    minimumNights: d.minimumNights,
    scrapedAt,
  }));
}

async function upsertDays(rows: InsertRentalPriceByDate[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Chunk to keep statements within Postgres's parameter limit
  // (rentalPricesByDateTable insert: 6 values per row → 5000 rows = 30k params).
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

async function processOne(listing: ListingRow): Promise<PerListingStats> {
  const stats: PerListingStats = {
    listingId: listing.id,
    url: listing.sourceUrl,
    ok: false,
    daysReturned: 0,
    daysWithPrice: 0,
    daysAvailable: 0,
    daysUnavailable: 0,
    rowsWritten: 0,
  };
  try {
    const result = await fetchPvrpvCalendar(listing.sourceUrl);
    stats.daysReturned = result.daysReturned;
    stats.daysWithPrice = result.daysWithPrice;
    stats.daysAvailable = result.daysAvailable;
    stats.daysUnavailable = result.daysUnavailable;
    if (result.errors.length > 0 && result.daysReturned === 0) {
      stats.error = result.errors.join("; ").slice(0, 200);
      return stats;
    }
    const insertRows = toInsertRows(listing.id, result, new Date());
    stats.rowsWritten = await upsertDays(insertRows);
    stats.ok = true;
  } catch (e) {
    stats.error = (e as Error).message.slice(0, 200);
  }
  return stats;
}

async function main(): Promise<number> {
  console.log(`[calendar-scrape] start  source=${SOURCE_PLATFORM}  concurrency=${CONCURRENCY}`);
  const all = await loadActiveListings();
  const listings = MAX_LISTINGS ? all.slice(0, MAX_LISTINGS) : all;
  console.log(`[calendar-scrape] loaded  active_pvrpv=${all.length}  processing=${listings.length}`);

  if (listings.length === 0) {
    console.log("[calendar-scrape] no active listings — nothing to do");
    return 0;
  }

  const stats: PerListingStats[] = [];
  let done = 0;
  await runPool(
    listings,
    {
      concurrency: CONCURRENCY,
      hardTimeoutMs: HARD_TIMEOUT_MS,
      delayBetweenMs: MIN_DELAY_MS,
    },
    async (l) => {
      let s: PerListingStats;
      try {
        s = await processOne(l);
      } catch (e) {
        // Includes RunPoolTimeoutError from the outer kill-switch.
        s = {
          listingId: l.id,
          url: l.sourceUrl,
          ok: false,
          daysReturned: 0,
          daysWithPrice: 0,
          daysAvailable: 0,
          daysUnavailable: 0,
          rowsWritten: 0,
          error: (e as Error).message.slice(0, 200),
        };
      }
      stats.push(s);
      done++;
      const tag = s.ok ? "ok " : "ERR";
      const url = l.sourceUrl.replace("https://www.pvrpv.com", "");
      console.log(
        `[${done}/${listings.length}] ${tag} listing=${l.id}  days=${s.daysReturned}` +
          `  price=${s.daysWithPrice}  avail=${s.daysAvailable}  unavail=${s.daysUnavailable}` +
          `  written=${s.rowsWritten}` +
          (s.error ? `  ERROR=${s.error}` : "") +
          `  ${url}`,
      );
    },
  );

  const ok = stats.filter((s) => s.ok);
  const failed = stats.filter((s) => !s.ok);
  const totalRows = stats.reduce((acc, s) => acc + s.rowsWritten, 0);
  const totalAvail = stats.reduce((acc, s) => acc + s.daysAvailable, 0);
  const totalUnavail = stats.reduce((acc, s) => acc + s.daysUnavailable, 0);
  const failureRate = stats.length === 0 ? 0 : failed.length / stats.length;

  console.log("─".repeat(72));
  console.log(`[calendar-scrape] DONE`);
  console.log(`  listings_processed: ${stats.length}`);
  console.log(`  ok                : ${ok.length}`);
  console.log(`  failed            : ${failed.length}`);
  console.log(`  failure_rate      : ${(failureRate * 100).toFixed(1)}%`);
  console.log(`  rows_written      : ${totalRows}`);
  console.log(`  days_available    : ${totalAvail}`);
  console.log(`  days_unavailable  : ${totalUnavail}`);
  if (failed.length > 0) {
    console.log(`  failures (first 10):`);
    for (const f of failed.slice(0, 10)) {
      console.log(`    listing=${f.listingId}  url=${f.url}  error=${f.error}`);
    }
  }

  // Cron health: if too many listings failed, the run was effectively useless;
  // exit non-zero so GitHub Actions / freshness check surfaces it.
  if (failureRate >= FAILURE_RATE_FAIL_THRESHOLD) {
    console.error(
      `[calendar-scrape] FAIL: failure_rate=${(failureRate * 100).toFixed(1)}%` +
        ` >= threshold=${(FAILURE_RATE_FAIL_THRESHOLD * 100).toFixed(0)}%`,
    );
    return 1;
  }
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    if (code !== 0) process.exit(code);
  })
  .catch(async (e) => {
    console.error("[calendar-scrape] FATAL", e);
    await pool.end();
    process.exit(1);
  });
