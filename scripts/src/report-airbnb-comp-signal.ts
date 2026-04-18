/**
 * scripts/report-airbnb-comp-signal.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2c report: read-only summary over the airbnb_comp_signal view.
 * No source-table mutation, no fetches — pure aggregation.
 *
 * Sections:
 *   1. Per-bucket counts (total / price / geo / rating / detail / minimal /
 *      rich) across the three Phase-2b PV buckets
 *   2. Avg + median derived nightly per bucket (USD-only; preserves nulls)
 *   3. 5 sample merged comp rows (one per bucket where available)
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/report-airbnb-comp-signal.ts
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const PV_BUCKETS = [
  "Zona Romántica",
  "Amapas / Conchas Chinas",
  "Centro / Alta Vista",
] as const;

// Drizzle's `sql` template flattens JS arrays into N positional params, which
// PostgreSQL then can't apply `= ANY()` to. `sql.join` builds a true SQL list
// of distinct positional params suitable for `IN (…)`.
const bucketsInList = sql.join(
  PV_BUCKETS.map((b) => sql`${b}`),
  sql`, `
);

interface BucketRow {
  bucket: string;
  total: number;
  with_price: number;
  with_geo: number;
  with_rating: number;
  with_detail: number;
  minimal_usable: number;
  rich_usable: number;
  avg_nightly_mxn: number | null;
  median_nightly_mxn: number | null;
  avg_nightly_usd: number | null;
  median_nightly_usd: number | null;
}

interface SampleRow {
  listing_id: number;
  bucket: string | null;
  external_listing_id: string | null;
  canonical_url: string | null;
  derived_nightly_price: number | null;
  currency: string | null;
  stay_length_nights: number | null;
  rating_overall: number | null;
  review_count: number | null;
  lat: number | null;
  lng: number | null;
  max_guests: number | null;
  bed_count: number | null;
  property_type: string | null;
  image_count: number | null;
  title: string | null;
  has_price_signal: boolean;
  has_geo_signal: boolean;
  has_rating_signal: boolean;
  has_detail_signal: boolean;
  is_comp_usable_minimal: boolean;
  is_comp_usable_rich: boolean;
}

function fmt(n: number | null, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

async function main(): Promise<void> {
  // ── 1+2. Per-bucket aggregates ─────────────────────────────────────────
  const aggRes = (await db.execute(sql`
    SELECT
      normalized_neighborhood_bucket                                   AS bucket,
      COUNT(*)::int                                                    AS total,
      SUM(CASE WHEN has_price_signal       THEN 1 ELSE 0 END)::int     AS with_price,
      SUM(CASE WHEN has_geo_signal         THEN 1 ELSE 0 END)::int     AS with_geo,
      SUM(CASE WHEN has_rating_signal      THEN 1 ELSE 0 END)::int     AS with_rating,
      SUM(CASE WHEN has_detail_signal      THEN 1 ELSE 0 END)::int     AS with_detail,
      SUM(CASE WHEN is_comp_usable_minimal THEN 1 ELSE 0 END)::int     AS minimal_usable,
      SUM(CASE WHEN is_comp_usable_rich    THEN 1 ELSE 0 END)::int     AS rich_usable,
      AVG(CASE WHEN currency = 'MXN' THEN derived_nightly_price END)::float8
                                                                       AS avg_nightly_mxn,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY CASE WHEN currency = 'MXN' THEN derived_nightly_price END
      )::float8                                                        AS median_nightly_mxn,
      AVG(CASE WHEN currency = 'USD' THEN derived_nightly_price END)::float8
                                                                       AS avg_nightly_usd,
      PERCENTILE_CONT(0.5) WITHIN GROUP (
        ORDER BY CASE WHEN currency = 'USD' THEN derived_nightly_price END
      )::float8                                                        AS median_nightly_usd
    FROM airbnb_comp_signal
    WHERE normalized_neighborhood_bucket IN (${bucketsInList})
    GROUP BY normalized_neighborhood_bucket
    ORDER BY bucket
  `)) as unknown as { rows: BucketRow[] };

  const buckets = aggRes.rows;

  console.log("=".repeat(96));
  console.log("Phase 2c — airbnb_comp_signal report");
  console.log("=".repeat(96));
  console.log();
  console.log("Per-bucket coverage (3 PV buckets):");
  console.log();
  const header = [
    "bucket".padEnd(26),
    "total".padStart(6),
    "price".padStart(6),
    "geo".padStart(5),
    "rating".padStart(7),
    "detail".padStart(7),
    "min✓".padStart(6),
    "rich✓".padStart(6),
    "avgMXN".padStart(9),
    "medMXN".padStart(9),
    "avgUSD".padStart(8),
    "medUSD".padStart(8),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const b of buckets) {
    console.log(
      [
        (b.bucket ?? "—").padEnd(26),
        String(b.total).padStart(6),
        String(b.with_price).padStart(6),
        String(b.with_geo).padStart(5),
        String(b.with_rating).padStart(7),
        String(b.with_detail).padStart(7),
        String(b.minimal_usable).padStart(6),
        String(b.rich_usable).padStart(6),
        fmt(b.avg_nightly_mxn).padStart(9),
        fmt(b.median_nightly_mxn).padStart(9),
        fmt(b.avg_nightly_usd).padStart(8),
        fmt(b.median_nightly_usd).padStart(8),
      ].join(" ")
    );
  }
  console.log();
  console.log(
    "Legend: total=Airbnb listings, price/geo/rating/detail=signals present, " +
      "min✓=is_comp_usable_minimal, rich✓=is_comp_usable_rich. " +
      "avgMXN/medMXN/avgUSD/medUSD computed only from rows whose latest " +
      "observation matches that currency (—=no rows in that currency yet)."
  );

  // ── 3. Sample merged comp rows ─────────────────────────────────────────
  // Pull the top minimal-usable rows, biased toward rich-usable so the
  // sample is informative. One per bucket if possible, then fill from
  // whichever bucket has the most data.
  const sampleRes = (await db.execute(sql`
    WITH ranked AS (
      SELECT
        s.listing_id,
        s.normalized_neighborhood_bucket AS bucket,
        s.external_listing_id,
        s.canonical_url,
        s.derived_nightly_price,
        s.currency,
        s.stay_length_nights,
        s.rating_overall,
        s.review_count,
        s.lat,
        s.lng,
        s.max_guests,
        s.bed_count,
        s.property_type,
        s.image_count,
        s.title,
        s.has_price_signal,
        s.has_geo_signal,
        s.has_rating_signal,
        s.has_detail_signal,
        s.is_comp_usable_minimal,
        s.is_comp_usable_rich,
        s.observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY s.normalized_neighborhood_bucket
          ORDER BY s.is_comp_usable_rich DESC,
                   s.has_detail_signal   DESC,
                   s.has_geo_signal      DESC,
                   s.observed_at         DESC
        ) AS rk_in_bucket
      FROM airbnb_comp_signal s
      WHERE s.normalized_neighborhood_bucket IN (${bucketsInList})
        AND s.is_comp_usable_minimal
    )
    SELECT * FROM ranked
    ORDER BY rk_in_bucket ASC,
             is_comp_usable_rich DESC,
             has_detail_signal   DESC
    LIMIT 5
  `)) as unknown as { rows: SampleRow[] };

  console.log();
  console.log("─".repeat(96));
  console.log("5 sample merged comp rows (preferring rich-usable, then detail-enriched):");
  console.log("─".repeat(96));
  for (const r of sampleRes.rows) {
    const flags = [
      r.has_price_signal ? "price" : null,
      r.has_geo_signal ? "geo" : null,
      r.has_rating_signal ? "rating" : null,
      r.has_detail_signal ? "detail" : null,
      r.is_comp_usable_rich
        ? "RICH"
        : r.is_comp_usable_minimal
        ? "MIN"
        : null,
    ]
      .filter(Boolean)
      .join("·");
    console.log();
    console.log(
      `• listing_id=${r.listing_id}  ext=${r.external_listing_id ?? "—"}  ` +
        `bucket="${r.bucket ?? "—"}"  [${flags}]`
    );
    console.log(`    title:        ${(r.title ?? "—").slice(0, 80)}`);
    console.log(
      `    price:        ${fmt(r.derived_nightly_price)} ${r.currency ?? "—"} ` +
        `/night  (stay=${r.stay_length_nights ?? "—"}n)`
    );
    console.log(
      `    rating:       ${fmt(r.rating_overall)} (${r.review_count ?? "—"} reviews) · imgs=${
        r.image_count ?? "—"
      }`
    );
    console.log(
      `    geo:          lat=${fmt(r.lat, 5)} lng=${fmt(r.lng, 5)}`
    );
    console.log(
      `    capacity:     guests=${r.max_guests ?? "—"} beds=${r.bed_count ?? "—"} ` +
        `type=${r.property_type ?? "—"}`
    );
    console.log(`    url:          ${r.canonical_url ?? "—"}`);
  }
  console.log();
  console.log("=".repeat(96));
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("report-airbnb-comp-signal failed:", err);
    process.exit(1);
  });
