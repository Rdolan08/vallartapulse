/**
 * scripts/src/str-discovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * STR discovery CLI — Phase 2a.
 *
 * Capabilities in 2a:
 *   --backfill              Run the idempotent rental_listings backfill.
 *   --seed-only             Generate + insert seeds (no scraping).
 *   --dry-run               Print what would be done without writing.
 *   --max-seeds=<n>         Cap how many seeds get generated/inserted.
 *   --resume                Print queue diagnostics + the top pending jobs.
 *   --source=<airbnb|vrbo|all>
 *   --region=<puerto_vallarta|riviera_nayarit|all>
 *   --neighborhood=<bucket name>   (repeatable)
 *
 * Phase 2a NEVER hits Airbnb or VRBO — when the runner mode would normally
 * scrape, this script just prints the seeds it would have run.
 *
 * Cross-package import: this script lives in @workspace/scripts but pulls
 * Phase 2 ingest infrastructure straight from @workspace/api-server source via
 * a relative path. tsx (used by all script entrypoints) handles that fine.
 */

import {
  generateSeeds,
  toInsertRow,
  ALL_SOURCES,
  type Source,
  type RegionFilter,
  type DiscoverySeed,
} from "../../artifacts/api-server/src/lib/ingest/seed-generator.js";
import {
  insertSeeds,
  summarizePending,
  reclaimStaleInProgress,
} from "../../artifacts/api-server/src/lib/ingest/discovery-queue.js";
import { runBackfill } from "../../artifacts/api-server/src/lib/ingest/backfill.js";
import { runDiscoveryLoop } from "../../artifacts/api-server/src/lib/ingest/runner.js";
import {
  describeProxy,
  isProxyConfigured,
  isUnblockerConfigured,
  type FetchMode,
} from "../../artifacts/api-server/src/lib/ingest/http-proxy.js";

type Mode = "seed-only" | "resume" | "backfill" | "run" | "default";

interface CliArgs {
  mode: Mode;
  dryRun: boolean;
  source: Source[] | null;
  region: RegionFilter | null;
  neighborhoods: string[];
  maxSeeds: number | null;
  maxJobs: number;
  maxResultsPerJob: number;
  maxDurationMs: number;
  fetchMode: FetchMode | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    mode: "default",
    dryRun: false,
    source: null,
    region: null,
    neighborhoods: [],
    maxSeeds: null,
    maxJobs: 1,
    maxResultsPerJob: 10,
    maxDurationMs: 5 * 60 * 1000,
    fetchMode: null,
    help: false,
  };

  for (const a of argv.slice(2)) {
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--seed-only") args.mode = "seed-only";
    else if (a === "--resume") args.mode = "resume";
    else if (a === "--backfill") args.mode = "backfill";
    else if (a === "--run") args.mode = "run";
    else if (a.startsWith("--source=")) {
      const v = a.slice("--source=".length);
      args.source = v === "all" ? ALL_SOURCES : (v.split(",") as Source[]);
    } else if (a.startsWith("--region=")) {
      const v = a.slice("--region=".length) as RegionFilter;
      args.region = v;
    } else if (a.startsWith("--neighborhood=")) {
      args.neighborhoods.push(a.slice("--neighborhood=".length));
    } else if (a.startsWith("--max-seeds=")) {
      args.maxSeeds = parseInt(a.slice("--max-seeds=".length), 10);
    } else if (a.startsWith("--max-jobs=")) {
      args.maxJobs = parseInt(a.slice("--max-jobs=".length), 10);
    } else if (a.startsWith("--max-results-per-job=")) {
      args.maxResultsPerJob = parseInt(
        a.slice("--max-results-per-job=".length),
        10
      );
    } else if (a.startsWith("--max-duration-sec=")) {
      args.maxDurationMs =
        parseInt(a.slice("--max-duration-sec=".length), 10) * 1000;
    } else if (a.startsWith("--fetch-mode=")) {
      const v = a.slice("--fetch-mode=".length) as FetchMode;
      if (v !== "direct" && v !== "proxy" && v !== "unblocker") {
        console.warn(
          `[str-discovery] Invalid --fetch-mode='${v}'. Expected: direct|proxy|unblocker. Ignoring.`
        );
      } else {
        args.fetchMode = v;
      }
    } else {
      console.warn(`[str-discovery] Ignoring unknown argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
STR Discovery CLI (Phase 2a — no live scraping)

Usage:
  pnpm tsx scripts/src/str-discovery.ts [flags]

Modes:
  --seed-only     Generate + insert seeds, then exit.
  --backfill      Run the idempotent rental_listings backfill.
  --resume        Print queue diagnostics + top pending jobs.
  (default)       Same as --resume in Phase 2a (no scraping yet).

Filters:
  --source=airbnb|vrbo|all          Default: all
  --region=puerto_vallarta|riviera_nayarit|all   Default: all
  --neighborhood="Zona Romántica"   Repeatable (exact bucket name)
  --max-seeds=<n>                   Cap total seeds generated/inserted
  --fetch-mode=direct|proxy|unblocker
                                    Outbound transport for --run mode.
                                    Default: unblocker if UNBLOCKER_URL set,
                                    else proxy if PROXY_URL set, else direct.

Behaviour:
  --dry-run       Show what would be done; do not write to the database.

Examples:
  # Generate the full PV-priority seed plan, insert into queue
  pnpm tsx scripts/src/str-discovery.ts --seed-only --source=all --region=puerto_vallarta

  # Preview what 25 Airbnb seeds in Zona Romántica would look like
  pnpm tsx scripts/src/str-discovery.ts --seed-only --source=airbnb \\
        --neighborhood="Zona Romántica" --max-seeds=25 --dry-run

  # Backfill the existing rental_listings rows in dry-run mode first
  pnpm tsx scripts/src/str-discovery.ts --backfill --dry-run

  # Reset stale in-progress jobs and show what's pending
  pnpm tsx scripts/src/str-discovery.ts --resume
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.mode === "default") args.mode = "resume";

  console.log(`[str-discovery] mode=${args.mode} dryRun=${args.dryRun}`);

  if (args.mode === "backfill") {
    const report = await runBackfill({ dryRun: args.dryRun });
    console.log("\n── Backfill Report ─────────────────────────────────────");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.mode === "seed-only") {
    const sources = args.source ?? ALL_SOURCES;
    const regions: RegionFilter[] = args.region ? [args.region] : ["all"];
    const all = generateSeeds({
      source: sources,
      regions,
      neighborhoods: args.neighborhoods.length ? args.neighborhoods : undefined,
    });
    const limited = args.maxSeeds ? all.slice(0, args.maxSeeds) : all;

    console.log(
      `\n[str-discovery] Generated ${all.length} seeds (capped to ${limited.length})`
    );
    console.log("\nTop 10 by priority:");
    console.table(
      limited.slice(0, 10).map((s) => ({
        priority: s.priority,
        source: s.source,
        bucket: s.normalizedNeighborhoodBucket,
        region: s.parentRegionBucket,
        guests: s.guestCount,
        nights: s.stayLengthNights,
        beds: s.bedroomBucket,
        window: s.checkinWindow,
      }))
    );
    console.log("\nBucket → seed-count breakdown (priority order):");
    console.table(seedBreakdown(limited));

    if (args.dryRun) {
      console.log("\n[dry-run] Skipping queue insert.");
      return;
    }

    const result = await insertSeeds(limited.map(toInsertRow));
    console.log(
      `\n[str-discovery] insertSeeds → attempted=${result.attempted} inserted=${result.inserted} skipped=${result.skipped}`
    );
    return;
  }

  if (args.mode === "run") {
    if (args.dryRun) {
      console.log("[str-discovery] --dry-run incompatible with --run; aborting.");
      return;
    }
    if (
      !args.source ||
      args.source.length !== 1 ||
      (args.source[0] !== "airbnb" && args.source[0] !== "vrbo")
    ) {
      console.log(
        "[str-discovery] Phase 2b run requires exactly one --source=airbnb or --source=vrbo. Aborting."
      );
      return;
    }
    if (args.neighborhoods.length !== 1) {
      console.log(
        "[str-discovery] Phase 2b first-run scope requires exactly one --neighborhood. Aborting."
      );
      return;
    }
    const dbUrl = process.env.DATABASE_URL ?? "";
    if (
      process.env.RAILWAY_DATABASE_URL &&
      dbUrl === process.env.RAILWAY_DATABASE_URL
    ) {
      console.log(
        "[str-discovery] DATABASE_URL points at Railway prod — Phase 2b runs are local-only by policy. Aborting."
      );
      return;
    }

    // Resolve effective fetch mode.
    //  - explicit flag wins
    //  - else: unblocker if UNBLOCKER_URL set, else proxy if PROXY_URL set, else direct
    let effectiveFetchMode: FetchMode;
    if (args.fetchMode) {
      effectiveFetchMode = args.fetchMode;
    } else if (isUnblockerConfigured()) {
      effectiveFetchMode = "unblocker";
    } else if (isProxyConfigured()) {
      effectiveFetchMode = "proxy";
    } else {
      effectiveFetchMode = "direct";
    }

    if (effectiveFetchMode === "unblocker" && !isUnblockerConfigured()) {
      console.log(
        "[str-discovery] --fetch-mode=unblocker requires UNBLOCKER_URL secret to be set. Aborting."
      );
      return;
    }
    if (effectiveFetchMode === "proxy" && !isProxyConfigured()) {
      console.log(
        "[str-discovery] --fetch-mode=proxy requires PROXY_URL secret to be set. Aborting."
      );
      return;
    }

    console.log(
      `\n[str-discovery] LIVE RUN — source=${args.source[0]} neighborhood="${args.neighborhoods[0]}" maxJobs=${args.maxJobs} maxResultsPerJob=${args.maxResultsPerJob} maxDurationSec=${Math.round(args.maxDurationMs / 1000)}`
    );
    console.log(
      `[str-discovery] Fetch transport: ${effectiveFetchMode} → ${describeProxy(effectiveFetchMode)}`
    );
    const report = await runDiscoveryLoop({
      maxJobs: args.maxJobs,
      maxDurationMs: args.maxDurationMs,
      maxResultsPerJob: args.maxResultsPerJob,
      source: args.source[0],
      parentRegion:
        args.region && args.region !== "all" ? args.region : undefined,
      neighborhood: args.neighborhoods[0],
      fetchMode: effectiveFetchMode,
    });
    console.log("\n── Run Report ──────────────────────────────────────────");
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (args.mode === "resume") {
    const reclaimed = await reclaimStaleInProgress();
    if (reclaimed > 0) {
      console.log(`[str-discovery] Reclaimed ${reclaimed} stale in_progress jobs → pending`);
    }
    const summary = await summarizePending({
      source: args.source?.[0],
      parentRegion:
        args.region && args.region !== "all" ? args.region : undefined,
    });
    console.log("\n── Queue Summary ───────────────────────────────────────");
    console.log(`Total jobs:    ${summary.total}`);
    console.log(`By status:     ${JSON.stringify(summary.byStatus)}`);
    console.log("\nPending by (source, parent_region):");
    console.table(summary.bySourceRegion);
    console.log("\nTop 10 pending jobs that would be claimed next:");
    console.table(
      summary.topPending.slice(0, 10).map((j) => ({
        id: j.id,
        prio: j.priority,
        source: j.source,
        bucket: j.normalizedNeighborhoodBucket,
        region: j.parentRegionBucket,
        g: j.guestCount,
        n: j.stayLengthNights,
        b: j.bedroomBucket,
        w: j.checkinWindow,
      }))
    );
    console.log("\n[str-discovery] Phase 2a — no live scraping performed.");
    console.log(
      "Phase 2b will plug Airbnb + VRBO adapters into claimNext() to actually run these jobs.\n"
    );
    return;
  }
}

function seedBreakdown(
  seeds: DiscoverySeed[]
): Array<{ bucket: string; region: string; count: number; topPrio: number }> {
  const map = new Map<
    string,
    { bucket: string; region: string; count: number; topPrio: number }
  >();
  for (const s of seeds) {
    const k = `${s.normalizedNeighborhoodBucket}|${s.parentRegionBucket}`;
    const cur = map.get(k);
    if (cur) {
      cur.count += 1;
      if (s.priority > cur.topPrio) cur.topPrio = s.priority;
    } else {
      map.set(k, {
        bucket: s.normalizedNeighborhoodBucket,
        region: s.parentRegionBucket,
        count: 1,
        topPrio: s.priority,
      });
    }
  }
  return [...map.values()].sort((a, b) => b.topPrio - a.topPrio);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[str-discovery] FATAL:", err);
    process.exit(1);
  });
