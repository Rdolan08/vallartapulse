/**
 * POST /api/rental/comps
 * ─────────────────────────────────────────────────────────────────────────────
 * V3.1 comps endpoint — adds finish quality, private pool, large terrace,
 * seasonal sweep, building context, and positioning statement.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, asc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { rentalListingsTable, marketEventsTable } from "@workspace/db/schema";
// Phase 1.5 — availability filter: drop listings that are KNOWN-fully-blocked
// for the requested month from the comp pool. Pulls from rental_prices_by_date,
// which is populated for both PVRPV (with $) and Airbnb (availability only).
import {
  CompsEngineV3,
  type TargetPropertyV3,
  type ViewType,
  type YearBuiltRange,
  type FinishQuality,
} from "../lib/comps-engine-v3";
import { type CompsListingV2, type CompResultV2, type BeachTier } from "../lib/comps-engine-v2";
import { selectCompPriceSources, type PriceSource } from "../lib/comps-pricing-source";
import { lookupBuilding } from "../lib/building-lookup";
import { PV_MONTHLY_FACTORS, getStayWindowSeasonalContext, normalizeNeighborhoodKey } from "../lib/pv-seasonality";
import { enrichAuditWithZoneCandidate } from "../lib/event-zone-overlay";
import { recordPricingToolSuccess } from "../lib/pricing-tool-uptime";
import type { MarketEvent } from "@workspace/db/schema";

const router: IRouter = Router();

// ── Engine singleton ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PoolDiagnostics {
  totalListingsConsidered: number;
  excludedReasons: {
    no_priced_observation: number;
    stale_beyond_60d: number;
    no_static_fallback: number;
    missing_required_field: number;
  };
  sourceCounts: Record<PriceSource, number>;
  /** Avg freshness (days) of admitted comps, by source */
  avgFreshnessDays: Record<PriceSource, number | null>;
}

let engineCache: {
  engine: CompsEngineV3;
  builtAt: number;
  listingCount: number;
  diagnostics: PoolDiagnostics;
} | null = null;

async function getEngine(): Promise<{ engine: CompsEngineV3; listingCount: number; diagnostics: PoolDiagnostics }> {
  const now = Date.now();
  if (engineCache && now - engineCache.builtAt < CACHE_TTL_MS) {
    return {
      engine: engineCache.engine,
      listingCount: engineCache.listingCount,
      diagnostics: engineCache.diagnostics,
    };
  }

  const rows = await db.select().from(rentalListingsTable);

  // Field-level prerequisites the engine itself requires (independent
  // of price source).
  const eligible = rows.filter(r =>
    r.distanceToBeachM != null &&
    r.neighborhoodNormalized != null,
  );
  const missingRequiredField = rows.length - eligible.length;

  // Comp Model Contract v1 — pick one nightly price per listing
  // (PVRPV daily preferred, static fallback) with freshness gating.
  const selection = await selectCompPriceSources(eligible.map(r => r.id));

  const listings: CompsListingV2[] = [];
  const freshnessAccum: Record<PriceSource, { sum: number; n: number }> = {
    airbnb_quote: { sum: 0, n: 0 },
    airbnb_daily: { sum: 0, n: 0 },
    pvrpv_daily: { sum: 0, n: 0 },
    vacation_vallarta_daily: { sum: 0, n: 0 },
    static_displayed: { sum: 0, n: 0 },
  };

  for (const r of eligible) {
    const chosen = selection.chosen.get(r.id);
    if (!chosen) continue;
    listings.push({
      id: r.id,
      externalId: r.externalId ?? String(r.id),
      sourceUrl: r.sourceUrl,
      neighborhoodNormalized: r.neighborhoodNormalized as "Zona Romantica" | "Amapas",
      bedrooms: r.bedrooms,
      bathrooms: parseFloat(String(r.bathrooms)),
      sqft: r.sqft != null ? parseFloat(String(r.sqft)) : null,
      distanceToBeachM: parseFloat(String(r.distanceToBeachM!)),
      amenitiesNormalized: Array.isArray(r.amenitiesNormalized) ? r.amenitiesNormalized : [],
      ratingOverall: r.ratingOverall != null ? parseFloat(String(r.ratingOverall)) : null,
      nightlyPriceUsd: chosen.nightlyPriceUsd,
      buildingName: r.buildingName ?? null,
      dataConfidenceScore: parseFloat(String(r.dataConfidenceScore)),
      priceSource: chosen.priceSource,
      priceObservedAt: chosen.priceObservedAt.toISOString(),
      priceFreshnessDays: chosen.priceFreshnessDays,
      priceFreshnessWeight: chosen.priceFreshnessWeight,
    });
    freshnessAccum[chosen.priceSource].sum += chosen.priceFreshnessDays;
    freshnessAccum[chosen.priceSource].n += 1;
  }

  const diagnostics: PoolDiagnostics = {
    totalListingsConsidered: rows.length,
    excludedReasons: {
      ...selection.excludedReasons,
      missing_required_field: missingRequiredField,
    },
    sourceCounts: selection.sourceCounts,
    avgFreshnessDays: {
      airbnb_quote: freshnessAccum.airbnb_quote.n > 0
        ? Math.round(10 * freshnessAccum.airbnb_quote.sum / freshnessAccum.airbnb_quote.n) / 10
        : null,
      airbnb_daily: freshnessAccum.airbnb_daily.n > 0
        ? Math.round(10 * freshnessAccum.airbnb_daily.sum / freshnessAccum.airbnb_daily.n) / 10
        : null,
      pvrpv_daily: freshnessAccum.pvrpv_daily.n > 0
        ? Math.round(10 * freshnessAccum.pvrpv_daily.sum / freshnessAccum.pvrpv_daily.n) / 10
        : null,
      vacation_vallarta_daily: freshnessAccum.vacation_vallarta_daily.n > 0
        ? Math.round(10 * freshnessAccum.vacation_vallarta_daily.sum / freshnessAccum.vacation_vallarta_daily.n) / 10
        : null,
      static_displayed: freshnessAccum.static_displayed.n > 0
        ? Math.round(10 * freshnessAccum.static_displayed.sum / freshnessAccum.static_displayed.n) / 10
        : null,
    },
  };

  const engine = new CompsEngineV3(listings);
  engineCache = { engine, builtAt: now, listingCount: listings.length, diagnostics };
  return { engine, listingCount: listings.length, diagnostics };
}

// ── Market events cache ───────────────────────────────────────────────────────

const EVENTS_CACHE_TTL_MS = 15 * 60 * 1000;

let eventsCache: {
  events: MarketEvent[];
  builtAt: number;
} | null = null;

async function getActiveEvents(): Promise<MarketEvent[]> {
  const now = Date.now();
  if (eventsCache && now - eventsCache.builtAt < EVENTS_CACHE_TTL_MS) {
    return eventsCache.events;
  }
  const events = await db.select().from(marketEventsTable)
    .where(eq(marketEventsTable.isActive, true))
    .orderBy(asc(marketEventsTable.startDate));
  eventsCache = { events, builtAt: now };
  return events;
}

// ── Per-month availability cache ──────────────────────────────────────────────
// For each (year, month) we cache the set of listing IDs that are KNOWN to be
// fully blocked: i.e. they have ≥1 row in rental_prices_by_date for that month
// and zero of those rows are availability_status='available'. Listings with NO
// data for the month are NOT in the set — they pass through unaffected, since
// "no calendar data yet" must not be confused with "blocked". 5-min TTL keeps
// the lookup off the hot path.

const AVAILABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

interface MonthAvailability {
  /** listing IDs we have data for AND that are fully booked/blocked for the month */
  unavailable: Set<number>;
  /** total listings with any data in the month */
  withData: number;
  /** listings with at least one available night */
  withAvailability: number;
}

const availabilityCache = new Map<string, { built: number; data: MonthAvailability }>();

async function getMonthAvailability(year: number, month: number): Promise<MonthAvailability> {
  const key = `${year}-${month}`;
  const now = Date.now();
  const hit = availabilityCache.get(key);
  if (hit && now - hit.built < AVAILABILITY_CACHE_TTL_MS) return hit.data;

  // Month bounds — start inclusive, end exclusive
  const startStr = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endStr = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const rows = (await db.execute(sql`
    SELECT
      listing_id::int                                                                AS listing_id,
      COUNT(*) FILTER (WHERE availability_status = 'available')::int                  AS available_days,
      COUNT(*)::int                                                                   AS total_days
    FROM rental_prices_by_date
    WHERE date >= ${startStr}::date AND date < ${endStr}::date
    GROUP BY listing_id
  `)).rows as Array<{ listing_id: number; available_days: number; total_days: number }>;

  const unavailable = new Set<number>();
  let withAvailability = 0;
  for (const r of rows) {
    if (r.total_days > 0 && r.available_days === 0) unavailable.add(r.listing_id);
    if (r.available_days > 0) withAvailability += 1;
  }

  const data: MonthAvailability = {
    unavailable,
    withData: rows.length,
    withAvailability,
  };
  availabilityCache.set(key, { built: now, data });
  return data;
}

function eventsForMonth(events: MarketEvent[], year: number, month: number): MarketEvent[] {
  const mStart = new Date(Date.UTC(year, month - 1, 1));
  const mEnd   = new Date(Date.UTC(year, month, 0));
  return events.filter(ev => {
    if (!ev.affectedMetrics.split(",").map(m => m.trim()).includes("pricing")) return false;
    const evStart = new Date(ev.startDate + "T00:00:00Z");
    // Use recovery_window_end as the effective window end (covers recovery phase pricing)
    const effectiveEnd = ev.recoveryWindowEnd
      ? new Date(ev.recoveryWindowEnd + "T00:00:00Z")
      : ev.endDate
        ? new Date(ev.endDate + "T00:00:00Z")
        : new Date("2099-12-31T00:00:00Z");
    return evStart <= mEnd && effectiveEnd >= mStart;
  });
}

// ── Request schema ────────────────────────────────────────────────────────────

const SUPPORTED_NEIGHBORHOODS = [
  "Zona Romantica", "Amapas", "Centro", "Hotel Zone",
  "5 de Diciembre", "Old Town", "Versalles", "Marina Vallarta",
  "Nuevo Vallarta", "Bucerias", "La Cruz de Huanacaxtle",
  "Punta Mita", "El Anclote", "Sayulita", "San Pancho", "Mismaloya",
] as const;

const VIEW_TYPES = ["ocean", "partial", "city", "garden", "none"] as const;
const YEAR_BUILT_RANGES = ["2020+", "2015-2019", "2010-2014", "2000-2009", "1990-1999", "pre-1990", ""] as const;
const FINISH_QUALITIES = ["standard", "upgraded", "premium"] as const;

const CompsRequestSchema = z.object({
  neighborhood_normalized: z.enum(SUPPORTED_NEIGHBORHOODS),
  bedrooms: z.number().int().min(1).max(6),
  bathrooms: z.number().min(0.5).max(8),
  sqft: z.number().min(100).max(10000).optional().nullable(),
  distance_to_beach_m: z.number().min(0).max(5000),
  amenities_normalized: z.array(z.string()).default([]),
  rating_overall: z.number().min(1).max(5).optional().nullable(),
  building_name: z.string().optional().nullable(),
  month: z.number().int().min(1).max(12).default(() => new Date().getMonth() + 1),
  view_type: z.enum(VIEW_TYPES).default("none"),
  rooftop_pool: z.boolean().default(false),
  year_built: z.enum(YEAR_BUILT_RANGES).default(""),
  // V3.1 additions
  finish_quality: z.enum(FINISH_QUALITIES).default("standard"),
  private_plunge_pool: z.boolean().default(false),
  large_terrace: z.boolean().default(false),

  // Optional stay-window inputs. When both are provided and well-formed, the
  // engine treats the stay-window's first day as the seasonal anchor (overrides
  // the `month` field) and computes a window-specific factor against the same
  // selected comp pool's per-night data. When absent, behavior is identical to
  // pre-stay-window — month-based pricing only.
  check_in:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

type CompsRequest = z.infer<typeof CompsRequestSchema>;

// ── Helpers ───────────────────────────────────────────────────────────────────

type ConfidenceLabel = "high" | "medium" | "low" | "guidance_only";

function confidenceLabel(poolSize: number): ConfidenceLabel {
  if (poolSize >= 8) return "high";
  if (poolSize >= 5) return "medium";
  if (poolSize >= 3) return "low";
  return "guidance_only";
}

function extractTopDrivers(comp: CompResultV2): string[] {
  const bd = comp.scoreBreakdown;
  return [
    { label: "beach_distance", score: bd.beachDistance },
    { label: "amenities",      score: bd.amenities },
    { label: "sqft",           score: bd.sqft },
    { label: "bathrooms",      score: bd.bathrooms },
    { label: "rating",         score: bd.rating },
    { label: "beach_tier",     score: bd.beachTierMatch },
    { label: "price_tier",     score: bd.priceTierMatch },
    { label: "building",       score: bd.buildingMatch },
  ]
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(d => d.label);
}

function buildWarnings(
  input: CompsRequest,
  poolSize: number,
  expandedPool: boolean,
  adjacentNeighborhood: boolean,
  adjacentNeighborhoodsUsed: string[],
  confidence: ConfidenceLabel,
  beachTier: BeachTier
): string[] {
  const w: string[] = [];
  if (confidence === "guidance_only") {
    w.push(`Pool too thin (${poolSize} comps) for a reliable recommendation. Result is directional guidance only.`);
  } else if (confidence === "low") {
    w.push(`Thin comp pool (${poolSize} comps). Use the P25–P75 range, not the point estimate.`);
  }
  if (adjacentNeighborhood && adjacentNeighborhoodsUsed.length > 0) {
    w.push(
      `${input.neighborhood_normalized} has too few listings for a local-only comparison. ` +
      `Comps pulled from adjacent neighborhoods (${adjacentNeighborhoodsUsed.join(", ")}). ` +
      `Pricing should be directional — verify against current market.`
    );
  } else if (expandedPool) {
    w.push("Comp pool expanded to ±1 bedroom because the same-bedroom segment is too small. Prices may not reflect your exact bedroom count.");
  }
  if (input.neighborhood_normalized === "Amapas" && input.bedrooms >= 3) {
    w.push(`Amapas ${input.bedrooms}BR segment has fewer than 8 listings. Statistical noise is high — treat the range as more reliable.`);
  }
  if (input.neighborhood_normalized === "Zona Romantica" && beachTier === "A") {
    w.push("ZR Tier A (≤100m beachfront) is a structurally separate sub-market. Verify this reflects the current beachfront market.");
  }
  if (!input.sqft) {
    w.push("sqft not provided — size similarity scoring skipped and weight redistributed.");
  }
  return w;
}

/** Median of a sorted array */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Apply the comp-pool median per-night fee uplift to a base nightly rate.
 * Shared between the hero "all-in / night" number and the seasonal sweep
 * so they stay consistent. Returns null for `all_in` when no fee data is
 * available — UI should fall back to the base.
 */
function withFeeUplift(
  base: number,
  perNightFeeUsd: number | null,
): { base: number; all_in: number | null } {
  return {
    base,
    all_in: perNightFeeUsd != null ? Math.round(base + perNightFeeUsd) : null,
  };
}

/** Compute seasonal sweep from a non-seasonal base price */
function computeSeasonalSweep(
  nonSeasonalBase: number,
  perNightFeeUsd: number | null,
) {
  // Representative month multipliers
  const lowMulti      = PV_MONTHLY_FACTORS.find(m => m.month === 9)!.multiplier;  // Sep 0.68
  const shoulderMulti = PV_MONTHLY_FACTORS.find(m => m.month === 10)!.multiplier; // Oct 0.88
  const highMulti     = PV_MONTHLY_FACTORS.find(m => m.month === 11)!.multiplier; // Nov 1.00
  const peakMulti     = PV_MONTHLY_FACTORS.find(m => m.month === 3)!.multiplier;  // Mar 1.20

  return {
    low:      withFeeUplift(Math.round(nonSeasonalBase * lowMulti),      perNightFeeUsd),
    shoulder: withFeeUplift(Math.round(nonSeasonalBase * shoulderMulti), perNightFeeUsd),
    high:     withFeeUplift(Math.round(nonSeasonalBase * highMulti),     perNightFeeUsd),
    peak:     withFeeUplift(Math.round(nonSeasonalBase * peakMulti),     perNightFeeUsd),
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.post("/rental/comps", async (req, res) => {
  const parsed = CompsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request payload", details: parsed.error.flatten().fieldErrors });
    return;
  }

  const input = parsed.data;

  // ── Stay-window derivation ────────────────────────────────────────────────
  // When both check_in and check_out are present and check_in < check_out, the
  // stay window becomes the seasonal anchor and the source-of-truth date range
  // for both the engine call and the per-night data block downstream. When
  // absent (or malformed), behavior is identical to month-only pricing.
  const checkIn  = input.check_in  ?? null;
  const checkOut = input.check_out ?? null;
  const useStayWindow = !!(checkIn && checkOut && checkIn < checkOut);
  let effectiveYear:  number;
  let effectiveMonth: number;
  let stayNights = 0;
  if (useStayWindow) {
    const [yStr, mStr] = checkIn!.split("-");
    effectiveYear  = parseInt(yStr, 10);
    effectiveMonth = parseInt(mStr, 10);
    // Inclusive of check-in, exclusive of check-out — standard hotel/STR
    // night-count convention.
    const ms = Date.parse(checkOut + "T00:00:00Z") - Date.parse(checkIn + "T00:00:00Z");
    stayNights = Math.max(1, Math.round(ms / 86400000));
  } else {
    effectiveYear  = new Date().getFullYear();
    effectiveMonth = input.month;
  }

  req.log.info({
    neighborhood: input.neighborhood_normalized,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    month: effectiveMonth,
    view_type: input.view_type,
    rooftop_pool: input.rooftop_pool,
    finish_quality: input.finish_quality,
    private_plunge_pool: input.private_plunge_pool,
    large_terrace: input.large_terrace,
  }, "comps v3.1 request");

  try {
    const targetYear = effectiveYear;

    const [{ engine, listingCount, diagnostics: poolDiagnostics }, allEvents, monthAvail] = await Promise.all([
      getEngine(),
      getActiveEvents(),
      getMonthAvailability(targetYear, effectiveMonth),
    ]);

    const pricingEvents = eventsForMonth(allEvents, targetYear, effectiveMonth);

    // Building resolution
    let resolvedBuildingName: string | null = input.building_name ?? null;
    const buildingResolutionWarnings: string[] = [];

    if (input.building_name) {
      const bLookup = lookupBuilding(input.building_name, input.neighborhood_normalized);
      if (bLookup.match && bLookup.match.confidence_tier !== "low") {
        resolvedBuildingName = bLookup.match.canonical_building_name;
        if (bLookup.match.confidence_tier === "medium") {
          buildingResolutionWarnings.push(
            `Building "${input.building_name}" partially matched to "${resolvedBuildingName}" ` +
            `(${Math.round(bLookup.match.match_confidence * 100)}% confidence).`
          );
        }
        if (bLookup.match.neighborhood_normalized !== input.neighborhood_normalized) {
          resolvedBuildingName = null;
          buildingResolutionWarnings.push(
            `Building "${bLookup.match.canonical_building_name}" is in ${bLookup.match.neighborhood_normalized}, not ${input.neighborhood_normalized}. Building premium not applied.`
          );
        }
      } else if (bLookup.match?.confidence_tier === "low") {
        resolvedBuildingName = null;
        buildingResolutionWarnings.push(`Building "${input.building_name}" could not be confidently matched. Building premium not applied.`);
      } else {
        resolvedBuildingName = null;
        buildingResolutionWarnings.push(bLookup.warning ?? `Building "${input.building_name}" not recognized.`);
      }
    }

    // Bug fix: when an explicit stay window is provided, build a date-aware
    // seasonal context that averages per-night multipliers across the stay.
    // This prevents month-level event leak — e.g. a 4/22–4/28 stay should
    // NOT inherit the Easter/Semana Santa premium (4/10–4/22) just because
    // both fall in April.
    const seasonalContextOverride = useStayWindow
      ? getStayWindowSeasonalContext(
          new Date(checkIn! + "T00:00:00Z"),
          new Date(checkOut! + "T00:00:00Z"),
        )
      : undefined;

    const target: TargetPropertyV3 = {
      neighborhoodNormalized: input.neighborhood_normalized,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft: input.sqft ?? null,
      distanceToBeachM: input.distance_to_beach_m,
      amenitiesNormalized: input.amenities_normalized,
      ratingOverall: input.rating_overall ?? null,
      buildingName: resolvedBuildingName,
      month: effectiveMonth,
      seasonalContextOverride,
      viewType: input.view_type as ViewType,
      rooftopPool: input.rooftop_pool,
      yearBuilt: input.year_built as YearBuiltRange,
      finishQuality: input.finish_quality as FinishQuality,
      privatePlungePool: input.private_plunge_pool,
      largeTerrace: input.large_terrace,
    };

    // Phase 1.5: drop listings KNOWN-fully-blocked for the requested month
    // from the comp pool. Listings without calendar data pass through.
    const result = engine.run(target, { excludeIds: monthAvail.unavailable });
    const { comps, expandedPool, adjacentNeighborhood, adjacentNeighborhoodsUsed } = result;
    const poolSize = comps.length;
    const confidence = confidenceLabel(poolSize);

    // Phase 1.5 — numeric confidence_score (0..1) for the structured summary,
    // with a freshness penalty when the comp pool is dominated by static-displayed
    // listings (mostly Airbnb baseline) AND those are stale beyond 7d. Per-night
    // PVRPV daily comps don't get penalised — they're already the freshest source.
    let staticCount = 0;          // Airbnb baseline (rental_listings.nightly_price_usd)
    let staticFreshSum = 0;
    let dailyCount = 0;            // PVRPV daily quotes — freshest source
    let otherCount = 0;            // anything else (vrbo scrape, vacation_vallarta, ...)
    for (const c of comps) {
      const src = c.listing.priceSource;
      const fresh = c.listing.priceFreshnessDays;
      if (src === "static_displayed") {
        staticCount += 1;
        if (typeof fresh === "number") staticFreshSum += fresh;
      } else if (
        src === "pvrpv_daily" ||
        src === "airbnb_daily" ||
        src === "vacation_vallarta_daily" ||
        src === "airbnb_quote"
      ) {
        // All four are real-rate sources kept fresh by scrapers — none
        // contributes to the static-staleness penalty. The three *_daily
        // tags share one per-day-rate table (rental_prices_by_date) and
        // are distinguished by the listing's source_platform; see
        // platformToDailySource() in lib/comps-pricing-source.ts.
        dailyCount += 1;
      } else {
        otherCount += 1;
      }
    }
    const staticShare = poolSize > 0 ? staticCount / poolSize : 0;
    const staticAvgFresh = staticCount > 0 ? staticFreshSum / staticCount : 0;
    const staleStaticHeavy = staticShare >= 0.5 && staticAvgFresh > 7;
    const baseConfidenceScore =
      confidence === "high"           ? 1.00
      : confidence === "medium"       ? 0.75
      : confidence === "low"          ? 0.45
      :                                  0.20; // guidance_only
    const confidenceScore = parseFloat(
      Math.max(0, Math.min(1, staleStaticHeavy ? baseConfidenceScore * 0.85 : baseConfidenceScore))
        .toFixed(2)
    );

    // ── Phase 2-prelude: weekday / weekend split ──────────────────────────────
    // Pull per-night prices from rental_prices_by_date for the SAME listing
    // IDs the engine already selected (no separate hidden comp pool), bucket
    // Fri+Sat as weekend (PV short-term-rental convention), derive a factor
    // against the overall raw median, then scale the engine's already-adjusted
    // recommended/conservative/stretch by that factor. The split therefore
    // sits consistently around summary.median and inherits every adjustment
    // the engine applied (building, beach tier, premium features, seasonal).
    //
    // Degrades silently: if either bucket has fewer than MIN_PER_BUCKET rows,
    // returns nulls for all six fields rather than surfacing a noisy partial
    // signal. The UI hides the split block when both medians are null.
    let weekdayMedian: number | null = null;
    let weekdayLow:    number | null = null;
    let weekdayHigh:   number | null = null;
    let weekendMedian: number | null = null;
    let weekendLow:    number | null = null;
    let weekendHigh:   number | null = null;
    let weekdaySamples = 0;
    let weekendSamples = 0;

    const compIdsForSplit = comps
      .map(c => c.listing.id)
      .filter((n): n is number => typeof n === "number" && Number.isFinite(n));

    if (compIdsForSplit.length > 0 && confidence !== "guidance_only") {
      const startStr = `${targetYear}-${String(effectiveMonth).padStart(2, "0")}-01`;
      const nextMonth = effectiveMonth === 12 ? 1 : effectiveMonth + 1;
      const nextYear  = effectiveMonth === 12 ? targetYear + 1 : targetYear;
      const endStr    = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

      const idArrayLiteral = `ARRAY[${compIdsForSplit.join(",")}]::int[]`;
      const dowRows = (await db.execute(sql`
        SELECT
          EXTRACT(DOW FROM date)::int AS dow,
          nightly_price_usd::float8   AS price
        FROM rental_prices_by_date
        WHERE listing_id = ANY(${sql.raw(idArrayLiteral)})
          AND date >= ${startStr}::date AND date < ${endStr}::date
          AND availability_status = 'available'
          AND nightly_price_usd IS NOT NULL
      `)).rows as Array<{ dow: number; price: number }>;

      const wd: number[] = [];
      const we: number[] = [];
      for (const r of dowRows) {
        // dow: 0=Sun..6=Sat. Weekend = Fri (5) + Sat (6) nights — the
        // industry-standard short-term-rental weekend definition.
        if (r.dow === 5 || r.dow === 6) we.push(r.price);
        else wd.push(r.price);
      }
      weekdaySamples = wd.length;
      weekendSamples = we.length;

      const MIN_PER_BUCKET = 8;
      if (wd.length >= MIN_PER_BUCKET && we.length >= MIN_PER_BUCKET) {
        const sortAsc = (xs: number[]) => xs.slice().sort((a, b) => a - b);
        const wdSorted = sortAsc(wd);
        const weSorted = sortAsc(we);
        const overallSorted = sortAsc([...wd, ...we]);
        const overallMedian = median(overallSorted);
        if (overallMedian > 0) {
          const wdFactor = median(wdSorted) / overallMedian;
          const weFactor = median(weSorted) / overallMedian;
          weekdayMedian = Math.round(result.recommended  * wdFactor);
          weekdayLow    = Math.round(result.conservative * wdFactor);
          weekdayHigh   = Math.round(result.stretch      * wdFactor);
          weekendMedian = Math.round(result.recommended  * weFactor);
          weekendLow    = Math.round(result.conservative * weFactor);
          weekendHigh   = Math.round(result.stretch      * weFactor);
        }
      }
    }

    // ── Stay-window block ─────────────────────────────────────────────────────
    // When the user provided check_in/check_out, derive a window-specific
    // factor against the same selected comp pool's per-night data over the
    // entire effectiveMonth. The factor captures within-month seasonality
    // (e.g., Christmas week vs early-December baseline) and day-of-week mix
    // simultaneously — exactly the information a stay-date selection demands.
    // Falls back to nulls (UI hides) when either bucket is too thin.
    let stayWindowMedian: number | null = null;
    let stayWindowLow:    number | null = null;
    let stayWindowHigh:   number | null = null;
    let stayWindowTotal:  number | null = null;
    let stayWindowSamples = 0;

    if (
      useStayWindow &&
      compIdsForSplit.length > 0 &&
      confidence !== "guidance_only"
    ) {
      const idArrayLiteral = `ARRAY[${compIdsForSplit.join(",")}]::int[]`;
      // Two queries in parallel: month baseline (denominator) and stay-window
      // (numerator). Both restricted to available, priced rows from the same
      // comp set so the factor is apples-to-apples.
      const [monthRowsRes, winRowsRes] = await Promise.all([
        db.execute(sql`
          SELECT nightly_price_usd::float8 AS price
          FROM rental_prices_by_date
          WHERE listing_id = ANY(${sql.raw(idArrayLiteral)})
            AND date >= ${`${effectiveYear}-${String(effectiveMonth).padStart(2, "0")}-01`}::date
            AND date <  ${`${effectiveMonth === 12 ? effectiveYear + 1 : effectiveYear}-${String(effectiveMonth === 12 ? 1 : effectiveMonth + 1).padStart(2, "0")}-01`}::date
            AND availability_status = 'available'
            AND nightly_price_usd IS NOT NULL
        `),
        db.execute(sql`
          SELECT nightly_price_usd::float8 AS price
          FROM rental_prices_by_date
          WHERE listing_id = ANY(${sql.raw(idArrayLiteral)})
            AND date >= ${checkIn}::date
            AND date <  ${checkOut}::date
            AND availability_status = 'available'
            AND nightly_price_usd IS NOT NULL
        `),
      ]);

      const monthPrices = (monthRowsRes.rows as Array<{ price: number }>).map(r => r.price);
      const winPrices   = (winRowsRes.rows   as Array<{ price: number }>).map(r => r.price);
      stayWindowSamples = winPrices.length;

      // Min thresholds: month baseline needs enough density to be a stable
      // denominator; window needs enough nights × listings to be meaningful.
      const MIN_MONTH_BASELINE = 12;
      const MIN_WINDOW_OBSERVATIONS = 8;
      if (monthPrices.length >= MIN_MONTH_BASELINE && winPrices.length >= MIN_WINDOW_OBSERVATIONS) {
        const sortAsc = (xs: number[]) => xs.slice().sort((a, b) => a - b);
        const monthMedian  = median(sortAsc(monthPrices));
        const windowMedian = median(sortAsc(winPrices));
        if (monthMedian > 0) {
          const factor = windowMedian / monthMedian;
          stayWindowMedian = Math.round(result.recommended  * factor);
          stayWindowLow    = Math.round(result.conservative * factor);
          stayWindowHigh   = Math.round(result.stretch      * factor);
          stayWindowTotal  = stayWindowMedian * stayNights;
        }
      }
    }

    req.log.info({
      pool_size: poolSize, confidence,
      conservative: result.conservative,
      recommended: result.recommended,
      stretch: result.stretch,
    }, "v3.1 comps recommendation");

    const warnings = [
      ...buildingResolutionWarnings,
      ...buildWarnings(input, poolSize, expandedPool, adjacentNeighborhood, adjacentNeighborhoodsUsed, confidence, result.targetBeachTier),
    ];

    // ── Building context from comp set ────────────────────────────────────────
    let buildingContext = null;
    if (resolvedBuildingName) {
      const bComps = result.comps.filter(c =>
        c.listing.buildingNameNormalized === resolvedBuildingName
      );
      if (bComps.length > 0) {
        const bPrices = bComps
          .map(c => c.listing.nightlyPriceUsd * result.seasonalContext.totalMultiplier)
          .sort((a, b) => a - b);
        const bMedian = Math.round(median(bPrices));
        const bLow  = Math.round(bPrices[0]!);
        const bHigh = Math.round(bPrices[bPrices.length - 1]!);
        const bP25  = bPrices.length >= 4 ? Math.round(bPrices[Math.floor(bPrices.length * 0.25)]!) : bLow;
        const bP75  = bPrices.length >= 4 ? Math.round(bPrices[Math.floor(bPrices.length * 0.75)]!) : bHigh;

        // Positioning vs building median
        let positioning: "underpriced" | "aligned" | "premium" = "aligned";
        let positioningStatement = "Your current positioning is roughly in line with building median pricing.";
        if (confidence !== "guidance_only" && result.recommended) {
          const ratio = result.recommended / bMedian;
          if (ratio > 1.08) {
            positioning = "premium";
            positioningStatement = "Your configuration suggests top-tier pricing within this building.";
          } else if (ratio < 0.92) {
            positioning = "underpriced";
            positioningStatement = "You appear underpriced versus comparable units in this building.";
          }
        }

        buildingContext = {
          matched: true,
          building_name: resolvedBuildingName,
          comp_count: bComps.length,
          median_price: bMedian,
          range_low: bP25,
          range_high: bP75,
          positioning,
          positioning_statement: positioningStatement,
        };
      }
    }

    // If no building context, generate positioning vs segment median
    let globalPositioningStatement: string | null = null;
    if (!buildingContext && confidence !== "guidance_only" && result.recommended) {
      const segAdj = Math.round(result.segmentMedian * result.seasonalContext.totalMultiplier);
      if (segAdj > 0) {
        const ratio = result.recommended / segAdj;
        if (ratio > 1.12) {
          globalPositioningStatement = "Your configuration places this unit in the top tier of comparable neighborhood inventory.";
        } else if (ratio < 0.92) {
          globalPositioningStatement = "Your configuration suggests this unit may be underpriced relative to neighborhood comps.";
        } else {
          globalPositioningStatement = "Your configuration is roughly in line with comparable neighborhood inventory.";
        }
      }
    }

    // ── Selected comps ────────────────────────────────────────────────────────
    const topComps = comps.slice(0, 10);
    const topListingIds = topComps.map(c => c.listing.id);

    // Mexico vacation-rental tax bundle: 16% federal IVA + 3% Jalisco state
    // lodging tax. PVRPV's quoted totals match this exactly; used to build
    // synthetic stay-window quotes when no exact source quote exists.
    const MX_VACATION_RENTAL_TAX_RATE = 0.19;

    const topListingsIdArrayLiteral =
      `ARRAY[${topListingIds.map((n) => Number(n)).filter(Number.isFinite).join(",") || "NULL"}]::int[]`;

    type FeeRow = {
      listing_id: number;
      nightly_price_usd: number | null;
      cleaning_fee_usd: number | null;
      service_fee_usd: number | null;
      taxes_usd: number | null;
      total_price_usd: number | null;
      stay_length_nights: number | null;
      currency: string | null;
      collected_at: Date;
      // Provenance — distinguishes scraped quotes from per-night-derived
      // synthetics so the UI can label the source honestly.
      source?: "exact_quote" | "synthetic_window";
    };

    // Quote selection rules:
    //   • Stay-window mode (check_in/check_out provided): require an EXACT
    //     window match. Showing a quote for any other date range would
    //     misrepresent the rate the user is actually pricing against.
    //   • Month-only mode: keep the legacy "most-recent quote per listing"
    //     behavior — there's no specific window to anchor to.
    const feeRows: FeeRow[] = topListingIds.length === 0
      ? []
      : useStayWindow
        ? (await db.execute(sql`
            SELECT DISTINCT ON (listing_id)
              listing_id::int                  AS listing_id,
              nightly_price_usd::float8        AS nightly_price_usd,
              cleaning_fee_usd::float8         AS cleaning_fee_usd,
              service_fee_usd::float8          AS service_fee_usd,
              taxes_usd::float8                AS taxes_usd,
              total_price_usd::float8          AS total_price_usd,
              stay_length_nights::int          AS stay_length_nights,
              currency                         AS currency,
              collected_at                     AS collected_at
            FROM listing_price_quotes
            WHERE listing_id = ANY(${sql.raw(topListingsIdArrayLiteral)})
              AND availability_status = 'available'
              AND checkin_date  = ${checkIn}::date
              AND checkout_date = ${checkOut}::date
            ORDER BY listing_id, collected_at DESC
          `)).rows.map(r => ({ ...(r as Omit<FeeRow, "source">), source: "exact_quote" as const }))
        : (await db.execute(sql`
            SELECT DISTINCT ON (listing_id)
              listing_id::int                  AS listing_id,
              nightly_price_usd::float8        AS nightly_price_usd,
              cleaning_fee_usd::float8         AS cleaning_fee_usd,
              service_fee_usd::float8          AS service_fee_usd,
              taxes_usd::float8                AS taxes_usd,
              total_price_usd::float8          AS total_price_usd,
              stay_length_nights::int          AS stay_length_nights,
              currency                         AS currency,
              collected_at                     AS collected_at
            FROM listing_price_quotes
            WHERE listing_id = ANY(${sql.raw(topListingsIdArrayLiteral)})
              AND availability_status = 'available'
            ORDER BY listing_id, collected_at DESC
          `)).rows.map(r => ({ ...(r as Omit<FeeRow, "source">), source: "exact_quote" as const }));

    const feesByListing = new Map<number, FeeRow>();
    for (const r of feeRows) feesByListing.set(r.listing_id, r);

    // Stay-window synthetic fallback: for any selected comp without an
    // exact-window quote, build one from rental_prices_by_date covering
    // [check_in, check_out). Requires full nightly coverage AND every
    // night marked available — partial coverage would mislead.
    if (useStayWindow) {
      const missingIds = topListingIds.filter(id => !feesByListing.has(id));
      if (missingIds.length > 0) {
        const missingArrayLiteral = `ARRAY[${missingIds.join(",")}]::int[]`;
        const winRows = (await db.execute(sql`
          SELECT listing_id::int AS listing_id,
                 date,
                 nightly_price_usd::float8 AS nightly_price_usd
          FROM rental_prices_by_date
          WHERE listing_id = ANY(${sql.raw(missingArrayLiteral)})
            AND date >= ${checkIn}::date
            AND date <  ${checkOut}::date
            AND availability_status = 'available'
            AND nightly_price_usd IS NOT NULL
        `)).rows as Array<{ listing_id: number; date: Date | string; nightly_price_usd: number }>;

        const pricesByListing = new Map<number, number[]>();
        for (const r of winRows) {
          let arr = pricesByListing.get(r.listing_id);
          if (!arr) { arr = []; pricesByListing.set(r.listing_id, arr); }
          arr.push(r.nightly_price_usd);
        }
        for (const [lid, prices] of pricesByListing) {
          // Reject anything short of full coverage — a 5-of-6-night sample
          // would imply the user can actually book the partial window, which
          // we can't verify.
          if (prices.length !== stayNights) continue;
          const subtotal = prices.reduce((a, b) => a + b, 0);
          const taxes    = subtotal * MX_VACATION_RENTAL_TAX_RATE;
          const total    = subtotal + taxes;
          const avgNightly = subtotal / stayNights;
          feesByListing.set(lid, {
            listing_id: lid,
            nightly_price_usd: Math.round(avgNightly * 100) / 100,
            cleaning_fee_usd: 0,
            service_fee_usd: 0,
            taxes_usd: Math.round(taxes * 100) / 100,
            total_price_usd: Math.round(total * 100) / 100,
            stay_length_nights: stayNights,
            currency: "USD",
            collected_at: new Date(),
            source: "synthetic_window",
          });
        }
      }
    }

    // Per-night fees implied by each comp's guest-paid quote, used to derive
    // a comp-pool median fee uplift for the owner's recommended rate.
    const compFeesPerNight: number[] = [];

    const selectedComps = topComps.map((c, i) => {
      const fees = feesByListing.get(c.listing.id);

      // Effective per-night including fees & taxes:
      //   total_price_usd / stay_length_nights
      // Falls back to null when total or stay length is missing/zero.
      let effectivePerNight: number | null = null;
      if (
        fees &&
        fees.total_price_usd != null &&
        fees.stay_length_nights != null &&
        fees.stay_length_nights > 0
      ) {
        effectivePerNight = fees.total_price_usd / fees.stay_length_nights;
        if (fees.nightly_price_usd != null) {
          const perNightFees = effectivePerNight - fees.nightly_price_usd;
          if (Number.isFinite(perNightFees) && perNightFees >= 0) {
            compFeesPerNight.push(perNightFees);
          }
        }
      }

      return {
        rank: i + 1,
        external_id: c.listing.externalId,
        source_url: c.listing.sourceUrl,
        neighborhood: c.listing.neighborhoodNormalized,
        bedrooms: c.listing.bedrooms,
        bathrooms: c.listing.bathrooms,
        sqft: c.listing.sqft,
        distance_to_beach_m: c.listing.distanceToBeachM,
        beach_tier: c.listing.beachTier,
        price_tier: c.listing.priceTier,
        // When pricing a stay window, anchor the displayed nightly to the
        // SAME source as the total (exact quote or per-night synthetic) so
        // the card is internally consistent. In month-only mode, fall back
        // to the listing's sticker rate (legacy behavior).
        nightly_price_usd: useStayWindow && fees && fees.nightly_price_usd != null
          ? Math.round(fees.nightly_price_usd)
          : c.listing.nightlyPriceUsd,
        rating_overall: c.listing.ratingOverall,
        building_name: c.listing.buildingNameNormalized,
        score: parseFloat(c.score.toFixed(1)),
        match_reasons: c.matchReasons,
        top_drivers: extractTopDrivers(c),
        // Effective per-night incl. fees & taxes (total / stay_length_nights).
        // Null when no guest-paid quote with usable totals exists — the UI
        // should fall back to nightly_price_usd in that case.
        effective_per_night_usd: effectivePerNight != null
          ? Math.round(effectivePerNight)
          : null,
        // Guest-paid breakdown (from latest available listing_price_quote).
        // Null = no quote on file for this listing (e.g. PVRPV-only comps).
        // Treat 0 as a real zero (no fee charged) — distinct from null.
        guest_paid: fees
          ? {
              nightly_price_usd: fees.nightly_price_usd,
              cleaning_fee_usd: fees.cleaning_fee_usd,
              service_fee_usd: fees.service_fee_usd,
              taxes_usd: fees.taxes_usd,
              total_price_usd: fees.total_price_usd,
              stay_length_nights: fees.stay_length_nights,
              currency: fees.currency ?? "USD",
              collected_at: fees.collected_at instanceof Date
                ? fees.collected_at.toISOString()
                : String(fees.collected_at),
              // "exact_quote" = real scraped guest-paid quote for the exact
              // window. "synthetic_window" = derived from per-night rates +
              // 19% MX tax because no exact quote existed. UI labels both.
              source: fees.source ?? "exact_quote",
            }
          : null,
      };
    });

    // Median per-night fees uplift inferred from the comp pool. Used to
    // estimate what the owner's recommended rate would look like once the
    // typical cleaning + service + tax load is folded in.
    const sortedFees = [...compFeesPerNight].sort((a, b) => a - b);
    const medianFeesPerNight = sortedFees.length > 0 ? median(sortedFees) : null;
    const poolMedianFeesPerNightUsd = medianFeesPerNight != null
      ? Math.round(medianFeesPerNight)
      : null;
    const recommendedEffectivePerNightUsd =
      confidence !== "guidance_only" && result.recommended
        ? withFeeUplift(result.recommended, medianFeesPerNight).all_in
        : null;
    const compsWithFeesCount = sortedFees.length;

    // ── Seasonal sweep ────────────────────────────────────────────────────────
    // Computed after the comp-pool fee uplift so each season can show both
    // a base and an all-in number using the same fee logic as the hero.
    // Guard: only compute the sweep when we have a finite, positive base to
    // multiply against. Otherwise the four cards downstream render "$NaN".
    const seasonalDivisor = result.seasonalContext.totalMultiplier;
    const nonSeasonalBase =
      Number.isFinite(result.totalAdjustmentMultiplier) &&
      result.totalAdjustmentMultiplier > 0 &&
      Number.isFinite(seasonalDivisor) &&
      seasonalDivisor > 0
        ? result.recommended / seasonalDivisor
        : result.recommended;
    const sweepBaseUsable =
      Number.isFinite(nonSeasonalBase) && nonSeasonalBase > 0;
    const seasonalSweep =
      confidence !== "guidance_only" && sweepBaseUsable
        ? computeSeasonalSweep(nonSeasonalBase, medianFeesPerNight)
        : null;
    if (confidence !== "guidance_only" && !sweepBaseUsable) {
      req.log.warn(
        {
          recommended: result.recommended,
          totalAdjustmentMultiplier: result.totalAdjustmentMultiplier,
          seasonalDivisor,
          nonSeasonalBase,
          neighborhood: input.neighborhood_normalized,
          bedrooms: input.bedrooms,
          month: effectiveMonth,
        },
        "comps: skipping seasonal_sweep — non-finite base would have rendered $NaN",
      );
    }

    const topDriversOverall = selectedComps.length > 0
      ? Object.entries(
          selectedComps
            .flatMap(c => c.top_drivers)
            .reduce<Record<string, number>>((acc, d) => { acc[d] = (acc[d] ?? 0) + 1; return acc; }, {})
        )
          .sort(([, a], [, b]) => b - a)
          .slice(0, 4)
          .map(([label]) => label)
      : [];

    // ── Explanation ───────────────────────────────────────────────────────────
    const neighborhoodScope = adjacentNeighborhood && adjacentNeighborhoodsUsed.length > 0
      ? `${input.neighborhood_normalized} + adjacent (${adjacentNeighborhoodsUsed.join(", ")})`
      : input.neighborhood_normalized;
    const explanation = [
      `Recommendation based on ${poolSize} comparable listings in ${neighborhoodScope}.`,
      result.adjustmentExplanation,
      "Data scope: multi-source (PVRPV, Vacation Vallarta, Airbnb, VRBO).",
    ].filter(Boolean).join(" ");

    const modelLimitations = [
      "Single-rate scraping: rates reflect the listed baseline, not seasonal peaks or minimums.",
      "Seasonality is applied using PV market knowledge, not live booking data.",
      "View type and finish quality are self-reported — not verified against listing photos.",
      "Building prestige signals are partially captured via building premium factor.",
      "Calibrated weights for Hotel Zone, Centro, 5 de Dic, Versalles, Marina are in development.",
    ];

    const thinPoolWarning = confidence === "guidance_only" || confidence === "low";

    res.json({
      model_version: "v3.1",
      source_scope: `Multi-source (PVRPV + Vacation Vallarta + Airbnb + VRBO) — ${input.neighborhood_normalized}`,
      eligible_listing_count: engine.eligibleCount,
      db_listing_count: listingCount,
      // Comp Model Contract v1 — provenance + freshness diagnostics
      // for the entire comp pool (not just the matched comps below).
      // Lets the dashboard surface "X PVRPV daily, Y static fallback,
      // Z dropped for staleness". See docs/comp-model-contract.md.
      pool_diagnostics: poolDiagnostics,
      eligibility_status: confidence === "guidance_only" ? "guidance_only" : "eligible",

      target_summary: {
        neighborhood: result.target.neighborhoodNormalized,
        bedrooms: result.target.bedrooms,
        bathrooms: result.target.bathrooms,
        beach_tier: result.targetBeachTier,
        building_normalized: result.targetBuildingNormalized,
        building_premium_pct: result.targetBuildingPremiumFactor != null
          ? parseFloat((result.targetBuildingPremiumFactor * 100).toFixed(1)) : null,
        segment_median: result.segmentMedian,
        month: effectiveMonth,
        view_type: input.view_type,
        rooftop_pool: input.rooftop_pool,
        finish_quality: input.finish_quality,
        private_plunge_pool: input.private_plunge_pool,
        large_terrace: input.large_terrace,
      },

      pool_size: poolSize,
      thin_pool_warning: thinPoolWarning,
      expanded_pool: expandedPool,
      adjacent_neighborhood: adjacentNeighborhood,
      adjacent_neighborhoods_used: adjacentNeighborhoodsUsed,
      confidence_label: confidence,

      conservative_price: confidence === "guidance_only" ? null : result.conservative,
      recommended_price:  confidence === "guidance_only" ? null : result.recommended,
      stretch_price:      confidence === "guidance_only" ? null : result.stretch,

      // Effective per-night incl. fees & taxes for the recommended rate,
      // estimated by adding the comp-pool median per-night fee uplift to
      // the base recommendation. Null when no comps in the pool have a
      // usable guest-paid quote — UI should fall back to recommended_price.
      recommended_effective_per_night_usd: recommendedEffectivePerNightUsd,
      pool_median_fees_per_night_usd:      poolMedianFeesPerNightUsd,
      pool_fees_sample_size:               compsWithFeesCount,

      base_comp_median: result.baseCompMedian,
      building_adjustment_pct: result.buildingAdjustmentPct,
      beach_tier_adjustment_pct: result.beachTierAdjustmentPct,

      pricing_breakdown: result.pricingBreakdown,
      total_adjustment_multiplier: parseFloat(result.totalAdjustmentMultiplier.toFixed(4)),

      seasonal: (() => {
        const ctx = result.seasonalContext;
        // Phase B: enrich the Phase A audit with zone candidates (per-night
        // zone_multiplier + final_night_multiplier, plus stay-level averages).
        // EXPLANATORY ONLY — these values are NOT applied to price. Pricing
        // remains identical to Phase A (legacy_event_only mode). Activating
        // zone math against price requires empirical M_event_avg from
        // historical pricing data and is reserved for a future phase.
        const enrichedAudit = ctx.eventAudit
          ? enrichAuditWithZoneCandidate({
              audit: ctx.eventAudit,
              neighborhoodKey: normalizeNeighborhoodKey(input.neighborhood_normalized),
            })
          : null;
        return {
          month: ctx.month,
          month_name: ctx.monthName,
          season: ctx.season,
          monthly_multiplier: ctx.monthlyMultiplier,
          monthly_note: ctx.monthlyNote,
          event_name: ctx.activeEvent?.name ?? null,
          event_key: ctx.activeEvent?.key ?? null,
          event_premium_pct: ctx.eventPremiumPct != null
            ? parseFloat((ctx.eventPremiumPct * 100).toFixed(1)) : null,
          total_multiplier: parseFloat(ctx.totalMultiplier.toFixed(4)),
          display_label: ctx.displayLabel,
          event_audit: enrichedAudit,
        };
      })(),

      // New V3.1 fields
      seasonal_sweep: seasonalSweep,
      building_context: buildingContext,
      positioning_statement: buildingContext?.positioning_statement ?? globalPositioningStatement,

      market_anomaly: pricingEvents.length > 0
        ? {
            detected: true,
            severity: pricingEvents[0].severity,
            events: pricingEvents.map(ev => ({
              slug:        ev.slug,
              title:       ev.title,
              title_es:    ev.titleEs,
              category:    ev.category,
              severity:    ev.severity,
              summary:     ev.summary,
              summary_es:  ev.summaryEs,
              start_date:  ev.startDate,
              end_date:    ev.endDate ?? null,
              recovery_window_end: ev.recoveryWindowEnd ?? null,
            })),
          }
        : { detected: false, events: [] },

      selected_comps: selectedComps,
      top_drivers: topDriversOverall,
      explanation,
      warnings,
      model_limitations: modelLimitations,

      // Phase 1.5 — additive structured summary. Mirrors the existing
      // conservative/recommended/stretch fields in a leaner shape so
      // downstream callers (frontend, exports) can adopt without breaking
      // the V3.1 response contract. `low`/`high` are the P15/P85 band
      // (with the conservative/stretch guardrails applied), `median` is
      // the post-adjustment recommended price.
      summary: {
        median:           confidence === "guidance_only" ? null : result.recommended,
        low:              confidence === "guidance_only" ? null : result.conservative,
        high:             confidence === "guidance_only" ? null : result.stretch,
        confidence_score: confidenceScore,
        sample_size:      poolSize,
        // Composition counts for the UI's concise data-signal line:
        //   "Based on N comparable listings (X nightly-priced, Y Airbnb)"
        // Drawn from the same source breakdown that powers the freshness
        // penalty, so the line reflects exactly what the engine actually used.
        composition: {
          nightly_priced:   dailyCount,   // PVRPV daily quotes (freshest)
          airbnb_baseline:  staticCount,  // rental_listings.nightly_price_usd
          other:            otherCount,
        },
        // Diagnostic context for the freshness penalty above. Lets the UI
        // show "trimmed N stale, M fully-blocked" without re-deriving it.
        availability_filtered_out: monthAvail.unavailable.size,
        static_share:              parseFloat(staticShare.toFixed(2)),
        static_avg_freshness_days: staticCount > 0 ? parseFloat(staticAvgFresh.toFixed(1)) : null,
        freshness_penalty_applied: staleStaticHeavy,

        // Weekday / weekend split — derived from the SAME selected comp IDs
        // via rental_prices_by_date for the requested month. All six fields
        // are null when the per-bucket sample is too thin for a clean signal;
        // the UI hides the block in that case rather than showing a caveat.
        weekday_median: weekdayMedian,
        weekday_low:    weekdayLow,
        weekday_high:   weekdayHigh,
        weekend_median: weekendMedian,
        weekend_low:    weekendLow,
        weekend_high:   weekendHigh,
        weekday_samples: weekdaySamples,
        weekend_samples: weekendSamples,

        // Stay-window block — populated only when the request supplied valid
        // check_in/check_out and the per-night sample within the window is
        // dense enough. Same scaling pattern as weekday/weekend so the bands
        // sit consistently around recommended/conservative/stretch.
        stay_window_median:  stayWindowMedian,
        stay_window_low:     stayWindowLow,
        stay_window_high:    stayWindowHigh,
        stay_window_total:   stayWindowTotal,
        stay_window_nights:  useStayWindow ? stayNights : null,
        stay_window_samples: stayWindowSamples,
      },

      generated_at: new Date().toISOString(),
    });

    // Pricing-tool uptime probe — record the timestamp of the most recent
    // successful response so /api/health/pricing-tool can surface it on
    // the /sources dashboard. Done after `res.json(...)` so a serializer
    // failure doesn't falsely advance the success marker.
    recordPricingToolSuccess();

  } catch (err) {
    req.log.error({ err }, "Failed to run comps engine");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
