/**
 * scripts/backfill-bedrooms-from-text.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time offline backfill: re-extracts bedroom / bathroom counts from
 * `rental_listings.title` (and `listing_details.normalized_fields.description`
 * when available) using the EN/ES regex helpers in airbnb-detail-adapter.ts.
 *
 * Why: 286/290 PV airbnb listings currently have bedrooms=0 because (a) the
 * persistence pipeline used to default missing values to 0, and (b) the detail
 * enrichment wrote bedrooms only into listing_details JSON — not back to the
 * canonical rental_listings.bedrooms column. Both bugs are now fixed in
 * persist.ts / rental-ingest.ts / airbnb-detail-runner.ts. This script clears
 * the historic backlog without re-scraping.
 *
 * Updates are guarded with GREATEST() so a real existing value is never
 * destroyed by a regex miss.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-bedrooms-from-text.ts
 *   pnpm --filter @workspace/scripts exec tsx src/backfill-bedrooms-from-text.ts --region=puerto_vallarta --dry-run
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  extractBedroomsFromText,
  extractBathroomsFromText,
} from "../../artifacts/api-server/src/lib/ingest/airbnb-detail-adapter.js";

interface Args {
  region: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const out: Args = { region: "puerto_vallarta", dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") out.dryRun = true;
    else if (a.startsWith("--region=")) out.region = a.slice("--region=".length);
  }
  return out;
}

async function coverage(region: string): Promise<{ total: number; with_br: number; with_ba: number }> {
  const r = await db.execute(sql`
    SELECT
      COUNT(*)::int                                 AS total,
      COUNT(*) FILTER (WHERE bedrooms  > 0)::int    AS with_br,
      COUNT(*) FILTER (WHERE bathrooms > 0)::int    AS with_ba
    FROM rental_listings
    WHERE source_platform='airbnb' AND parent_region_bucket=${region}
  `);
  const row = (r as unknown as { rows: Array<{ total: number; with_br: number; with_ba: number }> }).rows[0];
  return row;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const before = await coverage(args.region);
  console.log(
    `[backfill] region=${args.region} dryRun=${args.dryRun}\n` +
    `[backfill] BEFORE: total=${before.total}  with_bedrooms=${before.with_br} (${pct(before.with_br, before.total)})  with_bathrooms=${before.with_ba} (${pct(before.with_ba, before.total)})`
  );

  // Pull every PV airbnb row + any enriched description.
  // We re-evaluate even rows that already have bedrooms>0 (in case a later
  // crawl mistakenly overwrote a real value) — GREATEST() in the UPDATE
  // guarantees we never lower a real number.
  const r = await db.execute(sql`
    SELECT
      rl.id,
      rl.title,
      rl.bedrooms  AS cur_br,
      rl.bathrooms AS cur_ba,
      ld.normalized_fields->>'description' AS description
    FROM rental_listings rl
    LEFT JOIN LATERAL (
      SELECT normalized_fields
      FROM listing_details
      WHERE listing_id = rl.id AND parse_status IN ('ok', 'partial')
      ORDER BY enriched_at DESC
      LIMIT 1
    ) ld ON TRUE
    WHERE rl.source_platform='airbnb' AND rl.parent_region_bucket=${args.region}
    ORDER BY rl.id
  `);
  const rows = (r as unknown as {
    rows: Array<{ id: number; title: string | null; cur_br: number; cur_ba: number; description: string | null }>;
  }).rows;

  let brWrites = 0, baWrites = 0, examined = 0;
  const samples: Array<{ id: number; title: string; br: number | null; ba: number | null }> = [];

  for (const row of rows) {
    examined++;
    const text = `${row.title ?? ""}\n${row.description ?? ""}`;
    const br = extractBedroomsFromText(text);
    const ba = extractBathroomsFromText(text);

    const wantsBrUpdate = br !== null && br > row.cur_br;
    const wantsBaUpdate = ba !== null && ba > row.cur_ba;

    if (!wantsBrUpdate && !wantsBaUpdate) continue;

    if (samples.length < 8) {
      samples.push({ id: row.id, title: (row.title ?? "").slice(0, 60), br, ba });
    }

    if (!args.dryRun) {
      await db.execute(sql`
        UPDATE rental_listings
        SET
          bedrooms   = GREATEST(rental_listings.bedrooms,  ${br ?? 0}),
          bathrooms  = GREATEST(rental_listings.bathrooms, ${ba ?? 0}),
          updated_at = NOW()
        WHERE id = ${row.id}
      `);
    }
    if (wantsBrUpdate) brWrites++;
    if (wantsBaUpdate) baWrites++;
  }

  console.log(
    `[backfill] examined=${examined}  bedroom_writes=${brWrites}  bathroom_writes=${baWrites}`
  );
  console.log("[backfill] sample updates:");
  for (const s of samples) {
    console.log(`  id=${s.id}  br=${s.br}  ba=${s.ba}  title="${s.title}"`);
  }

  if (!args.dryRun) {
    const after = await coverage(args.region);
    const brDelta = after.with_br - before.with_br;
    const baDelta = after.with_ba - before.with_ba;
    console.log(
      `[backfill] AFTER:  total=${after.total}  with_bedrooms=${after.with_br} (${pct(after.with_br, after.total)})  with_bathrooms=${after.with_ba} (${pct(after.with_ba, after.total)})`
    );
    console.log(`[backfill] DELTA:  bedrooms +${brDelta}  bathrooms +${baDelta}`);
  } else {
    console.log("[backfill] DRY RUN — no DB writes performed.");
  }

  process.exit(0);
}

function pct(n: number, d: number): string {
  if (d === 0) return "0%";
  return `${((n / d) * 100).toFixed(1)}%`;
}

main().catch((err) => {
  console.error("[backfill] fatal", err);
  process.exit(1);
});
