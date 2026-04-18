/**
 * ingest/yield-tracker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-seed yield + exhaustion tracking. Pure / no I/O / no scraper coupling.
 *
 * Phase 2b's queue runner will instantiate one tracker per claimed job, call
 * `recordBatch(...)` after each search-page batch, and check `shouldStop()`
 * to decide whether to keep paginating. When it stops, `terminationReason`
 * tells the runner what to pass to `markComplete()`.
 *
 * Default policy: two consecutive zero-new-yield batches → `exhausted`.
 * Configurable via YieldTrackerOptions for future tuning.
 */

export type TerminationReason =
  | "exhausted"
  | "manual_cap"
  | "timeout"
  | "blocked"
  | "parse_fail"
  | "duplicate_only"
  | "running";

export interface YieldTrackerOptions {
  /** Stop after this many consecutive zero-new-yield batches. Default: 2. */
  zeroYieldStreakLimit?: number;
  /** Hard cap on total observations across all batches. Default: 500. */
  maxObservations?: number;
  /** Hard cap on total wall-clock time in ms across all batches. Default: 5 min. */
  maxDurationMs?: number;
  /** Optional caller-supplied clock (testing). */
  now?: () => number;
}

export interface BatchOutcome {
  /** Number of cards observed in the batch (raw, before dedup). */
  observed: number;
  /** Number of NEW listings (insertion to rental_listings) within the batch. */
  newListings: number;
  /** Number of duplicates within the batch — usually `observed - newListings`. */
  duplicates?: number;
}

export interface YieldSnapshot {
  batchesProcessed: number;
  totalObserved: number;
  totalNew: number;
  totalDuplicates: number;
  consecutiveZeroNew: number;
  startedAt: number;
  elapsedMs: number;
  terminationReason: TerminationReason;
}

export class YieldTracker {
  private readonly opts: Required<YieldTrackerOptions>;
  private batches = 0;
  private totalObs = 0;
  private totalNew = 0;
  private totalDup = 0;
  private zeroStreak = 0;
  private readonly t0: number;
  private reason: TerminationReason = "running";

  constructor(options: YieldTrackerOptions = {}) {
    this.opts = {
      zeroYieldStreakLimit: options.zeroYieldStreakLimit ?? 2,
      maxObservations: options.maxObservations ?? 500,
      maxDurationMs: options.maxDurationMs ?? 5 * 60 * 1000,
      now: options.now ?? (() => Date.now()),
    };
    this.t0 = this.opts.now();
  }

  /** Record one batch of search-card observations. */
  recordBatch(outcome: BatchOutcome): void {
    this.batches += 1;
    this.totalObs += outcome.observed;
    this.totalNew += outcome.newListings;
    this.totalDup +=
      outcome.duplicates ?? Math.max(0, outcome.observed - outcome.newListings);

    if (outcome.newListings === 0) this.zeroStreak += 1;
    else this.zeroStreak = 0;

    if (this.zeroStreak >= this.opts.zeroYieldStreakLimit) {
      this.reason = this.totalNew === 0 ? "duplicate_only" : "exhausted";
    } else if (this.totalObs >= this.opts.maxObservations) {
      this.reason = "manual_cap";
    } else if (this.opts.now() - this.t0 >= this.opts.maxDurationMs) {
      this.reason = "timeout";
    }
  }

  /** Mark a non-yield-driven termination (e.g. adapter-detected block). */
  forceStop(reason: Exclude<TerminationReason, "running">): void {
    this.reason = reason;
  }

  shouldStop(): boolean {
    return this.reason !== "running";
  }

  snapshot(): YieldSnapshot {
    return {
      batchesProcessed: this.batches,
      totalObserved: this.totalObs,
      totalNew: this.totalNew,
      totalDuplicates: this.totalDup,
      consecutiveZeroNew: this.zeroStreak,
      startedAt: this.t0,
      elapsedMs: this.opts.now() - this.t0,
      terminationReason: this.reason,
    };
  }
}
