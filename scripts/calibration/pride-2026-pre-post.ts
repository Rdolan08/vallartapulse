#!/usr/bin/env tsx
/**
 * Pride 2026 calibration — forward-calendar pre/post measurement.
 *
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║  READ-ONLY DIAGNOSTIC. DO NOT MODIFY PRICING BEHAVIOR.                ║
 * ║                                                                       ║
 * ║  This script does NOT change multipliers, event rules, comp-engine    ║
 * ║  logic, the /api/rental/comps response shape, or any production       ║
 * ║  pricing path. It only SELECTs from rental_prices_by_date and         ║
 * ║  rental_listings to observe how host pricing in the forward calendar  ║
 * ║  evolves as Pride 2026 (May 20-28) approaches.                        ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * The query shape is intentionally FROZEN at v1.0.0 so checkpoint runs are
 * comparable. If you need a different measurement, write a new script —
 * do NOT edit window dates, hood definitions, or filter predicates here.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts calibrate:pride
 *   pnpm --filter @workspace/scripts calibrate:pride --json-only
 *
 * Output:
 *   - Console table (human-readable)
 *   - JSON artifact at: diagnostics/calibration/pride-2026/<ISO ts>.json
 *
 * Recommended cadence (today is the calibration anchor — Apr 22, 2026):
 *   T-21  May 1     first signal whether host adjustments have started
 *   T-14  May 8     within the dynamic-pricer adjustment window
 *   T-7   May 13    should show full pricing if events drive any host behavior
 *   T-2   May 18    Pride eve
 *   T+0   May 24    Pride midpoint
 *   T+5   May 30    Pride post
 *   T+14  June 11   retrospective; May 2026 becomes proper historical truth
 *
 * Trajectory across these checkpoints matters more than any single snapshot.
 */
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Locate workspace root ─────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKSPACE_ROOT = resolve(__dirname, "../..");
const ARTIFACTS_DIR = resolve(
  WORKSPACE_ROOT,
  "diagnostics/calibration/pride-2026",
);

// ══════════════════════════════════════════════════════════════════════════
// FROZEN MEASUREMENT DEFINITIONS — DO NOT EDIT
// ══════════════════════════════════════════════════════════════════════════
const SCRIPT_VERSION = "1.0.0";
const QUERY_FROZEN_AT = "2026-04-22"; // version v1.0.0 anchor date
const DATA_SOURCE = "rental_prices_by_date (production / Railway)";

const FILTERS = {
  availability_status: "(none — intentionally not filtered)",
  nightly_price_usd: "IS NOT NULL",
  source_platform: "(none — Airbnb / PVRPV / Vacation Vallarta all included)",
} as const;

const WINDOWS = [
  {
    label: "1_pre",
    start: "2026-05-06",
    end: "2026-05-14",
    note: "9 nights, Wed-Thu, weekend May 8-10",
  },
  {
    label: "2_pride",
    start: "2026-05-20",
    end: "2026-05-28",
    note: "9 nights, Wed-Thu, weekend May 22-24, Pride core",
  },
  {
    label: "3_post",
    start: "2026-06-03",
    end: "2026-06-11",
    note: "9 nights, Wed-Thu, weekend Jun 5-7",
  },
] as const;

const HOOD_DEFS = [
  {
    label: "ZR + Old Town",
    includes: ["Zona Romantica", "Old Town"],
    note: "Primary ZR diagnostic — combines ZR with Old Town alias rows",
  },
  {
    label: "Zona Romantica only",
    includes: ["Zona Romantica"],
    note: "Pure ZR for comparison against the combined bucket",
  },
  {
    label: "Amapas",
    includes: ["Amapas"],
    note: "Spillover hood with mid-strength Pride zone seed (1.06)",
  },
  {
    label: "Marina Vallarta",
    includes: ["Marina Vallarta"],
    note: "Negative-control hood — no Pride zone seed",
  },
] as const;
// ══════════════════════════════════════════════════════════════════════════

interface MeasurementRow {
  hood_label: string;
  window_label: string;
  listing_count: number;
  nightly_row_count: number;
  median: number;
  p25: number;
  p75: number;
}

interface MappingRow {
  hood_label: string;
  exact_mapping_count: number;
  null_mapping_count: number;
  total_listing_count: number;
}

const CONN = process.env.RAILWAY_DATABASE_URL;
if (!CONN) {
  console.error("ERROR: RAILWAY_DATABASE_URL is not set in environment.");
  process.exit(1);
}

const jsonOnly = process.argv.includes("--json-only");

function fmt(n: unknown): string {
  return n === null || n === undefined ? "n/a" : String(n);
}

function pad(s: unknown, n: number, dir: "L" | "R" = "L"): string {
  const str = fmt(s);
  return dir === "L" ? str.padStart(n) : str.padEnd(n);
}

async function main() {
  const runAt = new Date().toISOString();
  const client = new pg.Client({
    connectionString: CONN,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  // ── Mapping-confidence inventory (per hood diagnostic) ──────────────────
  const mappingSql = `
    WITH hood_defs(hood_label, included_hoods) AS (
      VALUES
        ('ZR + Old Town',       ARRAY['Zona Romantica','Old Town']),
        ('Zona Romantica only', ARRAY['Zona Romantica']),
        ('Amapas',              ARRAY['Amapas']),
        ('Marina Vallarta',     ARRAY['Marina Vallarta'])
    )
    SELECT
      h.hood_label,
      count(*) FILTER (WHERE l.neighborhood_mapping_confidence = 'exact')::int AS exact_mapping_count,
      count(*) FILTER (WHERE l.neighborhood_mapping_confidence IS NULL)::int    AS null_mapping_count,
      count(*)::int                                                              AS total_listing_count
    FROM hood_defs h
    JOIN rental_listings l ON l.neighborhood_normalized = ANY(h.included_hoods)
    GROUP BY h.hood_label
    ORDER BY h.hood_label
  `;

  // ── Main forward-calendar measurement ──────────────────────────────────
  // No availability_status filter. Raw nightly_price_usd only.
  // Hood diagnostics are independent rows (ZR-only and ZR+OT both reported).
  const measurementSql = `
    WITH windows(label, win_start, win_end) AS (
      VALUES
        ('1_pre',   DATE '2026-05-06', DATE '2026-05-14'),
        ('2_pride', DATE '2026-05-20', DATE '2026-05-28'),
        ('3_post',  DATE '2026-06-03', DATE '2026-06-11')
    ),
    hood_defs(hood_label, included_hoods) AS (
      VALUES
        ('ZR + Old Town',       ARRAY['Zona Romantica','Old Town']),
        ('Zona Romantica only', ARRAY['Zona Romantica']),
        ('Amapas',              ARRAY['Amapas']),
        ('Marina Vallarta',     ARRAY['Marina Vallarta'])
    ),
    base AS (
      SELECT
        h.hood_label,
        w.label AS window_label,
        p.listing_id,
        p.nightly_price_usd
      FROM rental_prices_by_date p
      JOIN rental_listings l ON l.id = p.listing_id
      CROSS JOIN windows w
      CROSS JOIN hood_defs h
      WHERE p.date >= w.win_start AND p.date <= w.win_end
        AND l.neighborhood_normalized = ANY(h.included_hoods)
        AND p.nightly_price_usd IS NOT NULL
    )
    SELECT
      hood_label,
      window_label,
      count(DISTINCT listing_id)::int AS listing_count,
      count(*)::int                   AS nightly_row_count,
      ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY nightly_price_usd)::numeric, 2)::float8 AS median,
      ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY nightly_price_usd)::numeric, 2)::float8 AS p25,
      ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY nightly_price_usd)::numeric, 2)::float8 AS p75
    FROM base
    GROUP BY hood_label, window_label
    ORDER BY hood_label, window_label
  `;

  const [mappingRes, measureRes] = await Promise.all([
    client.query(mappingSql),
    client.query(measurementSql),
  ]);
  await client.end();

  const mappingByHood = new Map<string, MappingRow>();
  for (const r of mappingRes.rows as MappingRow[]) {
    mappingByHood.set(r.hood_label, r);
  }

  // Compose per-hood/window measurement rows with mapping fields attached.
  const measurements = (measureRes.rows as MeasurementRow[]).map((r) => {
    const m = mappingByHood.get(r.hood_label);
    return {
      hood: r.hood_label,
      window: r.window_label,
      listing_count: r.listing_count,
      nightly_row_count: r.nightly_row_count,
      median: r.median,
      p25: r.p25,
      p75: r.p75,
      exact_mapping_count: m?.exact_mapping_count ?? null,
      null_mapping_count: m?.null_mapping_count ?? null,
    };
  });

  // ── Ratios: Pride median / pre median, Pride median / post median ──────
  const byHood: Record<string, Record<string, MeasurementRow>> = {};
  for (const r of measureRes.rows as MeasurementRow[]) {
    (byHood[r.hood_label] ??= {})[r.window_label] = r;
  }
  const ratios = HOOD_DEFS.map((h) => {
    const g = byHood[h.label] ?? {};
    const pri = g["2_pride"]?.median ?? null;
    const pre = g["1_pre"]?.median ?? null;
    const post = g["3_post"]?.median ?? null;
    return {
      hood: h.label,
      pride_median: pri,
      pre_median: pre,
      post_median: post,
      pride_vs_pre_median_ratio:
        pri && pre ? Number((pri / pre).toFixed(4)) : null,
      pride_vs_post_median_ratio:
        pri && post ? Number((pri / post).toFixed(4)) : null,
    };
  });

  // ── Compose final artifact ─────────────────────────────────────────────
  const artifact = {
    metadata: {
      run_at: runAt,
      script_version: SCRIPT_VERSION,
      query_frozen_at: QUERY_FROZEN_AT,
      data_source: DATA_SOURCE,
      filters: FILTERS,
      windows: WINDOWS,
      hood_definitions: HOOD_DEFS,
      notes: [
        "Read-only diagnostic. Does not affect pricing behavior.",
        "Compare across checkpoints to observe Pride uplift trajectory in raw host pricing.",
        "All windows are 9 nights (Wed-Thu) with one full Fri-Sun weekend.",
        "Pre and post controls are 14 days from Pride core in either direction.",
      ],
    },
    mapping_inventory: mappingRes.rows,
    measurements,
    ratios,
  };

  // ── Console output ─────────────────────────────────────────────────────
  if (!jsonOnly) {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(" Pride 2026 calibration — forward-calendar pre/post snapshot");
    console.log(`  run_at: ${runAt}`);
    console.log(`  script_version: ${SCRIPT_VERSION}  (query frozen at ${QUERY_FROZEN_AT})`);
    console.log("═══════════════════════════════════════════════════════════════");

    console.log("\n── Windows ──");
    for (const w of WINDOWS) {
      console.log(`  ${pad(w.label, 8, "R")} ${w.start} → ${w.end}   ${w.note}`);
    }

    console.log("\n── Mapping confidence inventory ──");
    console.log(
      "  " +
        pad("hood", 22, "R") +
        pad("exact", 8) +
        pad("null", 8) +
        pad("total", 8),
    );
    for (const m of mappingRes.rows as MappingRow[]) {
      console.log(
        "  " +
          pad(m.hood_label, 22, "R") +
          pad(m.exact_mapping_count, 8) +
          pad(m.null_mapping_count, 8) +
          pad(m.total_listing_count, 8),
      );
    }

    console.log("\n── Measurements (raw nightly_price_usd) ──");
    let lastHood: string | null = null;
    for (const r of measurements) {
      if (r.hood !== lastHood) {
        console.log(`\n  ── ${r.hood} ──`);
        console.log(
          "    " +
            pad("window", 10, "R") +
            pad("listings", 10) +
            pad("nights", 10) +
            pad("median", 10) +
            pad("p25", 10) +
            pad("p75", 10),
        );
        lastHood = r.hood;
      }
      console.log(
        "    " +
          pad(r.window, 10, "R") +
          pad(r.listing_count, 10) +
          pad(r.nightly_row_count, 10) +
          pad(r.median, 10) +
          pad(r.p25, 10) +
          pad(r.p75, 10),
      );
    }

    console.log("\n── Pride uplift ratios ──");
    console.log(
      "  " +
        pad("hood", 22, "R") +
        pad("pride", 9) +
        pad("pre", 9) +
        pad("post", 9) +
        pad("pride/pre", 12) +
        pad("pride/post", 12),
    );
    for (const r of ratios) {
      console.log(
        "  " +
          pad(r.hood, 22, "R") +
          pad(r.pride_median, 9) +
          pad(r.pre_median, 9) +
          pad(r.post_median, 9) +
          pad(r.pride_vs_pre_median_ratio, 12) +
          pad(r.pride_vs_post_median_ratio, 12),
      );
    }
    console.log("");
  }

  // ── Write JSON artifact ────────────────────────────────────────────────
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  // Filename: ISO timestamp with colons replaced (filesystem-safe).
  const fname = runAt.replace(/[:.]/g, "-") + ".json";
  const fpath = resolve(ARTIFACTS_DIR, fname);
  await writeFile(fpath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  if (!jsonOnly) {
    console.log(`Artifact written: ${fpath}`);
  } else {
    // In json-only mode, emit just the path on stdout for piping.
    console.log(fpath);
  }
}

main().catch((err) => {
  console.error("calibration script failed:", err);
  process.exit(1);
});
