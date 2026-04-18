/**
 * scripts/enrich-airbnb-listings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CLI: pull rental_listings rows that need Airbnb listing-detail enrichment
 * and run them through enrichOneAirbnbListing one at a time. Local-only
 * worker — no Railway, no GitHub, no VRBO, no discovery changes.
 *
 * Candidate selection (mirrors the Phase-2b enrichment brief):
 *   - source_platform = 'airbnb'
 *   - source_url IS NOT NULL
 *   - NO listing_details row exists for that listing yet
 *   - normalized_neighborhood_bucket IN (--bucket [...]),
 *     defaulting to the three Phase-2b validation buckets
 *
 * Reporting includes coverage % per field — bedrooms / bathrooms / guest
 * cap / amenities / lat-lng — plus three sample enriched rows.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/enrich-airbnb-listings.ts \
 *     --max-listings=10
 */

// Force blocking I/O on stdout/stderr. Without this, Node block-buffers
// writes when stdout is a pipe (e.g. backgrounded with redirect to a
// file), which prevents per-listing progress lines from showing up
// until the buffer fills (~16KB) or the process exits — making
// long-running batches look hung.
for (const stream of [process.stdout, process.stderr]) {
  const handle = (stream as unknown as { _handle?: { setBlocking?: (b: boolean) => void } })._handle;
  if (handle && typeof handle.setBlocking === "function") {
    handle.setBlocking(true);
  }
}

import { db } from "@workspace/db";
import { rentalListingsTable, listingDetailsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  enrichOneAirbnbListing,
  type EnrichResult,
} from "../../artifacts/api-server/src/lib/ingest/airbnb-detail-runner.js";
import { closeBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";

const DEFAULT_BUCKETS = [
  "Zona Romántica",
  "Amapas / Conchas Chinas",
  "Centro / Alta Vista",
];

interface CliArgs {
  maxListings: number;
  buckets: string[];
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let maxListings = 10;
  // Track whether the user passed any --bucket= flag. If they did, the
  // resulting list replaces the defaults. Multiple --bucket= flags accumulate
  // (e.g. `--bucket="Marina Vallarta" --bucket="Zona Romántica"` runs both).
  let userBuckets: string[] = [];
  let dryRun = false;
  for (const a of argv.slice(2)) {
    if (a.startsWith("--max-listings=")) maxListings = Number(a.split("=")[1]);
    else if (a.startsWith("--bucket=")) userBuckets.push(a.split("=").slice(1).join("="));
    else if (a === "--dry-run") dryRun = true;
  }
  const buckets = userBuckets.length > 0 ? userBuckets : DEFAULT_BUCKETS;
  if (!Number.isFinite(maxListings) || maxListings <= 0) maxListings = 10;
  return { maxListings, buckets, dryRun };
}

async function selectCandidates(buckets: string[], limit: number) {
  // LEFT JOIN approach: any rental_listings with no listing_details rows.
  // Order by id DESC so the test set leans toward the most recent
  // discovery observations.
  //
  // We expand the buckets array into individual parameter placeholders
  // (`$1, $2, $3`) via sql.join — passing the JS array straight to
  // drizzle's tag inlines it as a record literal, which Postgres
  // refuses to cast to text[].
  const bucketList: SQL = sql.join(
    buckets.map((b) => sql`${b}`),
    sql`, `
  );
  const rows = await db.execute(sql`
    SELECT rl.id,
           rl.external_id,
           rl.source_url,
           rl.normalized_neighborhood_bucket AS bucket,
           rl.title
    FROM rental_listings rl
    LEFT JOIN listing_details ld ON ld.listing_id = rl.id
    WHERE rl.source_platform = 'airbnb'
      AND rl.source_url IS NOT NULL
      AND ld.id IS NULL
      AND rl.normalized_neighborhood_bucket IN (${bucketList})
    ORDER BY rl.id DESC
    LIMIT ${limit}
  `);
  return (rows as unknown as { rows: Array<{ id: number; external_id: string | null; source_url: string; bucket: string; title: string }> }).rows;
}

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log("[enrich] starting Airbnb detail enrichment");
  console.log("[enrich] max-listings =", args.maxListings);
  console.log("[enrich] buckets      =", JSON.stringify(args.buckets));
  console.log("[enrich] dry-run      =", args.dryRun);

  const candidates = await selectCandidates(args.buckets, args.maxListings);
  console.log(`[enrich] ${candidates.length} candidate(s) selected\n`);

  const results: EnrichResult[] = [];
  for (const c of candidates) {
    const t0 = Date.now();
    process.stdout.write(`  → id=${c.id} ext=${c.external_id ?? "?"} bucket="${c.bucket}" ... `);
    const r = await enrichOneAirbnbListing(c.id, c.source_url, { dryRun: args.dryRun });
    const ms = Date.now() - t0;
    if (r.outcome === "enriched") {
      console.log(`OK [${r.parseStatus}] filled=${r.filledFieldCount}/17 in ${ms}ms`);
    } else if (r.outcome === "parse_fail") {
      console.log(`PARSE_FAIL filled=${r.filledFieldCount}/17 in ${ms}ms`);
    } else if (r.outcome === "blocked") {
      console.log(`BLOCKED (${r.errorMessage}) in ${ms}ms`);
    } else {
      console.log(`ERROR (${r.errorMessage}) in ${ms}ms`);
    }
    results.push(r);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const attempted = results.length;
  const enriched = results.filter((r) => r.outcome === "enriched").length;
  const parseFails = results.filter((r) => r.outcome === "parse_fail").length;
  const blocked = results.filter((r) => r.outcome === "blocked").length;
  const errored = results.filter((r) => r.outcome === "error").length;

  // Coverage on enriched (incl. partial) rows only — those are the rows
  // that actually had structured data to score.
  const ok = results.filter((r) => r.outcome === "enriched" && r.normalized);
  const denom = ok.length;
  const cov = (key: keyof NonNullable<EnrichResult["normalized"]>) =>
    ok.filter((r) => r.normalized && (r.normalized as unknown as Record<string, unknown>)[key] !== null).length;
  const covLatLng = ok.filter((r) => r.normalized?.latitude !== null && r.normalized?.longitude !== null).length;

  console.log("\n──────────────── enrichment summary ────────────────");
  console.log(`attempted          : ${attempted}`);
  console.log(`enriched (ok+part) : ${enriched}`);
  console.log(`parse failures     : ${parseFails}`);
  console.log(`blocked            : ${blocked}`);
  console.log(`transport errors   : ${errored}`);
  console.log("");
  console.log(`coverage on the ${denom} enriched row(s):`);
  console.log(`  bedrooms        : ${cov("bedrooms")} / ${denom} (${pct(cov("bedrooms"), denom)})`);
  console.log(`  bathrooms       : ${cov("bathrooms")} / ${denom} (${pct(cov("bathrooms"), denom)})`);
  console.log(`  maxGuests       : ${cov("maxGuests")} / ${denom} (${pct(cov("maxGuests"), denom)})`);
  console.log(`  amenities       : ${cov("amenities")} / ${denom} (${pct(cov("amenities"), denom)})`);
  console.log(`  latitude+lng    : ${covLatLng} / ${denom} (${pct(covLatLng, denom)})`);
  console.log(`  bedCount (beds) : ${cov("bedCount")} / ${denom} (${pct(cov("bedCount"), denom)})`);
  console.log(`  rating          : ${cov("ratingOverall")} / ${denom} (${pct(cov("ratingOverall"), denom)})`);
  console.log(`  review count    : ${cov("reviewCount")} / ${denom} (${pct(cov("reviewCount"), denom)})`);
  console.log(`  image count     : ${cov("imageCount")} / ${denom} (${pct(cov("imageCount"), denom)})`);
  console.log(`  hostName        : ${cov("hostName")} / ${denom} (${pct(cov("hostName"), denom)})`);

  // ── 3 sample enriched rows ────────────────────────────────────────────
  console.log("\n──────────────── 3 sample enriched rows ────────────────");
  const samples = ok.slice(0, 3);
  for (const s of samples) {
    const n = s.normalized!;
    console.log(`\n  listing id=${s.listingId}  url=${s.url}`);
    console.log(`    title         : ${n.title?.slice(0, 80) ?? "(null)"}`);
    console.log(`    propertyType  : ${n.propertyType ?? "(null)"}`);
    console.log(`    maxGuests     : ${n.maxGuests ?? "(null)"}     bedCount: ${n.bedCount ?? "(null)"}`);
    console.log(`    bedrooms/bath : ${n.bedrooms ?? "(null)"} / ${n.bathrooms ?? "(null)"}`);
    console.log(`    amenities     : ${n.amenities === null ? "(null)" : `${n.amenities.length} items`}`);
    console.log(`    lat / lng     : ${n.latitude ?? "(null)"} / ${n.longitude ?? "(null)"}`);
    console.log(`    rating / revs : ${n.ratingOverall ?? "(null)"} / ${n.reviewCount ?? "(null)"}`);
    console.log(`    images        : ${n.imageCount ?? "(null)"}`);
    console.log(`    locality      : addr="${n.rawLocationHints.addressLocality ?? ""}"  apolloCity="${n.rawLocationHints.apolloCity ?? ""}"`);
    console.log(`    extId / pdp   : ${n.externalListingId ?? "(null)"} / ${n.pdpType ?? "(null)"}`);
  }

  await closeBrowser();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[enrich] FATAL:", err);
  try { await closeBrowser(); } catch {}
  process.exit(1);
});
