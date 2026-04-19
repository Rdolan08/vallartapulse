/**
 * ingest/airbnb-pricing-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Driver for the daily Airbnb per-night pricing refresh.
 *
 * Connects three pieces:
 *   - airbnb-graphql-pricing-adapter.ts → fetches the GraphQL calendar
 *     (per-night prices for 12 months) for one listing.
 *   - airbnb-checkpoints.ts            → generates the ~30–40 stay windows
 *     per listing that the comp model wants priced.
 *   - listing_price_quotes (DB table)  → insert-only history of quotes.
 *
 * Per listing, ONE GraphQL fetch yields prices for every checkpoint we
 * care about. We map each checkpoint's checkin/checkout window onto the
 * calendar date map and emit one quote row per checkpoint. Fees aren't
 * available from this endpoint — only base nightly — so the cleaning /
 * service / taxes columns stay null and `subtotal_usd` is the per-night
 * price summed across the stay (when every night has a price).
 *
 * Cohort: stale-first across ALL active Airbnb listings, regardless of
 * external_id length. The PdpAvailabilityCalendar GraphQL operation
 * accepts both legacy 9-digit and post-2022 long-form IDs — that's the
 * whole point of running this path. The 345 long-form IDs that
 * airbnb-calendar-adapter.ts (path 1) skips are first-class citizens here.
 *
 * SHA self-healing: if the first attempt for a listing returns
 * staleSha=true, the runner re-discovers the persisted-query hash and
 * retries that listing. From then on the fresh hash is used for the
 * remainder of the run.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  listingPriceQuotesTable,
  type InsertListingPriceQuote,
} from "@workspace/db/schema";

import {
  fetchAirbnbCalendarGraphql,
  getOrDiscoverSha,
  type AirbnbGraphqlCalendarResult,
  type AirbnbGraphqlDay,
} from "./airbnb-graphql-pricing-adapter.js";
import {
  generateCheckpoints,
  type Checkpoint,
} from "./airbnb-checkpoints.js";

const SOURCE_PLATFORM = "airbnb";

export interface AirbnbPricingRunOpts {
  /** Cap how many listings to process this run. Default 50 (matches the daily budget). */
  maxListings?: number;
  /** If true, skip DB writes (used for canary / smoke runs). Default false. */
  dryRun?: boolean;
  /** Override "today" for checkpoint generation (test hook). */
  today?: Date;
}

export interface AirbnbPricingPerListing {
  listingId: number;
  externalId: string;
  ok: boolean;
  daysReturned: number;
  daysWithPrice: number;
  checkpointsAttempted: number;
  quotesWritten: number;
  staleShaRetried: boolean;
  shaUsed: string | null;
  error?: string;
}

export interface AirbnbPricingRunSummary {
  attempted: number;
  ok: number;
  failed: number;
  totalQuotesWritten: number;
  totalDaysWithPrice: number;
  shaSource: "cache" | "discovered" | "fallback";
  shaRediscoveriesDuringRun: number;
}

export interface AirbnbPricingRunResult {
  summary: AirbnbPricingRunSummary;
  listings: AirbnbPricingPerListing[];
}

interface ListingRow {
  id: number;
  externalId: string;
  sourceUrl: string;
}

/**
 * Stale-first cohort across ALL active Airbnb listings (both legacy
 * 9-digit and long-form post-2022 IDs). Ordered so listings whose last
 * quote is oldest go first; listings that have never been quoted go
 * before everything else.
 */
async function loadStaleFirstListings(maxListings: number): Promise<ListingRow[]> {
  // Done as raw SQL because drizzle's LEFT JOIN + MAX(...) + NULLS FIRST
  // composition is awkward and this is a one-shot query.
  const result = await db.execute(sql`
    SELECT rl.id,
           rl.external_id AS "externalId",
           rl.source_url AS "sourceUrl"
    FROM rental_listings rl
    LEFT JOIN (
      SELECT listing_id, MAX(collected_at) AS last_quoted
      FROM listing_price_quotes
      GROUP BY listing_id
    ) q ON q.listing_id = rl.id
    WHERE rl.source_platform = ${SOURCE_PLATFORM}
      AND rl.is_active = true
      AND rl.external_id IS NOT NULL
      AND rl.external_id ~ '^[0-9]+$'
    ORDER BY q.last_quoted ASC NULLS FIRST, rl.id ASC
    LIMIT ${maxListings}
  `);
  const rows = (result as unknown as {
    rows: Array<{ id: number; externalId: string; sourceUrl: string }>;
  }).rows;
  return rows;
}

/**
 * Build a date→day map for O(1) checkpoint lookups. Days outside the
 * map (beyond the 12-month GraphQL window) are simply skipped at quote
 * emission time.
 */
function buildDayIndex(days: AirbnbGraphqlDay[]): Map<string, AirbnbGraphqlDay> {
  const m = new Map<string, AirbnbGraphqlDay>();
  for (const d of days) m.set(d.date, d);
  return m;
}

/**
 * Iterate every night in [checkin, checkout) and collect the matching
 * GraphQL day rows. Returns the per-night prices, the count of nights
 * that had a price, and an "all available" flag.
 */
function pricesForStay(
  checkpoint: Checkpoint,
  index: Map<string, AirbnbGraphqlDay>,
): { perNight: number[]; nightsCovered: number; allAvailable: boolean; anyAvailable: boolean } {
  const start = new Date(`${checkpoint.checkin}T00:00:00Z`);
  const perNight: number[] = [];
  let allAvailable = true;
  let anyAvailable = false;
  let nightsCovered = 0;
  for (let i = 0; i < checkpoint.stayNights; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const day = index.get(key);
    if (!day) {
      allAvailable = false;
      continue;
    }
    nightsCovered++;
    if (day.available) anyAvailable = true;
    else allAvailable = false;
    if (typeof day.nightlyPriceUsd === "number") perNight.push(day.nightlyPriceUsd);
  }
  return { perNight, nightsCovered, allAvailable, anyAvailable };
}

function buildQuoteRows(
  listingId: number,
  result: AirbnbGraphqlCalendarResult,
  collectedAt: Date,
  today: Date,
): InsertListingPriceQuote[] {
  const checkpoints = generateCheckpoints({ today });
  const index = buildDayIndex(result.days);
  const out: InsertListingPriceQuote[] = [];

  for (const cp of checkpoints) {
    const { perNight, nightsCovered, allAvailable, anyAvailable } = pricesForStay(cp, index);

    // Skip checkpoints whose stay window falls entirely outside the
    // 12-month GraphQL response — emitting a quote for a window we have
    // zero data on would just be noise in the time-series.
    if (nightsCovered === 0) continue;

    const avgNightly = perNight.length > 0
      ? perNight.reduce((a, b) => a + b, 0) / perNight.length
      : null;
    const subtotal = perNight.length === cp.stayNights
      ? perNight.reduce((a, b) => a + b, 0)
      : null;

    const availability = allAvailable && nightsCovered === cp.stayNights
      ? "available"
      : anyAvailable
        ? "min_stay_violated" // partial-availability stays = booked across part of the window
        : "unavailable";

    out.push({
      listingId,
      collectedAt,
      checkinDate: cp.checkin,
      checkoutDate: cp.checkout,
      stayLengthNights: cp.stayNights,
      guestCount: cp.guestCount,
      nightlyPriceUsd: avgNightly,
      subtotalUsd: subtotal,
      cleaningFeeUsd: null,
      serviceFeeUsd: null,
      taxesUsd: null,
      totalPriceUsd: null,
      currency: "USD",
      availabilityStatus: availability,
      // Store the per-night price array for parser-repair / debugging.
      rawQuoteJson: {
        source: "airbnb_graphql_pdpAvailabilityCalendar",
        checkpointKind: cp.kind,
        eventTag: cp.eventTag,
        priorityTier: cp.priorityTier,
        nightsCovered,
        stayNights: cp.stayNights,
        perNightPricesUsd: perNight,
      },
    });
  }
  return out;
}

async function insertQuotes(rows: InsertListingPriceQuote[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Bounded chunk to stay well under Postgres's parameter limit.
  // listing_price_quotes inserts ~16 columns × 1000 rows = 16k params.
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db.insert(listingPriceQuotesTable).values(slice);
    total += slice.length;
  }
  return total;
}

/**
 * Run one daily Airbnb pricing refresh.
 *
 * Returns a structured summary so the calling endpoint can ship the
 * same shape JSON GitHub Actions consumes for the "did it work" check.
 */
export async function runAirbnbPricingRefresh(
  opts: AirbnbPricingRunOpts = {},
): Promise<AirbnbPricingRunResult> {
  const maxListings = opts.maxListings ?? 50;
  const dryRun = opts.dryRun ?? false;
  const today = opts.today ?? new Date();

  const listings = await loadStaleFirstListings(maxListings);

  // Discover the SHA up front so all listings share one cache hit.
  const initial = await getOrDiscoverSha();
  let currentSha = initial.sha;
  let shaRediscoveries = 0;

  const perListing: AirbnbPricingPerListing[] = [];
  let totalQuotes = 0;
  let totalDaysWithPrice = 0;

  for (const l of listings) {
    const stat: AirbnbPricingPerListing = {
      listingId: l.id,
      externalId: l.externalId,
      ok: false,
      daysReturned: 0,
      daysWithPrice: 0,
      checkpointsAttempted: 0,
      quotesWritten: 0,
      staleShaRetried: false,
      shaUsed: currentSha,
    };
    try {
      let result = await fetchAirbnbCalendarGraphql(l.externalId, currentSha, { today });

      // SHA rotation: re-discover once and retry. From then on the fresh
      // hash is used for the rest of the run.
      if (result.staleSha) {
        stat.staleShaRetried = true;
        const fresh = await getOrDiscoverSha({ forceRediscover: true });
        currentSha = fresh.sha;
        shaRediscoveries++;
        stat.shaUsed = currentSha;
        result = await fetchAirbnbCalendarGraphql(l.externalId, currentSha, { today });
      }

      stat.daysReturned = result.daysReturned;
      stat.daysWithPrice = result.daysWithPrice;

      if (result.errors.length > 0 && result.daysReturned === 0) {
        stat.error = result.errors.join("; ").slice(0, 200);
        perListing.push(stat);
        continue;
      }

      const rows = buildQuoteRows(l.id, result, new Date(), today);
      stat.checkpointsAttempted = rows.length;
      if (!dryRun) {
        stat.quotesWritten = await insertQuotes(rows);
      } else {
        stat.quotesWritten = rows.length; // would-have-written count
      }
      stat.ok = true;
      totalQuotes += stat.quotesWritten;
      totalDaysWithPrice += stat.daysWithPrice;
    } catch (e) {
      stat.error = (e as Error).message.slice(0, 200);
    }
    perListing.push(stat);
  }

  const ok = perListing.filter((p) => p.ok).length;
  return {
    summary: {
      attempted: perListing.length,
      ok,
      failed: perListing.length - ok,
      totalQuotesWritten: totalQuotes,
      totalDaysWithPrice,
      shaSource: initial.source,
      shaRediscoveriesDuringRun: shaRediscoveries,
    },
    listings: perListing,
  };
}

