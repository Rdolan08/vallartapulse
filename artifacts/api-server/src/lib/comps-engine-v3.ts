/**
 * comps-engine-v3.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VallartaPulse Pricing Engine — Version 3
 *
 * Version:   3.2 — April 2026
 * Changes from V3.1 — PV market calibration:
 *   • Rooftop pool:      +12/15% → +15/18%  (scarcest premium feature in ZR/Amapas)
 *   • Premium finish:    +16%    → +22%      (design-forward units command real premium)
 *   • Upgraded finish:   +8%     → +10%      (above-average finish meaningfully valued)
 *   • Private plunge:    +8%     → +12%      (rare in ZR/Amapas buildings)
 *   • Large terrace:     +5%     → +8%       (indoor-outdoor lifestyle = primary PV driver)
 *   • Year built factor: halved — renovation & finish quality > raw build year in PV
 *   • Beach tier cross-adj: capped ±8% — comp selection already controls for proximity;
 *     generic beach distance must not be over-weighted in ZR/Amapas pricing
 *
 * LAYER ORDER (applied to baseCompMedian sequentially):
 *   1. Base comp median           (from v2 IQR-trimmed comp set)
 *   2. Building anchor            (from v2 building premium factor)
 *   3. Beach tier                 (from v2, capped ±8% — proximity de-emphasized)
 *   4. Seasonal                   (monthly multiplier × event premium)
 *   5. View premium               (ocean / partial / city / garden / none)
 *   6. Rooftop pool               (if rooftop_pool = true)
 *   7. Finish quality             (standard / upgraded / premium)
 *   8. Private plunge pool        (if private_plunge_pool = true)
 *   9. Large terrace              (if large_terrace = true)
 *  10. Quality                    (rating + year built — year capped, finish takes precedence)
 *  11. Guardrails                 (clamp 0.5×–2.5× base)
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

// ── Finish quality ─────────────────────────────────────────────────────────────

export type FinishQuality = "standard" | "upgraded" | "premium";

const FINISH_QUALITY_FACTOR: Record<FinishQuality, number> = {
  standard: 0.00,
  upgraded: 0.10,
  premium:  0.22,
};

const FINISH_QUALITY_NOTE: Record<FinishQuality, string> = {
  standard: "Standard interiors — neutral (baseline)",
  upgraded: "Upgraded interiors: +10% — above-average finish and furnishings command a real PV premium",
  premium:  "Premium/luxury interiors: +22% — design-forward, high-end quality; vacationers pay significantly for this in ZR/Amapas",
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

// In PV, finish quality and renovation matter far more than raw build year.
// A renovated 2005 building beats an unrenovated 2022 build. These factors
// are intentionally modest — finish_quality layer already captures interior condition.
const YEAR_BUILT_FACTOR: Record<string, number> = {
  "2020+":     0.02,
  "2015-2019": 0.008,
  "2010-2014": 0.00,
  "2000-2009": -0.005,
  "1990-1999": -0.012,
  "pre-1990":  -0.025,
  "":           0.00,
};

// ── Per-layer breakdown ───────────────────────────────────────────────────────

export interface PricingLayer {
  layer: string;
  label: string;
  factor: number | null;
  adjustment_pct: number | null;
  cumulative_price: number;
  applied: boolean;
  note: string;
}

// ── Extended target ───────────────────────────────────────────────────────────

export interface TargetPropertyV3 extends TargetPropertyV2 {
  month: number;
  viewType: ViewType;
  rooftopPool: boolean;
  yearBuilt: YearBuiltRange;
  finishQuality: FinishQuality;
  privatePlungePool: boolean;
  largeTerrace: boolean;
}

// ── Extended result ───────────────────────────────────────────────────────────

export interface CompsResultV3 {
  comps: CompResultV2[];
  expandedPool: boolean;
  targetBeachTier: BeachTier;
  targetPriceTier: "low" | "mid" | "high" | null;
  targetBuildingNormalized: string | null;
  targetBuildingPremiumFactor: number | null;
  segmentMedian: number;
  target: TargetPropertyV2;

  baseCompMedian: number;
  v2Conservative: number;
  v2Stretch: number;
  buildingAdjustmentPct: number | null;
  beachTierAdjustmentPct: number | null;

  seasonalContext: SeasonalContext;
  pricingBreakdown: PricingLayer[];

  conservative: number;
  recommended: number;
  stretch: number;

  totalAdjustmentMultiplier: number;
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

  return { factor: ratingFactor + yearFactor, ratingNote, yearNote };
}

// ── Rooftop pool premium ──────────────────────────────────────────────────────

function computeRooftopPoolFactor(
  rooftopPool: boolean,
  amenities: string[]
): { factor: number; note: string } {
  if (!rooftopPool) return { factor: 0, note: "No rooftop pool" };

  const hasStandardPool = amenities.some(a =>
    a === "pool" || a === "shared_pool" || a === "private_pool"
  );

  if (hasStandardPool) {
    return { factor: 0.15, note: "Rooftop pool: +15% — scarcest lifestyle premium in PV; comps include standard pool" };
  }
  return { factor: 0.18, note: "Rooftop pool: +18% — scarcest lifestyle premium in PV; no standard pool in comp set" };
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
    // ── 1. Run v2 engine ─────────────────────────────────────────────────────
    const v2Result = this.v2Engine.run(target);
    const { recommendation, comps, expandedPool } = v2Result;

    const baseCompMedian = recommendation.baseCompMedian;
    const v2Conservative = recommendation.conservative;
    const v2Stretch      = recommendation.stretch;

    // ── 2. Compute factors ───────────────────────────────────────────────────
    const seasonal      = getSeasonalContext(target.month);
    const viewFactor    = VIEW_PREMIUM[target.viewType];
    const finishFactor  = FINISH_QUALITY_FACTOR[target.finishQuality];
    const { factor: rooftopFactor, note: rooftopNote } =
      computeRooftopPoolFactor(target.rooftopPool, target.amenitiesNormalized);
    const { factor: qualityFactor, ratingNote, yearNote } =
      computeQualityFactor(target.ratingOverall, target.yearBuilt);

    const buildingFactor =
      recommendation.buildingAdjustmentPct != null
        ? recommendation.buildingAdjustmentPct / 100 : 0;
    // Beach proximity is already controlled for in comp-set selection (V2 beach tier matching).
    // Applying a large additional cross-tier adjustment over-weights generic beach distance
    // in ZR/Amapas, where view, finish quality, and lifestyle amenities are the true
    // demand drivers. Cap at ±8% to prevent double-counting.
    const rawBeachFactor =
      recommendation.beachTierAdjustmentPct != null
        ? recommendation.beachTierAdjustmentPct / 100 : 0;
    const beachFactor = Math.max(-0.08, Math.min(0.08, rawBeachFactor));

    // ── 3. Apply layers sequentially ─────────────────────────────────────────
    const layers: PricingLayer[] = [];
    let price = baseCompMedian;

    // Layer 0: Base
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
    price = price * (1 + buildingFactor);
    layers.push({
      layer: "building_anchor",
      label: "Building Premium",
      factor: buildingFactor !== 0 ? (1 + buildingFactor) : null,
      adjustment_pct: buildingFactor !== 0 ? parseFloat((buildingFactor * 100).toFixed(1)) : null,
      cumulative_price: Math.round(price),
      applied: buildingFactor !== 0,
      note: buildingFactor !== 0
        ? `${target.buildingName ?? "Building"}: ${buildingFactor >= 0 ? "+" : ""}${(buildingFactor * 100).toFixed(1)}%`
        : "No building premium — general comps",
    });

    // Layer 2: Beach tier
    price = price * (1 + beachFactor);
    layers.push({
      layer: "beach_tier",
      label: "Beach Tier Adjustment",
      factor: beachFactor !== 0 ? (1 + beachFactor) : null,
      adjustment_pct: beachFactor !== 0 ? parseFloat((beachFactor * 100).toFixed(1)) : null,
      cumulative_price: Math.round(price),
      applied: beachFactor !== 0,
      note: beachFactor !== 0
        ? `Tier ${v2Result.targetBeachTier}: cross-tier ${beachFactor >= 0 ? "+" : ""}${(beachFactor * 100).toFixed(1)}%`
        : `Tier ${v2Result.targetBeachTier}: comps already same-tier`,
    });

    // Layer 3: Seasonal
    const seasonalFactor = seasonal.totalMultiplier;
    price = price * seasonalFactor;
    const seasonalPct = parseFloat(((seasonalFactor - 1) * 100).toFixed(1));
    layers.push({
      layer: "seasonal",
      label: "Seasonal Multiplier",
      factor: seasonalFactor,
      adjustment_pct: seasonalPct,
      cumulative_price: Math.round(price),
      applied: Math.abs(seasonalFactor - 1) > 0.001,
      note: seasonal.activeEvent
        ? `${seasonal.monthName}: ×${seasonalFactor.toFixed(2)} — ${seasonal.activeEvent.name} event overlay`
        : `${seasonal.monthName} (${seasonal.season}): ×${seasonalFactor.toFixed(2)}`,
    });

    // Layer 4: View premium
    price = price * (1 + viewFactor);
    const viewPct = parseFloat((viewFactor * 100).toFixed(1));
    layers.push({
      layer: "view_premium",
      label: "View Premium",
      factor: viewFactor !== 0 ? (1 + viewFactor) : null,
      adjustment_pct: viewFactor !== 0 ? viewPct : null,
      cumulative_price: Math.round(price),
      applied: viewFactor !== 0,
      note: {
        ocean:   "Ocean view: +20% premium — strongest demand driver after bedrooms",
        partial: "Partial ocean view: +10% premium",
        city:    "City / street view: +2% — neutral-to-mild premium",
        garden:  "Garden / courtyard view: neutral (0%)",
        none:    "No notable view: −2% discount vs comps with views",
      }[target.viewType],
    });

    // Layer 5: Rooftop pool
    price = price * (1 + rooftopFactor);
    const rooftopPct = parseFloat((rooftopFactor * 100).toFixed(1));
    layers.push({
      layer: "rooftop_pool",
      label: "Rooftop Pool",
      factor: rooftopFactor !== 0 ? (1 + rooftopFactor) : null,
      adjustment_pct: rooftopFactor !== 0 ? rooftopPct : null,
      cumulative_price: Math.round(price),
      applied: rooftopFactor !== 0,
      note: rooftopNote,
    });

    // Layer 6: Finish quality
    price = price * (1 + finishFactor);
    const finishPct = parseFloat((finishFactor * 100).toFixed(1));
    layers.push({
      layer: "finish_quality",
      label: "Interior Finish Quality",
      factor: finishFactor !== 0 ? (1 + finishFactor) : null,
      adjustment_pct: finishFactor !== 0 ? finishPct : null,
      cumulative_price: Math.round(price),
      applied: finishFactor !== 0,
      note: FINISH_QUALITY_NOTE[target.finishQuality],
    });

    // Layer 7: Private plunge pool
    // Rare in ZR/Amapas buildings — scarcity justifies +12% in the PV market.
    const plungeFactor = target.privatePlungePool ? 0.12 : 0;
    price = price * (1 + plungeFactor);
    const plungePct = parseFloat((plungeFactor * 100).toFixed(1));
    layers.push({
      layer: "private_plunge_pool",
      label: "Private Pool / Plunge Pool",
      factor: plungeFactor !== 0 ? (1 + plungeFactor) : null,
      adjustment_pct: plungeFactor !== 0 ? plungePct : null,
      cumulative_price: Math.round(price),
      applied: plungeFactor !== 0,
      note: target.privatePlungePool
        ? "Private plunge pool: +12% — rare in ZR/Amapas; scarcity drives a strong unit-level premium"
        : "No private pool",
    });

    // Layer 8: Large terrace
    // Indoor-outdoor living is a primary PV lifestyle driver — not a minor convenience.
    const terraceFactor = target.largeTerrace ? 0.08 : 0;
    price = price * (1 + terraceFactor);
    const terracePct = parseFloat((terraceFactor * 100).toFixed(1));
    layers.push({
      layer: "large_terrace",
      label: "Large Terrace / Outdoor Living",
      factor: terraceFactor !== 0 ? (1 + terraceFactor) : null,
      adjustment_pct: terraceFactor !== 0 ? terracePct : null,
      cumulative_price: Math.round(price),
      applied: terraceFactor !== 0,
      note: target.largeTerrace
        ? "Large terrace/outdoor living: +8% — indoor-outdoor lifestyle is a primary value driver in PV"
        : "No premium terrace",
    });

    // Layer 9: Quality (rating + year)
    price = price * (1 + qualityFactor);
    const qualityPct = parseFloat((qualityFactor * 100).toFixed(1));
    layers.push({
      layer: "quality",
      label: "Quality Adjustment",
      factor: qualityFactor !== 0 ? (1 + qualityFactor) : null,
      adjustment_pct: qualityFactor !== 0 ? qualityPct : null,
      cumulative_price: Math.round(price),
      applied: qualityFactor !== 0,
      note: [ratingNote, yearNote].filter(Boolean).join(" · "),
    });

    // Layer 10: Guardrails
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

    // ── 4. Scale conservative / stretch ──────────────────────────────────────
    const totalAdjustmentMultiplier = baseCompMedian > 0 ? price / baseCompMedian : 1;
    const recommended  = Math.round(price);
    const conservative = Math.round(v2Conservative * totalAdjustmentMultiplier);
    const stretch      = Math.round(v2Stretch * totalAdjustmentMultiplier);

    // ── 5. Build explanation ──────────────────────────────────────────────────
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
    if (target.finishQuality !== "standard") {
      explanationParts.push(`${target.finishQuality.charAt(0).toUpperCase() + target.finishQuality.slice(1)} finish: +${finishPct}%.`);
    }
    if (target.privatePlungePool) {
      explanationParts.push(`Private pool: +${plungePct}%.`);
    }
    if (target.largeTerrace) {
      explanationParts.push(`Large terrace: +${terracePct}%.`);
    }
    if (Math.abs(qualityFactor) > 0.005) {
      explanationParts.push(`Quality adjustment: ${qualityFactor >= 0 ? "+" : ""}${qualityPct}% (${ratingNote}).`);
    }

    return {
      comps, expandedPool,
      targetBeachTier: v2Result.targetBeachTier,
      targetPriceTier: v2Result.targetPriceTier,
      targetBuildingNormalized: v2Result.targetBuildingNormalized,
      targetBuildingPremiumFactor: v2Result.targetBuildingPremiumFactor,
      segmentMedian: v2Result.segmentMedian,
      target,
      baseCompMedian, v2Conservative, v2Stretch,
      buildingAdjustmentPct: recommendation.buildingAdjustmentPct,
      beachTierAdjustmentPct: recommendation.beachTierAdjustmentPct,
      seasonalContext: seasonal,
      pricingBreakdown: layers,
      conservative, recommended, stretch,
      totalAdjustmentMultiplier,
      adjustmentExplanation: explanationParts.join(" "),
    };
  }
}
