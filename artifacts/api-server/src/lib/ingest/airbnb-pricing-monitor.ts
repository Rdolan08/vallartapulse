/**
 * ingest/airbnb-pricing-monitor.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Parser-health alert for the Airbnb full-quote enrichment path.
 *
 * Background: the per-checkpoint quote fetch in
 * airbnb-graphql-quote-adapter.ts parses Airbnb's GraphQL response by
 * matching display titles like "Cleaning fee", "Service fee", and
 * "Taxes". Airbnb periodically renames or restructures those rows
 * (e.g. "Service fee" → "Service charge"; taxes nested under a
 * "Government taxes" wrapper). When that happens the quote endpoint
 * still returns 200 OK, but the breakdown columns silently come back
 * null and airbnb-pricing-runner.ts drops the row rather than write
 * half-data. The daily summary keeps reporting `ok` for the listings
 * that did get a calendar back, and owners just stop seeing fee
 * numbers — there's no other obvious failure signal.
 *
 * This module turns the runner's per-checkpoint enrichment success
 * rate into an explicit alert that ops can route to Slack / email /
 * the freshness dashboard. Pure and synchronous on purpose so it's
 * trivial to call from a cron handler or unit-test.
 */

import type { AirbnbPricingRunSummary } from "./airbnb-pricing-runner.js";

/** A single historical run summary, paired with when it ran. */
export interface DailyRunRecord {
  /** When the run completed (used for ordering only). */
  ranAt: Date;
  summary: AirbnbPricingRunSummary;
}

export interface EnrichmentAlertOpts {
  /**
   * Minimum acceptable enrichment rate (0-1). The default 0.5 mirrors
   * the spec ("<50% of fully-available checkpoints got a breakdown").
   */
  minRate?: number;
  /**
   * How many of the most recent eligible runs must be below `minRate`
   * to fire. Default 2 — a single bad day could be a transient Airbnb
   * outage, but two in a row is the parser-keyword signal we're
   * actually after.
   */
  consecutiveDays?: number;
  /**
   * Skip runs whose denominator is too small to draw a conclusion
   * from. Default 5 — a run that only had 3 fully-available
   * checkpoints (e.g. high season everywhere) shouldn't be allowed to
   * single-handedly trip a "parser is broken" alarm.
   */
  minDenominator?: number;
}

export type EnrichmentAlertStatus = "ok" | "alert" | "insufficient_data";

export interface EnrichmentAlertResult {
  status: EnrichmentAlertStatus;
  /**
   * Plain-English explanation of the status. Suitable for dropping
   * straight into a Slack message or alert email body once the
   * delivery pipeline lands (separate task).
   */
  reason: string;
  /** The runs we evaluated, newest first. */
  evaluatedRuns: Array<{
    ranAt: Date;
    enrichmentRate: number | null;
    fullyAvailableCheckpoints: number;
    quotesEnriched: number;
    belowThreshold: boolean;
  }>;
  /** Echoed back so callers can log what threshold tripped. */
  thresholds: {
    minRate: number;
    consecutiveDays: number;
    minDenominator: number;
  };
}

/**
 * Inspect the most recent N daily runs and decide whether the
 * Airbnb-quote parser appears to have gone dark.
 *
 * Returns:
 *   - `alert` when the latest `consecutiveDays` eligible runs all
 *     came in below `minRate`.
 *   - `insufficient_data` when we don't have enough eligible runs
 *     yet (e.g. brand-new install, canary-only history). Callers
 *     should treat this as "do nothing" — never as a green light or
 *     as a reason to page someone.
 *   - `ok` otherwise.
 *
 * Eligible = run has a non-null `enrichmentRate` AND its denominator
 * (`totalFullyAvailableCheckpoints`) is at least `minDenominator`.
 * Canary / skipFullQuotes runs are excluded automatically because
 * the runner sets `enrichmentRate` to null for them.
 */
export function evaluateEnrichmentAlert(
  runs: DailyRunRecord[],
  opts: EnrichmentAlertOpts = {},
): EnrichmentAlertResult {
  const minRate = opts.minRate ?? 0.5;
  const consecutiveDays = opts.consecutiveDays ?? 2;
  const minDenominator = opts.minDenominator ?? 5;

  const thresholds = { minRate, consecutiveDays, minDenominator };

  // Newest first so "the last N days" reads naturally below.
  const sorted = [...runs].sort(
    (a, b) => b.ranAt.getTime() - a.ranAt.getTime(),
  );

  const eligible = sorted.filter(
    (r) =>
      r.summary.enrichmentRate !== null &&
      r.summary.totalFullyAvailableCheckpoints >= minDenominator,
  );

  const evaluatedRuns = eligible.slice(0, consecutiveDays).map((r) => ({
    ranAt: r.ranAt,
    enrichmentRate: r.summary.enrichmentRate,
    fullyAvailableCheckpoints: r.summary.totalFullyAvailableCheckpoints,
    quotesEnriched: r.summary.totalQuotesEnriched,
    belowThreshold:
      r.summary.enrichmentRate !== null &&
      r.summary.enrichmentRate < minRate,
  }));

  if (evaluatedRuns.length < consecutiveDays) {
    return {
      status: "insufficient_data",
      reason:
        `Only ${evaluatedRuns.length} of the last ${consecutiveDays} ` +
        `Airbnb pricing runs had at least ${minDenominator} fully-available ` +
        `checkpoints; need more history before judging parser health.`,
      evaluatedRuns,
      thresholds,
    };
  }

  const allBelow = evaluatedRuns.every((r) => r.belowThreshold);
  if (allBelow) {
    const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
    const rates = evaluatedRuns
      .map(
        (r) =>
          `${pct(r.enrichmentRate ?? 0)} ` +
          `(${r.quotesEnriched}/${r.fullyAvailableCheckpoints})`,
      )
      .join(", ");
    return {
      status: "alert",
      reason:
        `Airbnb fee-breakdown enrichment has been below ${pct(minRate)} ` +
        `for ${consecutiveDays} consecutive runs (newest first: ${rates}). ` +
        `Likely cause: Airbnb renamed a price-line title and the quote ` +
        `parser keyword set in airbnb-graphql-quote-adapter.ts needs ` +
        `updating.`,
      evaluatedRuns,
      thresholds,
    };
  }

  return {
    status: "ok",
    reason:
      `Airbnb fee-breakdown enrichment is healthy across the last ` +
      `${consecutiveDays} eligible runs.`,
    evaluatedRuns,
    thresholds,
  };
}
