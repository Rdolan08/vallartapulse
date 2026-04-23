/**
 * scripts/src/airbnb-pricing-refresh.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin CLI wrapper around the canonical Airbnb per-night pricing runner.
 * Designed to be invoked from the Mac mini's residential IP (the only
 * environment where Airbnb's GraphQL price endpoints reliably return
 * non-null prices on a meaningful fraction of listings).
 *
 * What this DOES NOT do:
 *   - Hit /api/v2/homes_pdp_availability_calendar (that endpoint returns
 *     null prices for everyone — see airbnb-calendar-adapter.ts header).
 *   - Write to rental_prices_by_date (calendar-only table, populated by
 *     scrape:airbnb-calendar). Per-night prices live in
 *     listing_price_quotes for behavioral reasons documented in
 *     docs/AIRBNB_PRICING_PIPELINE.md.
 *
 * What this DOES:
 *   - Call runAirbnbPricingRefresh({ maxListings, dryRun }) which:
 *       1. Picks N stale-first active Airbnb listings.
 *       2. For each: one GraphQL calendar fetch (per-night prices, 12mo).
 *       3. Generates ~30-40 stay-window checkpoints per listing.
 *       4. Inserts one quote row per checkpoint into listing_price_quotes.
 *       5. Persists a run summary into airbnb_pricing_run_summaries.
 *   - Print the summary as JSON for log-grepping / cron alerting.
 *
 * Usage from Mac mini:
 *   DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run scrape:airbnb-pricing
 *
 *   # Dial up the cohort once you confirm the first run worked:
 *   AIRBNB_PRICING_MAX_LISTINGS=200 \
 *     DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run scrape:airbnb-pricing
 *
 *   # Smoke check without DB writes:
 *   AIRBNB_PRICING_DRY_RUN=1 \
 *     DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run scrape:airbnb-pricing
 *
 * Env:
 *   DATABASE_URL                  required (use $RAILWAY_DATABASE_URL for prod)
 *   AIRBNB_PRICING_MAX_LISTINGS   default 50 (matches the in-process daily budget)
 *   AIRBNB_PRICING_DRY_RUN        truthy => skip DB writes
 *
 * STATUS (as of 2026-04-23):
 *   Both GraphQL adapters (airbnb-graphql-pricing-adapter.ts +
 *   airbnb-graphql-quote-adapter.ts) are fully implemented and the
 *   in-process exit-code-4 stub-detection branch is now defensive-only.
 *   This script is the canonical nightly entry point for the per-night
 *   pricing pipeline and is invoked by the Mac mini launchd job
 *   `com.vallartapulse.airbnb-pricing` at 17:00 PV (= 23:00 UTC).
 *   Railway / GH Actions can no longer reach Airbnb's PDP endpoints from
 *   datacenter IPs (the Decodo residential pool burned out 2026-04-22),
 *   so the residential IP of the Mac mini is now the only viable runner
 *   environment. See docs/AIRBNB_PRICING_PIPELINE.md.
 */

import { pool } from "@workspace/db";
import { runAirbnbPricingRefresh } from "../../artifacts/api-server/src/lib/ingest/airbnb-pricing-runner.js";

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is required (set to $RAILWAY_DATABASE_URL for prod)");
    return 1;
  }

  const maxListings = parseIntEnv("AIRBNB_PRICING_MAX_LISTINGS", 50);
  const dryRun = isTruthy(process.env.AIRBNB_PRICING_DRY_RUN);
  const maxCheckpointsPerListing = parseIntEnv(
    "AIRBNB_PRICING_MAX_CHECKPOINTS_PER_LISTING",
    Number.POSITIVE_INFINITY as unknown as number,
  );

  console.log(
    JSON.stringify(
      { event: "airbnb-pricing-refresh.start", maxListings, dryRun, ts: new Date().toISOString() },
    ),
  );

  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof runAirbnbPricingRefresh>>;
  try {
    result = await runAirbnbPricingRefresh({
      maxListings,
      dryRun,
      maxCheckpointsPerListing: Number.isFinite(maxCheckpointsPerListing)
        ? maxCheckpointsPerListing
        : undefined,
    });
  } catch (err) {
    // The two GraphQL adapters (airbnb-graphql-pricing-adapter,
    // airbnb-graphql-quote-adapter) currently throw "not implemented in
    // this build" from getOrDiscoverSha — which the runner calls BEFORE
    // the per-listing loop, so it bubbles all the way up here without
    // ever returning a summary. Detect that case and emit one clear
    // operator message + exit code 4. Any other error keeps the
    // existing crash behavior (full stack, exit 1).
    const msg = err instanceof Error ? err.message : String(err);
    if (/not implemented in this build/i.test(msg)) {
      console.error(
        "ERROR: airbnb-graphql-pricing-adapter / airbnb-graphql-quote-adapter " +
          "are still compile-only stubs. Implement them before running this " +
          "script. See docs/AIRBNB_PRICING_PIPELINE.md > 'Known blocker' and " +
          "issue #34. Underlying throw: " + msg,
      );
      return 4;
    }
    throw err;
  }
  const elapsedMs = Date.now() - t0;

  console.log(
    JSON.stringify(
      {
        event: "airbnb-pricing-refresh.done",
        elapsedMs,
        summary: result.summary,
        listings: result.listings,
      },
      null,
      2,
    ),
  );

  // Non-zero exit when the run fundamentally failed (no listings priced,
  // or every listing failed). The summary's enrichmentRate / totalDaysWithPrice
  // is the simplest health signal here.
  const summary = result.summary as unknown as {
    totalDaysWithPrice?: number;
    totalListings?: number;
    totalListingsFailed?: number;
  };
  const totalListings = summary.totalListings ?? 0;
  const totalDaysWithPrice = summary.totalDaysWithPrice ?? 0;
  const totalFailed = summary.totalListingsFailed ?? 0;

  if (totalListings === 0) {
    console.error("WARN: zero listings processed (check the active Airbnb cohort)");
    return 0;
  }
  if (totalDaysWithPrice === 0 && !dryRun) {
    console.error(
      "ERROR: zero priced days returned — likely a SHA rotation, IP block, or parser regression",
    );
    return 2;
  }
  if (totalFailed === totalListings) {
    // Look at the per-listing errors to distinguish "stub adapters" (the
    // current known blocker) from "real network/parser failure". This lets
    // the operator see at a glance whether they need to wait for the GraphQL
    // adapter implementation or actually debug something.
    const listings = (result.summary as unknown as {
      listings?: Array<{ error?: string }>;
    }).listings ?? [];
    const stubHits = listings.filter((p) =>
      typeof p.error === "string" && /not implemented in this build/i.test(p.error),
    ).length;

    if (stubHits === totalListings) {
      console.error(
        "ERROR: airbnb-graphql-pricing-adapter / airbnb-graphql-quote-adapter " +
          "are still compile-only stubs. Implement them before running this " +
          "script. See docs/AIRBNB_PRICING_PIPELINE.md > 'Known blocker'.",
      );
      return 4;
    }

    console.error("ERROR: every listing failed");
    return 3;
  }

  return 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await pool.end();
    } catch {
      // ignore
    }
    process.exit(1);
  });
