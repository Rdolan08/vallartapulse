/**
 * neighborhood-buckets.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pricing-tool-aligned neighborhood bucketing layer for the STR ingestion
 * pipeline (Phase 1).
 *
 * This sits ON TOP of the existing canonical normalization in
 * `rental-normalize.ts`. The canonical layer (Zona Romantica, Centro,
 * Hotel Zone, ...) is preserved unchanged. This layer rolls those canonicals
 * up into the product-facing buckets used by the VallartaPulse pricing tool.
 *
 * Pure / deterministic / no I/O. Safe to call from any ingestion phase.
 */

import {
  normalizeNeighborhood,
  type CanonicalNeighborhood,
} from "./rental-normalize";

// ─────────────────────────────────────────────────────────────────────────────
// Pricing-tool neighborhood buckets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Top-priority Puerto Vallarta buckets — these get the deepest and most
 * frequent discovery coverage. Order is roughly inventory-priority order.
 */
export const PV_BUCKETS = [
  "Zona Romántica",
  "Amapas / Conchas Chinas",
  "Centro / Alta Vista",
  "Hotel Zone / Malecón",
  "5 de Diciembre",
  "Old Town",
  "Versalles",
  "Marina Vallarta",
  "Mismaloya",
] as const;

/**
 * Secondary Riviera Nayarit buckets — supported but with lower frequency
 * and shallower depth than PV. Must NEVER blend into PV pricing medians.
 */
export const RN_BUCKETS = [
  "Nuevo Vallarta",
  "Bucerías",
  "La Cruz de Huanacaxtle",
  "Punta Mita",
  "El Anclote",
  "Sayulita",
  "San Pancho",
] as const;

export const PRICING_TOOL_BUCKETS = [...PV_BUCKETS, ...RN_BUCKETS] as const;

export type PvBucket = (typeof PV_BUCKETS)[number];
export type RnBucket = (typeof RN_BUCKETS)[number];
export type PricingToolBucket = (typeof PRICING_TOOL_BUCKETS)[number];

export type ParentRegion = "puerto_vallarta" | "riviera_nayarit";

export const PARENT_REGION_BY_BUCKET: Record<PricingToolBucket, ParentRegion> = {
  "Zona Romántica": "puerto_vallarta",
  "Amapas / Conchas Chinas": "puerto_vallarta",
  "Centro / Alta Vista": "puerto_vallarta",
  "Hotel Zone / Malecón": "puerto_vallarta",
  "5 de Diciembre": "puerto_vallarta",
  "Old Town": "puerto_vallarta",
  "Versalles": "puerto_vallarta",
  "Marina Vallarta": "puerto_vallarta",
  "Mismaloya": "puerto_vallarta",
  "Nuevo Vallarta": "riviera_nayarit",
  "Bucerías": "riviera_nayarit",
  "La Cruz de Huanacaxtle": "riviera_nayarit",
  "Punta Mita": "riviera_nayarit",
  "El Anclote": "riviera_nayarit",
  "Sayulita": "riviera_nayarit",
  "San Pancho": "riviera_nayarit",
};

// ─────────────────────────────────────────────────────────────────────────────
// Canonical → pricing-tool bucket mapping
// ─────────────────────────────────────────────────────────────────────────────
//
// The existing canonical normalizer returns one of CANONICAL_NEIGHBORHOODS.
// This map lifts each canonical into its pricing-tool bucket. A canonical with
// no entry here has no clean pricing-tool home (e.g. Pitillal, Fluvial Vallarta
// — residential / inland and not part of the pricing-tool product surface).

export const CANONICAL_TO_PRICING_BUCKET: Partial<
  Record<CanonicalNeighborhood, PricingToolBucket>
> = {
  // ── PV ─────────────────────────────────────────────────────────────────────
  "Zona Romantica": "Zona Romántica",
  "Amapas": "Amapas / Conchas Chinas",
  "Mismaloya": "Mismaloya",
  "Old Town": "Old Town",
  "Centro": "Centro / Alta Vista",
  "5 de Diciembre": "5 de Diciembre",
  "Hotel Zone": "Hotel Zone / Malecón",
  "Versalles": "Versalles",
  "Marina Vallarta": "Marina Vallarta",
  // Pitillal + Fluvial Vallarta intentionally omitted — residential/inland,
  // not part of the pricing-tool surface.

  // ── RN ─────────────────────────────────────────────────────────────────────
  "Nuevo Vallarta": "Nuevo Vallarta",
  "Bucerias": "Bucerías",
  "La Cruz de Huanacaxtle": "La Cruz de Huanacaxtle",
  "Punta Mita": "Punta Mita",
  "El Anclote": "El Anclote",
  "Sayulita": "Sayulita",
  "San Pancho": "San Pancho",
};

// ─────────────────────────────────────────────────────────────────────────────
// Mapping confidence
// ─────────────────────────────────────────────────────────────────────────────

export type MappingConfidence = "exact" | "high" | "inferred" | "unknown";

export interface NeighborhoodBucketMapping {
  /** The raw input string, preserved verbatim (after trim only). */
  rawText: string;
  /** Canonical-layer name from rental-normalize, if matched. */
  canonical: CanonicalNeighborhood | null;
  /** Pricing-tool bucket, if the canonical maps cleanly. */
  pricingToolBucket: PricingToolBucket | null;
  /** "puerto_vallarta" | "riviera_nayarit" — null when bucket is unknown. */
  parentRegion: ParentRegion | null;
  /**
   * Confidence:
   *   "exact"    — raw string was a direct alias of a canonical that maps to a bucket
   *   "high"     — raw string normalized via the alias map; canonical maps to a bucket
   *   "inferred" — partial substring match against canonical aliases (fuzzy)
   *   "unknown"  — could not map to any bucket
   */
  confidence: MappingConfidence;
}

const PV_HINTS = [
  "puerto vallarta",
  "vallarta, jalisco",
  "jalisco",
  "pv,",
  "pv ",
];
const RN_HINTS = [
  "riviera nayarit",
  "nayarit",
  "bahia de banderas",
  "bahía de banderas",
];

/**
 * Maps a raw source location string into the pricing-tool bucket layer.
 *
 * Priority:
 *   1. Try exact alias normalization → canonical → bucket.
 *   2. Fall back to substring scan over canonical aliases (inferred).
 *   3. If no canonical, fall back to PV/RN parent-region hints.
 *
 * NEVER throws. Always returns a result with explicit confidence.
 */
export function mapToPricingToolBucket(
  rawText: string | null | undefined
): NeighborhoodBucketMapping {
  const raw = (rawText ?? "").trim();
  const empty: NeighborhoodBucketMapping = {
    rawText: raw,
    canonical: null,
    pricingToolBucket: null,
    parentRegion: null,
    confidence: "unknown",
  };
  if (!raw) return empty;

  // 1. Exact alias normalization
  const canonical = normalizeNeighborhood(raw);
  if (canonical) {
    const bucket = CANONICAL_TO_PRICING_BUCKET[canonical] ?? null;
    if (bucket) {
      return {
        rawText: raw,
        canonical,
        pricingToolBucket: bucket,
        parentRegion: PARENT_REGION_BY_BUCKET[bucket],
        confidence: "exact",
      };
    }
    // Canonical matched but isn't part of the pricing-tool surface
    // (e.g. Pitillal). Still useful — record canonical, leave bucket null.
    return {
      rawText: raw,
      canonical,
      pricingToolBucket: null,
      parentRegion: parentRegionFromHints(raw),
      confidence: "high",
    };
  }

  // 2. Substring inference: scan raw text for any bucket name fragment
  const lower = raw.toLowerCase();
  for (const bucket of PRICING_TOOL_BUCKETS) {
    // Each bucket has 1–2 distinguishing tokens worth checking
    const tokens = bucketTokens(bucket);
    for (const token of tokens) {
      if (lower.includes(token)) {
        return {
          rawText: raw,
          canonical: null,
          pricingToolBucket: bucket,
          parentRegion: PARENT_REGION_BY_BUCKET[bucket],
          confidence: "inferred",
        };
      }
    }
  }

  // 3. Region-only hint
  const region = parentRegionFromHints(raw);
  if (region) {
    return {
      rawText: raw,
      canonical: null,
      pricingToolBucket: null,
      parentRegion: region,
      confidence: "inferred",
    };
  }

  return empty;
}

function parentRegionFromHints(raw: string): ParentRegion | null {
  const lower = raw.toLowerCase();
  if (RN_HINTS.some((h) => lower.includes(h))) return "riviera_nayarit";
  if (PV_HINTS.some((h) => lower.includes(h))) return "puerto_vallarta";
  return null;
}

/** Distinguishing tokens for fuzzy substring matching against raw location text. */
function bucketTokens(bucket: PricingToolBucket): string[] {
  switch (bucket) {
    case "Zona Romántica":
      return ["zona romántica", "zona romantica", "romantic zone"];
    case "Amapas / Conchas Chinas":
      return ["amapas", "conchas chinas"];
    case "Centro / Alta Vista":
      return ["el centro", "centro vallarta", "alta vista", "downtown vallarta"];
    case "Hotel Zone / Malecón":
      return ["hotel zone", "zona hotelera", "malecón", "malecon", "las glorias"];
    case "5 de Diciembre":
      return ["5 de diciembre", "cinco de diciembre", "5-de-diciembre"];
    case "Old Town":
      return ["old town"];
    case "Versalles":
      return ["versalles", "versailles"];
    case "Marina Vallarta":
      return ["marina vallarta"];
    case "Mismaloya":
      return ["mismaloya", "boca de tomatlán", "boca de tomatlan", "yelapa"];
    case "Nuevo Vallarta":
      return ["nuevo vallarta", "nuevo-vallarta"];
    case "Bucerías":
      return ["bucerías", "bucerias"];
    case "La Cruz de Huanacaxtle":
      return ["la cruz de huanacaxtle", "la cruz", "huanacaxtle"];
    case "Punta Mita":
      return ["punta mita", "punta de mita"];
    case "El Anclote":
      return ["el anclote", "anclote"];
    case "Sayulita":
      return ["sayulita"];
    case "San Pancho":
      return ["san pancho", "san francisco, nayarit"];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery seed weighting (Phase 2 will consume this)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Suggested discovery priority weights. Higher = run first / more often.
 * Phase 2's seed generator + scheduler should read these values rather than
 * hard-coding their own ordering, so priority can be adjusted in one place.
 *
 * Calibrated so that PV always outranks RN, and tourist-dense PV
 * neighborhoods (Zona Romántica, Centro / Alta Vista, Hotel Zone)
 * outrank residential/peripheral PV areas.
 */
export const BUCKET_PRIORITY: Record<PricingToolBucket, number> = {
  // PV — top tier
  "Zona Romántica": 100,
  "Amapas / Conchas Chinas": 95,
  "Centro / Alta Vista": 90,
  "Hotel Zone / Malecón": 85,
  "5 de Diciembre": 80,
  "Old Town": 80,
  "Marina Vallarta": 75,
  "Versalles": 60,
  "Mismaloya": 55,
  // RN — secondary tier
  "Nuevo Vallarta": 40,
  "Bucerías": 35,
  "La Cruz de Huanacaxtle": 30,
  "Punta Mita": 30,
  "Sayulita": 25,
  "San Pancho": 20,
  "El Anclote": 20,
};
