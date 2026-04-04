/**
 * POST /api/rental/comps
 * ─────────────────────────────────────────────────────────────────────────────
 * V3.1 comps endpoint — adds finish quality, private pool, large terrace,
 * seasonal sweep, building context, and positioning statement.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { rentalListingsTable } from "@workspace/db/schema";
import {
  CompsEngineV3,
  type TargetPropertyV3,
  type ViewType,
  type YearBuiltRange,
  type FinishQuality,
} from "../lib/comps-engine-v3";
import { type CompsListingV2, type CompResultV2, type BeachTier } from "../lib/comps-engine-v2";
import { lookupBuilding } from "../lib/building-lookup";
import { PV_MONTHLY_FACTORS } from "../lib/pv-seasonality";

const router: IRouter = Router();

// ── Engine singleton ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;

let engineCache: {
  engine: CompsEngineV3;
  builtAt: number;
  listingCount: number;
} | null = null;

async function getEngine(): Promise<{ engine: CompsEngineV3; listingCount: number }> {
  const now = Date.now();
  if (engineCache && now - engineCache.builtAt < CACHE_TTL_MS) {
    return { engine: engineCache.engine, listingCount: engineCache.listingCount };
  }

  const rows = await db.select().from(rentalListingsTable);

  const listings: CompsListingV2[] = rows
    .filter(r =>
      r.nightlyPriceUsd != null &&
      r.distanceToBeachM != null &&
      r.neighborhoodNormalized != null
    )
    .map(r => ({
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

  const engine = new CompsEngineV3(listings);
  engineCache = { engine, builtAt: now, listingCount: listings.length };
  return { engine, listingCount: listings.length };
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
  confidence: ConfidenceLabel,
  beachTier: BeachTier
): string[] {
  const w: string[] = [];
  if (confidence === "guidance_only") {
    w.push(`Pool too thin (${poolSize} comps) for a reliable recommendation. Result is directional guidance only.`);
  } else if (confidence === "low") {
    w.push(`Thin comp pool (${poolSize} comps). Use the P25–P75 range, not the point estimate.`);
  }
  if (expandedPool) {
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

/** Compute seasonal sweep from a non-seasonal base price */
function computeSeasonalSweep(nonSeasonalBase: number) {
  // Representative month multipliers
  const lowMulti      = PV_MONTHLY_FACTORS.find(m => m.month === 9)!.multiplier;  // Sep 0.68
  const shoulderMulti = PV_MONTHLY_FACTORS.find(m => m.month === 10)!.multiplier; // Oct 0.88
  const highMulti     = PV_MONTHLY_FACTORS.find(m => m.month === 11)!.multiplier; // Nov 1.00
  const peakMulti     = PV_MONTHLY_FACTORS.find(m => m.month === 3)!.multiplier;  // Mar 1.20

  return {
    low:      Math.round(nonSeasonalBase * lowMulti),
    shoulder: Math.round(nonSeasonalBase * shoulderMulti),
    high:     Math.round(nonSeasonalBase * highMulti),
    peak:     Math.round(nonSeasonalBase * peakMulti),
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

  req.log.info({
    neighborhood: input.neighborhood_normalized,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    month: input.month,
    view_type: input.view_type,
    rooftop_pool: input.rooftop_pool,
    finish_quality: input.finish_quality,
    private_plunge_pool: input.private_plunge_pool,
    large_terrace: input.large_terrace,
  }, "comps v3.1 request");

  try {
    const { engine, listingCount } = await getEngine();

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

    const target: TargetPropertyV3 = {
      neighborhoodNormalized: input.neighborhood_normalized,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      sqft: input.sqft ?? null,
      distanceToBeachM: input.distance_to_beach_m,
      amenitiesNormalized: input.amenities_normalized,
      ratingOverall: input.rating_overall ?? null,
      buildingName: resolvedBuildingName,
      month: input.month,
      viewType: input.view_type as ViewType,
      rooftopPool: input.rooftop_pool,
      yearBuilt: input.year_built as YearBuiltRange,
      finishQuality: input.finish_quality as FinishQuality,
      privatePlungePool: input.private_plunge_pool,
      largeTerrace: input.large_terrace,
    };

    const result = engine.run(target);
    const { comps, expandedPool } = result;
    const poolSize = comps.length;
    const confidence = confidenceLabel(poolSize);

    req.log.info({
      pool_size: poolSize, confidence,
      conservative: result.conservative,
      recommended: result.recommended,
      stretch: result.stretch,
    }, "v3.1 comps recommendation");

    const warnings = [
      ...buildingResolutionWarnings,
      ...buildWarnings(input, poolSize, expandedPool, confidence, result.targetBeachTier),
    ];

    // ── Seasonal sweep ────────────────────────────────────────────────────────
    const nonSeasonalBase = result.totalAdjustmentMultiplier > 0
      ? result.recommended / result.seasonalContext.totalMultiplier
      : result.recommended;
    const seasonalSweep = confidence !== "guidance_only"
      ? computeSeasonalSweep(nonSeasonalBase)
      : null;

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
      top_drivers: extractTopDrivers(c),
    }));

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
    const explanation = [
      `Recommendation based on ${poolSize} comparable listings in ${input.neighborhood_normalized}.`,
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
        month: input.month,
        view_type: input.view_type,
        rooftop_pool: input.rooftop_pool,
        finish_quality: input.finish_quality,
        private_plunge_pool: input.private_plunge_pool,
        large_terrace: input.large_terrace,
      },

      pool_size: poolSize,
      thin_pool_warning: thinPoolWarning,
      expanded_pool: expandedPool,
      confidence_label: confidence,

      conservative_price: confidence === "guidance_only" ? null : result.conservative,
      recommended_price:  confidence === "guidance_only" ? null : result.recommended,
      stretch_price:      confidence === "guidance_only" ? null : result.stretch,

      base_comp_median: result.baseCompMedian,
      building_adjustment_pct: result.buildingAdjustmentPct,
      beach_tier_adjustment_pct: result.beachTierAdjustmentPct,

      pricing_breakdown: result.pricingBreakdown,
      total_adjustment_multiplier: parseFloat(result.totalAdjustmentMultiplier.toFixed(4)),

      seasonal: {
        month: result.seasonalContext.month,
        month_name: result.seasonalContext.monthName,
        season: result.seasonalContext.season,
        monthly_multiplier: result.seasonalContext.monthlyMultiplier,
        monthly_note: result.seasonalContext.monthlyNote,
        event_name: result.seasonalContext.activeEvent?.name ?? null,
        event_premium_pct: result.seasonalContext.eventPremiumPct != null
          ? parseFloat((result.seasonalContext.eventPremiumPct * 100).toFixed(1)) : null,
        total_multiplier: parseFloat(result.seasonalContext.totalMultiplier.toFixed(4)),
        display_label: result.seasonalContext.displayLabel,
      },

      // New V3.1 fields
      seasonal_sweep: seasonalSweep,
      building_context: buildingContext,
      positioning_statement: buildingContext?.positioning_statement ?? globalPositioningStatement,

      selected_comps: selectedComps,
      top_drivers: topDriversOverall,
      explanation,
      warnings,
      model_limitations: modelLimitations,
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    req.log.error({ err }, "Failed to run comps engine");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
