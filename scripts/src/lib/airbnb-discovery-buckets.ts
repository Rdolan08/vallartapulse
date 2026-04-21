/**
 * scripts/src/lib/airbnb-discovery-buckets.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiered + ordered bucket generation for the residential discovery runner.
 *
 * Airbnb's search results page caps at ~280–500 cards per query. A single
 * "Puerto Vallarta" search can never exhaust the long tail. To cover the
 * market we cross-product:
 *
 *   neighborhood × bedroom band × price band  →  200 buckets total
 *
 * The first full residential-IP sweep proved the pipeline works end-to-end
 * (4259 candidates → 1089 new inserts in ~5.5 hours). It also proved most of
 * those buckets are low-yield: 5BR+ across the board, 4BR under_100/100_200,
 * and Bucerías returned almost nothing. Running all 200 daily wastes IP
 * budget and pushes useful inventory past the first hour of the run.
 *
 * Production policy (consolidated 2026-04) is therefore tiered:
 *
 *   TIER 1 — daily, high-yield core              ≈ 77 buckets
 *   TIER 2 — 2–3× per week, mid-yield wider net  ≈ 14 NEW buckets
 *   TIER 3 — weekly or manual; everything else   ≈ 109 buckets
 *
 * A bucket only carries the LOWEST tier it qualifies for, so T1 wins over T2
 * which wins over T3 — no double-counting. Within a tier, buckets are sorted
 * by an explicit executionRank so the highest-yield slices (zona_romantica
 * 1–3BR @ 100–400 USD) run inside the first 10–15 minutes of the run.
 *
 * Selection at runtime is via the DISCOVERY_TIER env var (handled in the
 * runner). This module is pure (no I/O). Callers receive immutable bucket
 * objects already sorted by (tier asc, executionRank asc).
 */

export type NeighborhoodKey =
  | "zona_romantica"
  | "amapas"
  | "conchas_chinas"
  | "centro"
  | "cinco_de_diciembre"
  | "versalles"
  | "fluvial"
  | "marina_vallarta"
  | "nuevo_vallarta"
  | "bucerias";

export type BedroomBand = "1" | "2" | "3" | "4" | "5_plus";

export type PriceBand = "under_100" | "100_200" | "200_400" | "400_plus";

export type Tier = 1 | 2 | 3;

export interface DiscoveryBucket {
  /** Stable, filename-safe identifier. */
  bucketId: string;
  neighborhoodKey: NeighborhoodKey;
  bedroomBand: BedroomBand;
  priceBand: PriceBand;
  /** Page-1 search URL. Used for the run log + replay. */
  searchUrl: string;
  /** Pricing-tool top-level region bucket. */
  parentRegionBucket: "puerto_vallarta" | "riviera_nayarit";
  /** Display name aligned with rental-normalize PRICING_TOOL_BUCKETS. */
  normalizedNeighborhoodBucket: string;
  /**
   * Tier this bucket belongs to. A bucket carries the LOWEST tier it
   * qualifies for (T1 wins over T2 wins over T3) so the cross-product never
   * double-counts a bucket across tiers. See module header for the policy.
   */
  tier: Tier;
  /**
   * Lower = run earlier within the tier. Used by the runner to surface
   * highest-yield buckets in the first 10–15 minutes. Comparable across
   * tiers (already biased by the tier number) so a single sort by
   * executionRank produces the canonical execution order for any tier
   * subset.
   */
  executionRank: number;
}

interface NeighborhoodConfig {
  key: NeighborhoodKey;
  /** Slug used in /s/{slug}/homes URL — exactly as Airbnb encodes it. */
  airbnbSlug: string;
  parentRegionBucket: "puerto_vallarta" | "riviera_nayarit";
  /** Display label aligned with the rest of the platform's normalization. */
  normalizedNeighborhoodBucket: string;
}

const NEIGHBORHOODS: readonly NeighborhoodConfig[] = [
  {
    key: "zona_romantica",
    airbnbSlug: "Zona-Romantica--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Zona Romantica",
  },
  {
    key: "amapas",
    airbnbSlug: "Amapas--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Amapas",
  },
  {
    key: "conchas_chinas",
    airbnbSlug: "Conchas-Chinas--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Conchas Chinas",
  },
  {
    key: "centro",
    airbnbSlug: "Centro--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Centro",
  },
  {
    key: "cinco_de_diciembre",
    airbnbSlug: "5-de-Diciembre--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "5 de Diciembre",
  },
  {
    key: "versalles",
    airbnbSlug: "Versalles--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Versalles",
  },
  {
    key: "fluvial",
    airbnbSlug: "Fluvial-Vallarta--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Fluvial",
  },
  {
    key: "marina_vallarta",
    airbnbSlug: "Marina-Vallarta--Puerto-Vallarta--Mexico",
    parentRegionBucket: "puerto_vallarta",
    normalizedNeighborhoodBucket: "Marina Vallarta",
  },
  {
    key: "nuevo_vallarta",
    airbnbSlug: "Nuevo-Vallarta--Nayarit--Mexico",
    parentRegionBucket: "riviera_nayarit",
    normalizedNeighborhoodBucket: "Nuevo Vallarta",
  },
  {
    key: "bucerias",
    airbnbSlug: "Bucerias--Nayarit--Mexico",
    parentRegionBucket: "riviera_nayarit",
    normalizedNeighborhoodBucket: "Bucerias",
  },
];

const BEDROOM_BANDS: readonly BedroomBand[] = ["1", "2", "3", "4", "5_plus"];
const PRICE_BANDS: readonly PriceBand[] = [
  "under_100",
  "100_200",
  "200_400",
  "400_plus",
];

interface BedroomQuery {
  minBedrooms: number;
  maxBedrooms: number | null;
}

function bedroomQuery(band: BedroomBand): BedroomQuery {
  switch (band) {
    case "1":
      return { minBedrooms: 1, maxBedrooms: 1 };
    case "2":
      return { minBedrooms: 2, maxBedrooms: 2 };
    case "3":
      return { minBedrooms: 3, maxBedrooms: 3 };
    case "4":
      return { minBedrooms: 4, maxBedrooms: 4 };
    case "5_plus":
      return { minBedrooms: 5, maxBedrooms: null };
  }
}

interface PriceQuery {
  priceMin: number | null;
  priceMax: number | null;
}

function priceQuery(band: PriceBand): PriceQuery {
  switch (band) {
    case "under_100":
      return { priceMin: null, priceMax: 100 };
    case "100_200":
      return { priceMin: 100, priceMax: 200 };
    case "200_400":
      return { priceMin: 200, priceMax: 400 };
    case "400_plus":
      return { priceMin: 400, priceMax: null };
  }
}

/** Build the page-N URL for a bucket. Page index is 0-based (Airbnb uses items_offset). */
export function buildSearchUrl(bucket: DiscoveryBucket, page: number): string {
  const url = new URL(bucket.searchUrl);
  if (page > 0) {
    // Airbnb paginates with items_offset = page * 18 (one card-grid page).
    url.searchParams.set("items_offset", String(page * 18));
  }
  return url.toString();
}

function buildBucketUrl(
  cfg: NeighborhoodConfig,
  bedroom: BedroomQuery,
  price: PriceQuery
): string {
  const url = new URL(`https://www.airbnb.com/s/${cfg.airbnbSlug}/homes`);
  url.searchParams.set("min_bedrooms", String(bedroom.minBedrooms));
  if (bedroom.maxBedrooms !== null) {
    url.searchParams.set("max_bedrooms", String(bedroom.maxBedrooms));
  }
  if (price.priceMin !== null) {
    url.searchParams.set("price_min", String(price.priceMin));
  }
  if (price.priceMax !== null) {
    url.searchParams.set("price_max", String(price.priceMax));
  }
  // Restrict to whole-property listings (vacation rentals) — drops shared
  // rooms / private rooms / hotel rooms at the search layer.
  url.searchParams.set("room_types[]", "Entire home/apt");
  return url.toString();
}

// ── Tier classification ─────────────────────────────────────────────────────

const TIER_1_NEIGHBORHOODS: ReadonlySet<NeighborhoodKey> = new Set([
  "zona_romantica",
  "centro",
  "versalles",
  "fluvial",
  "marina_vallarta",
  "nuevo_vallarta",
  "amapas",
]);

const TIER_2_NEIGHBORHOODS: ReadonlySet<NeighborhoodKey> = new Set([
  "conchas_chinas",
  "amapas",
  "marina_vallarta",
  "centro",
  "versalles",
  "fluvial",
]);

/**
 * Tier 1 spec — daily, high-yield core.
 *
 *   T1_NEIGHBORHOODS × {1,2,3} × {100_200, 200_400, 400_plus}   = 7×3×3 = 63
 *   T1_NEIGHBORHOODS × {1,2}   × {under_100}                    = 7×2×1 = 14
 *                                                                       = 77
 *
 * The under_100 carve-out for 1BR/2BR only is empirical: the first full
 * sweep showed 3BR/4BR/5+ at under_100 USD almost never produce inserts
 * (mismatched expectation — at that bedroom count owners price higher).
 */
function matchesTier1(b: { neighborhoodKey: NeighborhoodKey; bedroomBand: BedroomBand; priceBand: PriceBand }): boolean {
  if (!TIER_1_NEIGHBORHOODS.has(b.neighborhoodKey)) return false;
  if (b.priceBand === "under_100") {
    return b.bedroomBand === "1" || b.bedroomBand === "2";
  }
  if (b.priceBand === "100_200" || b.priceBand === "200_400" || b.priceBand === "400_plus") {
    return b.bedroomBand === "1" || b.bedroomBand === "2" || b.bedroomBand === "3";
  }
  return false;
}

/**
 * Tier 2 spec — 2–3× per week, mid-yield wider net.
 *
 *   T2_NEIGHBORHOODS × {3,4} × {200_400, 400_plus}              = 6×2×2 = 24
 *
 * Of those 24, 12 are already in T1 (the 6 nbhds × 3BR × {200_400, 400_plus}
 * intersect the T1 main grid). After dedup, T2 contributes ~14 NET-new
 * buckets — primarily the 4BR rows for the 6 wider-net neighborhoods plus
 * the 3BR rows for conchas_chinas (which isn't in T1 at all).
 */
function matchesTier2(b: { neighborhoodKey: NeighborhoodKey; bedroomBand: BedroomBand; priceBand: PriceBand }): boolean {
  if (!TIER_2_NEIGHBORHOODS.has(b.neighborhoodKey)) return false;
  if (b.bedroomBand !== "3" && b.bedroomBand !== "4") return false;
  if (b.priceBand !== "200_400" && b.priceBand !== "400_plus") return false;
  return true;
}

function classifyTier(b: { neighborhoodKey: NeighborhoodKey; bedroomBand: BedroomBand; priceBand: PriceBand }): Tier {
  if (matchesTier1(b)) return 1;
  if (matchesTier2(b)) return 2;
  return 3;
}

// ── Execution ordering ──────────────────────────────────────────────────────
//
// The user-specified "run earliest" list, modeled as ordered priority groups.
// Each group is a sub-product of (neighborhoods × bedrooms × prices). The
// group's index in PRIORITY_GROUPS determines its base rank, so buckets in
// group 0 run before buckets in group 1, etc.
//
// Buckets that don't match any priority group fall through to a deterministic
// rank biased by (tier, neighborhood, bedrooms, price) so within-tier ordering
// is still stable across runs.

interface PriorityGroup {
  nbhds: readonly NeighborhoodKey[];
  bbs: readonly BedroomBand[];
  pbs: readonly PriceBand[];
}

const PRIORITY_GROUPS: readonly PriorityGroup[] = [
  // 1. Zona Romántica core — proven highest yield
  { nbhds: ["zona_romantica"], bbs: ["1", "2", "3"], pbs: ["100_200", "200_400"] },
  // 2. Zona Romántica edges (1BR only at the extremes)
  { nbhds: ["zona_romantica"], bbs: ["1"], pbs: ["under_100", "400_plus"] },
  // 3. Versalles 1–2BR low-to-mid bands
  { nbhds: ["versalles"], bbs: ["1", "2"], pbs: ["under_100", "100_200", "200_400"] },
  // 4. Fluvial 1–2BR low-to-mid bands
  { nbhds: ["fluvial"], bbs: ["1", "2"], pbs: ["under_100", "100_200", "200_400"] },
  // 5. Marina Vallarta 1–2BR mid-to-high bands
  { nbhds: ["marina_vallarta"], bbs: ["1", "2"], pbs: ["100_200", "200_400", "400_plus"] },
  // 6. Nuevo Vallarta 1–2BR mid-to-high bands
  { nbhds: ["nuevo_vallarta"], bbs: ["1", "2"], pbs: ["100_200", "200_400", "400_plus"] },
  // 7. Centro 1–2BR low-to-mid bands
  { nbhds: ["centro"], bbs: ["1", "2"], pbs: ["under_100", "100_200", "200_400"] },
  // 8. Amapas 1–2BR mid bands
  { nbhds: ["amapas"], bbs: ["1", "2"], pbs: ["100_200", "200_400"] },
];

function priorityGroupIndex(b: { neighborhoodKey: NeighborhoodKey; bedroomBand: BedroomBand; priceBand: PriceBand }): number {
  for (let i = 0; i < PRIORITY_GROUPS.length; i++) {
    const g = PRIORITY_GROUPS[i];
    if (g.nbhds.includes(b.neighborhoodKey) &&
        g.bbs.includes(b.bedroomBand) &&
        g.pbs.includes(b.priceBand)) {
      return i;
    }
  }
  return -1;
}

/**
 * Compute the executionRank for a bucket. Lower = run earlier.
 *
 * Ranking layers (lower wins):
 *   - Priority groups: 0..(PRIORITY_GROUPS.length - 1)         → ranks 0..7
 *   - Tier 1 fill:    1000 + nbhdIdx*100 + bbIdx*10 + pbIdx   → ranks 1000..1999
 *   - Tier 2 fill:    2000 + ...                               → ranks 2000..2999
 *   - Tier 3 fill:    3000 + ...                               → ranks 3000..3999
 *
 * The biases ensure any tier subset still sorts correctly by executionRank.
 */
function computeExecutionRank(
  b: { neighborhoodKey: NeighborhoodKey; bedroomBand: BedroomBand; priceBand: PriceBand },
  tier: Tier,
): number {
  const pri = priorityGroupIndex(b);
  if (pri >= 0) return pri;
  const nbhdIdx = NEIGHBORHOODS.findIndex((n) => n.key === b.neighborhoodKey);
  const bbIdx = BEDROOM_BANDS.indexOf(b.bedroomBand);
  const pbIdx = PRICE_BANDS.indexOf(b.priceBand);
  return tier * 1000 + nbhdIdx * 100 + bbIdx * 10 + pbIdx;
}

// ── Public generator ────────────────────────────────────────────────────────

/**
 * Build the full cross-product of buckets (200 total), tagged with tier
 * and executionRank, sorted by (executionRank asc).
 *
 * The runner consumes this in order and may filter by tier via the
 * DISCOVERY_TIER env var. Sorting once here means callers never need to
 * sort again — a `slice(0, n)` on the returned array always gives the
 * top-n highest-priority buckets within the selected tier subset.
 */
export function buildBuckets(): DiscoveryBucket[] {
  const out: DiscoveryBucket[] = [];
  for (const cfg of NEIGHBORHOODS) {
    for (const bb of BEDROOM_BANDS) {
      for (const pb of PRICE_BANDS) {
        const bedroom = bedroomQuery(bb);
        const price = priceQuery(pb);
        const searchUrl = buildBucketUrl(cfg, bedroom, price);
        const partial = {
          neighborhoodKey: cfg.key,
          bedroomBand: bb,
          priceBand: pb,
        };
        const tier = classifyTier(partial);
        const executionRank = computeExecutionRank(partial, tier);
        out.push({
          bucketId: `${cfg.key}__${bb}__${pb}`,
          neighborhoodKey: cfg.key,
          bedroomBand: bb,
          priceBand: pb,
          searchUrl,
          parentRegionBucket: cfg.parentRegionBucket,
          normalizedNeighborhoodBucket: cfg.normalizedNeighborhoodBucket,
          tier,
          executionRank,
        });
      }
    }
  }
  out.sort((a, b) => a.executionRank - b.executionRank);
  return out;
}

/**
 * Convenience: filter a built bucket list to a specific tier or tier set.
 * Pass `"all"` (or omit) to return everything. Order is preserved.
 */
export function filterBucketsByTier(
  buckets: readonly DiscoveryBucket[],
  tiers: ReadonlySet<Tier> | "all",
): DiscoveryBucket[] {
  if (tiers === "all") return [...buckets];
  return buckets.filter((b) => tiers.has(b.tier));
}

/**
 * Parse a DISCOVERY_TIER env value into a Set<Tier> | "all".
 *
 * Accepts:
 *   undefined | "" | "all"   → "all"
 *   "1"                      → {1}
 *   "1,2"                    → {1, 2}
 *   "1,2,3"                  → {1, 2, 3}  (equivalent to "all")
 *
 * Throws on malformed input rather than silently selecting nothing — fail
 * fast is more useful than a zero-bucket run.
 */
export function parseTierEnv(raw: string | undefined): ReadonlySet<Tier> | "all" {
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "all") return "all";
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = new Set<Tier>();
  for (const p of parts) {
    if (p === "1") out.add(1);
    else if (p === "2") out.add(2);
    else if (p === "3") out.add(3);
    else {
      throw new Error(
        `DISCOVERY_TIER: invalid tier "${p}". Expected one of "1", "2", "3", "all", or a comma-separated list (e.g. "1,2"). Got "${raw}".`,
      );
    }
  }
  if (out.size === 0) {
    throw new Error(`DISCOVERY_TIER="${raw}" parsed to zero tiers.`);
  }
  return out;
}
