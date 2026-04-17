/**
 * Seed shim — replaces the former 1,164-line inline-data seed module.
 *
 * Canonical data layout (single source of truth):
 *   data/{airport,tourism,safety,economic,weather,sources,events}/*.csv
 *
 * Ingestion logic lives in `scripts/ingest/` (idempotent truncate-and-reload
 * wrapped in per-table transactions). This file's only job is to detect a
 * not-yet-populated database and run that pipeline before the server starts
 * accepting traffic. All of the ad-hoc `repair*` / `reseed*` helpers that
 * used to patch row-level drift have been retired — the CSVs are now
 * authoritative.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { db } from "@workspace/db";
import {
  airportMetricsTable,
  tourismMetricsTable,
  safetyMetricsTable,
  economicMetricsTable,
  weatherMetricsTable,
  dataSourcesTable,
  marketEventsTable,
} from "@workspace/db/schema";
import { sql, type Table } from "drizzle-orm";
import { logger } from "./logger";

/** Every canonical table the CSV pipeline owns. If ANY is empty → re-ingest. */
const CANONICAL_TABLES: { name: string; table: Table }[] = [
  { name: "airport_metrics",  table: airportMetricsTable },
  { name: "tourism_metrics",  table: tourismMetricsTable },
  { name: "safety_metrics",   table: safetyMetricsTable },
  { name: "economic_metrics", table: economicMetricsTable },
  { name: "weather_metrics",  table: weatherMetricsTable },
  { name: "data_sources",     table: dataSourcesTable },
  { name: "market_events",    table: marketEventsTable },
];

/** Walk upward from `start` until a directory contains `pnpm-workspace.yaml`. */
function findRepoRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(`Could not locate pnpm-workspace.yaml starting at ${start}`);
}

function runIngestPipeline(): Promise<void> {
  return new Promise((ok, fail) => {
    const repoRoot = process.env["VP_REPO_ROOT"] ?? findRepoRoot(import.meta.dirname);
    const proc = spawn("pnpm", ["--filter", "@workspace/scripts", "run", "ingest"], {
      stdio: "inherit",
      cwd: repoRoot,
      env: process.env,
    });
    proc.on("exit", (code) => code === 0 ? ok() : fail(new Error(`ingest exited ${code}`)));
    proc.on("error", fail);
  });
}

/** Returns the names of canonical tables that are currently empty. */
async function findEmptyTables(): Promise<string[]> {
  const empties: string[] = [];
  for (const { name, table } of CANONICAL_TABLES) {
    const result = await db.execute(sql`SELECT 1 FROM ${table} LIMIT 1`);
    // drizzle+node-pg returns { rows: [...] }; drizzle+neon returns array directly
    const rows = (result as unknown as { rows?: unknown[] }).rows
      ?? (result as unknown as unknown[]);
    if (!Array.isArray(rows) || rows.length === 0) empties.push(name);
  }
  return empties;
}

/**
 * Runs the canonical CSV ingest pipeline iff any canonical table is empty.
 * Awaited during startup so the server never accepts traffic mid-ingest.
 * Throws if the pipeline fails while the DB is still empty — callers decide
 * whether to exit the process.
 */
export async function seedIfEmpty(): Promise<void> {
  const empties = await findEmptyTables();
  if (empties.length === 0) {
    logger.info("seed: all canonical tables populated, skipping ingest");
    return;
  }
  logger.warn({ emptyTables: empties }, "seed: empty canonical tables detected, running CSV ingest pipeline");
  await runIngestPipeline();
  const stillEmpty = await findEmptyTables();
  if (stillEmpty.length > 0) {
    throw new Error(`ingest pipeline completed but tables still empty: ${stillEmpty.join(", ")}`);
  }
  logger.info("seed: ingest pipeline complete, all canonical tables populated");
}
