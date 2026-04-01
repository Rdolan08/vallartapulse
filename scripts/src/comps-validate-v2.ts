/**
 * comps-validate-v2.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Leave-one-out validation comparing V1 and V2 CompsEngines.
 *
 * 10 test cases:
 *   ZR cases (6):
 *     v399-unit-408              ZR 1BR $75   (budget)
 *     the-park-unit-209          ZR 1BR $125  (mid)
 *     rincon-de-almas-207-rinconcillo ZR 1BR $180 (upper-mid)
 *     madero-320-unit-301        ZR 2BR $155  (lower-mid)
 *     molino-de-agua-605         ZR 2BR $495  (premium, Tier A beachfront)
 *     rivera-molino-305          ZR 3BR $205  (lower segment)
 *
 *   Amapas cases (4):
 *     estrellita-del-mar-303-star-light  AMP 2BR $120  (budget)
 *     paramount-bay-villa-serena-407c    AMP 2BR $280  (premium)
 *     paramount-bay-unit-807c            AMP 3BR $300  (mid)
 *     sayan-tropical-penthouse-3         AMP 4BR $795  (premium Tier C)
 */

import { db, rentalListingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { CompsEngine,  CompsListing,  TargetProperty,  } from "./comps-engine.ts";
import { CompsEngineV2, CompsListingV2, TargetPropertyV2, formatCompsResultV2, normalizeBuildingName } from "./comps-engine-v2.ts";

// ── DB fetch ──────────────────────────────────────────────────────────────────

async function fetchEligible(): Promise<CompsListingV2[]> {
  const rows = await db
    .select({
      id:                  rentalListingsTable.id,
      externalId:          rentalListingsTable.externalId,
      sourceUrl:           rentalListingsTable.sourceUrl,
      neighborhoodNormalized: rentalListingsTable.neighborhoodNormalized,
      bedrooms:            rentalListingsTable.bedrooms,
      bathrooms:           rentalListingsTable.bathrooms,
      sqft:                rentalListingsTable.sqft,
      distanceToBeachM:    rentalListingsTable.distanceToBeachM,
      amenitiesNormalized: rentalListingsTable.amenitiesNormalized,
      ratingOverall:       rentalListingsTable.ratingOverall,
      nightlyPriceUsd:     rentalListingsTable.nightlyPriceUsd,
      buildingName:        rentalListingsTable.buildingName,
      dataConfidenceScore: rentalListingsTable.dataConfidenceScore,
    })
    .from(rentalListingsTable)
    .where(
      sql`source_platform = 'pvrpv'
        AND neighborhood_normalized IN ('Zona Romantica', 'Amapas')
        AND bedrooms BETWEEN 1 AND 4
        AND nightly_price_usd IS NOT NULL
        AND nightly_price_usd <= 1000
        AND latitude IS NOT NULL
        AND distance_to_beach_m IS NOT NULL
        AND (sqft IS NULL OR sqft >= 200)
        AND data_confidence_score >= 0.85`
    );

  return rows.map((r) => ({
    id:                     r.id,
    externalId:             r.externalId ?? "",
    sourceUrl:              r.sourceUrl,
    neighborhoodNormalized: r.neighborhoodNormalized as "Zona Romantica" | "Amapas",
    bedrooms:               r.bedrooms ?? 0,
    bathrooms:              parseFloat(String(r.bathrooms ?? 0)),
    sqft:                   r.sqft != null ? parseFloat(String(r.sqft)) : null,
    distanceToBeachM:       parseFloat(String(r.distanceToBeachM ?? 0)),
    amenitiesNormalized:    (r.amenitiesNormalized as string[] | null) ?? [],
    ratingOverall:          r.ratingOverall != null ? parseFloat(String(r.ratingOverall)) : null,
    nightlyPriceUsd:        parseFloat(String(r.nightlyPriceUsd ?? 0)),
    buildingName:           r.buildingName ?? null,
    dataConfidenceScore:    parseFloat(String(r.dataConfidenceScore ?? 0)),
  }));
}

// ── Test definitions ──────────────────────────────────────────────────────────

const V1_TEST_IDS = new Set([
  "v399-unit-408",
  "the-park-unit-209",
  "madero-320-unit-301",
  "estrellita-del-mar-303-star-light",
  "paramount-bay-villa-serena-unit-407c",
]);

const ALL_TEST_IDS = [
  // ZR
  "v399-unit-408",
  "the-park-unit-209",
  "rincon-de-almas-207-rinconcillo",
  "madero-320-unit-301",
  "molino-de-agua-605",
  "rivera-molino-305",
  // Amapas
  "estrellita-del-mar-303-star-light",
  "paramount-bay-villa-serena-unit-407c",
  "paramount-bay-unit-807c",
  "sayan-tropical-penthouse-3",
];

// ── Summary tracking ──────────────────────────────────────────────────────────

interface TestResult {
  externalId:   string;
  neighborhood: string;
  bedrooms:     number;
  actualPrice:  number;
  v1Rec:        number | null;
  v1ErrPct:     number | null;
  v1InRange:    boolean | null;
  v2Rec:        number;
  v2Conservative: number;
  v2Stretch:    number;
  v2ErrPct:     number;
  v2InRange:    boolean;
  compCount:    number;
}

function printComparisonTable(results: TestResult[]): void {
  console.log("\n" + "═".repeat(90));
  console.log("V1 vs V2 — VALIDATION SUMMARY (5 overlapping test cases)");
  console.log("═".repeat(90));
  console.log(
    "Test listing".padEnd(46) +
    "Actual".padStart(7) +
    "V1 Rec".padStart(8) +
    "V1 Err%".padStart(8) +
    "V2 Rec".padStart(8) +
    "V2 Err%".padStart(8) +
    "InRange".padStart(8)
  );
  console.log("─".repeat(90));

  const overlapping = results.filter((r) => V1_TEST_IDS.has(r.externalId));
  for (const r of overlapping) {
    const v1Err = r.v1ErrPct != null ? `${r.v1ErrPct > 0 ? "+" : ""}${r.v1ErrPct.toFixed(1)}%` : "N/A";
    const v2Err = `${r.v2ErrPct > 0 ? "+" : ""}${r.v2ErrPct.toFixed(1)}%`;
    const v1Flag = r.v1ErrPct != null ? (Math.abs(r.v1ErrPct) > 25 ? "⚠" : Math.abs(r.v1ErrPct) > 15 ? "△" : "✓") : "";
    const v2Flag = Math.abs(r.v2ErrPct) > 25 ? "⚠" : Math.abs(r.v2ErrPct) > 15 ? "△" : "✓";
    console.log(
      r.externalId.slice(0, 45).padEnd(46) +
      ("$" + r.actualPrice).padStart(7) +
      ("$" + (r.v1Rec ?? "–")).padStart(8) +
      (v1Flag + v1Err).padStart(8) +
      ("$" + r.v2Rec).padStart(8) +
      (v2Flag + v2Err).padStart(8) +
      (r.v2InRange ? "  Yes" : "  No").padStart(8)
    );
  }
  console.log("─".repeat(90));
}

function printFullSummaryTable(results: TestResult[]): void {
  console.log("\n" + "═".repeat(90));
  console.log("V2 FULL VALIDATION TABLE — ALL 10 TEST CASES");
  console.log("═".repeat(90));
  console.log(
    "Test listing".padEnd(46) +
    "NBhd".padStart(4) +
    "BR".padStart(3) +
    "Actual".padStart(7) +
    "Cons".padStart(6) +
    "Rec".padStart(6) +
    "Stretch".padStart(8) +
    "Err%".padStart(7) +
    "InRange".padStart(8)
  );
  console.log("─".repeat(90));

  for (const r of results) {
    const err = `${r.v2ErrPct > 0 ? "+" : ""}${r.v2ErrPct.toFixed(1)}%`;
    const flag = Math.abs(r.v2ErrPct) > 25 ? "⚠" : Math.abs(r.v2ErrPct) > 15 ? "△" : "✓";
    const nbhd = r.neighborhood === "Zona Romantica" ? "ZR" : "AMP";
    console.log(
      r.externalId.slice(0, 45).padEnd(46) +
      nbhd.padStart(4) +
      String(r.bedrooms).padStart(3) +
      ("$" + r.actualPrice).padStart(7) +
      ("$" + r.v2Conservative).padStart(6) +
      ("$" + r.v2Rec).padStart(6) +
      ("$" + r.v2Stretch).padStart(8) +
      (flag + err).padStart(7) +
      (r.v2InRange ? "  Yes" : "  No").padStart(8)
    );
  }
  console.log("─".repeat(90));

  const v1Errors = results.filter((r) => r.v1ErrPct != null).map((r) => Math.abs(r.v1ErrPct!));
  const v2Errors = results.map((r) => Math.abs(r.v2ErrPct));
  const v1MAE = v1Errors.length > 0 ? v1Errors.reduce((a, b) => a + b, 0) / v1Errors.length : null;
  const v2MAE = v2Errors.reduce((a, b) => a + b, 0) / v2Errors.length;
  const v2InRange = results.filter((r) => r.v2InRange).length;

  if (v1MAE != null) {
    const overlap = results.filter((r) => r.v1ErrPct != null);
    const v1MAEOverlap = overlap.map((r) => Math.abs(r.v1ErrPct!));
    const v2MAEOverlap = overlap.map((r) => Math.abs(r.v2ErrPct));
    const v1MaeStr = (v1MAEOverlap.reduce((a, b) => a + b, 0) / v1MAEOverlap.length).toFixed(1);
    const v2MaeStr = (v2MAEOverlap.reduce((a, b) => a + b, 0) / v2MAEOverlap.length).toFixed(1);
    console.log(`\nOn 5 overlapping cases:  V1 MAE = ${v1MaeStr}%   V2 MAE = ${v2MaeStr}%`);
  }
  console.log(`V2 overall MAE (all 10): ${v2MAE.toFixed(1)}%`);
  console.log(`Actual within P25–P75:   ${v2InRange}/${results.length}`);
  console.log("═".repeat(90));
}

function printObservations(results: TestResult[]): void {
  const v1Cases = results.filter((r) => r.v1ErrPct != null);
  const v1MAE = v1Cases.length > 0
    ? v1Cases.map((r) => Math.abs(r.v1ErrPct!)).reduce((a, b) => a + b, 0) / v1Cases.length
    : null;
  const v2MAE_overlap = v1Cases.map((r) => Math.abs(r.v2ErrPct)).reduce((a, b) => a + b, 0) / v1Cases.length;
  const v2MAE_all = results.map((r) => Math.abs(r.v2ErrPct)).reduce((a, b) => a + b, 0) / results.length;

  console.log("\n── V1 vs V2 PERFORMANCE ─────────────────────────────────────────────");
  if (v1MAE != null) {
    const improvement = ((v1MAE - v2MAE_overlap) / v1MAE * 100).toFixed(0);
    console.log(`V1 MAE (5 cases):          ${v1MAE.toFixed(1)}%`);
    console.log(`V2 MAE (same 5 cases):     ${v2MAE_overlap.toFixed(1)}%`);
    console.log(`MAE improvement:           ${improvement}% reduction`);
    console.log(`V2 MAE (all 10 cases):     ${v2MAE_all.toFixed(1)}%`);
  }

  const inRange = results.filter((r) => r.v2InRange).length;
  console.log(`Actual in V2 range:        ${inRange}/${results.length}`);

  console.log("\n── CASE-BY-CASE IMPROVEMENTS ────────────────────────────────────────");
  for (const r of results.filter((r) => r.v1ErrPct != null)) {
    const v1Err = r.v1ErrPct!;
    const v2Err = r.v2ErrPct;
    const improved = Math.abs(v2Err) < Math.abs(v1Err);
    const change = (Math.abs(v2Err) - Math.abs(v1Err)).toFixed(1);
    const icon = improved ? "✓ better" : "✗ worse";
    console.log(
      `  ${r.externalId.padEnd(50)} ` +
      `V1: ${(v1Err > 0 ? "+" : "") + v1Err.toFixed(1)}% → ` +
      `V2: ${(v2Err > 0 ? "+" : "") + v2Err.toFixed(1)}%  (${change}pp)  ${icon}`
    );
  }

  console.log(`
── MVP READINESS ASSESSMENT ─────────────────────────────────────────────
The model is evaluated against 3 thresholds:

  Tier 1 (Excellent):  MAE < 15%  — production-grade pricing tool
  Tier 2 (Good):       MAE 15–25% — internal MVP with caveats
  Tier 3 (Indicative): MAE 25–40% — directional guidance only, not for setting rates

V2 MAE (10 cases):  ${v2MAE_all.toFixed(1)}%`);

  if (v2MAE_all < 15) {
    console.log("  → Tier 1. The model is production-grade on the PVRPV dataset.");
    console.log("    Recommend: expose as /api/rental/comps endpoint.");
  } else if (v2MAE_all < 25) {
    console.log("  → Tier 2. The model is good enough for an internal MVP.");
    console.log("    Recommend: expose as /api/rental/comps endpoint with confidence indicator.");
    console.log("    Show the P25–P75 range, not just the point estimate.");
    console.log("    Add disclaimer: 'based on PVRPV listings only, not full market data'.");
  } else {
    console.log("  → Tier 3. The model is directionally useful but needs more work before MVP.");
    console.log("    Recommend: complete building-tier labeling and beach-tier adjustments first.");
    console.log("    Then re-run validation on a broader test set.");
  }

  console.log(`
── REMAINING SOURCES OF ERROR ────────────────────────────────────────────
1. Budget/promotional pricing floors
   PVRPV occasionally prices units at loyalty rates or long-stay discounts
   that are not detectable from listing data alone. These create 30-60% 
   overestimation errors that no comp model can resolve without occupancy data.

2. Segment thinness for Amapas 3BR and 4BR
   The AMP 3BR pool has only 6 listings; AMP 4BR has only 4.
   Statistical noise at this sample size means the P25-P75 range is the 
   more reliable output than the point estimate.

3. Building prestige not fully captured
   The building premium factor captures price differential but not prestige
   signals (design quality, amenity tier, concierge services) that explain
   why Avalon Zen ($315) commands a premium over similar-spec Estrellita ($185).

4. Single-rate scraping
   Every listing has one scraped rate. High-season vs low-season rates 
   can differ by 30-40% for the same unit. The model is calibrated to
   the rate as scraped (typically the standard listed rate).

── RECOMMENDED NEXT STEP ─────────────────────────────────────────────────
Build /api/rental/comps endpoint using the V2 engine.
Return:
  - conservative / recommended / stretch prices
  - top 5 comps with score breakdowns
  - adjustmentExplanation (1 sentence)
  - segmentMedian for context
  - a confidenceLevel flag: "high" (N≥8), "medium" (N 5-7), "low" (N<5)
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  VallartaPulse CompsEngine V2 — Leave-One-Out Validation        ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  const allListings = await fetchEligible();
  console.log(`\nEligible pool: ${allListings.length} listings`);

  // Build both engines from same data
  const v1Engine = new CompsEngine(allListings as unknown as CompsListing[]);
  const v2Engine = new CompsEngineV2(allListings);

  console.log(`V1 engine: ${v1Engine.eligibleCount} eligible | V2 engine: ${v2Engine.eligibleCount} eligible`);

  const testListings = allListings.filter((l) => ALL_TEST_IDS.includes(l.externalId));
  const missing = ALL_TEST_IDS.filter((id) => !testListings.find((l) => l.externalId === id));
  if (missing.length > 0) console.warn(`⚠ Missing test listings: ${missing.join(", ")}`);

  // Sort by the order defined in ALL_TEST_IDS
  testListings.sort((a, b) =>
    ALL_TEST_IDS.indexOf(a.externalId) - ALL_TEST_IDS.indexOf(b.externalId)
  );

  console.log(`\nRunning V2 validation on ${testListings.length} test listings...\n`);

  const summary: TestResult[] = [];

  for (const listing of testListings) {
    // --- V2 run ---
    const targetV2: TargetPropertyV2 = {
      neighborhoodNormalized: listing.neighborhoodNormalized,
      bedrooms:               listing.bedrooms,
      bathrooms:              listing.bathrooms,
      sqft:                   listing.sqft,
      distanceToBeachM:       listing.distanceToBeachM,
      amenitiesNormalized:    listing.amenitiesNormalized,
      ratingOverall:          listing.ratingOverall,
      buildingName:           listing.buildingName,
    };
    const v2Result = v2Engine.run(targetV2, { excludeId: listing.id });
    const v2Rec  = v2Result.recommendation.recommended;
    const v2Err  = parseFloat(((v2Rec - listing.nightlyPriceUsd) / listing.nightlyPriceUsd * 100).toFixed(1));
    const v2InRange = listing.nightlyPriceUsd >= v2Result.recommendation.conservative &&
                      listing.nightlyPriceUsd <= v2Result.recommendation.stretch;

    // Print V2 detail
    const label = `${listing.externalId}  (${listing.neighborhoodNormalized}, ${listing.bedrooms}BR)`;
    console.log(formatCompsResultV2(v2Result, label, listing.nightlyPriceUsd));

    // --- V1 run (for overlapping cases only) ---
    let v1Rec: number | null = null;
    let v1Err: number | null = null;
    let v1InRange: boolean | null = null;

    if (V1_TEST_IDS.has(listing.externalId)) {
      const targetV1: TargetProperty = {
        neighborhoodNormalized: listing.neighborhoodNormalized,
        bedrooms:               listing.bedrooms,
        bathrooms:              listing.bathrooms,
        sqft:                   listing.sqft,
        distanceToBeachM:       listing.distanceToBeachM,
        amenitiesNormalized:    listing.amenitiesNormalized,
        ratingOverall:          listing.ratingOverall,
      };
      const v1Result = v1Engine.run(targetV1 as any, { excludeId: listing.id });
      v1Rec = v1Result.recommendation.recommended;
      v1Err = parseFloat(((v1Rec - listing.nightlyPriceUsd) / listing.nightlyPriceUsd * 100).toFixed(1));
      v1InRange = listing.nightlyPriceUsd >= v1Result.recommendation.conservative &&
                  listing.nightlyPriceUsd <= v1Result.recommendation.stretch;
    }

    summary.push({
      externalId:     listing.externalId,
      neighborhood:   listing.neighborhoodNormalized,
      bedrooms:       listing.bedrooms,
      actualPrice:    listing.nightlyPriceUsd,
      v1Rec,
      v1ErrPct:       v1Err,
      v1InRange,
      v2Rec,
      v2Conservative: v2Result.recommendation.conservative,
      v2Stretch:      v2Result.recommendation.stretch,
      v2ErrPct:       v2Err,
      v2InRange,
      compCount:      v2Result.recommendation.compCount,
    });
  }

  // Summary tables
  printComparisonTable(summary);
  printFullSummaryTable(summary);
  printObservations(summary);

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
