/**
 * vrbo-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * VRBO discovery + refresh driver for VallartaPulse.
 *
 * Each run:
 *   1. Discovers VRBO listings on the Puerto Vallarta search-results pages
 *      via vrbo-search-adapter.discoverVrboListings(). No credentials —
 *      VRBO serves full HTML to datacenter IPs given browser headers.
 *   2. Loads every existing rental_listings row with source_platform='vrbo'
 *      so we re-refresh stale rows that may have dropped out of search.
 *   3. Takes the union (discovered ∪ existing), capped at MAX_LISTINGS per
 *      run, and for each URL fetches full detail via fetchVrboListing()
 *      then upserts on (source_platform, source_url). Inserts new rows,
 *      updates existing ones — same path either way.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run scrape:vrbo
 */

import { sql, eq } from "drizzle-orm";
import { db, rentalListingsTable } from "@workspace/db";
import { fetchVrboListing } from "../../artifacts/api-server/src/lib/ingest/vrbo-adapter.js";
import { discoverVrboListings } from "../../artifacts/api-server/src/lib/ingest/vrbo-search-adapter.js";
import { closeBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";

const SOURCE_PLATFORM = "vrbo";
const MAX_LISTINGS = 200;
const MIN_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function loadExistingUrls(): Promise<string[]> {
  const rows = await db
    .select({ sourceUrl: rentalListingsTable.sourceUrl })
    .from(rentalListingsTable)
    .where(eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM));
  return rows
    .map((r) => r.sourceUrl)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
}

async function refreshOne(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const listing = await fetchVrboListing(url);
    await db
      .insert(rentalListingsTable)
      .values({
        sourcePlatform: SOURCE_PLATFORM,
        // Always upsert against the URL we used to fetch. Even if the adapter
        // normalizes to a different canonical form, this keeps the row in the
        // DB the one that gets refreshed — no canonical-vs-legacy duplicates.
        sourceUrl: url,
        externalId: listing.source_listing_id ?? null,
        title: listing.title ?? "VRBO listing",
        neighborhoodRaw: listing.neighborhood ?? "unknown",
        neighborhoodNormalized: listing.neighborhood ?? "unclassified",
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
      })
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
  console.log("║  VRBO Discovery + Refresh — VallartaPulse                    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");

  console.log("Discovering VRBO listings from Puerto Vallarta search pages…");
  const discovery = await discoverVrboListings({ delayMs: 2000 });
  console.log(`  pages scraped: ${discovery.pagesScraped}`);
  console.log(`  URLs discovered: ${discovery.listingUrls.length}`);
  if (discovery.errors.length > 0) {
    console.log(`  (${discovery.errors.length} page error(s) — continuing)`);
    for (const e of discovery.errors.slice(0, 5)) console.log(`     · ${e}`);
  }
  if (discovery.debugFirstPageHrefs && discovery.debugFirstPageHrefs.length > 0) {
    console.log("  DEBUG: 0 IDs extracted — sample hrefs from first page:");
    for (const h of discovery.debugFirstPageHrefs) console.log(`     · ${h}`);
  }

  const existingUrls = await loadExistingUrls();
  console.log(`Existing VRBO rows in DB: ${existingUrls.length}`);

  // Union: discovered ∪ existing. Existing rows go first so they're always
  // refreshed within the cap; newly-discovered URLs fill any remaining slots.
  const seen = new Set<string>();
  const orderedUrls: string[] = [];
  for (const u of existingUrls) {
    if (!seen.has(u)) { seen.add(u); orderedUrls.push(u); }
  }
  for (const u of discovery.listingUrls) {
    if (!seen.has(u)) { seen.add(u); orderedUrls.push(u); }
  }
  const urls = orderedUrls.slice(0, MAX_LISTINGS);
  const newCount = urls.filter((u) => !existingUrls.includes(u)).length;
  console.log(`Total to process this run: ${urls.length}  (new: ${newCount}, refresh: ${urls.length - newCount}, cap: ${MAX_LISTINGS})`);

  if (urls.length === 0) {
    console.log("Nothing to do — no VRBO URLs from discovery or DB.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    process.stdout.write(`  [${i + 1}/${urls.length}] ${url} … `);
    const r = await refreshOne(url);
    if (r.ok) { ok++; console.log("OK"); }
    else      { failed++; console.log(`FAIL — ${r.error}`); }
    if (i < urls.length - 1) await sleep(MIN_DELAY_MS);
  }

  console.log(`\nDone. refreshed=${ok} failed=${failed} total=${urls.length}`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("vrbo-scrape failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // browser-fetch caches a Chromium instance — without explicit teardown
    // the Node process stays alive and the GH workflow times out at 30 min.
    try { await closeBrowser(); } catch { /* ignore */ }
  });
