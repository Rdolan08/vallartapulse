/**
 * POST /api/rental/comps
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal MVP comps endpoint — V2 engine, PVRPV dataset only.
 *
 * Returns a comparable-property price recommendation for a submitted property
 * spec. This is NOT a market-wide estimate; it is calibrated against the ~118
 * eligible PVRPV listings in Zona Romantica and Amapas only.
 *
 * Confidence labels:
 *   high   → pool_size ≥ 8 (full comp set, IQR trimming active)
 *   medium → pool_size 5–7 (adequate, point estimate reliable)
 *   low    → pool_size 3–4 (thin — use P25–P75 range, not point estimate)
 *   guidance_only → pool_size < 3 (no recommendation issued)
 *
 * Caching: engine is built once per cold-start and refreshed every 5 minutes.
 * The engine ingests all eligible DB rows at construction time, so the
 * marginal cost of each comps request is scoring only (~2ms).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { rentalListingsTable } from "@workspace/db/schema";
import {
  CompsEngineV2,
  type CompsListingV2,
  type TargetPropertyV2,
  type CompResultV2,
  type BeachTier,
} from "../lib/comps-engine-v2";
import { lookupBuilding } from "../lib/building-lookup";

const router: IRouter = Router();

// ── Engine singleton (refreshed every CACHE_TTL_MS) ──────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let engineCache: {
  engine: CompsEngineV2;
  builtAt: number;
  listingCount: number;
} | null = null;

async function getEngine(): Promise<{ engine: CompsEngineV2; listingCount: number }> {
  const now = Date.now();
  if (engineCache && now - engineCache.builtAt < CACHE_TTL_MS) {
    return { engine: engineCache.engine, listingCount: engineCache.listingCount };
  }

  const rows = await db
    .select()
    .from(rentalListingsTable);

  const listings: CompsListingV2[] = rows
    .filter((r) =>
      r.nightlyPriceUsd != null &&
      r.distanceToBeachM != null &&
      r.neighborhoodNormalized != null
    )
    .map((r) => ({
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
      nightlyPriceUsd: parseFloat(String(r.nightlyPriceUsd!)),
      buildingName: r.buildingName ?? null,
      dataConfidenceScore: parseFloat(String(r.dataConfidenceScore)),
    }));

  const engine = new CompsEngineV2(listings);
  engineCache = { engine, builtAt: now, listingCount: listings.length };
  return { engine, listingCount: listings.length };
}

// ── Request schema ────────────────────────────────────────────────────────────

const SUPPORTED_NEIGHBORHOODS = [
  "Zona Romantica",
  "Amapas",
  "Centro",
  "Hotel Zone",
  "5 de Diciembre",
  "Old Town",
  "Versalles",
  "Marina Vallarta",
  "Nuevo Vallarta",
  "Bucerias",
  "La Cruz de Huanacaxtle",
  "Punta Mita",
  "El Anclote",
  "Sayulita",
  "San Pancho",
  "Mismaloya",
] as const;

const CompsRequestSchema = z.object({
  neighborhood_normalized: z.enum(SUPPORTED_NEIGHBORHOODS, {
    errorMap: () => ({
      message: `neighborhood_normalized must be one of: ${SUPPORTED_NEIGHBORHOODS.join(", ")}`,
    }),
  }),
  bedrooms: z.number().int().min(1).max(6, {
    message: "bedrooms must be 1–6 (engine supports 1–6BR)",
  }),
  bathrooms: z.number().min(0.5).max(8),
  sqft: z.number().min(100).max(10000).optional().nullable(),
  distance_to_beach_m: z.number().min(0).max(5000),
  amenities_normalized: z.array(z.string()).default([]),
  rating_overall: z.number().min(1).max(5).optional().nullable(),
  building_name: z.string().optional().nullable(),
});

type CompsRequest = z.infer<typeof CompsRequestSchema>;

// ── Confidence labeling ───────────────────────────────────────────────────────

type ConfidenceLabel = "high" | "medium" | "low" | "guidance_only";

function confidenceLabel(poolSize: number): ConfidenceLabel {
  if (poolSize >= 8) return "high";
  if (poolSize >= 5) return "medium";
  if (poolSize >= 3) return "low";
  return "guidance_only";
}

// ── Top-driver extraction ─────────────────────────────────────────────────────

function extractTopDrivers(comp: CompResultV2, neighborhood: string): string[] {
  const bd = comp.scoreBreakdown;
  const drivers: { label: string; score: number }[] = [
    { label: "beach_distance",    score: bd.beachDistance },
    { label: "amenities",         score: bd.amenities },
    { label: "sqft",              score: bd.sqft },
    { label: "bathrooms",         score: bd.bathrooms },
    { label: "rating",            score: bd.rating },
    { label: "beach_tier",        score: bd.beachTierMatch },
    { label: "price_tier",        score: bd.priceTierMatch },
    { label: "building",          score: bd.buildingMatch },
  ];
  return drivers
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((d) => d.label);
}

// ── Warning generation ────────────────────────────────────────────────────────

function buildWarnings(
  input: CompsRequest,
  poolSize: number,
  expandedPool: boolean,
  confidence: ConfidenceLabel,
  beachTier: BeachTier,
): string[] {
  const warnings: string[] = [];

  if (confidence === "guidance_only") {
    warnings.push(
      `Pool too thin (${poolSize} comps) for a reliable recommendation. ` +
      "Result is directional guidance only. Expand eligibility or use segment median."
    );
  } else if (confidence === "low") {
    warnings.push(
      `Thin comp pool (${poolSize} comps). Use the P25–P75 range, not the point estimate.`
    );
  }

  if (expandedPool) {
    warnings.push(
      "Comp pool expanded to ±1 bedroom because the same-bedroom segment is too small. " +
      "Prices may not reflect your exact bedroom count."
    );
  }

  if (input.neighborhood_normalized === "Amapas" && input.bedrooms >= 3) {
    warnings.push(
      `Amapas ${input.bedrooms}BR segment has fewer than 8 listings. ` +
      "Statistical noise is high — treat the range as more reliable than the point estimate."
    );
  }

  if (input.neighborhood_normalized === "Zona Romantica" && beachTier === "A") {
    warnings.push(
      "ZR Tier A (≤100m beachfront) is a structurally separate sub-market from Tier B. " +
      "The model applies a +90% beach adjustment when comps are cross-tier — " +
      "verify this reflects the current Molino de Agua / beachfront market."
    );
  }

  if (!input.sqft) {
    warnings.push(
      "sqft not provided. Size similarity scoring is skipped and weight redistributed to " +
      "beach distance and bathrooms. Results may be less precise."
    );
  }

  if (!input.rating_overall) {
    warnings.push(
      "rating_overall not provided. Rating similarity scoring is skipped."
    );
  }

  return warnings;
}

// ── Route handler ─────────────────────────────────────────────────────────────

router.post("/rental/comps", async (req, res) => {
  const parsed = CompsRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request payload",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const input = parsed.data;

  req.log.info(
    {
      neighborhood: input.neighborhood_normalized,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft: input.sqft ?? null,
      distance_to_beach_m: input.distance_to_beach_m,
      amenity_count: input.amenities_normalized.length,
      has_rating: input.rating_overall != null,
      has_building: input.building_name != null,
    },
    "comps request received"
  );

  try {
    const { engine, listingCount } = await getEngine();

    // Building name resolution: fuzzy-match raw input to canonical building name.
    // High/medium confidence matches are used automatically (with a warning for medium).
    // Low-confidence matches are dropped to avoid building-premium contamination.
    let resolvedBuildingName: string | null = input.building_name ?? null;
    const buildingResolutionWarnings: string[] = [];

    if (input.building_name) {
      const bLookup = lookupBuilding(
        input.building_name,
        input.neighborhood_normalized
      );
      if (bLookup.match && bLookup.match.confidence_tier !== "low") {
        resolvedBuildingName = bLookup.match.canonical_building_name;
        if (bLookup.match.confidence_tier === "medium") {
          buildingResolutionWarnings.push(
            `Building name "${input.building_name}" partially matched to "${resolvedBuildingName}" ` +
            `(${Math.round(bLookup.match.match_confidence * 100)}% confidence). ` +
            "Use POST /api/rental/comps/prepare to confirm."
          );
        }
        if (bLookup.match.neighborhood_normalized !== input.neighborhood_normalized) {
          resolvedBuildingName = null;
          buildingResolutionWarnings.push(
            `Building "${bLookup.match.canonical_building_name}" is in ${bLookup.match.neighborhood_normalized}, ` +
            `not ${input.neighborhood_normalized}. Building premium will not be applied.`
          );
        }
      } else if (bLookup.match && bLookup.match.confidence_tier === "low") {
        resolvedBuildingName = null;
        buildingResolutionWarnings.push(
          `Building name "${input.building_name}" could not be confidently matched. ` +
          "Building premium not applied. Use POST /api/rental/comps/prepare for resolution."
        );
      } else {
        resolvedBuildingName = null;
        buildingResolutionWarnings.push(
          bLookup.warning ??
          `Building name "${input.building_name}" not recognized. Building premium not applied.`
        );
      }
    }

    const target: TargetPropertyV2 = {
      neighborhoodNormalized: input.neighborhood_normalized,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft: input.sqft ?? null,
      distanceToBeachM: input.distance_to_beach_m,
      amenitiesNormalized: input.amenities_normalized,
      ratingOverall: input.rating_overall ?? null,
      buildingName: resolvedBuildingName,
    };

    const result = engine.run(target);
    const { recommendation, comps, expandedPool } = result;
    const poolSize = comps.length;
    const confidence = confidenceLabel(poolSize);

    req.log.info(
      {
        pool_size: poolSize,
        confidence,
        conservative: recommendation.conservative,
        recommended: recommendation.recommended,
        stretch: recommendation.stretch,
        building_adj_pct: recommendation.buildingAdjustmentPct,
        beach_adj_pct: recommendation.beachTierAdjustmentPct,
      },
      "comps recommendation generated"
    );

    const warnings = [
      ...buildingResolutionWarnings,
      ...buildWarnings(input, poolSize, expandedPool, confidence, result.targetBeachTier),
    ];

    const thinPoolWarning = confidence === "guidance_only" || confidence === "low";

    const selectedComps = comps.slice(0, 10).map((c, i) => ({
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
      nightly_price_usd: c.listing.nightlyPriceUsd,
      rating_overall: c.listing.ratingOverall,
      building_name: c.listing.buildingNameNormalized,
      score: parseFloat(c.score.toFixed(1)),
      match_reasons: c.matchReasons,
      top_drivers: extractTopDrivers(c, input.neighborhood_normalized),
      score_breakdown: {
        beach_distance:   parseFloat(c.scoreBreakdown.beachDistance.toFixed(1)),
        sqft:             parseFloat(c.scoreBreakdown.sqft.toFixed(1)),
        bathrooms:        parseFloat(c.scoreBreakdown.bathrooms.toFixed(1)),
        amenities:        parseFloat(c.scoreBreakdown.amenities.toFixed(1)),
        rating:           parseFloat(c.scoreBreakdown.rating.toFixed(1)),
        beach_tier_match: parseFloat(c.scoreBreakdown.beachTierMatch.toFixed(1)),
        price_tier_match: parseFloat(c.scoreBreakdown.priceTierMatch.toFixed(1)),
        building_match:   parseFloat(c.scoreBreakdown.buildingMatch.toFixed(1)),
        bedroom_mismatch: parseFloat(c.scoreBreakdown.bedroomMismatch.toFixed(1)),
        total:            parseFloat(c.scoreBreakdown.total.toFixed(1)),
      },
    }));

    const topDriversOverall = selectedComps.length > 0
      ? Object.entries(
          selectedComps.flatMap((c) => c.top_drivers).reduce<Record<string, number>>((acc, d) => {
            acc[d] = (acc[d] ?? 0) + 1;
            return acc;
          }, {})
        )
          .sort(([, a], [, b]) => b - a)
          .slice(0, 4)
          .map(([label]) => label)
      : [];

    const explanationParts: string[] = [
      `Recommendation based on ${poolSize} comparable listings in ${input.neighborhood_normalized}.`,
      recommendation.adjustmentExplanation,
      "Data scope: multi-source (PVRPV, Vacation Vallarta, Airbnb, VRBO). Not a full-market estimate.",
    ];

    if (recommendation.trimmedOutlierCount > 0) {
      explanationParts.push(
        `${recommendation.trimmedOutlierCount} statistical outlier(s) trimmed before pricing.`
      );
    }

    const modelLimitations = [
      "Single-rate scraping: rates reflect the listed baseline, not seasonal peaks or minimums.",
      "Multi-source dataset: PVRPV, Vacation Vallarta, Airbnb, VRBO. Coverage varies by neighborhood.",
      "Building prestige signals (design quality, concierge) are partially captured via building premium factor.",
      "Promotional/loyalty rates at the low end create irreducible overestimation errors.",
      "Calibrated weights for Hotel Zone, Centro, 5 de Dic, Versalles, Marina are in development — thin pool warnings expected.",
    ];

    const response = {
      model_version: "v2.1",
      source_scope: `Multi-source (PVRPV + Vacation Vallarta + Airbnb + VRBO) — ${input.neighborhood_normalized}`,
      eligible_listing_count: engine.eligibleCount,
      db_listing_count: listingCount,

      eligibility_status: confidence === "guidance_only" ? "guidance_only" : "eligible",

      target_summary: {
        neighborhood: result.target.neighborhoodNormalized,
        bedrooms: result.target.bedrooms,
        bathrooms: result.target.bathrooms,
        sqft: result.target.sqft,
        distance_to_beach_m: result.target.distanceToBeachM,
        beach_tier: result.targetBeachTier,
        price_tier: result.targetPriceTier,
        building_normalized: result.targetBuildingNormalized,
        building_premium_pct:
          result.targetBuildingPremiumFactor != null
            ? parseFloat((result.targetBuildingPremiumFactor * 100).toFixed(1))
            : null,
        segment_median: result.segmentMedian,
      },

      pool_size: poolSize,
      thin_pool_warning: thinPoolWarning,
      expanded_pool: expandedPool,
      confidence_label: confidence,

      conservative_price: confidence === "guidance_only" ? null : recommendation.conservative,
      recommended_price:  confidence === "guidance_only" ? null : recommendation.recommended,
      stretch_price:      confidence === "guidance_only" ? null : recommendation.stretch,

      comp_prices: recommendation.compPrices,
      base_comp_median: recommendation.baseCompMedian,
      building_adjustment_pct: recommendation.buildingAdjustmentPct,
      beach_tier_adjustment_pct: recommendation.beachTierAdjustmentPct,
      trimmed_outlier_count: recommendation.trimmedOutlierCount,

      selected_comps: selectedComps,
      top_drivers: topDriversOverall,

      explanation: explanationParts.join(" "),
      warnings,
      model_limitations: modelLimitations,

      generated_at: new Date().toISOString(),
    };

    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to run comps engine");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
