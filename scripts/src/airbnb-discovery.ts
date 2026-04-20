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
 * Strict TypeScript, no `any`. All requests routed through PROXY_URL when
 * set (Decodo residential), otherwise direct (use only from a residential
 * IP — datacenter direct fetches will all fail the identity check).
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

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  discoveryRunLogTable,
} from "@workspace/db";
import {
  fetchAirbnbRaw,
  rawFetchLooksUnusable,
} from "../../artifacts/api-server/src/lib/ingest/raw-fetch.js";
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
      const r = await fetchAirbnbRaw(url, { timeoutMs: FETCH_TIMEOUT_MS });
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
      const r = await fetchAirbnbRaw(url, { timeoutMs: FETCH_TIMEOUT_MS });
      const u = rawFetchLooksUnusable(r.html, r.status);
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
    logEvent({
      event: "identity_check_failed",
      bucketId: bucket.bucketId,
      externalId,
      reason: lastFailReason,
    });
    counters.errors.push({ stage: "identity", externalId, reason: lastFailReason });
    if (!DRY_RUN) {
      await upsertExclusion(externalId, url, "identity_failed", null);
    }
    return { outcome: "rejected_identity" };
  }
  logEvent({ event: "identity_check_passed", bucketId: bucket.bucketId, externalId });

  const detail = parseListingDetail(html);

  // Geographic gate.
  if (detail.latitude !== null && detail.longitude !== null) {
    if (!inMarket(detail.latitude, detail.longitude)) {
      logEvent({
        event: "listing_rejected",
        bucketId: bucket.bucketId,
        externalId,
        reason: "out_of_market",
        lat: detail.latitude,
        lng: detail.longitude,
      });
      if (!DRY_RUN) {
        await upsertExclusion(externalId, url, "out_of_market", detail.title);
      }
      return { outcome: "rejected_geo" };
    }
  }

  // Property-type whitelist.
  if (!isAllowedPropertyType(detail.propertyTypeRaw)) {
    logEvent({
      event: "listing_rejected",
      bucketId: bucket.bucketId,
      externalId,
      reason: "wrong_property_type",
      propertyType: detail.propertyTypeRaw,
    });
    if (!DRY_RUN) {
      await upsertExclusion(externalId, url, "wrong_property_type", detail.title);
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
    logEvent({
      event: "listing_rejected",
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
    });
    // Do NOT insert — schema requires these as NOT NULL, and a placeholder
    // record would corrupt downstream comp queries. Audit lives in the run
    // log + this stdout event.
    return { outcome: "rejected_thin_data" };
  }

  // Active-cohort insert.
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
    });
  }
  logEvent({
    event: "listing_inserted",
    bucketId: bucket.bucketId,
    externalId,
    propertyType: detail.propertyTypeRaw,
  });
  return { outcome: "inserted" };
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
}

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
      dataConfidenceScore: 0.4, // Search+detail card data; richer enrich runs later.
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
      target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
      set: {
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
        updatedAt: now,
      },
    });
}

/**
 * Insert/update an exclusion record. Only runs when there's enough data to
 * satisfy the NOT NULL columns (bedrooms, bathrooms, etc.) — for thin
 * candidates the audit lives in discovery_run_log only. Currently this means
 * exclusions are rare for "thin_data" but common for "out_of_market" and
 * "wrong_property_type" (where we already parsed enough fields to tell).
 *
 * For identity_failed candidates we don't have ANY parsed detail data, so
 * we only update if the row already exists in the table.
 */
async function upsertExclusion(
  externalId: string,
  url: string,
  reason: "identity_failed" | "out_of_market" | "wrong_property_type",
  titleHint: string | null
): Promise<void> {
  const now = new Date();
  // Try update-only first (no insert). If 0 rows updated we just don't
  // record this exclusion — it's still in the run log.
  await db
    .update(rentalListingsTable)
    .set({
      identityCheckedAt: now,
      identityCheckStatus: reason === "identity_failed" ? "failed" : "passed",
      cohortExcludedReason: reason,
      isActive: false,
      lifecycleStatus: reason === "identity_failed" ? "delisted" : reason,
      updatedAt: now,
      ...(titleHint ? { title: titleHint } : {}),
    })
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        eq(rentalListingsTable.sourceUrl, url)
      )
    );
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
 * off 200 buckets. If transport is misconfigured (proxy down, residential
 * IP banned, captcha wall), abort immediately rather than spending an hour
 * silently filling discovery_run_log with zero-result rows. The bucket-level
 * try/catch otherwise swallows transport errors per-page and the only
 * symptom of a broken run is "totals all zero" — which is indistinguishable
 * from a legitimately empty market.
 */
async function preflight(): Promise<void> {
  const probeUrl = "https://www.airbnb.com/";
  try {
    const r = await fetchAirbnbRaw(probeUrl, { timeoutMs: FETCH_TIMEOUT_MS });
    const u = rawFetchLooksUnusable(r.html, r.status);
    if (u.unusable) {
      throw new Error(`preflight unusable: ${u.reason ?? `status=${r.status}`}`);
    }
    logEvent({ event: "run_started", preflight: "ok", probeStatus: r.status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logEvent({
      event: "run_finished",
      fatalError: `preflight failed: ${msg}`,
      proxyConfigured: Boolean(process.env.PROXY_URL),
    });
    throw new Error(
      `Discovery preflight failed (${msg}). ` +
        `Aborting before consuming the bucket budget. ` +
        `Check PROXY_URL or residential-IP routing.`
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
    proxyConfigured: Boolean(process.env.PROXY_URL),
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
