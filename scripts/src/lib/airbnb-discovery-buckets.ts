/**
 * scripts/src/lib/airbnb-discovery-buckets.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bucketed search-space slicing for the residential discovery runner.
 *
 * Airbnb's search results page caps at ~280–500 cards per query. A single
 * "Puerto Vallarta" search can never exhaust the long tail. To cover the
 * market we cross-product:
 *
 *   neighborhood × bedroom band × price band  →  ~200 buckets
 *
 * Each bucket is iterated up to 5 search pages by the runner, so a full sweep
 * touches ~1,000 page fetches at 5–8s pacing ≈ 1.5–2.5 hours per pass per
 * bucket subset, ~24 hours for a full sweep.
 *
 * This module is pure (no I/O). All callers receive immutable bucket objects.
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

/** Build the full cross-product of buckets. Returns 200 bucket objects. */
export function buildBuckets(): DiscoveryBucket[] {
  const out: DiscoveryBucket[] = [];
  for (const cfg of NEIGHBORHOODS) {
    for (const bb of BEDROOM_BANDS) {
      for (const pb of PRICE_BANDS) {
        const bedroom = bedroomQuery(bb);
        const price = priceQuery(pb);
        const searchUrl = buildBucketUrl(cfg, bedroom, price);
        out.push({
          bucketId: `${cfg.key}__${bb}__${pb}`,
          neighborhoodKey: cfg.key,
          bedroomBand: bb,
          priceBand: pb,
          searchUrl,
          parentRegionBucket: cfg.parentRegionBucket,
          normalizedNeighborhoodBucket: cfg.normalizedNeighborhoodBucket,
        });
      }
    }
  }
  return out;
}
