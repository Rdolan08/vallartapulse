/**
 * comps-engine-v3.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VallartaPulse Pricing Engine — Version 3
 *
 * Version:   3.0 — April 2026
 * Changes from V2:
 *   1. 7-layer pricing stack with per-layer breakdown
 *   2. Seasonality: monthly multiplier + event overlay (pv-seasonality.ts)
 *   3. View type premium: ocean +20%, partial +10%, city +2%, garden 0%, none −2%
 *   4. Rooftop pool premium: +12% vs standard pool, +15% vs no pool
 *   5. Quality adjustment: from guest rating + approximate year built
 *   6. Extended CompsResult with pricing_breakdown object
 *
 * LAYER ORDER (applied to baseCompMedian sequentially):
 *   1. Base comp median           (from v2 IQR-trimmed comp set)
 *   2. Building anchor            (from v2 building premium factor)
 *   3. Beach tier                 (from v2 neighborhood-aware beach bucket)
 *   4. Seasonal                   (monthly multiplier × event premium)
 *   5. View premium               (ocean / partial / city / garden / none)
 *   6. Rooftop pool               (if rooftop_pool = true)
 *   7. Quality                    (rating + year built)
 *   8. Guardrails                 (clamp 0.5×–2.5× base)
 *
 * Conservative / stretch are derived from the v2 comp P25/P75, then scaled
 * by the same total adjustment multiplier so the spread is preserved.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  CompsEngineV2,
  type CompsListingV2,
  type TargetPropertyV2,
  type CompResultV2,
  type BeachTier,
} from "./comps-engine-v2";
import { getSeasonalContext, type SeasonalContext } from "./pv-seasonality";

// ── View type ─────────────────────────────────────────────────────────────────

export type ViewType = "ocean" | "partial" | "city" | "garden" | "none";

const VIEW_PREMIUM: Record<ViewType, number> = {
  ocean:   0.20,
  partial: 0.10,
  city:    0.02,
  garden:  0.00,
  none:   -0.02,
};

// ── Year built ranges → quality factor ───────────────────────────────────────

export type YearBuiltRange =
  | "2020+"
  | "2015-2019"
  | "2010-2014"
  | "2000-2009"
  | "1990-1999"
  | "pre-1990"
  | "";

const YEAR_BUILT_FACTOR: Record<string, number> = {
  "2020+":     0.04,
  "2015-2019": 0.015,
  "2010-2014": 0.00,
  "2000-2009": -0.01,
  "1990-1999": -0.025,
  "pre-1990":  -0.05,
  "":           0.00,
};

// ── Per-layer breakdown ───────────────────────────────────────────────────────

export interface PricingLayer {
  layer: string;
  label: string;
  factor: number | null;     // multiplier applied (e.g. 1.20 = +20%), null if not applicable
  adjustment_pct: number | null; // factored as percentage change from previous step
  cumulative_price: number;  // running recommended price after this layer
  applied: boolean;          // false = layer skipped / not applicable
  note: string;
}

// ── Extended target ───────────────────────────────────────────────────────────

export interface TargetPropertyV3 extends TargetPropertyV2 {
  month: number;              // 1–12
  viewType: ViewType;
  rooftopPool: boolean;
  yearBuilt: YearBuiltRange;
}

// ── Extended result ───────────────────────────────────────────────────────────

export interface CompsResultV3 {
  // V2 passthrough
  comps: CompResultV2[];
  expandedPool: boolean;
  targetBeachTier: BeachTier;
  targetPriceTier: "low" | "mid" | "high" | null;
  targetBuildingNormalized: string | null;
  targetBuildingPremiumFactor: number | null;
  segmentMedian: number;
  target: TargetPropertyV2;

  // V2 base pricing (before v3 layers)
  baseCompMedian: number;
  v2Conservative: number;
  v2Stretch: number;
  buildingAdjustmentPct: number | null;
  beachTierAdjustmentPct: number | null;

  // V3 pricing breakdown
  seasonalContext: SeasonalContext;
  pricingBreakdown: PricingLayer[];

  // Final output
  conservative: number;
  recommended: number;
  stretch: number;

  // Adjustment summary
  totalAdjustmentMultiplier: number;  // product of all layer factors
  adjustmentExplanation: string;
}

// ── Quality score computation ─────────────────────────────────────────────────

function computeQualityFactor(
  rating: number | null,
  yearBuilt: YearBuiltRange
): { factor: number; ratingNote: string; yearNote: string } {
  let ratingFactor = 0;
  let ratingNote = "No guest rating — neutral";

  if (rating != null) {
    if (rating >= 4.9)      { ratingFactor = 0.04;  ratingNote = `${rating} ★ — exceptional (top 5%)`;   }
    else if (rating >= 4.7) { ratingFactor = 0.02;  ratingNote = `${rating} ★ — excellent`;               }
    else if (rating >= 4.3) { ratingFactor = 0.00;  ratingNote = `${rating} ★ — strong (neutral)`;        }
    else if (rating >= 3.8) { ratingFactor = -0.03; ratingNote = `${rating} ★ — below average`;           }
    else                    { ratingFactor = -0.06; ratingNote = `${rating} ★ — poor rating, significant discount`; }
  }

  const yearFactor = YEAR_BUILT_FACTOR[yearBuilt] ?? 0;
  const yearNote = yearBuilt
    ? `${yearBuilt} build: ${yearFactor >= 0 ? "+" : ""}${(yearFactor * 100).toFixed(1)}%`
    : "Build year unknown — neutral";

  return {
    factor: ratingFactor + yearFactor,
    ratingNote,
    yearNote,
  };
}

// ── Rooftop pool premium computation ─────────────────────────────────────────

function computeRooftopPoolFactor(
  rooftopPool: boolean,
  amenities: string[]
): { factor: number; note: string } {
  if (!rooftopPool) return { factor: 0, note: "No rooftop pool" };

  const hasStandardPool = amenities.some(a =>
    a === "pool" || a === "shared_pool" || a === "private_pool"
  );

  if (hasStandardPool) {
    return {
      factor: 0.12,
      note: "Rooftop pool: +12% premium over standard pool comps",
    };
  }
  return {
    factor: 0.15,
    note: "Rooftop pool (no standard pool): +15% premium",
  };
}

// ── Main V3 Engine ────────────────────────────────────────────────────────────

export class CompsEngineV3 {
  private v2Engine: CompsEngineV2;

  get eligibleCount(): number {
    return this.v2Engine.eligibleCount;
  }

  constructor(listings: CompsListingV2[]) {
    this.v2Engine = new CompsEngineV2(listings);
  }

  run(target: TargetPropertyV3): CompsResultV3 {
    // ── 1. Run v2 engine for comp selection ──────────────────────────────────
    const v2Result = this.v2Engine.run(target);
    const { recommendation, comps, expandedPool } = v2Result;

    const baseCompMedian = recommendation.baseCompMedian;
    const v2Conservative = recommendation.conservative;
    const v2Stretch      = recommendation.stretch;

    // ── 2. Seasonal layer ────────────────────────────────────────────────────
    const seasonal = getSeasonalContext(target.month);

    // ── 3. View premium layer ────────────────────────────────────────────────
    const viewFactor = VIEW_PREMIUM[target.viewType];

    // ── 4. Rooftop pool layer ─────────────────────────────────────────────────
    const { factor: rooftopFactor, note: rooftopNote } =
      computeRooftopPoolFactor(target.rooftopPool, target.amenitiesNormalized);

    // ── 5. Quality layer ──────────────────────────────────────────────────────
    const { factor: qualityFactor, ratingNote, yearNote } =
      computeQualityFactor(target.ratingOverall, target.yearBuilt);

    // ── 6. Building + beach tier (from v2, re-expressed as factors) ───────────
    const buildingFactor =
      recommendation.buildingAdjustmentPct != null
        ? recommendation.buildingAdjustmentPct / 100
        : 0;
    const beachFactor =
      recommendation.beachTierAdjustmentPct != null
        ? recommendation.beachTierAdjustmentPct / 100
        : 0;

    // ── 7. Apply layers sequentially ─────────────────────────────────────────
    const layers: PricingLayer[] = [];
    let price = baseCompMedian;

    // Layer 0: Base comp median (no factor)
    layers.push({
      layer: "base_comp_median",
      label: "Comp Set Median",
      factor: null,
      adjustment_pct: null,
      cumulative_price: Math.round(price),
      applied: true,
      note: `IQR-trimmed P50 of ${comps.length} comparable listings`,
    });

    // Layer 1: Building anchor
    const afterBuilding = price * (1 + buildingFactor);
    layers.push({
      layer: "building_anchor",
      label: "Building Premium",
      factor: buildingFactor !== 0 ? (1 + buildingFactor) : null,
      adjustment_pct: buildingFactor !== 0 ? parseFloat((buildingFactor * 100).toFixed(1)) : null,
      cumulative_price: Math.round(afterBuilding),
      applied: buildingFactor !== 0,
      note: buildingFactor !== 0
        ? `${target.buildingName ?? "Building"}: ${buildingFactor >= 0 ? "+" : ""}${(buildingFactor * 100).toFixed(1)}%`
        : "No building premium — general comps",
    });
    price = afterBuilding;

    // Layer 2: Beach tier
    const afterBeach = price * (1 + beachFactor);
    layers.push({
      layer: "beach_tier",
      label: "Beach Tier Adjustment",
      factor: beachFactor !== 0 ? (1 + beachFactor) : null,
      adjustment_pct: beachFactor !== 0 ? parseFloat((beachFactor * 100).toFixed(1)) : null,
      cumulative_price: Math.round(afterBeach),
      applied: beachFactor !== 0,
      note: beachFactor !== 0
        ? `Tier ${v2Result.targetBeachTier}: cross-tier ${beachFactor >= 0 ? "+" : ""}${(beachFactor * 100).toFixed(1)}%`
        : `Tier ${v2Result.targetBeachTier}: comps already same-tier`,
    });
    price = afterBeach;

    // Layer 3: Seasonal
    const seasonalFactor = seasonal.totalMultiplier;
    const afterSeasonal = price * seasonalFactor;
    const seasonalPct = parseFloat(((seasonalFactor - 1) * 100).toFixed(1));
    layers.push({
      layer: "seasonal",
      label: "Seasonal Multiplier",
      factor: seasonalFactor,
      adjustment_pct: seasonalPct,
      cumulative_price: Math.round(afterSeasonal),
      applied: Math.abs(seasonalFactor - 1) > 0.001,
      note: seasonal.activeEvent
        ? `${seasonal.monthName}: ×${seasonalFactor.toFixed(2)} — ${seasonal.activeEvent.name} event overlay`
        : `${seasonal.monthName} (${seasonal.season}): ×${seasonalFactor.toFixed(2)}`,
    });
    price = afterSeasonal;

    // Layer 4: View premium
    const afterView = price * (1 + viewFactor);
    const viewPct = parseFloat((viewFactor * 100).toFixed(1));
    layers.push({
      layer: "view_premium",
      label: "View Premium",
      factor: viewFactor !== 0 ? (1 + viewFactor) : null,
      adjustment_pct: viewFactor !== 0 ? viewPct : null,
      cumulative_price: Math.round(afterView),
      applied: viewFactor !== 0,
      note: {
        ocean:   "Ocean view: +20% premium — strongest demand driver after bedrooms",
        partial: "Partial ocean view: +10% premium",
        city:    "City / street view: +2% — neutral-to-mild premium",
        garden:  "Garden / courtyard view: neutral (0%)",
        none:    "No notable view: −2% discount vs comps with views",
      }[target.viewType],
    });
    price = afterView;

    // Layer 5: Rooftop pool
    const afterRooftop = price * (1 + rooftopFactor);
    const rooftopPct = parseFloat((rooftopFactor * 100).toFixed(1));
    layers.push({
      layer: "rooftop_pool",
      label: "Rooftop Pool",
      factor: rooftopFactor !== 0 ? (1 + rooftopFactor) : null,
      adjustment_pct: rooftopFactor !== 0 ? rooftopPct : null,
      cumulative_price: Math.round(afterRooftop),
      applied: rooftopFactor !== 0,
      note: rooftopNote,
    });
    price = afterRooftop;

    // Layer 6: Quality
    const afterQuality = price * (1 + qualityFactor);
    const qualityPct = parseFloat((qualityFactor * 100).toFixed(1));
    layers.push({
      layer: "quality",
      label: "Quality Adjustment",
      factor: qualityFactor !== 0 ? (1 + qualityFactor) : null,
      adjustment_pct: qualityFactor !== 0 ? qualityPct : null,
      cumulative_price: Math.round(afterQuality),
      applied: qualityFactor !== 0,
      note: [ratingNote, yearNote].filter(Boolean).join(" · "),
    });
    price = afterQuality;

    // Layer 7: Guardrails (clamp to 50%–250% of base)
    const lowerGuard = baseCompMedian * 0.50;
    const upperGuard = baseCompMedian * 2.50;
    const priceBeforeGuard = price;
    price = Math.max(lowerGuard, Math.min(upperGuard, price));
    const guardApplied = Math.abs(price - priceBeforeGuard) > 0.5;
    layers.push({
      layer: "guardrails",
      label: "Guardrails",
      factor: null,
      adjustment_pct: guardApplied ? parseFloat(((price / priceBeforeGuard - 1) * 100).toFixed(1)) : null,
      cumulative_price: Math.round(price),
      applied: guardApplied,
      note: guardApplied
        ? `Clamped to [${Math.round(lowerGuard)}–${Math.round(upperGuard)}] range`
        : `Within normal range [${Math.round(lowerGuard)}–${Math.round(upperGuard)}]`,
    });

    // ── 8. Scale conservative / stretch by total adjustment ──────────────────
    const totalAdjustmentMultiplier = baseCompMedian > 0
      ? price / baseCompMedian
      : 1;

    const recommended  = Math.round(price);
    const conservative = Math.round(v2Conservative * totalAdjustmentMultiplier);
    const stretch      = Math.round(v2Stretch * totalAdjustmentMultiplier);

    // ── 9. Build explanation string ───────────────────────────────────────────
    const explanationParts: string[] = [];

    if (seasonal.activeEvent) {
      explanationParts.push(
        `${seasonal.activeEvent.name} (${seasonal.monthName}): +${Math.round(seasonal.activeEvent.additionalPct * 100)}% event premium stacked on ${seasonal.season} season.`
      );
    } else {
      explanationParts.push(`${seasonal.monthName}: ${seasonal.season} season (×${seasonal.monthlyMultiplier.toFixed(2)} base multiplier).`);
    }

    if (target.viewType !== "none" && target.viewType !== "garden") {
      explanationParts.push(`${target.viewType.charAt(0).toUpperCase() + target.viewType.slice(1)} view: ${viewFactor >= 0 ? "+" : ""}${viewPct}%.`);
    }
    if (target.rooftopPool) {
      explanationParts.push(`Rooftop pool: +${rooftopPct}%.`);
    }
    if (Math.abs(qualityFactor) > 0.005) {
      explanationParts.push(`Quality adjustment: ${qualityFactor >= 0 ? "+" : ""}${qualityPct}% (${ratingNote}).`);
    }

    const adjustmentExplanation = explanationParts.join(" ");

    return {
      // V2 passthrough
      comps,
      expandedPool,
      targetBeachTier: v2Result.targetBeachTier,
      targetPriceTier: v2Result.targetPriceTier,
      targetBuildingNormalized: v2Result.targetBuildingNormalized,
      targetBuildingPremiumFactor: v2Result.targetBuildingPremiumFactor,
      segmentMedian: v2Result.segmentMedian,
      target,

      // V2 base pricing
      baseCompMedian,
      v2Conservative,
      v2Stretch,
      buildingAdjustmentPct: recommendation.buildingAdjustmentPct,
      beachTierAdjustmentPct: recommendation.beachTierAdjustmentPct,

      // V3 layers
      seasonalContext: seasonal,
      pricingBreakdown: layers,

      // Final output
      conservative,
      recommended,
      stretch,

      // Summary
      totalAdjustmentMultiplier,
      adjustmentExplanation,
    };
  }
}
