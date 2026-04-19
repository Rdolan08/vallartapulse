/**
 * vrbo-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VRBO listing refresher for VallartaPulse.
 *
 * Refresh-only mode: re-fetches every existing rental_listings row whose
 * source_platform='vrbo' and source_url IS NOT NULL, then upserts the
 * fresh data back. There is intentionally no discovery layer here — VRBO
 * does not yet have a search/seed driver, so this script is a no-op
 * cron until something else populates the seed rows. That's the desired
 * behavior: the freshness contract is "if it's on the site, it gets
 * refreshed daily" — and right now there is nothing on the site for VRBO.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run scrape:vrbo
 *
 * Limits: hard cap of MAX_LISTINGS per run to bound runtime.
 */

import { sql, and, eq, isNotNull } from "drizzle-orm";
import { db, rentalListingsTable } from "@workspace/db";
import { fetchVrboListing } from "../../artifacts/api-server/src/lib/ingest/vrbo-adapter.js";

const SOURCE_PLATFORM = "vrbo";
const MAX_LISTINGS = 200;
const MIN_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SeedRow {
  id: number;
  sourceUrl: string;
}

async function loadSeedRows(): Promise<SeedRow[]> {
  const rows = await db
    .select({
      id: rentalListingsTable.id,
      sourceUrl: rentalListingsTable.sourceUrl,
    })
    .from(rentalListingsTable)
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        isNotNull(rentalListingsTable.sourceUrl),
      ),
    )
    .orderBy(rentalListingsTable.scrapedAt)
    .limit(MAX_LISTINGS);

  return rows
    .filter((r): r is SeedRow => typeof r.sourceUrl === "string" && r.sourceUrl.length > 0);
}

async function refreshOne(seed: SeedRow): Promise<{ ok: boolean; error?: string }> {
  try {
    const listing = await fetchVrboListing(seed.sourceUrl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const values: any = {
        sourcePlatform: SOURCE_PLATFORM,
        sourceUrl: listing.source_url ?? seed.sourceUrl,
        externalId: listing.source_listing_id ?? null,
        title: listing.title ?? "VRBO listing",
        neighborhoodRaw: listing.neighborhood ?? "unknown",
        bedrooms: listing.bedrooms ?? 0,
        bathrooms: listing.bathrooms ?? 0,
        maxGuests: listing.max_guests ?? null,
        latitude: listing.latitude ?? null,
        longitude: listing.longitude ?? null,
        amenitiesRaw: listing.amenities_raw && listing.amenities_raw.length > 0
          ? listing.amenities_raw
          : null,
        ratingOverall: listing.rating_value ?? null,
        ratingCount: listing.review_count ?? null,
        reviewCount: listing.review_count ?? null,
        nightlyPriceUsd: listing.price_nightly_usd ?? null,
        scrapedAt: new Date(),
        isActive: true,
    };
    await db
      .insert(rentalListingsTable)
      .values(values)
      .onConflictDoUpdate({
        target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
        set: {
          title: sql`excluded.title`,
          neighborhoodRaw: sql`excluded.neighborhood_raw`,
          neighborhoodNormalized: sql`excluded.neighborhood_normalized`,
          bedrooms: sql`excluded.bedrooms`,
          bathrooms: sql`excluded.bathrooms`,
          maxGuests: sql`excluded.max_guests`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          amenitiesRaw: sql`excluded.amenities_raw`,
          ratingOverall: sql`excluded.rating_overall`,
          ratingCount: sql`excluded.rating_count`,
          reviewCount: sql`excluded.review_count`,
          nightlyPriceUsd: sql`excluded.nightly_price_usd`,
          scrapedAt: sql`excluded.scraped_at`,
          updatedAt: new Date(),
        },
      });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  VRBO Refresher — VallartaPulse                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  const seeds = await loadSeedRows();
  console.log(`Found ${seeds.length} existing VRBO row(s) to refresh (cap: ${MAX_LISTINGS}).`);

  if (seeds.length === 0) {
    console.log("Nothing to do — no VRBO seed rows in rental_listings yet.");
    console.log("To start feeding VRBO data, populate seed rows first (a discovery");
    console.log("driver under scripts/src/ is the next piece of work — see");
    console.log("docs/data-feeding.md → 'Out of scope' section).");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i];
    process.stdout.write(`  [${i + 1}/${seeds.length}] ${seed.sourceUrl} … `);
    const r = await refreshOne(seed);
    if (r.ok) { ok++; console.log("OK"); }
    else      { failed++; console.log(`FAIL — ${r.error}`); }
    if (i < seeds.length - 1) await sleep(MIN_DELAY_MS);
  }

  console.log(`\nDone. refreshed=${ok} failed=${failed} total=${seeds.length}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("vrbo-scrape failed:", e);
  process.exit(1);
});
