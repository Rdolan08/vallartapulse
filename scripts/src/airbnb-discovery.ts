/**
 * scripts/src/airbnb-discovery.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Residential Airbnb discovery runner. Production-safe; runs from a Mac mini
 * on a residential IP. Designed to coexist with the existing Railway-hosted
 * scheduled scrapers — does NOT replace them.
 *
 * Behavior:
 *   1. Build the cross-product of (neighborhood × bedroom-band × price-band)
 *      → ~200 buckets covering the PV + Riviera Nayarit market.
 *   2. For each bucket, fetch up to 5 search pages with 5–8s pacing.
 *   3. Extract candidate /rooms/{id} listings from the search HTML.
 *   4. Dedupe candidates against rental_listings; bump last_seen_at for any
 *      already known IDs in the bucket.
 *   5. For unseen candidates: fetch the listing PDP, run identity check
 *      (HTTP 200 + not delisted/captcha), parse minimum fields, apply gates:
 *        a. identity     (must reach a real listing page)
 *        b. geographic   (lat/lng inside PV market bbox)
 *        c. property type (whitelist: apartment, condo, house, villa, ...)
 *        d. completeness (bedrooms, bathrooms, lat, lng all present)
 *   6. Insert/upsert accepted listings into the active cohort. Insert/upsert
 *      excluded ones with `is_active=false` + `cohort_excluded_reason` IFF
 *      they have enough data to satisfy NOT NULL constraints; otherwise log
 *      the rejection in discovery_run_log + JSON event stream and skip.
 *   7. Write one row to discovery_run_log per bucket with full counters.
 *
 * Strict TypeScript, no `any`. All requests use the host's residential IP
 * directly (no proxy). PROXY_URL is intentionally ignored — this runner
 * MUST be invoked from the residential Mac mini; datacenter direct fetches
 * will all fail the identity check and trip the preflight.
 *
 * Usage (from Mac mini):
 *   DATABASE_URL=$RAILWAY_DATABASE_URL pnpm --filter @workspace/scripts \
 *     exec tsx ./src/airbnb-discovery.ts
 *
 * Optional env knobs:
 *   DISCOVERY_MAX_BUCKETS    cap buckets per run (default: all 200)
 *   DISCOVERY_MAX_PAGES      pages per bucket   (default: 5)
 *   DISCOVERY_MIN_DELAY_MS   min between requests (default: 5000)
 *   DISCOVERY_MAX_DELAY_MS   max between requests (default: 8000)
 *   DISCOVERY_DRY_RUN=1      skip all DB writes; just log what would happen
 */

import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  discoveryRunLogTable,
  discoveryRejectedCandidatesTable,
} from "@workspace/db";
import {
  fetchAirbnbResidential,
  residentialFetchLooksUnusable,
} from "./lib/airbnb-residential-fetch.js";
import { extractSearchCards } from "../../artifacts/api-server/src/lib/ingest/airbnb-search-adapter.js";
import {
  buildBuckets,
  buildSearchUrl,
  type DiscoveryBucket,
} from "./lib/airbnb-discovery-buckets.js";
import {
  sleep,
  randomDelayMs,
  backoffMs,
  inMarket,
  isAllowedPropertyType,
  normalizePropertyType,
  logEvent,
} from "./lib/airbnb-discovery-helpers.js";
import { parseListingDetail } from "./lib/airbnb-detail-parser.js";

const SOURCE_PLATFORM = "airbnb" as const;

const MAX_BUCKETS = process.env.DISCOVERY_MAX_BUCKETS
  ? Math.max(1, parseInt(process.env.DISCOVERY_MAX_BUCKETS, 10))
  : null;
const MAX_PAGES = process.env.DISCOVERY_MAX_PAGES
  ? Math.max(1, parseInt(process.env.DISCOVERY_MAX_PAGES, 10))
  : 5;
const MIN_DELAY_MS = process.env.DISCOVERY_MIN_DELAY_MS
  ? Math.max(0, parseInt(process.env.DISCOVERY_MIN_DELAY_MS, 10))
  : 5_000;
const MAX_DELAY_MS = process.env.DISCOVERY_MAX_DELAY_MS
  ? Math.max(MIN_DELAY_MS, parseInt(process.env.DISCOVERY_MAX_DELAY_MS, 10))
  : 8_000;
const DRY_RUN = process.env.DISCOVERY_DRY_RUN === "1";
const FETCH_TIMEOUT_MS = 25_000;
const MAX_IDENTITY_RETRIES = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Per-bucket counters
// ─────────────────────────────────────────────────────────────────────────────

interface BucketCounters {
  pagesFetched: number;
  candidateIdsSeen: number;
  existingTouched: number;
  newInserted: number;
  rejectedIdentity: number;
  rejectedGeo: number;
  rejectedPropertyType: number;
  rejectedThinData: number;
  retryCount: number;
  errors: Array<Record<string, unknown>>;
}

function freshCounters(): BucketCounters {
  return {
    pagesFetched: 0,
    candidateIdsSeen: 0,
    existingTouched: 0,
    newInserted: 0,
    rejectedIdentity: 0,
    rejectedGeo: 0,
    rejectedPropertyType: 0,
    rejectedThinData: 0,
    retryCount: 0,
    errors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bucket execution
// ─────────────────────────────────────────────────────────────────────────────

async function runBucket(bucket: DiscoveryBucket): Promise<BucketCounters> {
  const counters = freshCounters();
  logEvent({ event: "bucket_started", bucketId: bucket.bucketId, searchUrl: bucket.searchUrl });

  // ── 1. Fetch search pages, accumulate candidate IDs ────────────────────
  const candidateIds = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = buildSearchUrl(bucket, page);
    try {
      const r = await fetchAirbnbResidential(url, { timeoutMs: FETCH_TIMEOUT_MS });
      counters.pagesFetched++;
      if (r.status >= 400) {
        counters.errors.push({ stage: "search_page", page, url, status: r.status });
        logEvent({
          event: "search_page_failed",
          bucketId: bucket.bucketId,
          reason: `http ${r.status}`,
          page,
        });
        // 403/429 → stop this bucket; the IP needs a rest.
        if (r.status === 403 || r.status === 429) break;
        continue;
      }
      const cards = extractSearchCards(r.html);
      const beforeSize = candidateIds.size;
      for (const c of cards) candidateIds.add(c.id);
      const newOnPage = candidateIds.size - beforeSize;
      logEvent({
        event: "search_page_fetched",
        bucketId: bucket.bucketId,
        page,
        cardsExtracted: cards.length,
        newCandidatesOnPage: newOnPage,
      });
      // If page returned 0 NEW candidates and any cards at all, the bucket is
      // probably exhausted — stop early to save the IP budget.
      if (page > 0 && newOnPage === 0 && cards.length > 0) break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      counters.errors.push({ stage: "search_page", page, url, message: msg });
      logEvent({
        event: "search_page_failed",
        bucketId: bucket.bucketId,
        page,
        reason: msg,
      });
    }
    await sleep(randomDelayMs(MIN_DELAY_MS, MAX_DELAY_MS));
  }

  counters.candidateIdsSeen = candidateIds.size;
  if (candidateIds.size === 0) {
    logEvent({ event: "bucket_finished", bucketId: bucket.bucketId, ...summarize(counters) });
    return counters;
  }

  // ── 2. Dedupe against rental_listings ──────────────────────────────────
  const candidateUrls = Array.from(candidateIds).map(canonicalAirbnbUrl);
  const existing = DRY_RUN
    ? []
    : await db
        .select({ id: rentalListingsTable.id, sourceUrl: rentalListingsTable.sourceUrl })
        .from(rentalListingsTable)
        .where(
          and(
            eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
            inArray(rentalListingsTable.sourceUrl, candidateUrls)
          )
        );

  const existingUrls = new Set(existing.map((r) => r.sourceUrl));
  const existingIds = existing.map((r) => r.id);

  // Bump last_seen_at on already-known listings touched by this bucket.
  if (!DRY_RUN && existingIds.length > 0) {
    const now = new Date();
    await db
      .update(rentalListingsTable)
      .set({
        lastSeenAt: now,
        seenCount: sql`COALESCE(${rentalListingsTable.seenCount}, 0) + 1`,
      })
      .where(inArray(rentalListingsTable.id, existingIds));
    counters.existingTouched = existingIds.length;
    logEvent({
      event: "existing_touched",
      bucketId: bucket.bucketId,
      count: existingIds.length,
    });
  }

  for (const id of candidateIds) {
    if (existingUrls.has(canonicalAirbnbUrl(id))) {
      logEvent({ event: "candidate_deduped", bucketId: bucket.bucketId, externalId: id });
    }
  }

  // ── 3. Detail-fetch + gate-check unseen candidates ─────────────────────
  const unseen = Array.from(candidateIds).filter(
    (id) => !existingUrls.has(canonicalAirbnbUrl(id))
  );

  for (const externalId of unseen) {
    await sleep(randomDelayMs(MIN_DELAY_MS, MAX_DELAY_MS));
    const result = await processCandidate(bucket, externalId, counters);
    if (result.outcome === "inserted") counters.newInserted++;
    else if (result.outcome === "rejected_identity") counters.rejectedIdentity++;
    else if (result.outcome === "rejected_geo") counters.rejectedGeo++;
    else if (result.outcome === "rejected_property_type") counters.rejectedPropertyType++;
    else if (result.outcome === "rejected_thin_data") counters.rejectedThinData++;
  }

  logEvent({ event: "bucket_finished", bucketId: bucket.bucketId, ...summarize(counters) });
  return counters;
}

function summarize(c: BucketCounters): Record<string, number> {
  return {
    pagesFetched: c.pagesFetched,
    candidateIdsSeen: c.candidateIdsSeen,
    existingTouched: c.existingTouched,
    newInserted: c.newInserted,
    rejectedIdentity: c.rejectedIdentity,
    rejectedGeo: c.rejectedGeo,
    rejectedPropertyType: c.rejectedPropertyType,
    rejectedThinData: c.rejectedThinData,
    retryCount: c.retryCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-candidate flow
// ─────────────────────────────────────────────────────────────────────────────

type CandidateOutcome =
  | "inserted"
  | "rejected_identity"
  | "rejected_geo"
  | "rejected_property_type"
  | "rejected_thin_data";

interface CandidateResult {
  outcome: CandidateOutcome;
}

async function processCandidate(
  bucket: DiscoveryBucket,
  externalId: string,
  counters: BucketCounters
): Promise<CandidateResult> {
  const url = canonicalAirbnbUrl(externalId);

  // Identity: GET listing page with retries on transient failures.
  logEvent({ event: "identity_check_started", bucketId: bucket.bucketId, externalId });
  let html: string | null = null;
  let lastFailReason: string = "no_attempt";
  for (let attempt = 0; attempt < MAX_IDENTITY_RETRIES; attempt++) {
    try {
      const r = await fetchAirbnbResidential(url, { timeoutMs: FETCH_TIMEOUT_MS });
      const u = residentialFetchLooksUnusable(r.html, r.status);
      if (u.unusable) {
        lastFailReason = u.reason ?? `unusable status=${r.status}`;
        // Transient (5xx, 429, captcha) → retry. 404/delisted → no retry.
        if (r.status >= 500 || r.status === 429 || u.reason?.includes("captcha")) {
          counters.retryCount++;
          logEvent({
            event: "identity_retry",
            bucketId: bucket.bucketId,
            externalId,
            attempt,
            reason: lastFailReason,
          });
          await sleep(backoffMs(attempt));
          continue;
        }
        break; // Hard failure (404, etc.) — no point retrying.
      }
      html = r.html;
      break;
    } catch (e) {
      lastFailReason = e instanceof Error ? e.message : String(e);
      counters.retryCount++;
      logEvent({
        event: "identity_retry",
        bucketId: bucket.bucketId,
        externalId,
        attempt,
        reason: lastFailReason,
      });
      await sleep(backoffMs(attempt));
    }
  }

  if (!html) {
    const event = {
      event: "identity_check_failed" as const,
      bucketId: bucket.bucketId,
      externalId,
      reason: lastFailReason,
    };
    logEvent(event);
    counters.errors.push({ stage: "identity", externalId, reason: lastFailReason });
    if (!DRY_RUN) {
      await upsertRejectedCandidate({
        externalId,
        url,
        bucketId: bucket.bucketId,
        rejectionReason: "identity_failed",
        identityCheckStatus: "failed",
        detail: null,
        event,
      });
    }
    return { outcome: "rejected_identity" };
  }
  logEvent({ event: "identity_check_passed", bucketId: bucket.bucketId, externalId });

  const detail = parseListingDetail(html);

  // Geographic gate.
  if (detail.latitude !== null && detail.longitude !== null) {
    if (!inMarket(detail.latitude, detail.longitude)) {
      const event = {
        event: "listing_rejected" as const,
        bucketId: bucket.bucketId,
        externalId,
        reason: "out_of_market",
        lat: detail.latitude,
        lng: detail.longitude,
      };
      logEvent(event);
      if (!DRY_RUN) {
        await upsertRejectedCandidate({
          externalId,
          url,
          bucketId: bucket.bucketId,
          rejectionReason: "out_of_market",
          identityCheckStatus: "passed",
          detail,
          event,
        });
      }
      return { outcome: "rejected_geo" };
    }
  }

  // Property-type whitelist.
  if (!isAllowedPropertyType(detail.propertyTypeRaw)) {
    const event = {
      event: "listing_rejected" as const,
      bucketId: bucket.bucketId,
      externalId,
      reason: "wrong_property_type",
      propertyType: detail.propertyTypeRaw,
    };
    logEvent(event);
    if (!DRY_RUN) {
      await upsertRejectedCandidate({
        externalId,
        url,
        bucketId: bucket.bucketId,
        rejectionReason: "wrong_property_type",
        identityCheckStatus: "passed",
        detail,
        event,
      });
    }
    return { outcome: "rejected_property_type" };
  }

  // Completeness gate (NOT NULL fields on rental_listings).
  if (
    detail.bedrooms === null ||
    detail.bathrooms === null ||
    detail.latitude === null ||
    detail.longitude === null ||
    !detail.title
  ) {
    const event = {
      event: "listing_rejected" as const,
      bucketId: bucket.bucketId,
      externalId,
      reason: "thin_data",
      missing: {
        title: !detail.title,
        bedrooms: detail.bedrooms === null,
        bathrooms: detail.bathrooms === null,
        latitude: detail.latitude === null,
        longitude: detail.longitude === null,
      },
    };
    logEvent(event);
    // Persist whatever we DID parse to the rejected-candidates audit table
    // so the rejection is durable (not just in stdout/run-log).
    if (!DRY_RUN) {
      await upsertRejectedCandidate({
        externalId,
        url,
        bucketId: bucket.bucketId,
        rejectionReason: "thin_data",
        identityCheckStatus: "passed",
        detail,
        event,
      });
    }
    return { outcome: "rejected_thin_data" };
  }

  // Active-cohort insert.
  const confidence = computeDiscoveryConfidence(detail);
  if (!DRY_RUN) {
    await upsertActiveListing({
      externalId,
      url,
      title: detail.title,
      bedrooms: Math.round(detail.bedrooms),
      bathrooms: detail.bathrooms,
      latitude: detail.latitude,
      longitude: detail.longitude,
      propertyTypeRaw: detail.propertyTypeRaw,
      neighborhoodRaw: detail.neighborhoodHint ?? bucket.normalizedNeighborhoodBucket,
      neighborhoodNormalized: bucket.normalizedNeighborhoodBucket,
      parentRegionBucket: bucket.parentRegionBucket,
      normalizedNeighborhoodBucket: bucket.normalizedNeighborhoodBucket,
      dataConfidenceScore: confidence,
    });
  }
  logEvent({
    event: "listing_inserted",
    bucketId: bucket.bucketId,
    externalId,
    propertyType: detail.propertyTypeRaw,
    dataConfidenceScore: confidence,
  });
  return { outcome: "inserted" };
}

/**
 * Discovery-stage confidence score in [0, 1]. Composed from:
 *   - Identity check passing                (0.20)
 *   - Geographic gate passing (lat+lng in market) (0.15)
 *   - Property type extracted               (0.10)
 *   - Bedrooms parsed                       (0.15)
 *   - Bathrooms parsed                      (0.10)
 *   - Title parsed                          (0.10)
 *   - Neighborhood hint parsed              (0.05)
 *   - Lat/lng both parsed (geo enrich-ready) (0.15)
 *
 * Caller has already enforced the completeness floor, so most discovery
 * inserts will land in the 0.85–1.0 band. Listings that just barely passed
 * (no neighborhood hint, weak property type) score lower so downstream
 * dashboards can still distinguish quality without re-parsing.
 *
 * Replaces the previous bootstrap value of 0.4. Bumped up by the richer
 * detail/calendar/review enrichment passes that run later.
 */
function computeDiscoveryConfidence(detail: {
  title: string | null;
  propertyTypeRaw: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  latitude: number | null;
  longitude: number | null;
  neighborhoodHint: string | null;
}): number {
  let score = 0;
  // Identity always passed at this point in the flow.
  score += 0.20;
  // Geo gate: present AND in market (the gate would have rejected otherwise,
  // but be defensive — caller might bypass in future refactors).
  if (detail.latitude !== null && detail.longitude !== null) {
    score += 0.15;
    score += 0.15; // Both coordinates available for downstream enrichment.
  }
  if (detail.propertyTypeRaw && detail.propertyTypeRaw.trim().length > 0) {
    score += 0.10;
  }
  if (detail.bedrooms !== null) score += 0.15;
  if (detail.bathrooms !== null) score += 0.10;
  if (detail.title && detail.title.trim().length > 0) score += 0.10;
  if (detail.neighborhoodHint && detail.neighborhoodHint.trim().length > 0) {
    score += 0.05;
  }
  // Numerical safety: clamp to [0, 1].
  return Math.max(0, Math.min(1, parseFloat(score.toFixed(3))));
}

function canonicalAirbnbUrl(externalId: string): string {
  return `https://www.airbnb.com/rooms/${externalId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB writes
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveListingInput {
  externalId: string;
  url: string;
  title: string;
  bedrooms: number;
  bathrooms: number;
  latitude: number;
  longitude: number;
  propertyTypeRaw: string | null;
  neighborhoodRaw: string;
  neighborhoodNormalized: string;
  parentRegionBucket: string;
  normalizedNeighborhoodBucket: string;
  dataConfidenceScore: number;
}

/**
 * Upsert an accepted active listing into rental_listings. ON CONFLICT target
 * is the partial unique index on (source_platform, external_id), NOT
 * (source_platform, source_url) — so URL drift (mobile/desktop, query-param
 * variants, locale redirects) collapses to a single row per logical Airbnb
 * listing rather than producing duplicates.
 */
async function upsertActiveListing(input: ActiveListingInput): Promise<void> {
  const now = new Date();
  await db
    .insert(rentalListingsTable)
    .values({
      sourcePlatform: SOURCE_PLATFORM,
      sourceUrl: input.url,
      externalId: input.externalId,
      title: input.title,
      neighborhoodRaw: input.neighborhoodRaw,
      neighborhoodNormalized: input.neighborhoodNormalized,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      latitude: input.latitude,
      longitude: input.longitude,
      scrapedAt: now,
      dataConfidenceScore: input.dataConfidenceScore,
      isActive: true,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      lifecycleStatus: "active",
      identityKey: `${SOURCE_PLATFORM}:${input.externalId}`,
      parentRegionBucket: input.parentRegionBucket,
      normalizedNeighborhoodBucket: input.normalizedNeighborhoodBucket,
      propertyTypeRaw: input.propertyTypeRaw,
      propertyTypeNormalized: normalizePropertyType(input.propertyTypeRaw),
      identityCheckedAt: now,
      identityCheckStatus: "passed",
      cohortExcludedReason: null,
    })
    .onConflictDoUpdate({
      // Conflict target is the partial unique index idx_rl_platform_external_unique
      // on (source_platform, external_id) WHERE external_id IS NOT NULL.
      // Postgres requires the WHERE predicate be repeated here so the planner
      // knows which partial index to match. This makes external_id the durable
      // platform identity — URL drift no longer creates duplicate rows.
      target: [rentalListingsTable.sourcePlatform, rentalListingsTable.externalId],
      targetWhere: sql`${rentalListingsTable.externalId} IS NOT NULL`,
      set: {
        sourceUrl: input.url,
        externalId: input.externalId,
        title: input.title,
        bedrooms: input.bedrooms,
        bathrooms: input.bathrooms,
        latitude: input.latitude,
        longitude: input.longitude,
        neighborhoodRaw: input.neighborhoodRaw,
        neighborhoodNormalized: input.neighborhoodNormalized,
        propertyTypeRaw: input.propertyTypeRaw,
        propertyTypeNormalized: normalizePropertyType(input.propertyTypeRaw),
        parentRegionBucket: input.parentRegionBucket,
        normalizedNeighborhoodBucket: input.normalizedNeighborhoodBucket,
        identityCheckedAt: now,
        identityCheckStatus: "passed",
        cohortExcludedReason: null,
        isActive: true,
        lifecycleStatus: "active",
        lastSeenAt: now,
        seenCount: sql`COALESCE(${rentalListingsTable.seenCount}, 0) + 1`,
        // Bump the confidence score only if the new computation is higher.
        dataConfidenceScore: sql`GREATEST(${rentalListingsTable.dataConfidenceScore}, ${input.dataConfidenceScore})`,
        updatedAt: now,
      },
    });
}

interface RejectedCandidateInput {
  externalId: string;
  url: string;
  bucketId: string;
  rejectionReason:
    | "identity_failed"
    | "out_of_market"
    | "wrong_property_type"
    | "thin_data";
  identityCheckStatus: "passed" | "failed";
  detail: {
    title: string | null;
    propertyTypeRaw: string | null;
    bedrooms: number | null;
    bathrooms: number | null;
    latitude: number | null;
    longitude: number | null;
    neighborhoodHint: string | null;
  } | null;
  event: Record<string, unknown>;
}

/**
 * Upsert a rejected candidate into discovery_rejected_candidates. Unlike
 * the original update-only exclusion path, this ALWAYS persists the
 * rejection — satisfying the brief's "excluded rows preserved and never
 * deleted" requirement. Repeated rejections for the same external_id bump
 * last_seen_at and seen_count rather than creating duplicate audit rows.
 */
async function upsertRejectedCandidate(
  input: RejectedCandidateInput
): Promise<void> {
  const now = new Date();
  const detail = input.detail;
  await db
    .insert(discoveryRejectedCandidatesTable)
    .values({
      sourcePlatform: SOURCE_PLATFORM,
      externalId: input.externalId,
      sourceUrl: input.url,
      rejectionReason: input.rejectionReason,
      identityCheckStatus: input.identityCheckStatus,
      parsedTitle: detail?.title ?? null,
      parsedPropertyType: detail?.propertyTypeRaw ?? null,
      parsedLatitude: detail?.latitude ?? null,
      parsedLongitude: detail?.longitude ?? null,
      parsedBedrooms: detail?.bedrooms ?? null,
      parsedBathrooms: detail?.bathrooms ?? null,
      parsedNeighborhoodHint: detail?.neighborhoodHint ?? null,
      bucketId: input.bucketId,
      firstSeenAt: now,
      lastSeenAt: now,
      seenCount: 1,
      lastEvent: input.event,
    })
    .onConflictDoUpdate({
      target: [
        discoveryRejectedCandidatesTable.sourcePlatform,
        discoveryRejectedCandidatesTable.externalId,
      ],
      set: {
        sourceUrl: input.url,
        rejectionReason: input.rejectionReason,
        identityCheckStatus: input.identityCheckStatus,
        parsedTitle: detail?.title ?? null,
        parsedPropertyType: detail?.propertyTypeRaw ?? null,
        parsedLatitude: detail?.latitude ?? null,
        parsedLongitude: detail?.longitude ?? null,
        parsedBedrooms: detail?.bedrooms ?? null,
        parsedBathrooms: detail?.bathrooms ?? null,
        parsedNeighborhoodHint: detail?.neighborhoodHint ?? null,
        bucketId: input.bucketId,
        lastSeenAt: now,
        seenCount: sql`COALESCE(${discoveryRejectedCandidatesTable.seenCount}, 0) + 1`,
        lastEvent: input.event,
        updatedAt: now,
      },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery run log
// ─────────────────────────────────────────────────────────────────────────────

async function writeRunLog(
  bucket: DiscoveryBucket,
  startedAt: Date,
  finishedAt: Date,
  counters: BucketCounters
): Promise<void> {
  if (DRY_RUN) return;
  await db.insert(discoveryRunLogTable).values({
    bucketId: bucket.bucketId,
    sourcePlatform: SOURCE_PLATFORM,
    bucketQueryUrl: bucket.searchUrl,
    startedAt,
    finishedAt,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    pagesFetched: counters.pagesFetched,
    candidateIdsSeen: counters.candidateIdsSeen,
    existingTouched: counters.existingTouched,
    newInserted: counters.newInserted,
    rejectedIdentity: counters.rejectedIdentity,
    rejectedGeo: counters.rejectedGeo,
    rejectedPropertyType: counters.rejectedPropertyType,
    rejectedThinData: counters.rejectedThinData,
    retryCount: counters.retryCount,
    errors: counters.errors.length > 0 ? counters.errors : null,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface RunTotals {
  bucketsRun: number;
  candidateIdsSeen: number;
  existingTouched: number;
  newInserted: number;
  rejectedIdentity: number;
  rejectedGeo: number;
  rejectedPropertyType: number;
  rejectedThinData: number;
  retryCount: number;
  totalDurationMs: number;
}

function freshTotals(): RunTotals {
  return {
    bucketsRun: 0,
    candidateIdsSeen: 0,
    existingTouched: 0,
    newInserted: 0,
    rejectedIdentity: 0,
    rejectedGeo: 0,
    rejectedPropertyType: 0,
    rejectedThinData: 0,
    retryCount: 0,
    totalDurationMs: 0,
  };
}

/**
 * Preflight: do one cheap fetch against the airbnb.com root before kicking
 * off 200 buckets. If transport is misconfigured (residential IP banned,
 * captcha wall, no internet), abort immediately rather than spending an
 * hour silently filling discovery_run_log with zero-result rows. The
 * bucket-level try/catch otherwise swallows transport errors per-page and
 * the only symptom of a broken run is "totals all zero" — which is
 * indistinguishable from a legitimately empty market.
 */
async function preflight(): Promise<void> {
  const probeUrl = "https://www.airbnb.com/";
  try {
    const r = await fetchAirbnbResidential(probeUrl, { timeoutMs: FETCH_TIMEOUT_MS });
    const u = residentialFetchLooksUnusable(r.html, r.status);
    if (u.unusable) {
      throw new Error(`preflight unusable: ${u.reason ?? `status=${r.status}`}`);
    }
    logEvent({ event: "run_started", preflight: "ok", probeStatus: r.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent({
      event: "run_finished",
      fatalError: `preflight failed: ${msg}`,
    });
    throw new Error(
      `Discovery preflight failed (${msg}). ` +
        `Aborting before consuming the bucket budget. ` +
        `This runner uses the host residential IP — verify network ` +
        `connectivity and that the host is not on a datacenter network.`
    );
  }
}

async function main(): Promise<void> {
  const allBuckets = buildBuckets();
  const buckets = MAX_BUCKETS ? allBuckets.slice(0, MAX_BUCKETS) : allBuckets;
  const totals = freshTotals();
  const runStart = Date.now();

  logEvent({
    event: "run_started",
    totalBuckets: buckets.length,
    dryRun: DRY_RUN,
    pacingMs: { min: MIN_DELAY_MS, max: MAX_DELAY_MS },
    transport: "residential-direct",
  });

  await preflight();

  for (const bucket of buckets) {
    const startedAt = new Date();
    let counters: BucketCounters;
    try {
      counters = await runBucket(bucket);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({ event: "bucket_finished", bucketId: bucket.bucketId, fatalError: msg });
      counters = freshCounters();
      counters.errors.push({ stage: "bucket_fatal", message: msg });
    }
    const finishedAt = new Date();

    try {
      await writeRunLog(bucket, startedAt, finishedAt, counters);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({ event: "bucket_finished", bucketId: bucket.bucketId, runLogWriteError: msg });
    }

    totals.bucketsRun++;
    totals.candidateIdsSeen += counters.candidateIdsSeen;
    totals.existingTouched += counters.existingTouched;
    totals.newInserted += counters.newInserted;
    totals.rejectedIdentity += counters.rejectedIdentity;
    totals.rejectedGeo += counters.rejectedGeo;
    totals.rejectedPropertyType += counters.rejectedPropertyType;
    totals.rejectedThinData += counters.rejectedThinData;
    totals.retryCount += counters.retryCount;
  }

  totals.totalDurationMs = Date.now() - runStart;
  logEvent({ event: "run_finished", ...totals });
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    logEvent({
      event: "run_finished",
      fatalError: e instanceof Error ? e.message : String(e),
    });
    await pool.end();
    process.exit(1);
  });
