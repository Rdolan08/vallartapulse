/**
 * comps-pricing-source.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-listing nightly-price source selection for the comp engine.
 *
 * Implements the v1 Comp Model Contract (docs/comp-model-contract.md):
 *
 *   Rank 1: PVRPV daily         — rental_prices_by_date, forward 30–90d window
 *   Rank 2: Static displayed    — rental_listings.nightly_price_usd
 *
 *   Mac-scraper Airbnb daily slots in at rank 1.5 when it ships.
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

export type PriceSource = "pvrpv_daily" | "static_displayed";

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

interface StaticListingRow {
  id: number;
  nightly_price_usd: number | null;
  scraped_at: Date | null;
}

interface DailyPriceAggRow {
  listing_id: number;
  avg_price: number;
  latest_scraped_at: Date;
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
    pvrpv_daily: 0,
    static_displayed: 0,
  };

  if (listingIds.length === 0) {
    return { chosen, excluded, excludedReasons, sourceCounts };
  }

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
      rl.scraped_at        AS scraped_at
    FROM rental_listings rl
    WHERE rl.id = ANY(${sql.raw(`ARRAY[${listingIds.map((n) => Number(n)).filter(Number.isFinite).join(",") || "NULL"}]::int[]`)})
  `)).rows as unknown as StaticListingRow[];

  const staticByListing = new Map<number, StaticListingRow>();
  for (const row of staticRows) staticByListing.set(row.id, row);

  // ── Per-listing selection ────────────────────────────────────────────
  for (const listingId of listingIds) {
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
      chosen.set(listingId, {
        listingId,
        nightlyPriceUsd: daily.avg_price,
        priceSource: "pvrpv_daily",
        priceObservedAt: observedAt,
        priceFreshnessDays: ageDays,
        priceFreshnessWeight: weight,
      });
      sourceCounts.pvrpv_daily += 1;
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
