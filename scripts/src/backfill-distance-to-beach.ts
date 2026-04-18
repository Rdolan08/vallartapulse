/**
 * scripts/backfill-distance-to-beach.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time offline backfill: computes `rental_listings.distance_to_beach_m`
 * for every listing that has lat/lon but no distance, using the existing
 * `distanceToNearestBeachM()` helper in rental-normalize.ts (Haversine to
 * the nearest of 7 named PV beach access points).
 *
 * Why: distance_to_beach_m is a Layer-3 comp signal (V2 comps engine uses it
 * for beach-tier matching with weights 13-20% in Zona Romántica / Amapas).
 * Currently only 1/290 PV airbnb listings has a value, despite 229/290
 * already having lat/lon — pure data-derivation gap, no scraping required.
 *
 * The compute is the canonical helper: same function used by the live ingest
 * path, so backfilled values are byte-identical to what a future re-ingest
 * would produce.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-distance-to-beach.ts
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-distance-to-beach.ts --dry-run
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-distance-to-beach.ts --region=riviera_nayarit
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { distanceToNearestBeachM } from "../../artifacts/api-server/src/lib/rental-normalize.js";

interface Args {
  region: string | null;  // null = all regions
  dryRun: boolean;
  recompute: boolean;     // if true, also recompute rows that already have a value
}

function parseArgs(): Args {
  const out: Args = { region: "puerto_vallarta", dryRun: false, recompute: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--recompute") out.recompute = true;
    else if (a === "--all-regions") out.region = null;
    else if (a.startsWith("--region=")) out.region = a.slice("--region=".length);
  }
  return out;
}

async function coverage(region: string | null): Promise<{ total: number; with_dist: number; with_latlng: number }> {
  const r = await db.execute(sql`
    SELECT
      COUNT(*)::int                                            AS total,
      COUNT(*) FILTER (WHERE distance_to_beach_m IS NOT NULL)::int AS with_dist,
      COUNT(*) FILTER (WHERE latitude IS NOT NULL)::int        AS with_latlng
    FROM rental_listings
    WHERE source_platform='airbnb'
      AND (${region}::text IS NULL OR parent_region_bucket = ${region})
  `);
  return (r as unknown as { rows: Array<{ total: number; with_dist: number; with_latlng: number }> }).rows[0];
}

async function main(): Promise<void> {
  const args = parseArgs();

  const before = await coverage(args.region);
  console.log(
    `[backfill-beach] region=${args.region ?? "ALL"} dryRun=${args.dryRun} recompute=${args.recompute}\n` +
    `[backfill-beach] BEFORE: total=${before.total}  with_distance=${before.with_dist} (${pct(before.with_dist, before.total)})  with_latlng=${before.with_latlng} (${pct(before.with_latlng, before.total)})`
  );

  // Pull every airbnb listing with lat/lon. Skip ones that already have a
  // distance unless --recompute. The canonical helper is deterministic for a
  // given (lat, lon, BEACH_REFERENCE_POINTS), so re-running should be a no-op
  // on the same input.
  const r = await db.execute(sql`
    SELECT id, latitude, longitude, distance_to_beach_m, normalized_neighborhood_bucket
    FROM rental_listings
    WHERE source_platform='airbnb'
      AND latitude IS NOT NULL AND longitude IS NOT NULL
      AND (${args.region}::text IS NULL OR parent_region_bucket = ${args.region})
      AND (${args.recompute} OR distance_to_beach_m IS NULL)
    ORDER BY id
  `);
  const rows = (r as unknown as {
    rows: Array<{
      id: number;
      latitude: number | string;
      longitude: number | string;
      distance_to_beach_m: number | null;
      normalized_neighborhood_bucket: string | null;
    }>;
  }).rows;

  let writes = 0, examined = 0;
  const samples: Array<{ id: number; bucket: string; dist: number }> = [];
  // Sanity-check distribution (catch mis-located rows: e.g. dist > 5km is suspicious in PV).
  const distHist: Record<string, number> = { "0-100m": 0, "101-300m": 0, "301-500m": 0, "501-1km": 0, "1-3km": 0, ">3km": 0 };

  for (const row of rows) {
    examined++;
    const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
    const lon = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
    const dist = distanceToNearestBeachM(lat, lon);
    if (dist === null) continue;

    if (dist <= 100) distHist["0-100m"]++;
    else if (dist <= 300) distHist["101-300m"]++;
    else if (dist <= 500) distHist["301-500m"]++;
    else if (dist <= 1000) distHist["501-1km"]++;
    else if (dist <= 3000) distHist["1-3km"]++;
    else distHist[">3km"]++;

    if (samples.length < 10) {
      samples.push({ id: row.id, bucket: row.normalized_neighborhood_bucket ?? "?", dist });
    }

    if (!args.dryRun) {
      await db.execute(sql`
        UPDATE rental_listings
        SET distance_to_beach_m = ${dist}, updated_at = NOW()
        WHERE id = ${row.id}
      `);
    }
    writes++;
  }

  console.log(`[backfill-beach] examined=${examined}  writes=${writes}`);
  console.log("[backfill-beach] distance histogram:");
  for (const [bucket, n] of Object.entries(distHist)) {
    console.log(`  ${bucket.padEnd(10)} ${n}`);
  }
  console.log("[backfill-beach] sample updates:");
  for (const s of samples) {
    console.log(`  id=${s.id}  dist=${s.dist}m  bucket=${s.bucket}`);
  }

  if (!args.dryRun) {
    const after = await coverage(args.region);
    console.log(
      `[backfill-beach] AFTER:  total=${after.total}  with_distance=${after.with_dist} (${pct(after.with_dist, after.total)})  with_latlng=${after.with_latlng} (${pct(after.with_latlng, after.total)})`
    );
    console.log(`[backfill-beach] DELTA: +${after.with_dist - before.with_dist} listings`);
  } else {
    console.log("[backfill-beach] DRY RUN — no DB writes performed.");
  }

  process.exit(0);
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error("[backfill-beach] fatal", err);
  process.exit(1);
});
