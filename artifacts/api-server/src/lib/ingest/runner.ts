/**
 * ingest/runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2b queue runner. Claims jobs from discovery_jobs, calls the
 * appropriate source-specific composition wrapper, runs each card through
 * upsertListing + insertObservation, and closes the job out via
 * markComplete/markFailed.
 *
 * Honors a hard wall-clock budget (`maxDurationMs`) and a hard job count
 * (`maxJobs`) — both enforced before claiming the next job.
 *
 * NEVER touches Railway directly. Always runs against the DB pointed at by
 * DATABASE_URL — Phase 2b runs are local-only by policy.
 */

import {
  claimNext,
  markComplete,
  markFailed,
  type ClaimFilter,
} from "./discovery-queue.js";
import {
  upsertListing,
  insertObservation,
  canonicalizeUrl,
} from "./identity.js";
import { YieldTracker } from "./yield-tracker.js";
import {
  fetchAirbnbSeedBatch,
  type AirbnbBatch,
} from "./airbnb-discovery-wrapper.js";
import { fetchVrboSeedBatch } from "./vrbo-discovery-wrapper.js";
import { mapToPricingToolBucket } from "../neighborhood-buckets.js";
import type { DiscoveryJob } from "@workspace/db/schema";

export interface RunDiscoveryOptions {
  maxJobs: number;
  maxDurationMs: number;
  maxResultsPerJob?: number;
  source?: "airbnb" | "vrbo";
  parentRegion?: "puerto_vallarta" | "riviera_nayarit";
  /** Required pricing-tool bucket name; if set, jobs that don't match are skipped (and put back to pending). */
  neighborhood?: string;
  /** Set to true to bypass the per-job neighborhood filter (use with caution). */
  ignoreNeighborhoodGuard?: boolean;
}

export interface JobOutcome {
  jobId: number;
  source: string;
  bucket: string | null;
  url: string;
  cardsObserved: number;
  newListings: number;
  duplicates: number;
  parseFailures: number;
  blocked: string | null;
  error: string | null;
  terminationReason: string;
  httpDurationMs: number;
  htmlLength: number;
  sampleListingIds: number[];
}

export interface RunReport {
  jobsAttempted: number;
  jobsCompleted: number;
  jobsFailed: number;
  jobsSkipped: number;
  totalCardsObserved: number;
  totalNewListings: number;
  totalDuplicates: number;
  totalParseFailures: number;
  blockedCount: number;
  elapsedMs: number;
  perJob: JobOutcome[];
}

export async function runDiscoveryLoop(
  opts: RunDiscoveryOptions
): Promise<RunReport> {
  const t0 = Date.now();
  const report: RunReport = {
    jobsAttempted: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    jobsSkipped: 0,
    totalCardsObserved: 0,
    totalNewListings: 0,
    totalDuplicates: 0,
    totalParseFailures: 0,
    blockedCount: 0,
    elapsedMs: 0,
    perJob: [],
  };

  const filter: ClaimFilter = {};
  if (opts.source) filter.source = opts.source;
  if (opts.parentRegion) filter.parentRegion = opts.parentRegion;

  while (report.jobsAttempted < opts.maxJobs) {
    if (Date.now() - t0 >= opts.maxDurationMs) {
      console.log("[runner] Wall-clock budget exhausted, stopping.");
      break;
    }

    const job = await claimNext(filter);
    if (!job) {
      console.log("[runner] No pending jobs match the filter — queue empty.");
      break;
    }
    report.jobsAttempted += 1;

    // Optional neighborhood guard — protects the tight-scope first run.
    if (
      opts.neighborhood &&
      !opts.ignoreNeighborhoodGuard &&
      job.normalizedNeighborhoodBucket !== opts.neighborhood
    ) {
      console.log(
        `[runner] Job ${job.id} bucket=${job.normalizedNeighborhoodBucket} != ${opts.neighborhood}; releasing.`
      );
      // Put it back so other runs can pick it up.
      await markComplete(job.id, {
        discoveredCount: 0,
        newCount: 0,
        terminationReason: "manual_cap",
      });
      report.jobsSkipped += 1;
      continue;
    }

    console.log(
      `[runner] Claimed job ${job.id} (source=${job.source} bucket=${job.normalizedNeighborhoodBucket} g=${job.guestCount} n=${job.stayLengthNights} bed=${job.bedroomBucket} w=${job.checkinWindow})`
    );

    const outcome = await processJob(job, opts);
    report.perJob.push(outcome);
    report.totalCardsObserved += outcome.cardsObserved;
    report.totalNewListings += outcome.newListings;
    report.totalDuplicates += outcome.duplicates;
    report.totalParseFailures += outcome.parseFailures;
    if (outcome.blocked) report.blockedCount += 1;

    if (outcome.error) {
      report.jobsFailed += 1;
      await markFailed(
        job.id,
        outcome.error,
        outcome.blocked ? "blocked" : "parse_fail"
      );
    } else {
      report.jobsCompleted += 1;
      await markComplete(job.id, {
        discoveredCount: outcome.cardsObserved,
        newCount: outcome.newListings,
        terminationReason: outcome.terminationReason as
          | "exhausted"
          | "manual_cap"
          | "timeout"
          | "blocked"
          | "parse_fail"
          | "duplicate_only",
      });
    }

    // Stop the whole loop on first block — don't burn through the rest of the
    // budget hitting a wall.
    if (outcome.blocked) {
      console.log(
        `[runner] Block detected (${outcome.blocked}); stopping the loop.`
      );
      break;
    }
  }

  report.elapsedMs = Date.now() - t0;
  return report;
}

async function processJob(
  job: DiscoveryJob,
  opts: RunDiscoveryOptions
): Promise<JobOutcome> {
  const tracker = new YieldTracker({
    zeroYieldStreakLimit: 2,
    maxObservations: opts.maxResultsPerJob ?? 50,
  });

  const seed = {
    source: job.source as "airbnb" | "vrbo",
    jobType: "discovery" as const,
    parentRegionBucket: (job.parentRegionBucket ?? "puerto_vallarta") as
      | "puerto_vallarta"
      | "riviera_nayarit",
    normalizedNeighborhoodBucket: job.normalizedNeighborhoodBucket ?? "",
    guestCount: job.guestCount ?? 2,
    stayLengthNights: job.stayLengthNights ?? 3,
    bedroomBucket: job.bedroomBucket ?? "1",
    checkinWindow: job.checkinWindow ?? "next_weekend",
    priority: job.priority,
  };

  let batch: AirbnbBatch;
  if (job.source === "airbnb") {
    batch = await fetchAirbnbSeedBatch(seed as never, {
      maxCards: opts.maxResultsPerJob ?? 50,
    });
  } else if (job.source === "vrbo") {
    batch = await fetchVrboSeedBatch(seed as never, {
      maxCards: opts.maxResultsPerJob ?? 50,
    });
  } else {
    return {
      jobId: job.id,
      source: job.source,
      bucket: job.normalizedNeighborhoodBucket,
      url: "",
      cardsObserved: 0,
      newListings: 0,
      duplicates: 0,
      parseFailures: 0,
      blocked: null,
      error: `Source '${job.source}' is not enabled in Phase 2b first-run scope`,
      terminationReason: "manual_cap",
      httpDurationMs: 0,
      htmlLength: 0,
      sampleListingIds: [],
    };
  }

  const outcome: JobOutcome = {
    jobId: job.id,
    source: job.source,
    bucket: job.normalizedNeighborhoodBucket,
    url: batch.url,
    cardsObserved: batch.cards.length,
    newListings: 0,
    duplicates: 0,
    parseFailures: 0,
    blocked: batch.blocked,
    error: batch.error,
    terminationReason: "exhausted",
    httpDurationMs: batch.raw.httpDurationMs,
    htmlLength: batch.raw.htmlLength,
    sampleListingIds: [],
  };

  if (batch.blocked || batch.error) {
    outcome.terminationReason = batch.blocked ? "blocked" : "parse_fail";
    return outcome;
  }

  // Process each card → upsert listing + insert observation
  const observedAt = new Date();
  for (const card of batch.cards) {
    try {
      const sourceUrl =
        job.source === "vrbo"
          ? `https://www.vrbo.com/${card.id}`
          : `https://www.airbnb.com/rooms/${card.id}`;
      const neighborhoodRaw =
        job.normalizedNeighborhoodBucket ?? card.city ?? "Puerto Vallarta";

      const upsert = await upsertListing({
        source: job.source,
        externalId: card.id,
        sourceUrl,
        title: card.name ?? `Airbnb ${card.id}`,
        neighborhoodRaw,
        bedrooms: card.bedrooms ?? null,
        bathrooms: card.bathrooms ?? null,
        maxGuests: card.maxGuests ?? null,
        latitude: card.lat ?? null,
        longitude: card.lng ?? null,
        ratingOverall: card.rating ?? null,
        reviewCount: card.reviews ?? null,
        nightlyPriceUsd: card.price ?? null,
        observedAt,
      });

      if (upsert.isNew) outcome.newListings += 1;
      else outcome.duplicates += 1;
      if (outcome.sampleListingIds.length < 5) {
        outcome.sampleListingIds.push(upsert.listingId);
      }

      const mapping = mapToPricingToolBucket(neighborhoodRaw);
      await insertObservation({
        listingId: upsert.listingId,
        source: job.source,
        externalListingId: card.id,
        canonicalUrl: canonicalizeUrl(sourceUrl),
        observedAt,
        searchSeed: {
          jobId: job.id,
          guestCount: job.guestCount,
          stayLengthNights: job.stayLengthNights,
          bedroomBucket: job.bedroomBucket,
          checkinWindow: job.checkinWindow,
          searchUrl: batch.url,
        },
        titleDisplayed: card.name ?? null,
        displayedNightlyPrice: card.price ?? null,
        currency: "USD",
        displayedRating: card.rating ?? null,
        displayedReviewCount: card.reviews ?? null,
        rawLocationText: card.city ?? neighborhoodRaw,
        normalizedNeighborhoodBucket: mapping.pricingToolBucket,
        parentRegionBucket: mapping.parentRegion,
        rawCardJson: card,
      });

      tracker.recordBatch({
        observed: 1,
        newListings: upsert.isNew ? 1 : 0,
        duplicates: upsert.isNew ? 0 : 1,
      });
    } catch (err) {
      outcome.parseFailures += 1;
      console.error(
        `[runner] Card ${card.id} failed:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  outcome.terminationReason =
    tracker.snapshot().terminationReason === "running"
      ? "exhausted"
      : tracker.snapshot().terminationReason;
  return outcome;
}
