/**
 * comps-pricing-source.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-listing nightly-price source selection for the comp engine.
 *
 * Implements the v1 Comp Model Contract (docs/comp-model-contract.md):
 *
 *   Rank 0: Airbnb quote        — listing_price_quotes (booking-sidebar
 *                                 scrape, all-in nightly rate Airbnb
 *                                 quotes a guest TODAY)
 *   Rank 1: Per-day daily rate  — rental_prices_by_date, forward 30–90d window.
 *                                 Tagged airbnb_daily / pvrpv_daily based on
 *                                 the source listing's source_platform (each
 *                                 platform's calendar scraper writes to this
 *                                 table).
 *   Rank 2: Static displayed    — rental_listings.nightly_price_usd
 *
 * Rank 0 was added 2026-04-23 once the Playwright DOM scraper started
 * writing real per-stay totals into listing_price_quotes. It's the
 * truest demand signal we have for Airbnb inventory because it's what
 * a real guest would actually be charged at the moment of booking
 * (post-discount, pre-taxes-and-fees from sidebar — the same number
 * displayed on the listing page). PVRPV daily is a different platform
 * and the host's static displayed price isn't always transactable,
 * so quotes outrank both when fresh.
 *
 *   The reverted Airbnb GraphQL replay (path 2) is intentionally absent.
 *
 * The selector returns one chosen price per listing plus the freshness
 * weight defined in the contract:
 *
 *   ≤ 7d   → 1.00   (full credit)
 *    8–30d → 0.50   (half credit)
 *   31–60d → 0.25   (quarter credit; warning)
 *    >60d  → 0.00   (DROPPED from comp pool)
 *
 * The weight is advisory metadata in v1 — the engine still computes an
 * unweighted IQR median over the included pool. The 0.00 weight is a
 * hard cut: those listings are excluded from the pool, not just
 * deprioritized in the math.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type PriceSource =
  | "airbnb_quote"
  | "airbnb_daily"
  | "pvrpv_daily"
  | "static_displayed";

export type FreshnessWeight = 0 | 0.25 | 0.5 | 1;

export interface ChosenPrice {
  listingId: number;
  nightlyPriceUsd: number;
  priceSource: PriceSource;
  priceObservedAt: Date;
  priceFreshnessDays: number;
  priceFreshnessWeight: FreshnessWeight;
}

export interface ExcludedListing {
  listingId: number;
  reason:
    | "no_priced_observation"
    | "stale_beyond_60d"
    | "no_static_fallback";
}

export interface SourceSelectionResult {
  chosen: Map<number, ChosenPrice>;
  excluded: ExcludedListing[];
  /** Counts by reason, suitable for surfacing in API responses / dashboards */
  excludedReasons: Record<ExcludedListing["reason"], number>;
  /** Counts by chosen source */
  sourceCounts: Record<PriceSource, number>;
}

/** Forward window we average PVRPV daily prices over. */
const FORWARD_WINDOW_START_DAYS = 30;
const FORWARD_WINDOW_END_DAYS = 90;

/**
 * Trailing window for Airbnb-quote averaging. Quotes are stay-window
 * specific (each row is one checkpoint × one listing) so we want
 * enough history to smooth across multiple checkpoints, but not so
 * much that ancient pricing pollutes the current rate. 30d aligns
 * with the "half credit" freshness band — anything older is stale
 * enough that PVRPV daily is probably a better signal anyway.
 */
const QUOTE_LOOKBACK_DAYS = 30;

const FRESHNESS_FULL_CREDIT_DAYS = 7;
const FRESHNESS_HALF_CREDIT_DAYS = 30;
const FRESHNESS_QUARTER_CREDIT_DAYS = 60;

/**
 * Convert an age in days to the contract's freshness weight.
 * Exported so other call sites (dashboards, exports) compute it the
 * same way.
 */
export function freshnessWeightForAgeDays(ageDays: number): FreshnessWeight {
  if (ageDays <= FRESHNESS_FULL_CREDIT_DAYS) return 1;
  if (ageDays <= FRESHNESS_HALF_CREDIT_DAYS) return 0.5;
  if (ageDays <= FRESHNESS_QUARTER_CREDIT_DAYS) return 0.25;
  return 0;
}

/**
 * Map a rental_listings.source_platform value to its corresponding
 * per-day-rate PriceSource tag for Rank 1 of the comp waterfall.
 * Defaults to pvrpv_daily so unknown future platforms still land in
 * the dailyCount bucket (real-rate) rather than being mis-classified
 * as "other" (which would incorrectly trigger the static-staleness
 * penalty in routes/comps.ts).
 *
 * Pre-2026-04-26 the Rank-1 tag was hardcoded to pvrpv_daily because
 * PVRPV was the only writer of rental_prices_by_date. AirROI now
 * writes Airbnb rows there too.
 */
export function platformToDailySource(
  sourcePlatform: string | null | undefined,
): PriceSource {
  switch (sourcePlatform) {
    case "airbnb":            return "airbnb_daily";
    case "pvrpv":             return "pvrpv_daily";
    default:                  return "pvrpv_daily";
  }
}

interface StaticListingRow {
  id: number;
  nightly_price_usd: number | null;
  scraped_at: Date | null;
  source_platform: string | null;
}

interface DailyPriceAggRow {
  listing_id: number;
  avg_price: number;
  latest_scraped_at: Date;
}

interface QuoteAggRow {
  listing_id: number;
  avg_price: number;
  latest_collected_at: Date;
}

/**
 * Build the per-listing chosen-price map for the supplied listing IDs.
 *
 * Both queries are batched against the live DB; the map fits well
 * within the engine cache TTL (5min) so this is paid roughly once
 * every 5 minutes per process.
 */
export async function selectCompPriceSources(
  listingIds: number[],
  now: Date = new Date(),
): Promise<SourceSelectionResult> {
  const chosen = new Map<number, ChosenPrice>();
  const excluded: ExcludedListing[] = [];
  const excludedReasons: Record<ExcludedListing["reason"], number> = {
    no_priced_observation: 0,
    stale_beyond_60d: 0,
    no_static_fallback: 0,
  };
  const sourceCounts: Record<PriceSource, number> = {
    airbnb_quote: 0,
    airbnb_daily: 0,
    pvrpv_daily: 0,
    static_displayed: 0,
  };

  if (listingIds.length === 0) {
    return { chosen, excluded, excludedReasons, sourceCounts };
  }

  // ── Rank 0: Airbnb quote — booking-sidebar scrape ─────────────────────
  //
  // Aggregate per-listing AVG nightly_price_usd across recent quotes
  // where Airbnb actually returned a price (total_price_usd IS NOT NULL
  // — i.e. NOT the "Those dates are not available" rows the runner now
  // also writes). Window = trailing QUOTE_LOOKBACK_DAYS so we average
  // multiple checkpoint windows together rather than fixating on a
  // single stay date.
  //
  // Why pre-filter by total > 0: the scraper writes both successful
  // quotes AND unavailable signals to listing_price_quotes. The
  // unavailable rows have total_price_usd = NULL, but if we ever start
  // writing 0 instead, the > 0 guard keeps them out of the average.
  const quoteRows = (await db.execute(sql`
    SELECT
      lpq.listing_id::int                  AS listing_id,
      AVG(lpq.nightly_price_usd)::float8   AS avg_price,
      MAX(lpq.collected_at)                AS latest_collected_at
    FROM listing_price_quotes lpq
    WHERE lpq.listing_id = ANY(${sql.raw(`ARRAY[${listingIds.map((n) => Number(n)).filter(Number.isFinite).join(",") || "NULL"}]::int[]`)})
      AND lpq.total_price_usd IS NOT NULL
      AND lpq.nightly_price_usd IS NOT NULL
      AND lpq.nightly_price_usd > 0
      AND lpq.collected_at >= NOW() - INTERVAL '${sql.raw(String(QUOTE_LOOKBACK_DAYS))} days'
    GROUP BY lpq.listing_id
  `)).rows as unknown as QuoteAggRow[];

  const quoteByListing = new Map<number, QuoteAggRow>();
  for (const row of quoteRows) quoteByListing.set(row.listing_id, row);

  // ── Rank 1: PVRPV daily — average over forward 30–90d priced rows ─────
  const dailyRows = (await db.execute(sql`
    SELECT
      rpbd.listing_id::int                AS listing_id,
      AVG(rpbd.nightly_price_usd)::float8 AS avg_price,
      MAX(rpbd.scraped_at)                AS latest_scraped_at
    FROM rental_prices_by_date rpbd
    WHERE rpbd.listing_id = ANY(${sql.raw(`ARRAY[${listingIds.map((n) => Number(n)).filter(Number.isFinite).join(",") || "NULL"}]::int[]`)})
      AND rpbd.nightly_price_usd IS NOT NULL
      AND rpbd.date >= (CURRENT_DATE + (${FORWARD_WINDOW_START_DAYS})::int)
      AND rpbd.date <= (CURRENT_DATE + (${FORWARD_WINDOW_END_DAYS})::int)
    GROUP BY rpbd.listing_id
  `)).rows as unknown as DailyPriceAggRow[];

  const dailyByListing = new Map<number, DailyPriceAggRow>();
  for (const row of dailyRows) dailyByListing.set(row.listing_id, row);

  // ── Rank 2: static displayed — load fallbacks for everyone in scope ───
  const staticRows = (await db.execute(sql`
    SELECT
      rl.id                AS id,
      rl.nightly_price_usd AS nightly_price_usd,
      rl.scraped_at        AS scraped_at,
      rl.source_platform   AS source_platform
    FROM rental_listings rl
    WHERE rl.id = ANY(${sql.raw(`ARRAY[${listingIds.map((n) => Number(n)).filter(Number.isFinite).join(",") || "NULL"}]::int[]`)})
  `)).rows as unknown as StaticListingRow[];

  const staticByListing = new Map<number, StaticListingRow>();
  for (const row of staticRows) staticByListing.set(row.id, row);

  // ── Per-listing selection ────────────────────────────────────────────
  for (const listingId of listingIds) {
    // Rank 0: Airbnb quote (highest priority — real booking-funnel rate)
    const quote = quoteByListing.get(listingId);
    if (quote) {
      const observedAt = new Date(quote.latest_collected_at);
      const ageDays = ageInDays(now, observedAt);
      const weight = freshnessWeightForAgeDays(ageDays);
      // If quote is too stale (weight=0), fall through to PVRPV/static
      // rather than excluding outright — that's the whole point of
      // having a waterfall.
      if (weight > 0) {
        chosen.set(listingId, {
          listingId,
          nightlyPriceUsd: quote.avg_price,
          priceSource: "airbnb_quote",
          priceObservedAt: observedAt,
          priceFreshnessDays: ageDays,
          priceFreshnessWeight: weight,
        });
        sourceCounts.airbnb_quote += 1;
        continue;
      }
    }

    const daily = dailyByListing.get(listingId);
    if (daily) {
      const observedAt = new Date(daily.latest_scraped_at);
      const ageDays = ageInDays(now, observedAt);
      const weight = freshnessWeightForAgeDays(ageDays);
      if (weight === 0) {
        excluded.push({ listingId, reason: "stale_beyond_60d" });
        excludedReasons.stale_beyond_60d += 1;
        continue;
      }
      // Derive priceSource from the source listing's platform so per-day
      // rates from each scraper (Airbnb via AirROI, PVRPV) get tagged
      // correctly in source_counts and freshness breakdowns.
      // Pre-2026-04-26 this was hardcoded to "pvrpv_daily" because PVRPV
      // was the only writer of rental_prices_by_date.
      const platform = staticByListing.get(listingId)?.source_platform ?? null;
      const priceSource = platformToDailySource(platform);
      chosen.set(listingId, {
        listingId,
        nightlyPriceUsd: daily.avg_price,
        priceSource,
        priceObservedAt: observedAt,
        priceFreshnessDays: ageDays,
        priceFreshnessWeight: weight,
      });
      sourceCounts[priceSource] += 1;
      continue;
    }

    const stat = staticByListing.get(listingId);
    if (!stat || stat.nightly_price_usd == null || stat.scraped_at == null) {
      const reason: ExcludedListing["reason"] = !stat
        ? "no_static_fallback"
        : "no_priced_observation";
      excluded.push({ listingId, reason });
      excludedReasons[reason] += 1;
      continue;
    }
    const observedAt = new Date(stat.scraped_at);
    const ageDays = ageInDays(now, observedAt);
    const weight = freshnessWeightForAgeDays(ageDays);
    if (weight === 0) {
      excluded.push({ listingId, reason: "stale_beyond_60d" });
      excludedReasons.stale_beyond_60d += 1;
      continue;
    }
    chosen.set(listingId, {
      listingId,
      nightlyPriceUsd: stat.nightly_price_usd,
      priceSource: "static_displayed",
      priceObservedAt: observedAt,
      priceFreshnessDays: ageDays,
      priceFreshnessWeight: weight,
    });
    sourceCounts.static_displayed += 1;
  }

  return { chosen, excluded, excludedReasons, sourceCounts };
}

function ageInDays(now: Date, then: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24)),
  );
}
