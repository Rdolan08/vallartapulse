/**
 * ingest/seed-generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, deterministic Phase 2a seed generator for the STR discovery queue.
 *
 * Generates the full permutation of (source × neighborhood × guest × stay ×
 * bedroom × window) seeds for the pricing-tool neighborhoods, sorted so that
 * Puerto Vallarta buckets always run before Riviera Nayarit ones.
 *
 * No I/O. No live scrapers. Phase 2b will consume these via the queue.
 */

import {
  PRICING_TOOL_BUCKETS,
  PARENT_REGION_BY_BUCKET,
  BUCKET_PRIORITY,
  type PricingToolBucket,
  type ParentRegion,
} from "../neighborhood-buckets.js";
import type { InsertDiscoveryJob } from "@workspace/db/schema";

export type Source = "airbnb" | "vrbo";
export type RegionFilter = "puerto_vallarta" | "riviera_nayarit" | "all";
export type CheckinWindow =
  | "next_weekend"
  | "+14"
  | "+30"
  | "+60"
  | "+90"
  | "+180";
export type BedroomBucket = "studio" | "1" | "2" | "3" | "4plus";

export const ALL_SOURCES: Source[] = ["airbnb", "vrbo"];
export const DEFAULT_GUEST_COUNTS = [2, 4, 6] as const;
export const DEFAULT_STAY_LENGTHS = [3, 5, 7] as const;
// Phase 2d-ext (April 2026): expanded full-coverage defaults.
// Bedroom defaults now include studio + 4plus for full PV coverage.
// Checkin defaults extend to +90/+180 to surface listings whose calendars
// are blocked closer in but open further out.
export const DEFAULT_BEDROOM_BUCKETS: BedroomBucket[] = [
  "studio",
  "1",
  "2",
  "3",
  "4plus",
];
export const DEFAULT_CHECKIN_WINDOWS: CheckinWindow[] = [
  "next_weekend",
  "+14",
  "+30",
  "+60",
  "+90",
  "+180",
];

const WINDOW_WEIGHT: Record<CheckinWindow, number> = {
  next_weekend: 6,
  "+14": 5,
  "+30": 4,
  "+60": 3,
  "+90": 2,
  "+180": 1,
};
const STAY_WEIGHT: Record<number, number> = { 3: 3, 5: 2, 7: 1 };
const GUEST_WEIGHT: Record<number, number> = { 1: 0, 2: 3, 4: 2, 6: 1 };
const SOURCE_WEIGHT: Record<Source, number> = { airbnb: 2, vrbo: 1 };

export interface GenerateSeedsOptions {
  source: Source | Source[];
  regions?: RegionFilter[];
  /** Pricing-tool bucket names to restrict to (case sensitive, exact). */
  neighborhoods?: string[];
  guestCounts?: readonly number[];
  stayLengths?: readonly number[];
  bedroomBuckets?: BedroomBucket[];
  checkinWindows?: CheckinWindow[];
}

export interface DiscoverySeed {
  source: Source;
  jobType: "discovery";
  parentRegionBucket: ParentRegion;
  normalizedNeighborhoodBucket: PricingToolBucket;
  guestCount: number;
  stayLengthNights: number;
  bedroomBucket: BedroomBucket;
  checkinWindow: CheckinWindow;
  priority: number;
}

/**
 * Generate the full permutation of discovery seeds, sorted by descending
 * priority. PV buckets always sort ahead of RN buckets because BUCKET_PRIORITY
 * dominates the score formula by 1000×.
 */
export function generateSeeds(opts: GenerateSeedsOptions): DiscoverySeed[] {
  const sources = Array.isArray(opts.source) ? opts.source : [opts.source];
  const regions: RegionFilter[] = opts.regions ?? ["all"];
  const nbhdFilter = opts.neighborhoods?.length
    ? new Set(opts.neighborhoods)
    : null;

  const buckets = PRICING_TOOL_BUCKETS.filter((b) => {
    if (nbhdFilter && !nbhdFilter.has(b)) return false;
    if (regions.includes("all")) return true;
    return regions.includes(PARENT_REGION_BY_BUCKET[b]);
  });

  const guestCounts = opts.guestCounts ?? DEFAULT_GUEST_COUNTS;
  const stayLengths = opts.stayLengths ?? DEFAULT_STAY_LENGTHS;
  const bedroomBuckets = opts.bedroomBuckets ?? DEFAULT_BEDROOM_BUCKETS;
  const checkinWindows = opts.checkinWindows ?? DEFAULT_CHECKIN_WINDOWS;

  const seeds: DiscoverySeed[] = [];
  for (const source of sources) {
    for (const bucket of buckets) {
      for (const guests of guestCounts) {
        for (const stay of stayLengths) {
          for (const bedrooms of bedroomBuckets) {
            for (const window of checkinWindows) {
              seeds.push({
                source,
                jobType: "discovery",
                parentRegionBucket: PARENT_REGION_BY_BUCKET[bucket],
                normalizedNeighborhoodBucket: bucket,
                guestCount: guests,
                stayLengthNights: stay,
                bedroomBucket: bedrooms,
                checkinWindow: window,
                priority: computePriority({
                  bucket,
                  source,
                  window,
                  stay,
                  guests,
                }),
              });
            }
          }
        }
      }
    }
  }

  return seeds.sort(deterministicCompare);
}

function computePriority(p: {
  bucket: PricingToolBucket;
  source: Source;
  window: CheckinWindow;
  stay: number;
  guests: number;
}): number {
  return (
    BUCKET_PRIORITY[p.bucket] * 1000 +
    SOURCE_WEIGHT[p.source] * 100 +
    WINDOW_WEIGHT[p.window] * 10 +
    (STAY_WEIGHT[p.stay] ?? 0) +
    (GUEST_WEIGHT[p.guests] ?? 0)
  );
}

function deterministicCompare(a: DiscoverySeed, b: DiscoverySeed): number {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.normalizedNeighborhoodBucket !== b.normalizedNeighborhoodBucket)
    return a.normalizedNeighborhoodBucket.localeCompare(
      b.normalizedNeighborhoodBucket
    );
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  if (a.checkinWindow !== b.checkinWindow)
    return a.checkinWindow.localeCompare(b.checkinWindow);
  if (a.stayLengthNights !== b.stayLengthNights)
    return a.stayLengthNights - b.stayLengthNights;
  if (a.guestCount !== b.guestCount) return a.guestCount - b.guestCount;
  return a.bedroomBucket.localeCompare(b.bedroomBucket);
}

/** Convert a generated seed to a row shape suitable for `insert(discoveryJobsTable).values()`. */
export function toInsertRow(seed: DiscoverySeed): InsertDiscoveryJob {
  return {
    source: seed.source,
    jobType: seed.jobType,
    parentRegionBucket: seed.parentRegionBucket,
    normalizedNeighborhoodBucket: seed.normalizedNeighborhoodBucket,
    guestCount: seed.guestCount,
    stayLengthNights: seed.stayLengthNights,
    bedroomBucket: seed.bedroomBucket,
    checkinWindow: seed.checkinWindow,
    priority: seed.priority,
    status: "pending",
    attempts: 0,
    discoveredCount: 0,
    newCount: 0,
  };
}
