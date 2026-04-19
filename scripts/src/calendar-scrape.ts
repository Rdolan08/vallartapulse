/**
 * calendar-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily forward-window pricing+availability scraper for VallartaPulse.
 *
 * Sources covered:
 *   - "pvrpv"             — full calendar grid (rates + minicalendar)
 *   - "vacation_vallarta" — seasonal text brackets parsed from Squarespace
 *                           listing pages (no calendar grid → all days emit
 *                           availabilityStatus = "unknown")
 *
 * For every active listing in `rental_listings` whose source_platform is one
 * of the supported sources, fetches its calendar and UPSERTs one row per day
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
 *   CALENDAR_MAX_LISTINGS     optional cap (default: all active listings, applied per source)
 *   CALENDAR_CONCURRENCY      override worker pool size; defaults differ per
 *                             source (PVRPV=3, VV=2 — Squarespace is rate-sensitive)
 *   CALENDAR_SOURCES          comma list, default "pvrpv,vacation_vallarta"
 */

import { sql, eq, and, inArray } from "drizzle-orm";
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
import {
  fetchVacationVallartaCalendar,
  type VvCalendarResult,
} from "../../artifacts/api-server/src/lib/ingest/vacation-vallarta-calendar-adapter.js";
import { runPool } from "./lib/concurrency.js";

const SUPPORTED_SOURCES = ["pvrpv", "vacation_vallarta"] as const;
type SupportedSource = (typeof SUPPORTED_SOURCES)[number];
const RAW_SOURCES =
  process.env.CALENDAR_SOURCES?.split(",").map((s) => s.trim()).filter(Boolean) ??
  [...SUPPORTED_SOURCES];
const SOURCES: SupportedSource[] = RAW_SOURCES.filter((s): s is SupportedSource =>
  (SUPPORTED_SOURCES as readonly string[]).includes(s),
);
if (SOURCES.length === 0) {
  console.error(
    `[calendar-scrape] FATAL: CALENDAR_SOURCES="${process.env.CALENDAR_SOURCES ?? ""}" matched none of: ${SUPPORTED_SOURCES.join(", ")}`,
  );
  process.exit(2);
}
/** Per-source default worker-pool size; CALENDAR_CONCURRENCY env overrides for all sources. */
const DEFAULT_CONCURRENCY: Record<SupportedSource, number> = {
  pvrpv: 3,
  vacation_vallarta: 2,
};
const CONCURRENCY_OVERRIDE = process.env.CALENDAR_CONCURRENCY
  ? parseInt(process.env.CALENDAR_CONCURRENCY, 10)
  : null;
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
  sourcePlatform: SupportedSource;
  sourceUrl: string;
  title: string | null;
  bedrooms: number | null;
}

interface PerListingStats {
  listingId: number;
  source: SupportedSource;
  url: string;
  ok: boolean;
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  rowsWritten: number;
  error?: string;
}

async function loadActiveListings(sources: SupportedSource[]): Promise<ListingRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      sourcePlatform: rentalListingsTable.sourcePlatform,
      sourceUrl: rentalListingsTable.sourceUrl,
      title: rentalListingsTable.title,
      bedrooms: rentalListingsTable.bedrooms,
    })
    .from(rentalListingsTable)
    .where(
      and(
        inArray(rentalListingsTable.sourcePlatform, sources as unknown as string[]),
        eq(rentalListingsTable.isActive, true),
      ),
    );
  return rows
    .filter((r) => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0)
    .map((r) => ({ ...r, sourcePlatform: r.sourcePlatform as SupportedSource }));
}

interface UnifiedCalendarDay {
  date: string;
  nightlyPriceUsd: number | null;
  availabilityStatus: string;
  minimumNights: number | null;
}

interface UnifiedCalendarResult {
  days: UnifiedCalendarDay[];
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  errors: string[];
}

function unifyPvrpv(r: PvrpvCalendarResult): UnifiedCalendarResult {
  return {
    days: r.days,
    daysReturned: r.daysReturned,
    daysWithPrice: r.daysWithPrice,
    daysAvailable: r.daysAvailable,
    daysUnavailable: r.daysUnavailable,
    errors: r.errors,
  };
}

function unifyVv(r: VvCalendarResult): UnifiedCalendarResult {
  return {
    days: r.days,
    daysReturned: r.daysReturned,
    daysWithPrice: r.daysWithPrice,
    daysAvailable: 0,
    daysUnavailable: 0,
    errors: r.errors,
  };
}

function toInsertRows(
  listingId: number,
  result: UnifiedCalendarResult,
  scrapedAt: Date,
): InsertRentalPriceByDate[] {
  return result.days.map((d) => ({
    listingId,
    date: d.date, // YYYY-MM-DD; drizzle `date` accepts string
    nightlyPriceUsd: d.nightlyPriceUsd,
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
    source: listing.sourcePlatform,
    url: listing.sourceUrl,
    ok: false,
    daysReturned: 0,
    daysWithPrice: 0,
    daysAvailable: 0,
    daysUnavailable: 0,
    rowsWritten: 0,
  };
  try {
    let result: UnifiedCalendarResult;
    if (listing.sourcePlatform === "pvrpv") {
      result = unifyPvrpv(await fetchPvrpvCalendar(listing.sourceUrl));
    } else {
      // vacation_vallarta — pass bedroom count for multi-variant bracket selection
      result = unifyVv(
        await fetchVacationVallartaCalendar(listing.sourceUrl, {
          bedrooms: listing.bedrooms ?? undefined,
        }),
      );
    }
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

async function runForSource(
  source: SupportedSource,
  listings: ListingRow[],
  stats: PerListingStats[],
): Promise<void> {
  const concurrency = CONCURRENCY_OVERRIDE ?? DEFAULT_CONCURRENCY[source];
  console.log(
    `[calendar-scrape] source=${source}  processing=${listings.length}  concurrency=${concurrency}`,
  );
  if (listings.length === 0) return;
  let done = 0;
  await runPool(
    listings,
    {
      concurrency,
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
          source: l.sourcePlatform,
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
      const url = l.sourceUrl
        .replace("https://www.pvrpv.com", "")
        .replace("https://www.vacationvallarta.com", "");
      console.log(
        `[${source} ${done}/${listings.length}] ${tag} listing=${l.id}  days=${s.daysReturned}` +
          `  price=${s.daysWithPrice}  avail=${s.daysAvailable}  unavail=${s.daysUnavailable}` +
          `  written=${s.rowsWritten}` +
          (s.error ? `  ERROR=${s.error}` : "") +
          `  ${url}`,
      );
    },
  );
}

async function main(): Promise<number> {
  console.log(
    `[calendar-scrape] start  sources=${SOURCES.join(",")}  concurrency=${CONCURRENCY_OVERRIDE ?? "per-source"}`,
  );
  const all = await loadActiveListings(SOURCES);
  console.log(`[calendar-scrape] loaded  active_total=${all.length}`);
  if (all.length === 0) {
    console.log("[calendar-scrape] no active listings — nothing to do");
    return 0;
  }

  const stats: PerListingStats[] = [];
  for (const src of SOURCES) {
    const subset = all.filter((r) => r.sourcePlatform === src);
    const limited = MAX_LISTINGS ? subset.slice(0, MAX_LISTINGS) : subset;
    await runForSource(src, limited, stats);
  }

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
