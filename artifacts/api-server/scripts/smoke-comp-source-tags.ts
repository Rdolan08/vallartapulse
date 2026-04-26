/**
 * One-off smoke for the 2026-04-26 multi-platform daily-rate tagging fix
 * in src/lib/comps-pricing-source.ts. Calls selectCompPriceSources()
 * directly against whatever DATABASE_URL points at and prints the
 * resulting sourceCounts so we can confirm the new airbnb_daily and
 * vacation_vallarta_daily tags are populated correctly (and pvrpv_daily
 * is no longer over-counted).
 *
 * Read-only by construction — selectCompPriceSources runs only SELECT
 * queries. Safe to point at $RAILWAY_DATABASE_URL.
 *
 * Usage:
 *   DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm exec tsx artifacts/api-server/scripts/smoke-comp-source-tags.ts
 */

import { selectCompPriceSources } from "../src/lib/comps-pricing-source.js";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

function dbTargetLabel(): string {
  const url = process.env.DATABASE_URL ?? "";
  if (url.includes("railway")) return "RAILWAY (production)";
  if (url.includes("@localhost") || url.includes("@127.")) return "LOCAL sandbox";
  return "unknown";
}

async function main(): Promise<void> {
  console.log(`DB target: ${dbTargetLabel()}`);

  // Pull every listing ID in the two SUPPORTED_NEIGHBORHOODS the comps
  // route accepts. selectCompPriceSources will internally apply the
  // forward 30-90d Rank-1 window + freshness gating.
  const rows = (await db.execute(sql`
    SELECT id::int AS id
    FROM rental_listings
    WHERE neighborhood_normalized IN ('Zona Romantica', 'Amapas')
  `)).rows as Array<{ id: number }>;
  const ids = rows.map(r => r.id);
  console.log(`Eligible listings (ZR + Amapas): ${ids.length}`);

  const result = await selectCompPriceSources(ids);

  console.log("\n=== sourceCounts (post-edit, from selectCompPriceSources) ===");
  console.table(result.sourceCounts);

  console.log("\n=== chosen breakdown by priceSource (recomputed from chosen Map) ===");
  const breakdown: Record<string, number> = {};
  for (const c of result.chosen.values()) {
    breakdown[c.priceSource] = (breakdown[c.priceSource] ?? 0) + 1;
  }
  console.table(breakdown);

  console.log("\n=== excludedReasons ===");
  console.table(result.excludedReasons);

  console.log("\n=== sample (first 3 listings per tag) ===");
  const samples: Record<string, Array<{ id: number; price: number; freshDays: number; weight: number }>> = {};
  for (const c of result.chosen.values()) {
    if (!samples[c.priceSource]) samples[c.priceSource] = [];
    if (samples[c.priceSource].length < 3) {
      samples[c.priceSource].push({
        id: c.listingId,
        price: c.nightlyPriceUsd,
        freshDays: c.priceFreshnessDays,
        weight: c.priceFreshnessWeight,
      });
    }
  }
  for (const [tag, list] of Object.entries(samples)) {
    console.log(`\n  ${tag}:`);
    console.table(list);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Smoke failed:", err);
  process.exit(1);
});
