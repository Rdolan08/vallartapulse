/**
 * comps-engine-v2.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VallartaPulse Comparable-Property Pricing Engine — Version 2
 *
 * Version:   2.0 — April 2026
 * Dataset:   118 eligible PVRPV listings (Zona Romantica + Amapas, 1–4BR)
 * Changes from V1:
 *   1. Building normalization + building premium/discount factor
 *   2. Price-tier segmentation (P33/P67 tertiles within neighborhood+BR)
 *   3. Beach tier buckets (A/B/C) with neighborhood-aware premium direction
 *   4. Neighborhood-specific scoring weights (ZR vs Amapas)
 *   5. IQR-based outlier trimming before recommendation anchoring
 *   6. Two-pass recommendation: base median → building adj → beach-tier adj
 *   7. Expanded to 10 validation test cases
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BUILDING NORMALIZATION
 * ─────────────────────────────────────────────────────────────────────────────
 * PVRPV stores unit-level building names (e.g. "Estrellita Del Mar 303 Star
 * Light"). The alias map collapses these to a canonical complex name so that
 * all units in the same building share a common key for premium computation.
 * Minimum peer count to compute a building premium: MIN_BUILDING_PEERS = 2.
 * Building premium is capped at ±40% of segment median.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BEACH TIER BUCKETS
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier A:  ≤100m   "beachfront or steps from sand"
 * Tier B:  101–500m "walking distance to beach"
 * Tier C:  >500m   "elevated or further inland"
 *
 * CRITICAL: Beach tier price effects are OPPOSITE between neighborhoods:
 *   Zona Romantica: Tier A commands the premium (standard beach-proximity logic)
 *                   ZR 2BR: Tier A $340 vs Tier B $180 vs Tier C $165
 *                   ZR 3BR: Tier A $505 vs Tier B $253 vs Tier C $273
 *   Amapas:         Tier C commands the premium (hillside views + elevation)
 *                   AMP 2BR: Tier B $175 vs Tier C $228
 *                   AMP 3BR: Tier B $270 vs Tier C $350
 *                   AMP 4BR: Tier B $695 vs Tier C $795
 *
 * Beach tier is used both as a comp matching bonus (same-tier preference)
 * and as a post-selection adjustment to the recommended price.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCORING FORMULA — NEIGHBORHOOD-SPECIFIC WEIGHTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ZONA ROMANTICA (100 pts base):
 *   beach_distance    20   continuous Haversine similarity
 *   amenities         22   Jaccard overlap of normalized keys
 *   sqft              17   size similarity (scale: ±75% of target)
 *   bathrooms         12   exact=12, ±0.5=8, ±1=4, else=0
 *   rating            11   linear, 3.0-point window
 *   beach_tier_match   8   same=8, adjacent=3, cross=0
 *   price_tier_match   5   same=5, adjacent=2, cross=0
 *   building_match     5   same canonical building = +5 bonus
 *   ─────────────────────────────────────────────────────────
 *   Total            100   (beach_scale = 300m, sqft_scale = 0.75)
 *
 * AMAPAS (100 pts base):
 *   sqft              25   stronger signal — units range 900–5000 ft²
 *   amenities         18   Jaccard overlap
 *   beach_tier_match  13   critical — hillside vs coastal reversal
 *   bathrooms         12   exact=12, ±0.5=8, ±1=4, else=0
 *   rating            10   linear, 3.0-point window
 *   beach_distance    10   less important in hillside neighborhood
 *   price_tier_match   5   same=5, adjacent=2, cross=0
 *   building_match     7   premium buildings are key in Amapas
 *   ─────────────────────────────────────────────────────────
 *   Total            100   (beach_scale = 400m, sqft_scale = 0.65)
 *
 * WEIGHT REDISTRIBUTION (same rules as V1):
 *   Missing sqft → redistribute sqft weight to beach_distance (+60%) + bathrooms (+40%)
 *   Missing rating → redistribute rating weight to amenities (+60%) + beach_tier (+40%)
 *
 * BEDROOM MISMATCH PENALTY (expanded pool only): −12 pts
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRICE RECOMMENDATION — TWO-PASS LOGIC
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Pass 1 — Comp set pricing
 *   1. Take top-N comps (5–10) by score
 *   2. Trim IQR outliers from comp prices: exclude prices > Q3 + 1.5×IQR
 *      or < Q1 − 1.5×IQR. Always retain at least MIN_COMPS comps.
 *   3. Base price = P50 of trimmed comp prices.
 *   4. Conservative = P25, Stretch = P75.
 *
 * Pass 2 — Adjustments
 *   Building adjustment (applied if building has ≥MIN_BUILDING_PEERS peers):
 *     building_factor = clamp((building_median / segment_median) − 1, −0.20, +0.20)
 *     adj_price = base × (1 + building_factor)
 *
 *   Beach-tier adjustment (applied if comp set is NOT already same-tier):
 *     Only if target is in the premium tier for its neighborhood:
 *       ZR Tier A vs non-A comps → +12%
 *       Amapas Tier C vs non-C comps → +10%
 *     And inverse for discount tiers:
 *       ZR Tier C vs non-C comps → −8%
 *       Amapas Tier A vs non-A comps → (no adjustment — no Tier A in Amapas data)
 *     Skipped if comp set is already majority same-tier.
 *
 *   Final:
 *     recommended = clamp(adj_price, conservative × 0.8, stretch × 1.3)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTLIER EXCLUSION RULES
 * ─────────────────────────────────────────────────────────────────────────────
 * Eligibility layer (pre-engine, applied to pool):
 *   - bedrooms ≥ 6        → excluded
 *   - price > $1,000/night → excluded
 *   - sqft < 200 ft²      → excluded (known scrape error)
 *   - confidence < 0.85   → excluded
 *
 * Comp-set IQR trimming (post-selection):
 *   - Compute Q1, Q3, IQR from top-N comp prices
 *   - Trim prices outside [Q1 − 1.5×IQR, Q3 + 1.5×IQR]
 *   - Never trim below MIN_COMPS listings
 *   - Record how many were trimmed in the output
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CompsListingV2 {
  id: number;
  externalId: string;
  sourceUrl: string;
  neighborhoodNormalized: string;
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  distanceToBeachM: number;
  amenitiesNormalized: string[];
  ratingOverall: number | null;
  nightlyPriceUsd: number;
  buildingName: string | null;
  buildingNameNormalized?: string | null;
  dataConfidenceScore: number;
}

export interface TargetPropertyV2 {
  neighborhoodNormalized: string;
  bedrooms: number;
  bathrooms: number;
  sqft: number | null;
  distanceToBeachM: number;
  amenitiesNormalized: string[];
  ratingOverall?: number | null;
  /** Optional: caller can pass building name for building-premium lookup */
  buildingName?: string | null;
}

export type BeachTier = "A" | "B" | "C";
export type PriceTier = "lower" | "middle" | "upper";

export interface ScoreBreakdownV2 {
  beachDistance: number;
  sqft: number;
  bathrooms: number;
  amenities: number;
  rating: number;
  beachTierMatch: number;
  priceTierMatch: number;
  buildingMatch: number;
  bedroomMismatch: number;
  total: number;
  effectiveWeights: NeighborhoodWeights;
}

export interface CompResultV2 {
  listing: CompsListingV2 & {
    buildingNameNormalized: string | null;
    beachTier: BeachTier;
    priceTier: PriceTier;
  };
  score: number;
  scoreBreakdown: ScoreBreakdownV2;
  matchReasons: string[];
}

export interface PriceRecommendationV2 {
  conservative: number;
  recommended: number;
  stretch: number;
  compCount: number;
  trimmedOutlierCount: number;
  avgCompPrice: number;
  medianCompPrice: number;
  baseCompMedian: number;
  buildingAdjustmentPct: number | null;
  beachTierAdjustmentPct: number | null;
  adjustmentExplanation: string;
  compPrices: number[];
}

export interface CompsResultV2 {
  target: TargetPropertyV2;
  targetBeachTier: BeachTier;
  targetPriceTier: PriceTier | null;
  targetBuildingNormalized: string | null;
  targetBuildingPremiumFactor: number | null;
  segmentMedian: number | null;
  eligiblePoolSize: number;
  segmentPoolSize: number;
  expandedPool: boolean;
  comps: CompResultV2[];
  recommendation: PriceRecommendationV2;
}

interface NeighborhoodWeights {
  beachDistance: number;
  sqft: number;
  bathrooms: number;
  amenities: number;
  rating: number;
  beachTierMatch: number;
  priceTierMatch: number;
  buildingMatch: number;
}

interface BuildingSummary {
  buildingNameNormalized: string;
  neighborhoodNormalized: string;
  bedrooms: number;
  count: number;
  medianPrice: number;
  premiumFactor: number; // (building_median / segment_median) - 1, capped ±BUILDING_PREMIUM_CAP
  rawPremiumFactor: number; // uncapped version — used to detect structural anchoring cases
}

interface SegmentStats {
  neighborhoodNormalized: string;
  bedrooms: number;
  count: number;
  p25: number;
  p50: number;
  p67: number; // tertile upper boundary for lower/middle
  p75: number;
  p33: number; // tertile upper boundary for lower
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_WEIGHTS_ZR: NeighborhoodWeights = {
  beachDistance:  20,
  amenities:      22,
  sqft:           17,
  bathrooms:      12,
  rating:         11,
  beachTierMatch:  8,
  priceTierMatch:  5,
  buildingMatch:   5,
};

const BASE_WEIGHTS_AMAPAS: NeighborhoodWeights = {
  sqft:           25,
  amenities:      18,
  beachTierMatch: 13,
  bathrooms:      12,
  rating:         10,
  beachDistance:  10,
  priceTierMatch:  5,
  buildingMatch:   7,
};

const BEACH_SCALE_ZR_M    = 300;  // ZR: 300m delta → beach score = 0
const BEACH_SCALE_AMAPAS_M = 400; // Amapas: 400m delta → beach score = 0
const SQFT_SCALE_ZR       = 0.75;
const SQFT_SCALE_AMAPAS   = 0.65; // tighter scale since size variance is larger
const RATING_SCALE        = 3.0;
const BEDROOM_MISMATCH_PENALTY = 12;
const MIN_BUILDING_PEERS  = 2;
const BUILDING_PREMIUM_CAP = 0.40; // ±40% maximum building adjustment
const MIN_POOL_SIZE        = 3;
const MIN_SAME_TIER_COMPS  = 3;    // prefer same-tier if ≥3 available
const MIN_COMPS            = 5;
const MAX_COMPS            = 10;

// Beach tier adjustment rates by neighborhood + tier.
// Applied to recommended price when the comp set contains MIXED beach tiers.
//
// ZR: Tier A commands ~90% premium over Tier B (observed: 2BR Tier A $340 vs Tier B $180;
//     3BR Tier A $505 vs Tier B $253). Tier C in ZR shows no consistent premium/discount.
// Amapas: Tier C (hillside) commands ~25-30% premium over Tier B (observed:
//     2BR $228 vs $175 = +30%; 3BR $350 vs $270 = +30%; 4BR $795 vs $695 = +14%).
//     No Tier A data in Amapas eligible pool.
// Other neighborhoods: use generic neutral adjustments (thin data, no calibrated premiums yet).
const BEACH_ADJ: Record<string, Record<BeachTier, number>> = {
  "Zona Romantica": { A: +0.90, B: 0, C: 0 },
  "Amapas":         { A: 0, B: 0, C: +0.25 },
  // Generic fallback for all other neighborhoods — no calibrated beach adjustment yet
  __default__:      { A: 0, B: 0, C: 0 },
};

function getBeachAdj(neighborhood: string, tier: BeachTier): number {
  return (BEACH_ADJ[neighborhood] ?? BEACH_ADJ.__default__)[tier] ?? 0;
}

// ── Building name normalization ───────────────────────────────────────────────

/**
 * Maps unit-specific or compound building names to their canonical complex name.
 * Built from inspection of all 118 eligible PVRPV listings.
 */
const BUILDING_ALIASES: Record<string, string> = {
  "Estrellita Del Mar 303 Star Light": "Estrellita Del Mar",
  "Estrellita Del Mar 202":            "Estrellita Del Mar",
  "Estrellita Del Mar 102":            "Estrellita Del Mar",
  "Paramount Bay Villa Serena":        "Paramount Bay",
  "Rincon De Almas 207 Rinconcillo":   "Rincon De Almas",
  "Rincon De Almas Casa Sammy":        "Rincon De Almas",
  "Molino De Agua 701 Beach House":    "Molino De Agua",
  "Loma Del Mar C9 Sofias Casa Del Sol": "Loma Del Mar",
  "Loma Del Mar A14":                  "Loma Del Mar",
  "Loma Del Mar B21":                  "Loma Del Mar",
  "Loma Del Mar D22":                  "Loma Del Mar",
  "Playa Bonita Casa De Los Abuelos":  "Playa Bonita",
  "Playa Bonita Apartamento Para Amigos": "Playa Bonita",
  "Playa Bonita Casa Amistosa":        "Playa Bonita",
  "Playa Bonita Casa De Risa":         "Playa Bonita",
  "Selva Romantica Casa Cameron":      "Selva Romantica",
  "Selva Romantica Casa Leone":        "Selva Romantica",
  "Selva Romantica Villa Del Cielo":   "Selva Romantica",
  "Selva Romantica Paraiso":           "Selva Romantica",
  "Selva Romantica Amazonas":          "Selva Romantica",
  "Selva Romantica Safari":            "Selva Romantica",
  "Sayan Tropical Suite":              "Sayan Tropical",
  "Andrew Christian Sayan Beach":      "Sayan Beach",
  "Sayan Beach Casa Marriott":         "Sayan Beach",
  "Orchid 7e La Maravilla De Orchid":  "Orchid",
  "Avalon Zen Treetop Retreat":        "Avalon Zen",
  "V177 Ph":                           "V177",
  "Pacifica 404 Casa Astro":           "Pacifica",
  "Rivera Cuale Casa Camartiz":        "Rivera Cuale",
};

export function normalizeBuildingName(raw: string | null): string | null {
  if (!raw) return null;
  return BUILDING_ALIASES[raw] ?? raw;
}

// ── Eligibility ───────────────────────────────────────────────────────────────

export function isEligibleV2(listing: CompsListingV2): boolean {
  if (listing.bedrooms < 1 || listing.bedrooms > 6) return false;
  if (listing.nightlyPriceUsd == null || listing.nightlyPriceUsd <= 0) return false;
  if (listing.nightlyPriceUsd > 5000) return false;
  if (listing.distanceToBeachM == null) return false;
  if (listing.sqft != null && listing.sqft < 200) return false;
  // ZR/Amapas (primary calibrated neighborhoods) keep the 0.85 bar;
  // other neighborhoods use 0.70 since some sources (Vacation Vallarta) yield fewer fields.
  const confThreshold = (listing.neighborhoodNormalized === "Zona Romantica" || listing.neighborhoodNormalized === "Amapas") ? 0.85 : 0.70;
  if (listing.dataConfidenceScore < confThreshold) return false;
  return true;
}

// ── Utility math ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sortedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const k of setA) { if (setB.has(k)) inter++; }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function iqrTrim(prices: number[], minKeep: number): { trimmed: number[]; removed: number } {
  if (prices.length <= minKeep) return { trimmed: prices, removed: 0 };
  const s = [...prices].sort((a, b) => a - b);
  const q1 = sortedPercentile(s, 25);
  const q3 = sortedPercentile(s, 75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const trimmed = s.filter((p) => p >= lo && p <= hi);
  if (trimmed.length < minKeep) return { trimmed: s.slice(0, minKeep), removed: 0 };
  return { trimmed, removed: s.length - trimmed.length };
}

// ── Feature derivation ────────────────────────────────────────────────────────

export function beachTier(distM: number): BeachTier {
  if (distM <= 100) return "A";
  if (distM <= 500) return "B";
  return "C";
}

function priceTierFromStats(price: number, stats: SegmentStats): PriceTier {
  if (price <= stats.p33) return "lower";
  if (price <= stats.p67) return "middle";
  return "upper";
}

// ── Pre-computation ───────────────────────────────────────────────────────────

function computeSegmentStats(listings: CompsListingV2[]): Map<string, SegmentStats> {
  const map = new Map<string, SegmentStats>();
  const groups = new Map<string, number[]>();

  for (const l of listings) {
    const key = `${l.neighborhoodNormalized}|${l.bedrooms}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l.nightlyPriceUsd);
  }

  for (const [key, prices] of groups) {
    const [neighborhood, brStr] = key.split("|");
    const sorted = [...prices].sort((a, b) => a - b);
    map.set(key, {
      neighborhoodNormalized: neighborhood,
      bedrooms: parseInt(brStr, 10),
      count: sorted.length,
      p25: sortedPercentile(sorted, 25),
      p33: sortedPercentile(sorted, 33),
      p50: sortedPercentile(sorted, 50),
      p67: sortedPercentile(sorted, 67),
      p75: sortedPercentile(sorted, 75),
    });
  }

  return map;
}

function computeBuildingSummaries(
  listings: CompsListingV2[],
  segmentStats: Map<string, SegmentStats>
): Map<string, BuildingSummary> {
  const map = new Map<string, BuildingSummary>();
  const groups = new Map<string, { prices: number[]; neighborhood: string; bedrooms: number }>();

  for (const l of listings) {
    const bn = normalizeBuildingName(l.buildingName);
    if (!bn) continue;
    const key = `${bn}|${l.neighborhoodNormalized}|${l.bedrooms}`;
    if (!groups.has(key)) groups.set(key, { prices: [], neighborhood: l.neighborhoodNormalized, bedrooms: l.bedrooms });
    groups.get(key)!.prices.push(l.nightlyPriceUsd);
  }

  for (const [key, { prices, neighborhood, bedrooms }] of groups) {
    if (prices.length < MIN_BUILDING_PEERS) continue;
    const [buildingName] = key.split("|");
    const sorted = [...prices].sort((a, b) => a - b);
    const bMedian = sortedPercentile(sorted, 50);
    const segKey = `${neighborhood}|${bedrooms}`;
    const seg = segmentStats.get(segKey);
    const segMedian = seg?.p50 ?? bMedian;
    const rawFactor = segMedian > 0 ? (bMedian / segMedian) - 1 : 0;
    const premiumFactor = clamp(rawFactor, -BUILDING_PREMIUM_CAP, BUILDING_PREMIUM_CAP);

    map.set(key, {
      buildingNameNormalized: buildingName,
      neighborhoodNormalized: neighborhood,
      bedrooms,
      count: prices.length,
      medianPrice: Math.round(bMedian),
      premiumFactor,
      rawPremiumFactor: rawFactor,
    });
  }

  return map;
}

// ── Effective weights ─────────────────────────────────────────────────────────

// Generic balanced weights for neighborhoods without calibrated data yet
// (Hotel Zone, Centro, 5 de Diciembre, Old Town, Versalles, Marina Vallarta)
const BASE_WEIGHTS_GENERIC: NeighborhoodWeights = {
  beachDistance:  15,
  amenities:      20,
  sqft:           20,
  bathrooms:      12,
  rating:         11,
  beachTierMatch: 10,
  priceTierMatch:  7,
  buildingMatch:   5,
};

function getEffectiveWeights(
  neighborhood: string,
  hasSqft: boolean,
  hasRating: boolean
): NeighborhoodWeights {
  let baseWeights: NeighborhoodWeights;
  if (neighborhood === "Zona Romantica") baseWeights = BASE_WEIGHTS_ZR;
  else if (neighborhood === "Amapas") baseWeights = BASE_WEIGHTS_AMAPAS;
  else baseWeights = BASE_WEIGHTS_GENERIC;
  const base = { ...baseWeights };

  if (!hasSqft) {
    const w = base.sqft;
    base.sqft = 0;
    base.beachDistance += Math.round(w * 0.6);
    base.bathrooms += Math.round(w * 0.4);
  }

  if (!hasRating) {
    const w = base.rating;
    base.rating = 0;
    base.amenities += Math.round(w * 0.6);
    base.beachTierMatch += Math.round(w * 0.4);
  }

  return base;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreCompV2(
  target: TargetPropertyV2,
  comp: CompsListingV2 & { buildingNameNormalized: string | null; beachTier: BeachTier; priceTier: PriceTier },
  targetBeachTier: BeachTier,
  targetPriceTier: PriceTier | null,
  targetBuildingNormalized: string | null,
  hasSqft: boolean,
  hasRating: boolean,
  bedroomMismatch: boolean
): ScoreBreakdownV2 {
  const nn = target.neighborhoodNormalized;
  const w = getEffectiveWeights(nn, hasSqft, hasRating);
  const beachScale = nn === "Zona Romantica" ? BEACH_SCALE_ZR_M
    : (nn === "Amapas" ? BEACH_SCALE_AMAPAS_M : BEACH_SCALE_ZR_M);
  const sqftScale  = nn === "Zona Romantica" ? SQFT_SCALE_ZR
    : (nn === "Amapas" ? SQFT_SCALE_AMAPAS : SQFT_SCALE_ZR);

  // Beach distance (continuous)
  const beachDelta = Math.abs(comp.distanceToBeachM - target.distanceToBeachM);
  const beachScore = clamp(1 - beachDelta / beachScale, 0, 1) * w.beachDistance;

  // sqft
  let sqftScore = 0;
  if (w.sqft > 0 && target.sqft != null && comp.sqft != null) {
    const delta = Math.abs(comp.sqft - target.sqft);
    sqftScore = clamp(1 - delta / (target.sqft * sqftScale), 0, 1) * w.sqft;
  }

  // Bathrooms
  const bathDiff = Math.abs(comp.bathrooms - target.bathrooms);
  let bathScore: number;
  if (bathDiff === 0)       bathScore = w.bathrooms;
  else if (bathDiff <= 0.5) bathScore = w.bathrooms * 0.67;
  else if (bathDiff <= 1)   bathScore = w.bathrooms * 0.33;
  else                       bathScore = 0;

  // Amenities (Jaccard)
  const amenityScore = jaccardSimilarity(target.amenitiesNormalized, comp.amenitiesNormalized) * w.amenities;

  // Rating
  let ratingScore = 0;
  if (w.rating > 0 && target.ratingOverall != null && comp.ratingOverall != null) {
    ratingScore = clamp(1 - Math.abs(comp.ratingOverall - target.ratingOverall) / RATING_SCALE, 0, 1) * w.rating;
  }

  // Beach tier match
  let beachTierScore = 0;
  if (comp.beachTier === targetBeachTier)                 beachTierScore = w.beachTierMatch;
  else if (Math.abs(comp.beachTier.charCodeAt(0) - targetBeachTier.charCodeAt(0)) === 1)
                                                           beachTierScore = w.beachTierMatch * 0.375; // 3/8
  // else cross-tier = 0

  // Price tier match
  let priceTierScore = 0;
  if (targetPriceTier != null) {
    const tiers = ["lower", "middle", "upper"];
    const tIdx = tiers.indexOf(targetPriceTier);
    const cIdx = tiers.indexOf(comp.priceTier);
    const dist = Math.abs(tIdx - cIdx);
    if (dist === 0)      priceTierScore = w.priceTierMatch;
    else if (dist === 1) priceTierScore = w.priceTierMatch * 0.4;
    // else cross = 0
  }

  // Building match
  let buildingScore = 0;
  if (
    targetBuildingNormalized &&
    comp.buildingNameNormalized &&
    targetBuildingNormalized === comp.buildingNameNormalized
  ) {
    buildingScore = w.buildingMatch;
  }

  // Bedroom mismatch penalty
  const bedroomPenalty = bedroomMismatch ? BEDROOM_MISMATCH_PENALTY : 0;

  const total = clamp(
    beachScore + sqftScore + bathScore + amenityScore + ratingScore +
    beachTierScore + priceTierScore + buildingScore - bedroomPenalty,
    0, 100
  );

  return {
    beachDistance:  parseFloat(beachScore.toFixed(1)),
    sqft:           parseFloat(sqftScore.toFixed(1)),
    bathrooms:      parseFloat(bathScore.toFixed(1)),
    amenities:      parseFloat(amenityScore.toFixed(1)),
    rating:         parseFloat(ratingScore.toFixed(1)),
    beachTierMatch: parseFloat(beachTierScore.toFixed(1)),
    priceTierMatch: parseFloat(priceTierScore.toFixed(1)),
    buildingMatch:  parseFloat(buildingScore.toFixed(1)),
    bedroomMismatch: -bedroomPenalty,
    total:          parseFloat(total.toFixed(1)),
    effectiveWeights: w,
  };
}

// ── Match reasons ─────────────────────────────────────────────────────────────

function buildMatchReasonsV2(
  target: TargetPropertyV2,
  comp: CompResultV2["listing"],
  breakdown: ScoreBreakdownV2,
  targetBeachTier: BeachTier,
  targetBuildingNormalized: string | null
): string[] {
  const reasons: string[] = [];
  reasons.push(`Same neighborhood: ${comp.neighborhoodNormalized}`);
  reasons.push(`Same bedrooms: ${comp.bedrooms}BR`);

  if (breakdown.buildingMatch > 0 && comp.buildingNameNormalized) {
    reasons.push(`Same building: ${comp.buildingNameNormalized}`);
  }

  if (comp.beachTier === targetBeachTier) {
    reasons.push(`Same beach tier: ${comp.beachTier} (${comp.distanceToBeachM}m)`);
  }

  if (target.sqft != null && comp.sqft != null) {
    const pct = Math.abs(comp.sqft - target.sqft) / target.sqft;
    if (pct <= 0.10) reasons.push(`Very similar size (${comp.sqft} vs ${target.sqft} ft²)`);
    else if (pct <= 0.25) reasons.push(`Similar size (${comp.sqft} vs ${target.sqft} ft²)`);
  }

  const bathDiff = Math.abs(comp.bathrooms - target.bathrooms);
  if (bathDiff === 0) reasons.push(`Same bathrooms: ${comp.bathrooms}BA`);

  const beachDelta = Math.abs(comp.distanceToBeachM - target.distanceToBeachM);
  if (beachDelta <= 50) reasons.push(`Very close beach distance (${comp.distanceToBeachM}m)`);

  if (breakdown.priceTierMatch >= 5) reasons.push(`Same price tier: ${comp.priceTier}`);

  if (breakdown.bedroomMismatch < 0) {
    reasons.push(`⚠ Expanded pool: ${comp.bedrooms}BR (target: ${target.bedrooms}BR)`);
  }

  return reasons;
}

// ── Price recommendation ──────────────────────────────────────────────────────

function buildRecommendationV2(
  comps: CompResultV2[],
  target: TargetPropertyV2,
  targetBeachTier: BeachTier,
  targetBuildingSummary: BuildingSummary | null,
  segmentStats: SegmentStats | null,
  mixedBeachTiers: boolean = false
): PriceRecommendationV2 {
  const allPrices = comps.map((c) => c.listing.nightlyPriceUsd).sort((a, b) => a - b);

  // IQR outlier trimming — SKIPPED for mixed-beach-tier comp sets.
  // When the pool contains comps from different beach tiers (by necessity, not choice),
  // same-tier comps may appear as statistical outliers relative to the dominant tier.
  // Trimming would remove the most relevant comp (e.g. the one Tier A comp in a Tier A target)
  // and leave only the cross-tier comps, making the beach-tier adjustment do all the work
  // without the anchor price it needs.
  const skipTrim = mixedBeachTiers;
  const { trimmed: trimmedPrices, removed } = skipTrim
    ? { trimmed: allPrices, removed: 0 }
    : iqrTrim(allPrices, MIN_COMPS);

  const baseMedian  = Math.round(sortedPercentile(trimmedPrices, 50));
  const basePct25   = Math.round(sortedPercentile(trimmedPrices, 25));
  const basePct75   = Math.round(sortedPercentile(trimmedPrices, 75));
  const avg         = Math.round(trimmedPrices.reduce((a, b) => a + b, 0) / trimmedPrices.length);

  let adjustedPrice = baseMedian;
  let buildingAdjPct: number | null = null;
  let beachAdjPct: number | null = null;
  const explanationParts: string[] = [];

  // --- Building adjustment ---
  // Two modes:
  //   A) Structural anchor: rawPremiumFactor > BUILDING_PREMIUM_CAP (building prices at a
  //      radically different level than the market — e.g. Molino de Agua 2BR at +185%
  //      above segment). Use the building median directly as the price anchor instead of
  //      inflating the comp median, which would be anchored to wrong-tier comps.
  //   B) Normal adjustment: apply capped factor to comp median.
  const targetBuildingPremiumFactor = targetBuildingSummary?.premiumFactor ?? null;
  const rawBuildingFactor = targetBuildingSummary?.rawPremiumFactor ?? null;
  const buildingMedian = targetBuildingSummary?.medianPrice ?? null;

  if (rawBuildingFactor != null && rawBuildingFactor > BUILDING_PREMIUM_CAP && buildingMedian != null) {
    // Mode A: Extreme positive premium — building median is the reliable anchor
    adjustedPrice = buildingMedian;
    buildingAdjPct = parseFloat((rawBuildingFactor * 100).toFixed(1));
    explanationParts.push(
      `Building median anchor: $${buildingMedian}/night ` +
      `(building +${buildingAdjPct}% above segment — direct anchor used, not comp inflation)`
    );
  } else if (targetBuildingPremiumFactor != null && Math.abs(targetBuildingPremiumFactor) >= 0.05) {
    // Mode B: Normal adjustment (factor is within the cap range or is a negative discount)
    const adjAmt = Math.round(baseMedian * targetBuildingPremiumFactor);
    adjustedPrice += adjAmt;
    buildingAdjPct = parseFloat((targetBuildingPremiumFactor * 100).toFixed(1));
    const dir = targetBuildingPremiumFactor > 0 ? "above" : "below";
    explanationParts.push(
      `Building premium ${buildingAdjPct > 0 ? "+" : ""}${buildingAdjPct}% (building prices consistently ${dir} segment median)`
    );
  }

  // --- Beach tier adjustment ---
  // Apply only if comp set is NOT already majority same-tier as target
  const compTiers = comps.map((c) => c.listing.beachTier);
  const sameTierCount = compTiers.filter((t) => t === targetBeachTier).length;
  const isCompSetMixedTiers = sameTierCount < comps.length * 0.6;

  if (isCompSetMixedTiers) {
    const beachAdj = getBeachAdj(target.neighborhoodNormalized, targetBeachTier);
    if (Math.abs(beachAdj) >= 0.05) {
      const adjAmt = Math.round(adjustedPrice * beachAdj);
      adjustedPrice += adjAmt;
      beachAdjPct = parseFloat((beachAdj * 100).toFixed(1));
      const tierLabel = targetBeachTier === "A"
        ? "beachfront" : targetBeachTier === "C"
        ? "hillside/elevated" : "mid-distance";
      explanationParts.push(
        `Beach tier ${targetBeachTier} adjustment ${beachAdj > 0 ? "+" : ""}${beachAdjPct}% (${tierLabel} premium for ${target.neighborhoodNormalized})`
      );
    }
  }

  if (explanationParts.length === 0) {
    explanationParts.push("Comp set median — no building or beach-tier adjustments applied");
  }

  const recommended = Math.round(adjustedPrice);
  const conservative = Math.min(basePct25, Math.round(recommended * 0.88));
  const stretch      = Math.max(basePct75, Math.round(recommended * 1.10));

  return {
    conservative,
    recommended,
    stretch,
    compCount:           trimmedPrices.length,
    trimmedOutlierCount: removed,
    avgCompPrice:        avg,
    medianCompPrice:     baseMedian,
    baseCompMedian:      baseMedian,
    buildingAdjustmentPct:  buildingAdjPct,
    beachTierAdjustmentPct: beachAdjPct,
    adjustmentExplanation: explanationParts.join(" | "),
    compPrices: trimmedPrices,
  };
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class CompsEngineV2 {
  private eligible: (CompsListingV2 & { buildingNameNormalized: string | null; beachTier: BeachTier })[];
  private segmentStats: Map<string, SegmentStats>;
  private buildingSummaries: Map<string, BuildingSummary>;

  constructor(allListings: CompsListingV2[]) {
    const raw = allListings.filter(isEligibleV2);

    // Normalize building names and assign beach tiers
    this.eligible = raw.map((l) => ({
      ...l,
      buildingNameNormalized: normalizeBuildingName(l.buildingName),
      beachTier: beachTier(l.distanceToBeachM),
    }));

    this.segmentStats = computeSegmentStats(raw);
    this.buildingSummaries = computeBuildingSummaries(raw, this.segmentStats);
  }

  get eligibleCount(): number { return this.eligible.length; }

  run(
    target: TargetPropertyV2,
    options: { excludeId?: number; minComps?: number; maxComps?: number } = {}
  ): CompsResultV2 {
    const { excludeId, minComps = MIN_COMPS, maxComps = MAX_COMPS } = options;

    const targetBeachTierVal = beachTier(target.distanceToBeachM);
    const targetBuildingNorm = normalizeBuildingName(target.buildingName ?? null);

    // Segment stats for target
    const segKey = `${target.neighborhoodNormalized}|${target.bedrooms}`;
    const segStats = this.segmentStats.get(segKey) ?? null;

    // Building premium factor for target
    const bKey = `${targetBuildingNorm}|${target.neighborhoodNormalized}|${target.bedrooms}`;
    const buildingSummary = this.buildingSummaries.get(bKey) ?? null;
    const targetBuildingPremiumFactor = buildingSummary?.premiumFactor ?? null;

    // Price tier for target — can only infer after initial scoring pass
    // We do a quick pre-pass to estimate target price tier from characteristics
    const targetPriceTier: PriceTier | null = null; // deferred — see below

    // Filter eligible pool for this target (same neighborhood, exclude self)
    const pool = this.eligible.filter(
      (l) => l.neighborhoodNormalized === target.neighborhoodNormalized &&
             (excludeId == null || l.id !== excludeId)
    );

    // ── Beach-tier-first pool selection ─────────────────────────────────────
    // Step 1: same bedrooms + same beach tier (most comparable)
    // Step 2: same bedrooms + neighborhood-safe adjacent tiers
    // Step 3: same bedrooms + all beach tiers (last resort)
    // Step 4: ±1 bedroom + all tiers (thin-market fallback)
    //
    // "Neighborhood-safe adjacent" prevents cross-market contamination:
    //   ZR: Tier A commands 90%+ premium over Tier B. For a Tier B/C target, never
    //       pull Tier A comps into the pool (they would inflate the median by 2×).
    //       For Tier B: adjacent = {B, C} only. For Tier C: adjacent = {C, B}.
    //   Amapas: Tier C commands 25-30% premium (hillside views). For Tier B target:
    //       adjacent = {B, C, A} — both directions are acceptable.
    //       For Tier A target: adjacent = {A, B} (no A data exists in practice).
    const bedroomSegment = pool.filter((l) => l.bedrooms === target.bedrooms);
    const sameBeachTier  = bedroomSegment.filter((l) => l.beachTier === targetBeachTierVal);

    function safeAdjacentTiers(tier: BeachTier, neighborhood: string): BeachTier[] {
      if (neighborhood === "Zona Romantica") {
        // Tier A is a structurally separate sub-market; never include it as "adjacent"
        // when the target is Tier B or Tier C.
        if (tier === "A") return ["A", "B"];     // A target can expand to B (lower, acceptable)
        if (tier === "B") return ["B", "C"];     // B target: avoid Tier A inflation
        return ["C", "B"];                        // C target: avoid Tier A inflation
      } else {
        // Amapas: Tier C is premium but Tier A is the rare low end; all are acceptable
        if (tier === "C") return ["C", "B"];     // C target: use C first, then B
        if (tier === "B") return ["B", "C", "A"];
        return ["A", "B"];
      }
    }

    const safeAdj = safeAdjacentTiers(targetBeachTierVal, target.neighborhoodNormalized);
    const adjacentPool = bedroomSegment.filter((l) => safeAdj.includes(l.beachTier));

    let segment: typeof this.eligible;
    let mixedBeachTiers = false;
    let expandedPool = false;

    if (sameBeachTier.length >= MIN_SAME_TIER_COMPS) {
      segment = sameBeachTier;                        // Step 1: pure same-tier pool
    } else if (adjacentPool.length >= MIN_POOL_SIZE) {
      segment = adjacentPool;                         // Step 2: safe adjacent pool
      mixedBeachTiers = sameBeachTier.length < adjacentPool.length;
    } else if (bedroomSegment.length >= MIN_POOL_SIZE) {
      segment = bedroomSegment;                       // Step 3: all tiers (contaminated)
      mixedBeachTiers = true;
    } else {
      // Step 4: ±1 BR fallback
      const expanded = pool.filter((l) => Math.abs(l.bedrooms - target.bedrooms) <= 1);
      segment = expanded;
      expandedPool = expanded.some((l) => l.bedrooms !== target.bedrooms);
      mixedBeachTiers = segment.some((l) => l.beachTier !== targetBeachTierVal);
    }

    // Assign price tier to each comp
    const segWithTier = segment.map((l) => {
      const sKey = `${l.neighborhoodNormalized}|${l.bedrooms}`;
      const s = this.segmentStats.get(sKey);
      const pt: PriceTier = s ? priceTierFromStats(l.nightlyPriceUsd, s) : "middle";
      return { ...l, priceTier: pt };
    });

    // hasSqft / hasRating for effective weight computation
    const hasSqft   = target.sqft != null;
    const hasRating  = target.ratingOverall != null && target.ratingOverall > 0;

    // --- PASS 1: Score all comps without price-tier preference ---
    const scoredPass1 = segWithTier.map((comp) => {
      const bedroomMismatch = comp.bedrooms !== target.bedrooms;
      const breakdown = scoreCompV2(
        target, comp, targetBeachTierVal, null /* no price tier yet */,
        targetBuildingNorm, hasSqft, hasRating, bedroomMismatch
      );
      return { comp, breakdown };
    });
    scoredPass1.sort((a, b) => b.breakdown.total - a.breakdown.total);
    const top10Pass1 = scoredPass1.slice(0, Math.max(minComps, Math.min(maxComps, scoredPass1.length)));

    // Infer target price tier from pass-1 median
    const pass1Prices = top10Pass1.map((s) => s.comp.nightlyPriceUsd);
    const pass1Median = pass1Prices.length > 0
      ? sortedPercentile([...pass1Prices].sort((a, b) => a - b), 50) : 0;
    const inferredPriceTier: PriceTier | null = segStats
      ? priceTierFromStats(pass1Median, segStats) : null;

    // --- PASS 2: Re-score with inferred price tier ---
    const scoredPass2 = segWithTier.map((comp) => {
      const bedroomMismatch = comp.bedrooms !== target.bedrooms;
      const breakdown = scoreCompV2(
        target, comp, targetBeachTierVal, inferredPriceTier,
        targetBuildingNorm, hasSqft, hasRating, bedroomMismatch
      );
      const reasons = buildMatchReasonsV2(
        target, { ...comp }, breakdown, targetBeachTierVal, targetBuildingNorm
      );
      return {
        listing: comp,
        score: breakdown.total,
        scoreBreakdown: breakdown,
        matchReasons: reasons,
      } as CompResultV2;
    });
    scoredPass2.sort((a, b) => b.score - a.score);
    const topN = scoredPass2.slice(0, Math.max(minComps, Math.min(maxComps, scoredPass2.length)));

    // Build recommendation
    const recommendation = buildRecommendationV2(
      topN, target, targetBeachTierVal,
      buildingSummary, segStats, mixedBeachTiers
    );

    return {
      target,
      targetBeachTier: targetBeachTierVal,
      targetPriceTier: inferredPriceTier,
      targetBuildingNormalized: targetBuildingNorm,
      targetBuildingPremiumFactor,
      segmentMedian: segStats?.p50 ?? null,
      eligiblePoolSize: this.eligible.length,
      segmentPoolSize: segment.length,
      expandedPool,
      comps: topN,
      recommendation,
    };
  }
}

// ── CLI formatting ────────────────────────────────────────────────────────────

export function formatCompsResultV2(
  result: CompsResultV2,
  targetLabel: string,
  actualPrice?: number
): string {
  const { target, comps, recommendation, expandedPool, segmentPoolSize } = result;
  const lines: string[] = [];

  const tierLabel = (t: BeachTier) => ({ A: "A≤100m", B: "B 101-500m", C: "C>500m" }[t]);

  lines.push(`\n${"═".repeat(76)}`);
  lines.push(`TARGET [V2]: ${targetLabel}`);
  lines.push(
    `  ${target.neighborhoodNormalized} | ${target.bedrooms}BR / ${target.bathrooms}BA` +
    ` | ${target.sqft != null ? `${target.sqft} ft²` : "sqft N/A"}` +
    ` | ${target.distanceToBeachM}m → Beach Tier ${tierLabel(result.targetBeachTier)}` +
    ` | Price Tier: ${result.targetPriceTier ?? "N/A"}`
  );
  if (result.targetBuildingNormalized) {
    const pf = result.targetBuildingPremiumFactor;
    const pfStr = pf != null ? ` (${pf > 0 ? "+" : ""}${(pf * 100).toFixed(0)}% vs segment)` : " (no peers)";
    lines.push(`  Building: ${result.targetBuildingNormalized}${pfStr}`);
  }
  if (actualPrice != null) lines.push(`  Actual price: $${actualPrice}/night`);
  lines.push(`  Comp pool: ${segmentPoolSize} listings${expandedPool ? " (±1BR expanded)" : ""}`);

  lines.push(`\n${"─".repeat(76)}`);
  lines.push(`TOP ${comps.length} COMPS:`);
  lines.push(`${"─".repeat(76)}`);

  for (let i = 0; i < comps.length; i++) {
    const c = comps[i];
    const l = c.listing;
    const bd = c.scoreBreakdown;
    lines.push(
      `\n  [${String(i + 1).padStart(2)}] Score: ${c.score.toFixed(1).padStart(5)}` +
      `  $${l.nightlyPriceUsd}/night  ${l.externalId}`
    );
    lines.push(
      `       ${l.neighborhoodNormalized} | ${l.bedrooms}BR/${l.bathrooms}BA` +
      ` | ${l.sqft != null ? `${l.sqft}ft²` : "sqft:N/A"}` +
      ` | ${l.distanceToBeachM}m (Tier ${l.beachTier})` +
      ` | ★ ${l.ratingOverall ?? "N/A"}` +
      ` | Tier:${l.priceTier}`
    );
    lines.push(
      `       beach=${bd.beachDistance} sqft=${bd.sqft} bath=${bd.bathrooms}` +
      ` amen=${bd.amenities} rating=${bd.rating}` +
      ` beachTier=${bd.beachTierMatch} priceTier=${bd.priceTierMatch}` +
      ` bldg=${bd.buildingMatch}` +
      (bd.bedroomMismatch < 0 ? ` BR_pen=${bd.bedroomMismatch}` : "")
    );
    for (const r of c.matchReasons) {
      lines.push(`       → ${r}`);
    }
  }

  lines.push(`\n${"─".repeat(76)}`);
  lines.push("RECOMMENDATION:");
  lines.push(`  Base comp median:    $${recommendation.baseCompMedian}/night  (${recommendation.compCount} comps, ${recommendation.trimmedOutlierCount} outlier(s) trimmed)`);
  if (recommendation.buildingAdjustmentPct != null) {
    lines.push(`  Building adjustment: ${recommendation.buildingAdjustmentPct > 0 ? "+" : ""}${recommendation.buildingAdjustmentPct}%`);
  }
  if (recommendation.beachTierAdjustmentPct != null) {
    lines.push(`  Beach tier adj:      ${recommendation.beachTierAdjustmentPct > 0 ? "+" : ""}${recommendation.beachTierAdjustmentPct}%`);
  }
  lines.push(`  Explanation:         ${recommendation.adjustmentExplanation}`);
  lines.push(`  Conservative (P25):  $${recommendation.conservative}/night`);
  lines.push(`  Recommended:         $${recommendation.recommended}/night`);
  lines.push(`  Stretch (P75):       $${recommendation.stretch}/night`);
  lines.push(`  Comp prices:         $${recommendation.compPrices.join(", $")}`);

  if (actualPrice != null) {
    const diff = recommendation.recommended - actualPrice;
    const pct  = ((diff / actualPrice) * 100).toFixed(1);
    const inRange = actualPrice >= recommendation.conservative && actualPrice <= recommendation.stretch;
    const flag = Math.abs(parseFloat(pct)) > 25 ? " ⚠" : Math.abs(parseFloat(pct)) > 15 ? " △" : " ✓";
    lines.push(
      `\n  V2 vs actual: ${diff >= 0 ? "+" : ""}${diff} (${pct}% ${diff >= 0 ? "above" : "below"} actual)${flag}` +
      `  In range: ${inRange ? "Yes" : "No"}`
    );
  }

  lines.push("═".repeat(76));
  return lines.join("\n");
}
