/**
 * scripts/backfill-from-listing-details.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Retroactive Stage B back-write: applies the same GREATEST/COALESCE UPDATE
 * pattern that airbnb-detail-runner.ts now runs at the end of every successful
 * enrichment, to historic listing_details rows whose `normalized_fields` JSON
 * was never propagated into `rental_listings.{bedrooms,bathrooms,max_guests,
 * latitude,longitude,rating_overall,review_count}`.
 *
 * Why: Stage B (back-write at enrichment time) was deployed mid-session.
 * Every listing enriched before that deployment has the data sitting in
 * listing_details.normalized_fields but invisible to the comp engine because
 * the canonical columns were never updated.
 *
 * Safe to re-run: GREATEST/COALESCE never destroy existing real values.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-from-listing-details.ts
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-from-listing-details.ts --dry-run
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-from-listing-details.ts --region=puerto_vallarta
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

interface Args {
  region: string | null;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = { region: "puerto_vallarta", dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--all-regions") out.region = null;
    else if (a.startsWith("--region=")) out.region = a.slice("--region=".length);
  }
  return out;
}

async function coverage(region: string | null): Promise<{ br: number; ba: number; guests: number; latlng: number; rating: number; total: number }> {
  const r = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE bedrooms       > 0)::int        AS br,
      COUNT(*) FILTER (WHERE bathrooms      > 0)::int        AS ba,
      COUNT(*) FILTER (WHERE max_guests     IS NOT NULL)::int AS guests,
      COUNT(*) FILTER (WHERE latitude       IS NOT NULL)::int AS latlng,
      COUNT(*) FILTER (WHERE rating_overall IS NOT NULL)::int AS rating,
      COUNT(*)::int                                          AS total
    FROM rental_listings
    WHERE source_platform='airbnb'
      AND (${region}::text IS NULL OR parent_region_bucket = ${region})
  `);
  return (r as unknown as { rows: Array<{ br: number; ba: number; guests: number; latlng: number; rating: number; total: number }> }).rows[0];
}

async function main(): Promise<void> {
  const args = parseArgs();

  const before = await coverage(args.region);
  console.log(
    `[backfill-ld] region=${args.region ?? "ALL"} dryRun=${args.dryRun}\n` +
    `[backfill-ld] BEFORE: br=${before.br} ba=${before.ba} guests=${before.guests} latlng=${before.latlng} rating=${before.rating} (of ${before.total} total)`
  );

  // For each listing, take the LATEST successful (ok or partial) enrichment
  // record. parse_fail rows are skipped — their normalized_fields contain only
  // partially-populated parses we don't want to bias on.
  const r = await db.execute(sql`
    SELECT DISTINCT ON (ld.listing_id)
      ld.listing_id,
      ld.parse_status,
      ld.normalized_fields
    FROM listing_details ld
    JOIN rental_listings rl ON rl.id = ld.listing_id
    WHERE ld.parse_status IN ('ok', 'partial')
      AND rl.source_platform = 'airbnb'
      AND (${args.region}::text IS NULL OR rl.parent_region_bucket = ${args.region})
    ORDER BY ld.listing_id, ld.enriched_at DESC
  `);
  const rows = (r as unknown as {
    rows: Array<{
      listing_id: number;
      parse_status: string;
      normalized_fields: Record<string, unknown>;
    }>;
  }).rows;

  let writes = 0, examined = 0, skipped = 0;
  let brHits = 0, baHits = 0, guestsHits = 0, latlngHits = 0, ratingHits = 0;

  for (const row of rows) {
    examined++;
    const n = row.normalized_fields ?? {};

    const bedrooms     = typeof n.bedrooms     === "number" ? n.bedrooms     : null;
    const bathrooms    = typeof n.bathrooms    === "number" ? n.bathrooms    : null;
    const maxGuests    = typeof n.maxGuests    === "number" ? n.maxGuests    : null;
    const latitude     = typeof n.latitude     === "number" ? n.latitude     : null;
    const longitude    = typeof n.longitude    === "number" ? n.longitude    : null;
    const ratingOverall= typeof n.ratingOverall === "number" ? n.ratingOverall : null;
    const reviewCount  = typeof n.reviewCount  === "number" ? n.reviewCount  : null;

    // Skip rows that have no useful data to write
    if (
      (bedrooms ?? 0) <= 0 &&
      (bathrooms ?? 0) <= 0 &&
      maxGuests === null &&
      latitude === null &&
      ratingOverall === null
    ) {
      skipped++;
      continue;
    }

    if (bedrooms     !== null && bedrooms > 0)  brHits++;
    if (bathrooms    !== null && bathrooms > 0) baHits++;
    if (maxGuests    !== null) guestsHits++;
    if (latitude     !== null && longitude !== null) latlngHits++;
    if (ratingOverall !== null) ratingHits++;

    if (!args.dryRun) {
      await db.execute(sql`
        UPDATE rental_listings
        SET
          bedrooms       = GREATEST(rental_listings.bedrooms,  ${bedrooms ?? 0}),
          bathrooms      = GREATEST(rental_listings.bathrooms, ${bathrooms ?? 0}),
          max_guests     = COALESCE(rental_listings.max_guests,     ${maxGuests}),
          latitude       = COALESCE(rental_listings.latitude,       ${latitude}),
          longitude      = COALESCE(rental_listings.longitude,      ${longitude}),
          rating_overall = COALESCE(rental_listings.rating_overall, ${ratingOverall}),
          review_count   = COALESCE(rental_listings.review_count,   ${reviewCount}),
          updated_at     = NOW()
        WHERE id = ${row.listing_id}
      `);
    }
    writes++;
  }

  console.log(
    `[backfill-ld] examined=${examined}  writes=${writes}  skipped(no_data)=${skipped}\n` +
    `[backfill-ld] field hit counts (in source rows): br=${brHits} ba=${baHits} guests=${guestsHits} latlng=${latlngHits} rating=${ratingHits}`
  );

  if (!args.dryRun) {
    const after = await coverage(args.region);
    console.log(
      `[backfill-ld] AFTER:  br=${after.br} ba=${after.ba} guests=${after.guests} latlng=${after.latlng} rating=${after.rating} (of ${after.total} total)\n` +
      `[backfill-ld] DELTA:  br +${after.br - before.br}  ba +${after.ba - before.ba}  guests +${after.guests - before.guests}  latlng +${after.latlng - before.latlng}  rating +${after.rating - before.rating}`
    );
  } else {
    console.log("[backfill-ld] DRY RUN — no DB writes performed.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-ld] fatal", err);
  process.exit(1);
});
