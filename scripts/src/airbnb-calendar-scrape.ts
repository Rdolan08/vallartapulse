/**
 * airbnb-calendar-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily forward-window AVAILABILITY scraper for Airbnb listings.
 *
 * Sister script to `calendar-scrape.ts` (PVRPV). Same target table
 * (`rental_prices_by_date`), same UPSERT semantics — but writes
 * `nightlyPriceUsd: null` since Airbnb's public homes_pdp_availability_calendar
 * endpoint no longer returns prices (only availability + min/max-nights).
 * Full rationale + spike notes in
 * artifacts/api-server/src/lib/ingest/airbnb-calendar-adapter.ts.
 *
 * Per active Airbnb listing in `rental_listings`:
 *   1. Fetch /api/v2/homes_pdp_availability_calendar (one HTTP call,
 *      ~1s, no proxy required).
 *   2. UPSERT 365 days into rental_prices_by_date keyed on (listing_id, date).
 *
 * Idempotent. Re-running refreshes the availability + min-nights for every
 * covered day. Plays nicely with PVRPV's calendar-scrape — both target the
 * same unique index `idx_rpbd_unique`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run scrape:airbnb-calendar
 *   # or against prod:
 *   DATABASE_URL=$RAILWAY_DATABASE_URL pnpm --filter @workspace/scripts run scrape:airbnb-calendar
 *
 * Env:
 *   DATABASE_URL                       required
 *   AIRBNB_CALENDAR_MAX_LISTINGS       optional cap (default: all active Airbnb listings)
 *   AIRBNB_CALENDAR_CONCURRENCY        default 3
 */

import { sql, eq, and, isNotNull } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  rentalPricesByDateTable,
  type InsertRentalPriceByDate,
} from "@workspace/db";
import {
  fetchAirbnbCalendar,
  type AirbnbCalendarResult,
} from "../../artifacts/api-server/src/lib/ingest/airbnb-calendar-adapter.js";
import { runPool } from "./lib/concurrency.js";

const SOURCE_PLATFORM = "airbnb";
const CONCURRENCY = parseInt(process.env.AIRBNB_CALENDAR_CONCURRENCY ?? "3", 10);
const MAX_LISTINGS = process.env.AIRBNB_CALENDAR_MAX_LISTINGS
  ? parseInt(process.env.AIRBNB_CALENDAR_MAX_LISTINGS, 10)
  : null;
/** Politeness delay between successive requests per worker (ms). */
const MIN_DELAY_MS = 400;
/** Per-listing hard timeout — calendar fetch typically completes in <2s; 60s is generous. */
const HARD_TIMEOUT_MS = 60_000;
/** Fail the run (exit non-zero) when failure rate exceeds this fraction. */
const FAILURE_RATE_FAIL_THRESHOLD = 0.75;

interface ListingRow {
  id: number;
  externalId: string;
  sourceUrl: string;
  title: string | null;
}

interface PerListingStats {
  listingId: number;
  externalId: string;
  ok: boolean;
  daysReturned: number;
  daysAvailable: number;
  daysUnavailable: number;
  rowsWritten: number;
  error?: string;
}

async function loadActiveListings(): Promise<ListingRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      externalId: rentalListingsTable.externalId,
      sourceUrl: rentalListingsTable.sourceUrl,
      title: rentalListingsTable.title,
    })
    .from(rentalListingsTable)
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        eq(rentalListingsTable.isActive, true),
        isNotNull(rentalListingsTable.externalId),
      ),
    );
  // Filter to numeric external IDs only — that's what the calendar
  // adapters (both v2 legacy and v3 GraphQL) accept. Length is no
  // longer a gate: the adapter dispatches by ID length internally
  // (≤ 10 digits → legacy /api/v2/homes_pdp_availability_calendar,
  // 11+ digits → /api/v3/PdpAvailabilityCalendar GraphQL persisted
  // query). All ~504 active Airbnb listings now refresh daily.
  const out: ListingRow[] = [];
  for (const r of rows) {
    const ext = r.externalId;
    if (typeof ext !== "string") continue;
    if (!/^\d+$/.test(ext)) continue;
    out.push({ id: r.id, externalId: ext, sourceUrl: r.sourceUrl, title: r.title });
  }
  return out;
}

function toInsertRows(
  listingId: number,
  result: AirbnbCalendarResult,
  scrapedAt: Date,
): InsertRentalPriceByDate[] {
  return result.days.map((d) => ({
    listingId,
    date: d.date, // YYYY-MM-DD; drizzle `date` accepts string
    nightlyPriceUsd: d.nightlyPriceUsd, // null today (Airbnb stripped prices); auto-fills if Airbnb ever restores
    availabilityStatus: d.availabilityStatus,
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
          // COALESCE: only overwrite price if Airbnb returned a non-null value.
          // Airbnb's public calendar strips prices, so EXCLUDED.nightly_price_usd
          // is null today — without COALESCE this scrape would wipe out
          // AirROI-sourced prices on every run.
          nightlyPriceUsd: sql`COALESCE(EXCLUDED.nightly_price_usd, ${rentalPricesByDateTable.nightlyPriceUsd})`,
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
    externalId: listing.externalId,
    ok: false,
    daysReturned: 0,
    daysAvailable: 0,
    daysUnavailable: 0,
    rowsWritten: 0,
  };
  try {
    const result = await fetchAirbnbCalendar(listing.externalId);
    stats.daysReturned = result.daysReturned;
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
  console.log(`[airbnb-calendar] start  source=${SOURCE_PLATFORM}  concurrency=${CONCURRENCY}`);
  const all = await loadActiveListings();
  const listings = MAX_LISTINGS ? all.slice(0, MAX_LISTINGS) : all;
  console.log(`[airbnb-calendar] loaded  active_airbnb=${all.length}  processing=${listings.length}`);

  if (listings.length === 0) {
    console.log("[airbnb-calendar] no active listings — nothing to do");
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
        s = {
          listingId: l.id,
          externalId: l.externalId,
          ok: false,
          daysReturned: 0,
          daysAvailable: 0,
          daysUnavailable: 0,
          rowsWritten: 0,
          error: (e as Error).message.slice(0, 200),
        };
      }
      stats.push(s);
      done++;
      const tag = s.ok ? "ok " : "ERR";
      console.log(
        `[${done}/${listings.length}] ${tag} listing=${l.id} ext=${l.externalId}` +
          `  days=${s.daysReturned}  avail=${s.daysAvailable}  unavail=${s.daysUnavailable}` +
          `  written=${s.rowsWritten}` +
          (s.error ? `  ERROR=${s.error}` : ""),
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
  console.log(`[airbnb-calendar] DONE`);
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
      console.log(`    listing=${f.listingId}  ext=${f.externalId}  error=${f.error}`);
    }
  }

  if (failureRate >= FAILURE_RATE_FAIL_THRESHOLD) {
    console.error(
      `[airbnb-calendar] FAIL: failure_rate=${(failureRate * 100).toFixed(1)}%` +
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
    console.error("[airbnb-calendar] FATAL", e);
    await pool.end();
    process.exit(1);
  });
