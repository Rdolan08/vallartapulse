/**
 * comps-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Comparable-property pricing engine for Puerto Vallarta rental listings.
 *
 * Version:   1.0 — PVRPV dataset only, Zona Romantica + Amapas
 * Data:      125 PVRPV listings (63 + 62 scrape passes, April 2026)
 * Scope:     1–4 bedroom condos, max $1,000/night, beach distance required
 *
 * Usage (pure, no DB dependency):
 *   const engine = new CompsEngine(listings);
 *   const result = engine.run(targetProperty, { excludeId: target.id });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCORING FORMULA (total: 100 pts)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BASE WEIGHTS (when all fields are present on target and comp):
 *   beach_distance   25 pts   proximity to beach is the #1 PV price driver
 *   amenities        25 pts   Jaccard similarity of normalized amenity keys
 *   sqft             20 pts   size similarity (scaled to ±75% of target sqft)
 *   bathrooms        15 pts   exact=15, ±0.5=10, ±1=5, else=0
 *   rating            15 pts  scaled over 0–3 point difference window
 *
 * REDISTRIBUTION RULES (when fields are missing):
 *   If target OR comp has no sqft:      drop sqft weight;
 *                                       add 12pts to beach, 8pts to bathrooms
 *   If target has no rating_overall:    drop rating weight;
 *                                       add 8pts to beach, 7pts to amenities
 *   Both can apply simultaneously.
 *
 * BEACH DISTANCE SIMILARITY:
 *   beachScore = clamp(1 - |Δdist| / BEACH_SCALE, 0, 1) × weight
 *   BEACH_SCALE = 400m  → comps 400m+ further/closer than target score 0
 *
 * SQFT SIMILARITY:
 *   sqftScore = clamp(1 - |Δsqft| / (target_sqft × SQFT_SCALE), 0, 1) × weight
 *   SQFT_SCALE = 0.75  → comp 75%+ larger/smaller than target scores 0
 *
 * BATHROOM SIMILARITY:
 *   diff   = |comp_baths - target_baths|
 *   score  = diff===0 → weight, ≤0.5 → weight×0.67, ≤1 → weight×0.33, else 0
 *
 * AMENITY SIMILARITY (Jaccard):
 *   amenityScore = |intersection| / |union| × weight
 *   Keys in both / Keys in either
 *
 * RATING SIMILARITY:
 *   ratingScore = clamp(1 - |Δrating| / RATING_SCALE, 0, 1) × weight
 *   RATING_SCALE = 3.0  → comps 3.0+ apart on a 5.0 scale score 0
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRICE RECOMMENDATION LOGIC
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Uses the TOP_N highest-scoring comps (min 5, max 10) within the segment.
 * No mean/average — anchored entirely on median and percentiles.
 *
 *   conservative  = P25  (25th percentile of comp prices)
 *   recommended   = P50  (median of comp prices)
 *   stretch       = P75  (75th percentile of comp prices)
 *
 * Rationale:
 *   P25/P50/P75 are robust to outliers and naturally express a risk range.
 *   No additional adjustments are applied in v1 — the price range itself
 *   implicitly captures differences in sqft, beach proximity, and amenities
 *   through the comp selection scoring.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * COMP POOL SELECTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Primary filter:  same neighborhood + same bedroom count
 * 2. If pool (after excluding target) < MIN_POOL_SIZE (3):
 *    Expand to ±1 bedroom within same neighborhood.
 *    Bedroom-mismatch comps are penalized 12 points in the final score.
 * 3. Rank by similarity score descending.
 * 4. Return top N comps (5 ≤ N ≤ 10, configurable).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompsListing {
  /** DB primary key */
  id: number;
  externalId: string;
  sourceUrl: string;
  neighborhoodNormalized: "Zona Romantica" | "Amapas";
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  distanceToBeachM: number;
  amenitiesNormalized: string[];
  ratingOverall: number | null;
  /** Nightly rate in USD — must be present for eligible listings */
  nightlyPriceUsd: number;
  buildingName: string | null;
  dataConfidenceScore: number;
}

export interface TargetProperty {
  neighborhoodNormalized: "Zona Romantica" | "Amapas";
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  distanceToBeachM: number;
  amenitiesNormalized: string[];
  /** Optional — if missing, rating similarity is dropped and weight redistributed */
  ratingOverall?: number | null;
}

export interface ScoreBreakdown {
  /** Points earned per factor (out of effective weight) */
  beachDistance: number;
  sqft: number;
  bathrooms: number;
  amenities: number;
  rating: number;
  /** Penalty if bedrooms differ from target (expanded pool only) */
  bedroomMismatch: number;
  total: number;
  /** Effective weights used (may differ from base if fields are missing) */
  effectiveWeights: {
    beachDistance: number;
    sqft: number;
    bathrooms: number;
    amenities: number;
    rating: number;
  };
}

export interface CompResult {
  listing: CompsListing;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  matchReasons: string[];
}

export interface PriceRecommendation {
  conservative: number;  // P25 of comp prices
  recommended: number;   // P50 (median)
  stretch: number;       // P75
  compCount: number;
  avgCompPrice: number;
  medianCompPrice: number;
  compPrices: number[];
}

export interface CompsResult {
  target: TargetProperty;
  eligiblePoolSize: number;
  segmentPoolSize: number;
  expandedPool: boolean;
  comps: CompResult[];
  recommendation: PriceRecommendation;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Base scoring weights when all fields are present. Must sum to 100. */
const BASE_WEIGHTS = {
  beachDistance: 25,
  sqft:          20,
  bathrooms:     15,
  amenities:     25,
  rating:        15,
} as const;

/** Beach distance scale: 400m separation → beach score = 0. */
const BEACH_SCALE_M = 400;

/** sqft scale: comp is SQFT_SCALE × target_sqft away → sqft score = 0. */
const SQFT_SCALE = 0.75;

/** Rating scale: ratings differ by 3.0 → rating score = 0. */
const RATING_SCALE = 3.0;

/** Minimum listings in comp pool before expanding to ±1 bedroom. */
const MIN_POOL_SIZE = 3;

/** Bedroom mismatch penalty (points deducted when pool is expanded). */
const BEDROOM_MISMATCH_PENALTY = 12;

/** Minimum comps to return. */
const MIN_COMPS = 5;

/** Maximum comps to return. */
const MAX_COMPS = 10;

// ── Eligibility filter ────────────────────────────────────────────────────────

/**
 * Returns true if a listing is eligible to serve as a comparable.
 * Called once on the full listing set at engine construction time.
 */
export function isEligible(listing: CompsListing): boolean {
  if (!["Zona Romantica", "Amapas"].includes(listing.neighborhoodNormalized)) return false;
  if (listing.bedrooms < 1 || listing.bedrooms > 4) return false;
  if (listing.nightlyPriceUsd == null || listing.nightlyPriceUsd <= 0) return false;
  if (listing.nightlyPriceUsd > 1000) return false;
  if (listing.distanceToBeachM == null) return false;
  // Sqft < 200 is a known parsing error — exclude
  if (listing.sqft != null && listing.sqft < 200) return false;
  // Low-confidence only if missing more than rating
  if (listing.dataConfidenceScore < 0.85) return false;
  return true;
}

// ── Similarity scoring ────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const k of setA) { if (setB.has(k)) intersection++; }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Computes effective weights, adjusting for missing fields.
 */
function effectiveWeights(
  target: TargetProperty,
  comp: CompsListing
): typeof BASE_WEIGHTS {
  let { beachDistance, sqft, bathrooms, amenities, rating } = { ...BASE_WEIGHTS };

  const hasSqft = target.sqft != null && comp.sqft != null;
  const hasRating = target.ratingOverall != null && target.ratingOverall > 0;

  if (!hasSqft) {
    // Redistribute sqft weight
    beachDistance += 12;
    bathrooms += 8;
    sqft = 0;
  }

  if (!hasRating) {
    // Redistribute rating weight
    beachDistance += 8;
    amenities += 7;
    rating = 0;
  }

  return { beachDistance, sqft, bathrooms, amenities, rating };
}

/**
 * Scores a single comp against the target.
 * Returns a full breakdown.
 */
export function scoreComp(
  target: TargetProperty,
  comp: CompsListing,
  bedroomMismatch: boolean
): ScoreBreakdown {
  const w = effectiveWeights(target, comp);

  // Beach distance
  const beachDelta = Math.abs(comp.distanceToBeachM - target.distanceToBeachM);
  const beachScore = clamp(1 - beachDelta / BEACH_SCALE_M, 0, 1) * w.beachDistance;

  // sqft
  let sqftScore = 0;
  if (w.sqft > 0 && target.sqft != null && comp.sqft != null) {
    const sqftDelta = Math.abs(comp.sqft - target.sqft);
    sqftScore = clamp(1 - sqftDelta / (target.sqft * SQFT_SCALE), 0, 1) * w.sqft;
  }

  // Bathrooms
  const bathDiff = Math.abs(comp.bathrooms - target.bathrooms);
  let bathScore: number;
  if (bathDiff === 0) bathScore = w.bathrooms;
  else if (bathDiff <= 0.5) bathScore = w.bathrooms * 0.67;
  else if (bathDiff <= 1) bathScore = w.bathrooms * 0.33;
  else bathScore = 0;

  // Amenities (Jaccard)
  const jaccard = jaccardSimilarity(target.amenitiesNormalized, comp.amenitiesNormalized);
  const amenityScore = jaccard * w.amenities;

  // Rating
  let ratingScore = 0;
  if (w.rating > 0 && target.ratingOverall != null && comp.ratingOverall != null) {
    const ratingDelta = Math.abs(comp.ratingOverall - target.ratingOverall);
    ratingScore = clamp(1 - ratingDelta / RATING_SCALE, 0, 1) * w.rating;
  }

  // Bedroom mismatch penalty (expanded pool)
  const bedroomMismatchPoints = bedroomMismatch ? BEDROOM_MISMATCH_PENALTY : 0;

  const total = clamp(
    beachScore + sqftScore + bathScore + amenityScore + ratingScore - bedroomMismatchPoints,
    0,
    100
  );

  return {
    beachDistance: parseFloat(beachScore.toFixed(1)),
    sqft: parseFloat(sqftScore.toFixed(1)),
    bathrooms: parseFloat(bathScore.toFixed(1)),
    amenities: parseFloat(amenityScore.toFixed(1)),
    rating: parseFloat(ratingScore.toFixed(1)),
    bedroomMismatch: -bedroomMismatchPoints,
    total: parseFloat(total.toFixed(1)),
    effectiveWeights: w,
  };
}

/**
 * Generates human-readable reasons why a comp matched.
 */
function buildMatchReasons(
  target: TargetProperty,
  comp: CompsListing,
  breakdown: ScoreBreakdown
): string[] {
  const reasons: string[] = [];

  reasons.push(`Same neighborhood: ${comp.neighborhoodNormalized}`);
  reasons.push(`Same bedrooms: ${comp.bedrooms}BR`);

  const beachDelta = Math.abs(comp.distanceToBeachM - target.distanceToBeachM);
  if (beachDelta <= 50) reasons.push(`Same beach proximity (~${comp.distanceToBeachM}m)`);
  else if (beachDelta <= 150) reasons.push(`Close beach proximity (${comp.distanceToBeachM}m vs ${target.distanceToBeachM}m target)`);

  if (target.sqft != null && comp.sqft != null) {
    const pctDiff = Math.abs(comp.sqft - target.sqft) / target.sqft;
    if (pctDiff <= 0.10) reasons.push(`Very similar size (${comp.sqft} vs ${target.sqft} ft²)`);
    else if (pctDiff <= 0.25) reasons.push(`Similar size (${comp.sqft} vs ${target.sqft} ft²)`);
  }

  if (Math.abs(comp.bathrooms - target.bathrooms) === 0) {
    reasons.push(`Same bathrooms: ${comp.bathrooms}BA`);
  }

  if (breakdown.amenities >= breakdown.effectiveWeights.amenities * 0.75) {
    const intersection = target.amenitiesNormalized.filter(
      (k) => comp.amenitiesNormalized.includes(k)
    );
    reasons.push(`High amenity match (${intersection.length} shared)`);
  }

  if (breakdown.bedroomMismatch < 0) {
    reasons.push(`⚠ Expanded pool: ${comp.bedrooms}BR (target: ${target.bedrooms}BR)`);
  }

  return reasons;
}

// ── Price recommendation ──────────────────────────────────────────────────────

function buildRecommendation(comps: CompResult[]): PriceRecommendation {
  const prices = comps.map((c) => c.listing.nightlyPriceUsd).sort((a, b) => a - b);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    conservative: Math.round(percentile(prices, 25)),
    recommended:  Math.round(percentile(prices, 50)),
    stretch:      Math.round(percentile(prices, 75)),
    compCount:    prices.length,
    avgCompPrice: Math.round(avg),
    medianCompPrice: Math.round(percentile(prices, 50)),
    compPrices: prices,
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class CompsEngine {
  private eligible: CompsListing[];

  constructor(allListings: CompsListing[]) {
    this.eligible = allListings.filter(isEligible);
  }

  get eligibleCount(): number {
    return this.eligible.length;
  }

  /**
   * Run the comps engine for a target property.
   *
   * @param target     The property to find comps for.
   * @param options.excludeId   DB id to exclude from pool (for leave-one-out tests).
   * @param options.minComps    Min comps to return (default: MIN_COMPS = 5).
   * @param options.maxComps    Max comps to return (default: MAX_COMPS = 10).
   */
  run(
    target: TargetProperty,
    options: {
      excludeId?: number;
      minComps?: number;
      maxComps?: number;
    } = {}
  ): CompsResult {
    const { excludeId, minComps = MIN_COMPS, maxComps = MAX_COMPS } = options;

    // Exclude the target listing itself from pool
    const pool = this.eligible.filter(
      (l) => l.neighborhoodNormalized === target.neighborhoodNormalized &&
             (excludeId == null || l.id !== excludeId)
    );

    // Primary segment: same neighborhood + same bedrooms
    let segment = pool.filter((l) => l.bedrooms === target.bedrooms);
    let expandedPool = false;

    // Expand to ±1 bedroom if pool too small
    if (segment.length < MIN_POOL_SIZE) {
      segment = pool.filter(
        (l) => Math.abs(l.bedrooms - target.bedrooms) <= 1
      );
      expandedPool = segment.length > 0 && segment.some((l) => l.bedrooms !== target.bedrooms);
    }

    // Score each comp
    const scored: CompResult[] = segment.map((comp) => {
      const bedroomMismatch = comp.bedrooms !== target.bedrooms;
      const breakdown = scoreComp(target, comp, bedroomMismatch);
      const reasons = buildMatchReasons(target, comp, breakdown);
      return {
        listing: comp,
        score: breakdown.total,
        scoreBreakdown: breakdown,
        matchReasons: reasons,
      };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    // Take top N
    const topN = scored.slice(0, Math.max(minComps, Math.min(maxComps, scored.length)));

    // Build recommendation from top comps
    const recommendation = buildRecommendation(topN);

    return {
      target,
      eligiblePoolSize: this.eligible.length,
      segmentPoolSize: segment.length,
      expandedPool,
      comps: topN,
      recommendation,
    };
  }
}

// ── Formatting helpers (for CLI output) ──────────────────────────────────────

export function formatCompsResult(
  result: CompsResult,
  targetLabel: string,
  actualPrice?: number
): string {
  const { target, comps, recommendation, expandedPool, segmentPoolSize } = result;
  const lines: string[] = [];

  lines.push(`\n${"═".repeat(72)}`);
  lines.push(`TARGET: ${targetLabel}`);
  lines.push(
    `  ${target.neighborhoodNormalized} | ${target.bedrooms}BR / ${target.bathrooms}BA` +
    ` | ${target.sqft != null ? `${target.sqft} ft²` : "sqft unknown"}` +
    ` | ${target.distanceToBeachM}m to beach`
  );
  if (actualPrice != null) {
    lines.push(`  Actual price: $${actualPrice}/night`);
  }
  lines.push(`  Pool: ${segmentPoolSize} eligible comps${expandedPool ? " (±1BR expanded)" : ""}`);

  lines.push(`\n${"─".repeat(72)}`);
  lines.push(`TOP ${comps.length} COMPS (scored out of 100):`);
  lines.push(`${"─".repeat(72)}`);

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const l = c.listing;
    lines.push(
      `\n  [${String(i + 1).padStart(2)}] Score: ${c.score.toFixed(1).padStart(5)}  $${l.nightlyPriceUsd}/night  ${l.externalId}`
    );
    lines.push(
      `       ${l.neighborhoodNormalized} | ${l.bedrooms}BR/${l.bathrooms}BA` +
      ` | ${l.sqft != null ? `${l.sqft} ft²` : "sqft:N/A"}` +
      ` | ${l.distanceToBeachM}m beach` +
      ` | ★ ${l.ratingOverall != null ? l.ratingOverall : "N/A"}`
    );
    lines.push(`       Breakdown: beach=${c.scoreBreakdown.beachDistance}` +
      ` sqft=${c.scoreBreakdown.sqft}` +
      ` bath=${c.scoreBreakdown.bathrooms}` +
      ` amen=${c.scoreBreakdown.amenities}` +
      ` rating=${c.scoreBreakdown.rating}` +
      (c.scoreBreakdown.bedroomMismatch < 0 ? ` BR_penalty=${c.scoreBreakdown.bedroomMismatch}` : "")
    );
    for (const r of c.matchReasons) {
      lines.push(`       → ${r}`);
    }
  }

  lines.push(`\n${"─".repeat(72)}`);
  lines.push("PRICE RECOMMENDATION:");
  lines.push(`  Conservative (P25):  $${recommendation.conservative}/night`);
  lines.push(`  Recommended  (P50):  $${recommendation.recommended}/night`);
  lines.push(`  Stretch      (P75):  $${recommendation.stretch}/night`);
  lines.push(`  Avg of comps:        $${recommendation.avgCompPrice}/night`);
  lines.push(`  Comp prices:         $${recommendation.compPrices.join(", $")}`);

  if (actualPrice != null) {
    const diff = recommendation.recommended - actualPrice;
    const pct = ((diff / actualPrice) * 100).toFixed(1);
    const direction = diff >= 0 ? "above" : "below";
    const flag = Math.abs(parseFloat(pct)) > 25 ? " ⚠" : Math.abs(parseFloat(pct)) > 15 ? " △" : " ✓";
    lines.push(
      `\n  Recommendation vs actual: ${diff >= 0 ? "+" : ""}${diff} (${pct}% ${direction} actual)${flag}`
    );
  }

  lines.push("═".repeat(72));
  return lines.join("\n");
}
