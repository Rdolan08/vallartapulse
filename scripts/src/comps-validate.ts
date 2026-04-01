/**
 * comps-validate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Leave-one-out validation of the CompsEngine against 5 real PVRPV listings.
 *
 * For each test listing:
 *   1. Remove it from the comp pool (leave-one-out)
 *   2. Build a TargetProperty from its actual data
 *   3. Run the engine to generate comps + price recommendation
 *   4. Compare recommended price to actual nightly_price_usd
 *   5. Print a detailed breakdown
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run validate:comps
 *
 * Test cases selected to span:
 *   - 3 Zona Romantica listings (low, mid, high within segment)
 *   - 2 Amapas listings (low-mid and high)
 *   - Different bedroom counts: 1BR, 1BR, 2BR, 2BR, 3BR
 */

import { db, rentalListingsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  CompsEngine,
  CompsListing,
  TargetProperty,
  formatCompsResult,
} from "./comps-engine.ts";

// ── DB fetch ──────────────────────────────────────────────────────────────────

async function fetchEligibleListings(): Promise<CompsListing[]> {
  const rows = await db
    .select({
      id:                     rentalListingsTable.id,
      externalId:             rentalListingsTable.externalId,
      sourceUrl:              rentalListingsTable.sourceUrl,
      neighborhoodNormalized: rentalListingsTable.neighborhoodNormalized,
      bedrooms:               rentalListingsTable.bedrooms,
      bathrooms:              rentalListingsTable.bathrooms,
      sqft:                   rentalListingsTable.sqft,
      distanceToBeachM:       rentalListingsTable.distanceToBeachM,
      amenitiesNormalized:    rentalListingsTable.amenitiesNormalized,
      ratingOverall:          rentalListingsTable.ratingOverall,
      nightlyPriceUsd:        rentalListingsTable.nightlyPriceUsd,
      buildingName:           rentalListingsTable.buildingName,
      dataConfidenceScore:    rentalListingsTable.dataConfidenceScore,
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

// ── Test case definitions ─────────────────────────────────────────────────────

/**
 * The 5 test listings selected for leave-one-out validation.
 * Each entry is the external_id from the DB.
 *
 * Selection rationale:
 *   ZR-1:  v399-unit-408       ($75)   ZR 1BR cheap end — tests floor pricing
 *   ZR-2:  the-park-unit-209   ($125)  ZR 1BR mid range — near Romantic Zone
 *   ZR-3:  madero-320-unit-301 ($155)  ZR 2BR mid range — tests 2BR segment
 *   AMP-1: estrellita-del-mar-303-star-light ($120) Amapas 2BR low end
 *   AMP-2: paramount-bay-villa-serena-unit-407c ($280) Amapas 2BR premium
 */
const TEST_EXTERNAL_IDS = [
  "v399-unit-408",                           // ZR 1BR $75
  "the-park-unit-209",                       // ZR 1BR $125
  "madero-320-unit-301",                     // ZR 2BR $155
  "estrellita-del-mar-303-star-light",       // Amapas 2BR $120
  "paramount-bay-villa-serena-unit-407c",    // Amapas 2BR $280
];

// ── Validation summary tracker ────────────────────────────────────────────────

interface ValidationResult {
  externalId: string;
  actualPrice: number;
  recommended: number;
  conservative: number;
  stretch: number;
  errorPct: number;
  withinRange: boolean;
  compCount: number;
}

function printSummaryTable(results: ValidationResult[]): void {
  console.log("\n" + "═".repeat(72));
  console.log("LEAVE-ONE-OUT VALIDATION SUMMARY");
  console.log("═".repeat(72));
  console.log(
    "Test listing".padEnd(45) +
    "Actual".padStart(7) +
    "Cons".padStart(7) +
    "Rec".padStart(7) +
    "Stretch".padStart(8) +
    "Err%".padStart(7) +
    "InRange".padStart(8)
  );
  console.log("─".repeat(72));

  for (const r of results) {
    const errStr = (r.errorPct >= 0 ? "+" : "") + r.errorPct.toFixed(1) + "%";
    const flag = Math.abs(r.errorPct) > 25 ? " ⚠" : Math.abs(r.errorPct) > 15 ? " △" : " ✓";
    console.log(
      r.externalId.slice(0, 44).padEnd(45) +
      ("$" + r.actualPrice).padStart(7) +
      ("$" + r.conservative).padStart(7) +
      ("$" + r.recommended).padStart(7) +
      ("$" + r.stretch).padStart(8) +
      errStr.padStart(7) +
      (r.withinRange ? "  Yes" + flag : "  No" + flag).padStart(8)
    );
  }

  console.log("─".repeat(72));

  const errors = results.map((r) => Math.abs(r.errorPct));
  const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
  const inRange = results.filter((r) => r.withinRange).length;
  console.log(
    `\nMean Absolute Error (recommended vs actual):  ${mae.toFixed(1)}%`
  );
  console.log(`Actual price within P25–P75 range:             ${inRange}/${results.length}`);
  console.log("═".repeat(72));
}

function printObservations(results: ValidationResult[]): void {
  const overestimates = results.filter((r) => r.errorPct > 10);
  const underestimates = results.filter((r) => r.errorPct < -10);
  const accurate = results.filter((r) => Math.abs(r.errorPct) <= 10);

  console.log("\n── OBSERVATIONS ──────────────────────────────────────────────");

  if (accurate.length > 0) {
    console.log(`\n✓ Accurate (within 10%): ${accurate.length} listing(s)`);
    for (const r of accurate) {
      console.log(`    ${r.externalId}: actual $${r.actualPrice} → rec $${r.recommended} (${r.errorPct > 0 ? "+" : ""}${r.errorPct.toFixed(1)}%)`);
    }
  }

  if (overestimates.length > 0) {
    console.log(`\n△ Overestimated (>10% above actual): ${overestimates.length} listing(s)`);
    for (const r of overestimates) {
      console.log(`    ${r.externalId}: actual $${r.actualPrice} → rec $${r.recommended} (+${r.errorPct.toFixed(1)}%)`);
    }
    console.log("  Likely causes:");
    console.log("  - Very low-priced listings can be outlier budget options in the segment");
    console.log("  - Comps may include higher-amenity listings with similar profiles");
    console.log("  - PVRPV pricing may be intentionally below-market for loyal repeat guests");
  }

  if (underestimates.length > 0) {
    console.log(`\n▽ Underestimated (>10% below actual): ${underestimates.length} listing(s)`);
    for (const r of underestimates) {
      console.log(`    ${r.externalId}: actual $${r.actualPrice} → rec $${r.recommended} (${r.errorPct.toFixed(1)}%)`);
    }
    console.log("  Likely causes:");
    console.log("  - Premium listings may have unique attributes not captured (building prestige)");
    console.log("  - Segment is thin — comp set price range below true market ceiling");
    console.log("  - Some PVRPV premium addresses command a premium beyond similarity score");
  }

  console.log(`
── NEXT IMPROVEMENT STEPS ────────────────────────────────────────
1. Building/complex premium signal
   Listings in Paramount Bay, Residences by Pinnacle, Avalon Zen
   command $50-150/night over equivalent sqft/beach-distance comps.
   Adding a building_tier field would reduce overestimation on budget
   listings and underestimation on luxury ones.

2. Beach tier as a categorical feature
   Three tiers are visible in the data:
   Tier A (≤100m): Molino de Agua, beachfront Sayan complex → +25-40%
   Tier B (100-500m): Most Zona Romantica, central Amapas → base rate
   Tier C (500m+): Upper Amapas, Selva Romantica → -10-20%
   A tier adjustment factor would improve recommendations vs raw Haversine.

3. sqft/bedroom price-per-sqft normalization
   Amapas listings range from 238 ft² (data error, Paramount 401a)
   to 5,000 ft² penthouses. Price-per-sqft normalization would allow
   comp scores to anchor on value density, not just size similarity.

4. Seasonal rate layer
   PVRPV rate tables include date ranges. Scraping the full rate
   calendar would allow season-adjusted comps (high season Dec-Mar
   vs shoulder season Apr-Jun).

5. Marina Vallarta — insufficient data (only 3 listings)
   Cannot run reliable comps for that neighborhood until 15-20 listings
   minimum are available.

6. Confidence interval on the recommendation
   With N=5-10 comps in a thin segment, the P25-P75 range is wide.
   Adding a sample-size confidence flag (e.g. "thin market, N=4") would
   help users calibrate trust in the recommendation.
`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  VallartaPulse CompsEngine — Leave-One-Out Validation       ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("\nFetching eligible listings from DB...");

  const allListings = await fetchEligibleListings();
  console.log(`Eligible pool: ${allListings.length} listings`);

  const engine = new CompsEngine(allListings);
  console.log(`Engine initialized with ${engine.eligibleCount} eligible listings.`);

  const testListings = allListings.filter((l) => TEST_EXTERNAL_IDS.includes(l.externalId));
  const missing = TEST_EXTERNAL_IDS.filter((id) => !testListings.find((l) => l.externalId === id));
  if (missing.length > 0) {
    console.warn(`\n⚠ Test listings not found in eligible pool: ${missing.join(", ")}`);
    console.warn("  (They may be ineligible due to filtering rules — check the data.)");
  }

  console.log(`\nRunning leave-one-out validation on ${testListings.length} test listings...\n`);

  const validationResults: ValidationResult[] = [];

  for (const listing of testListings) {
    // Build target property from the listing's own data
    const target: TargetProperty = {
      neighborhoodNormalized: listing.neighborhoodNormalized,
      bedrooms:               listing.bedrooms,
      bathrooms:              listing.bathrooms,
      sqft:                   listing.sqft,
      distanceToBeachM:       listing.distanceToBeachM,
      amenitiesNormalized:    listing.amenitiesNormalized,
      ratingOverall:          listing.ratingOverall,
    };

    // Leave-one-out: exclude this listing from the comp pool
    const result = engine.run(target, {
      excludeId: listing.id,
      minComps:  5,
      maxComps:  10,
    });

    const { recommendation } = result;
    const errorPct = ((recommendation.recommended - listing.nightlyPriceUsd) / listing.nightlyPriceUsd) * 100;
    const withinRange =
      listing.nightlyPriceUsd >= recommendation.conservative &&
      listing.nightlyPriceUsd <= recommendation.stretch;

    validationResults.push({
      externalId:   listing.externalId,
      actualPrice:  listing.nightlyPriceUsd,
      recommended:  recommendation.recommended,
      conservative: recommendation.conservative,
      stretch:      recommendation.stretch,
      errorPct:     parseFloat(errorPct.toFixed(1)),
      withinRange,
      compCount:    recommendation.compCount,
    });

    // Print full detail for this test
    const label =
      `${listing.externalId}  (${listing.neighborhoodNormalized}, ${listing.bedrooms}BR)`;
    console.log(formatCompsResult(result, label, listing.nightlyPriceUsd));
  }

  // Summary table
  printSummaryTable(validationResults);

  // Observations
  printObservations(validationResults);

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
