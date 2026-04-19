/**
 * scripts/report-vv-coverage.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Operator health report: surfaces vacation_vallarta listings whose
 * forward-365 priced-day count is below the coverage threshold (default 80%).
 *
 * Why this exists:
 *   The VV calendar adapter parses seasonal-text brackets from Squarespace
 *   listing pages. A handful of listings (e.g. /villa-savana) typeset their
 *   pricing in a table where the price cell is detached from the season
 *   header — the parser only catches the holiday bracket and emits ~17 priced
 *   days out of 365. There is no other surfaced signal that a particular
 *   listing is under-covered, so silently-thin coverage rots.
 *
 * What it does:
 *   For every active vacation_vallarta listing in `rental_listings`, counts
 *   distinct dates in `rental_prices_by_date` falling in the forward-365 window
 *   that have a non-null `nightly_price_usd`. Lists every listing whose count
 *   is below the threshold (default 80% = 292 / 365), with id, title, source
 *   URL, and priced_days / horizon so an operator can open the page and either
 *   fix the parser or hand-curate a bracket override.
 *
 * Read-only. No mutations.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/report-vv-coverage.ts
 *
 * Env:
 *   DATABASE_URL              required
 *   VV_COVERAGE_THRESHOLD     fraction of horizon required to be "covered"
 *                             (default 0.8); listings strictly below are
 *                             flagged for manual review
 *   VV_COVERAGE_HORIZON       forward-day window to evaluate (default 365)
 */
import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";

function parseIntEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.warn(`[report-vv-coverage] ignoring ${name}="${raw}" (not a number); using ${fallback}`);
    return fallback;
  }
  return Math.max(min, n);
}

function parseFractionEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[report-vv-coverage] ignoring ${name}="${raw}" (not a number); using ${fallback}`);
    return fallback;
  }
  return Math.min(1, Math.max(0, n));
}

const HORIZON = parseIntEnv("VV_COVERAGE_HORIZON", 365, 1);
const THRESHOLD = parseFractionEnv("VV_COVERAGE_THRESHOLD", 0.8);
const THRESHOLD_DAYS = Math.ceil(HORIZON * THRESHOLD);

interface CoverageRow {
  listing_id: number;
  title: string | null;
  source_url: string;
  priced_days: number;
  last_scraped_at: string | null;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<number> {
  const res = (await db.execute(sql`
    WITH window_days AS (
      SELECT
        rl.id          AS listing_id,
        rl.title       AS title,
        rl.source_url  AS source_url,
        COUNT(DISTINCT rpbd.date) FILTER (
          WHERE rpbd.nightly_price_usd IS NOT NULL
            AND rpbd.date >= CURRENT_DATE
            AND rpbd.date <  CURRENT_DATE + ${HORIZON}::int
        )::int AS priced_days,
        MAX(rpbd.scraped_at) AS last_scraped_at
      FROM rental_listings rl
      LEFT JOIN rental_prices_by_date rpbd
        ON rpbd.listing_id = rl.id
      WHERE rl.source_platform = 'vacation_vallarta'
        AND rl.is_active = TRUE
      GROUP BY rl.id, rl.title, rl.source_url
    )
    SELECT
      listing_id,
      title,
      source_url,
      priced_days,
      last_scraped_at::text AS last_scraped_at
    FROM window_days
    ORDER BY priced_days ASC, listing_id ASC
  `)) as unknown as { rows: CoverageRow[] };

  const rows = res.rows;
  const total = rows.length;
  const underCovered = rows.filter((r) => r.priced_days < THRESHOLD_DAYS);
  const zeroCoverage = rows.filter((r) => r.priced_days === 0);

  console.log("=".repeat(96));
  console.log("Vacation Vallarta — forward calendar coverage report");
  console.log("=".repeat(96));
  console.log(
    `horizon=${HORIZON}d  threshold=${fmtPct(THRESHOLD)} (${THRESHOLD_DAYS}/${HORIZON} priced days required)`,
  );
  console.log(
    `active_listings=${total}  needing_review=${underCovered.length}  zero_coverage=${zeroCoverage.length}`,
  );
  console.log();

  if (total === 0) {
    console.log("No active vacation_vallarta listings found — nothing to report.");
    return 0;
  }
  if (underCovered.length === 0) {
    console.log(
      `All ${total} active VV listings meet the ${fmtPct(THRESHOLD)} coverage bar. ✓`,
    );
    return 0;
  }

  const header = [
    "id".padStart(5),
    "priced".padStart(7),
    "ratio".padStart(7),
    "last_scraped".padEnd(20),
    "title".padEnd(38),
    "url",
  ].join("  ");
  console.log(header);
  console.log("-".repeat(Math.min(140, header.length + 60)));
  for (const r of underCovered) {
    const ratio = r.priced_days / HORIZON;
    const title = (r.title ?? "—").slice(0, 38);
    const lastScraped = (r.last_scraped_at ?? "—").slice(0, 19);
    console.log(
      [
        String(r.listing_id).padStart(5),
        `${r.priced_days}/${HORIZON}`.padStart(7),
        fmtPct(ratio).padStart(7),
        lastScraped.padEnd(20),
        title.padEnd(38),
        r.source_url,
      ].join("  "),
    );
  }

  console.log();
  console.log(
    `${underCovered.length} of ${total} VV listing(s) below the ${fmtPct(THRESHOLD)} coverage bar — open each URL and either fix the parser or curate a bracket override.`,
  );
  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    if (code !== 0) process.exit(code);
  })
  .catch(async (err) => {
    console.error("report-vv-coverage failed:", err);
    await pool.end();
    process.exit(1);
  });
