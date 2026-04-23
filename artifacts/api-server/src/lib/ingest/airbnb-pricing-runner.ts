/**
 * ingest/airbnb-pricing-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Driver for the daily Airbnb per-night pricing refresh.
 *
 * Connects three pieces:
 *   - airbnb-graphql-pricing-adapter.ts → fetches the GraphQL calendar
 *     (per-night prices for 12 months) for one listing.
 *   - airbnb-checkpoints.ts            → generates the ~30–40 stay windows
 *     per listing that the comp model wants priced.
 *   - listing_price_quotes (DB table)  → insert-only history of quotes.
 *
 * Per listing, ONE GraphQL fetch yields prices for every checkpoint we
 * care about. We map each checkpoint's checkin/checkout window onto the
 * calendar date map and emit one quote row per checkpoint. Fees aren't
 * available from this endpoint — only base nightly — so the cleaning /
 * service / taxes columns stay null and `subtotal_usd` is the per-night
 * price summed across the stay (when every night has a price).
 *
 * Cohort: stale-first across ALL active Airbnb listings, regardless of
 * external_id length. The PdpAvailabilityCalendar GraphQL operation
 * accepts both legacy 9-digit and post-2022 long-form IDs — that's the
 * whole point of running this path. The 345 long-form IDs that
 * airbnb-calendar-adapter.ts (path 1) skips are first-class citizens here.
 *
 * SHA self-healing: if the first attempt for a listing returns
 * staleSha=true, the runner re-discovers the persisted-query hash and
 * retries that listing. From then on the fresh hash is used for the
 * remainder of the run.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger.js";
import {
  airbnbPricingRunSummariesTable,
  listingPriceQuotesTable,
  type InsertListingPriceQuote,
} from "@workspace/db/schema";

import {
  fetchAirbnbCalendarGraphql,
  getOrDiscoverSha,
  type AirbnbGraphqlCalendarResult,
  type AirbnbGraphqlDay,
} from "./airbnb-graphql-pricing-adapter.js";
import {
  fetchAirbnbQuote,
  getOrDiscoverQuoteSha,
  shutdownQuoteBrowser,
  type AirbnbQuoteResult,
} from "./airbnb-graphql-quote-adapter.js";
import {
  generateCheckpoints,
  type Checkpoint,
} from "./airbnb-checkpoints.js";

const SOURCE_PLATFORM = "airbnb";

export interface AirbnbPricingRunOpts {
  /** Cap how many listings to process this run. Default 50 (matches the daily budget). */
  maxListings?: number;
  /** If true, skip DB writes (used for canary / smoke runs). Default false. */
  dryRun?: boolean;
  /** Override "today" for checkpoint generation (test hook). */
  today?: Date;
  /**
   * If true, only fetch the calendar (skip the per-checkpoint full-fee
   * quote calls). Used for canary runs that just want to confirm the
   * calendar SHA still works. Default false.
   */
  skipFullQuotes?: boolean;
  /** Cap checkpoints per listing (smoke-test hook). Default unlimited. */
  maxCheckpointsPerListing?: number;
}

export interface AirbnbPricingPerListing {
  listingId: number;
  externalId: string;
  ok: boolean;
  daysReturned: number;
  daysWithPrice: number;
  checkpointsAttempted: number;
  /** Per-checkpoint full-fee quote fetches that returned a usable breakdown. */
  quotesEnriched: number;
  /**
   * Subset of `quotesEnriched` that came from a checkpoint where every
   * night was both covered and available. This is the numerator paired
   * with `fullyAvailableCheckpoints` for the enrichment-rate signal —
   * mixing in enrichments from partially-available checkpoints would
   * let the ratio exceed 1.0 and hide parser regressions.
   */
  quotesEnrichedFullyAvailable: number;
  /** Per-checkpoint full-fee quote fetches that errored / had no breakdown. */
  quotesFailed: number;
  /**
   * Of the checkpointsAttempted, how many had every night both covered
   * and available. This is the denominator we expect to enrich — a
   * "min_stay_violated" or "unavailable" checkpoint can't get a quote
   * back from Airbnb, so excluding them keeps the enrichment-rate
   * signal focused on parser health rather than on inventory churn.
   */
  fullyAvailableCheckpoints: number;
  quotesWritten: number;
  staleShaRetried: boolean;
  /** True when the quote-flow SHA had to be re-discovered for this listing. */
  staleQuoteShaRetried: boolean;
  shaUsed: string | null;
  quoteShaUsed: string | null;
  error?: string;
}

export interface AirbnbPricingRunSummary {
  attempted: number;
  ok: number;
  failed: number;
  totalQuotesWritten: number;
  totalDaysWithPrice: number;
  /** Sum of per-checkpoint quote calls that returned a usable fee breakdown. */
  totalQuotesEnriched: number;
  /** Sum of per-checkpoint quote calls that failed / had no breakdown. */
  totalQuotesFailed: number;
  /** Sum across listings of fullyAvailableCheckpoints — the enrichment denominator. */
  totalFullyAvailableCheckpoints: number;
  /**
   * Sum across listings of `quotesEnrichedFullyAvailable` — the
   * enrichment numerator. Always ≤ `totalFullyAvailableCheckpoints`.
   */
  totalQuotesEnrichedFullyAvailable: number;
  /**
   * Share of fully-available checkpoints that successfully got a fee
   * breakdown (totalQuotesEnrichedFullyAvailable / totalFullyAvailableCheckpoints).
   * `null` when the denominator is zero (e.g. canary or all listings
   * fully booked) so consumers don't divide by zero or treat 0/0 as a
   * crash signal.
   *
   * Tracked because Airbnb periodically renames the price-line titles
   * the parser keys off ("Cleaning fee" → "Cleaning charge", etc).
   * When that happens the per-checkpoint quote still returns 200 but
   * the breakdown columns silently come back null, the runner drops
   * the row, and owners stop getting fee data without anything else
   * looking obviously broken. A persistent dip in this rate is the
   * canary for a parser-keyword update.
   */
  enrichmentRate: number | null;
  shaSource: "cache" | "discovered" | "fallback";
  quoteShaSource: "cache" | "discovered" | "fallback";
  shaRediscoveriesDuringRun: number;
  quoteShaRediscoveriesDuringRun: number;
  /**
   * Pass/fail signal for ops monitoring. Computed from the run shape so
   * GitHub Actions (and the freshness dashboard) can show a clear
   * thumbs-up / thumbs-down without re-deriving the rules.
   *
   *   "fail"  — pipeline is dark (everything failed, no quotes written,
   *             or the persisted-query SHA rotated more than once in a
   *             single run, which means rediscovery itself is unstable).
   *   "warn"  — partial outage (more than half the cohort failed, or no
   *             listings were processed at all).
   *   "ok"    — healthy.
   */
  alertLevel: "ok" | "warn" | "fail";
  /** Human-readable reason for the alertLevel (empty when ok). */
  alertReason: string;
}

export interface AirbnbPricingRunResult {
  summary: AirbnbPricingRunSummary;
  listings: AirbnbPricingPerListing[];
}

interface ListingRow {
  id: number;
  externalId: string;
  sourceUrl: string;
}

/**
 * Stale-first cohort across ALL active Airbnb listings (both legacy
 * 9-digit and long-form post-2022 IDs). Ordered so listings whose last
 * quote is oldest go first; listings that have never been quoted go
 * before everything else.
 */
async function loadStaleFirstListings(maxListings: number): Promise<ListingRow[]> {
  // Done as raw SQL because drizzle's LEFT JOIN + MAX(...) + NULLS FIRST
  // composition is awkward and this is a one-shot query.
  const result = await db.execute(sql`
    SELECT rl.id,
           rl.external_id AS "externalId",
           rl.source_url AS "sourceUrl"
    FROM rental_listings rl
    LEFT JOIN (
      SELECT listing_id, MAX(collected_at) AS last_quoted
      FROM listing_price_quotes
      GROUP BY listing_id
    ) q ON q.listing_id = rl.id
    WHERE rl.source_platform = ${SOURCE_PLATFORM}
      AND rl.is_active = true
      AND rl.external_id IS NOT NULL
      AND rl.external_id ~ '^[0-9]+$'
    ORDER BY q.last_quoted ASC NULLS FIRST, rl.id ASC
    LIMIT ${maxListings}
  `);
  const rows = (result as unknown as {
    rows: Array<{ id: number; externalId: string; sourceUrl: string }>;
  }).rows;
  return rows;
}

/**
 * Build a date→day map for O(1) checkpoint lookups. Days outside the
 * map (beyond the 12-month GraphQL window) are simply skipped at quote
 * emission time.
 */
function buildDayIndex(days: AirbnbGraphqlDay[]): Map<string, AirbnbGraphqlDay> {
  const m = new Map<string, AirbnbGraphqlDay>();
  for (const d of days) m.set(d.date, d);
  return m;
}

/**
 * Iterate every night in [checkin, checkout) and collect the matching
 * GraphQL day rows. Returns the per-night prices, the count of nights
 * that had a price, and an "all available" flag.
 */
function pricesForStay(
  checkpoint: Checkpoint,
  index: Map<string, AirbnbGraphqlDay>,
): { perNight: number[]; nightsCovered: number; allAvailable: boolean; anyAvailable: boolean } {
  // Empty calendar (Airbnb GraphQL shape changed / SHA stale / IP blocked) =>
  // assume all nights available, no per-night price. The Playwright quote
  // becomes the sole source of truth for price AND availability — if the
  // window is unbookable the quote returns null and the row is dropped
  // downstream.
  if (index.size === 0) {
    return {
      perNight: [],
      nightsCovered: checkpoint.stayNights,
      allAvailable: true,
      anyAvailable: true,
    };
  }
  const start = new Date(`${checkpoint.checkin}T00:00:00Z`);
  const perNight: number[] = [];
  let allAvailable = true;
  let anyAvailable = false;
  let nightsCovered = 0;
  for (let i = 0; i < checkpoint.stayNights; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const day = index.get(key);
    if (!day) {
      allAvailable = false;
      continue;
    }
    nightsCovered++;
    if (day.available) anyAvailable = true;
    else allAvailable = false;
    if (typeof day.nightlyPriceUsd === "number") perNight.push(day.nightlyPriceUsd);
  }
  return { perNight, nightsCovered, allAvailable, anyAvailable };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface CheckpointRow {
  row: InsertListingPriceQuote;
  checkpoint: Checkpoint;
  /** True when every night in the stay window was both covered and available. */
  fullyAvailable: boolean;
}

function buildQuoteRows(
  listingId: number,
  result: AirbnbGraphqlCalendarResult,
  collectedAt: Date,
  today: Date,
): CheckpointRow[] {
  const checkpoints = generateCheckpoints({ today });
  const index = buildDayIndex(result.days);
  const out: CheckpointRow[] = [];

  for (const cp of checkpoints) {
    const { perNight, nightsCovered, allAvailable, anyAvailable } = pricesForStay(cp, index);

    // Skip checkpoints whose stay window falls entirely outside the
    // 12-month GraphQL response — emitting a quote for a window we have
    // zero data on would just be noise in the time-series.
    if (nightsCovered === 0) continue;

    const avgNightly = perNight.length > 0
      ? perNight.reduce((a, b) => a + b, 0) / perNight.length
      : null;
    const subtotal = perNight.length === cp.stayNights
      ? perNight.reduce((a, b) => a + b, 0)
      : null;

    const availability = allAvailable && nightsCovered === cp.stayNights
      ? "available"
      : anyAvailable
        ? "min_stay_violated" // partial-availability stays = booked across part of the window
        : "unavailable";

    const fullyAvailable = allAvailable && nightsCovered === cp.stayNights;

    const row: InsertListingPriceQuote = {
      listingId,
      collectedAt,
      checkinDate: cp.checkin,
      checkoutDate: cp.checkout,
      stayLengthNights: cp.stayNights,
      guestCount: cp.guestCount,
      nightlyPriceUsd: avgNightly,
      subtotalUsd: subtotal,
      cleaningFeeUsd: null,
      serviceFeeUsd: null,
      taxesUsd: null,
      totalPriceUsd: null,
      currency: "USD",
      availabilityStatus: availability,
      // Store the per-night price array for parser-repair / debugging.
      rawQuoteJson: {
        source: "airbnb_graphql_pdpAvailabilityCalendar",
        checkpointKind: cp.kind,
        eventTag: cp.eventTag,
        priorityTier: cp.priorityTier,
        nightsCovered,
        stayNights: cp.stayNights,
        perNightPricesUsd: perNight,
      },
    };
    out.push({ row, checkpoint: cp, fullyAvailable });
  }
  return out;
}

/**
 * Mutate `row` in place with the fee breakdown from a successful
 * full-quote fetch. Subtotal is preferred over the calendar-derived
 * sum when the quote endpoint reports an explicit accommodation total
 * (it accounts for length-of-stay discounts the calendar misses).
 *
 * Once a quote returns ANY usable component (any of cleaning, service,
 * taxes, or total), missing sibling fee components are defaulted to
 * 0. Reasoning: Airbnb omits a price item when the host hasn't set a
 * fee at all (e.g. no cleaning fee on a long-term rental), so an
 * absent line item legitimately means $0 — and writing 0 keeps the
 * column non-null per the comp-comparison contract.
 */
function applyQuoteToRow(row: InsertListingPriceQuote, q: AirbnbQuoteResult): void {
  row.cleaningFeeUsd = q.cleaningFeeUsd ?? 0;
  row.serviceFeeUsd = q.serviceFeeUsd ?? 0;
  row.taxesUsd = q.taxesUsd ?? 0;
  // If the quote endpoint didn't surface an explicit total but DID give
  // us the components, synthesize one so total_price_usd is also never
  // null on enriched rows.
  if (q.totalPriceUsd !== null) {
    row.totalPriceUsd = q.totalPriceUsd;
  } else {
    const subtotalForTotal =
      q.accommodationUsd !== null ? q.accommodationUsd : (row.subtotalUsd ?? 0);
    row.totalPriceUsd = round2(
      subtotalForTotal +
        (q.cleaningFeeUsd ?? 0) +
        (q.serviceFeeUsd ?? 0) +
        (q.taxesUsd ?? 0),
    );
  }
  if (q.accommodationUsd !== null) {
    row.subtotalUsd = q.accommodationUsd;
    if (typeof row.stayLengthNights === "number" && row.stayLengthNights > 0) {
      row.nightlyPriceUsd = q.accommodationUsd / row.stayLengthNights;
    }
  }
  if (q.currency && q.currency !== row.currency) row.currency = q.currency;

  // Append the quote breakdown to the raw_quote_json blob without
  // dropping the calendar context already there.
  const existing = (row.rawQuoteJson ?? {}) as Record<string, unknown>;
  row.rawQuoteJson = {
    ...existing,
    fullQuote: {
      source: "airbnb_graphql_StaysPdpReservationFlow",
      shaUsed: q.shaUsed,
      available: q.available,
      accommodationUsd: q.accommodationUsd,
      cleaningFeeUsd: q.cleaningFeeUsd,
      serviceFeeUsd: q.serviceFeeUsd,
      taxesUsd: q.taxesUsd,
      totalPriceUsd: q.totalPriceUsd,
      currency: q.currency,
      errors: q.errors,
    },
  };
}

async function insertQuotes(rows: InsertListingPriceQuote[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Bounded chunk to stay well under Postgres's parameter limit.
  // listing_price_quotes inserts ~16 columns × 1000 rows = 16k params.
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db.insert(listingPriceQuotesTable).values(slice);
    total += slice.length;
  }
  return total;
}

/**
 * Run one daily Airbnb pricing refresh.
 *
 * Returns a structured summary so the calling endpoint can ship the
 * same shape JSON GitHub Actions consumes for the "did it work" check.
 */
export async function runAirbnbPricingRefresh(
  opts: AirbnbPricingRunOpts = {},
): Promise<AirbnbPricingRunResult> {
  const maxListings = opts.maxListings ?? 50;
  const dryRun = opts.dryRun ?? false;
  const today = opts.today ?? new Date();
  const skipFullQuotes = opts.skipFullQuotes ?? false;
  const maxCheckpointsPerListing = opts.maxCheckpointsPerListing ?? Infinity;

  const listings = await loadStaleFirstListings(maxListings);

  try {
  // Discover the calendar SHA up front so all listings share one cache hit.
  const initial = await getOrDiscoverSha();
  let currentSha = initial.sha;
  let shaRediscoveries = 0;

  // Same up-front discovery for the reservation-flow (full-quote) SHA.
  // When `skipFullQuotes` is true we don't even pay the cache read.
  const initialQuote = skipFullQuotes
    ? { sha: "", source: "cache" as const }
    : await getOrDiscoverQuoteSha();
  let currentQuoteSha = initialQuote.sha;
  let quoteShaRediscoveries = 0;

  const perListing: AirbnbPricingPerListing[] = [];
  let totalQuotes = 0;
  let totalDaysWithPrice = 0;
  let totalQuotesEnriched = 0;
  let totalQuotesEnrichedFullyAvailable = 0;
  let totalQuotesFailed = 0;
  let totalFullyAvailableCheckpoints = 0;

  for (const l of listings) {
    const stat: AirbnbPricingPerListing = {
      listingId: l.id,
      externalId: l.externalId,
      ok: false,
      daysReturned: 0,
      daysWithPrice: 0,
      checkpointsAttempted: 0,
      quotesEnriched: 0,
      quotesEnrichedFullyAvailable: 0,
      quotesFailed: 0,
      fullyAvailableCheckpoints: 0,
      quotesWritten: 0,
      staleShaRetried: false,
      staleQuoteShaRetried: false,
      shaUsed: currentSha,
      quoteShaUsed: skipFullQuotes ? null : currentQuoteSha,
    };
    try {
      let result = await fetchAirbnbCalendarGraphql(l.externalId, currentSha, { today });

      // SHA rotation: re-discover once and retry. From then on the fresh
      // hash is used for the rest of the run.
      if (result.staleSha) {
        stat.staleShaRetried = true;
        const fresh = await getOrDiscoverSha({ forceRediscover: true });
        currentSha = fresh.sha;
        shaRediscoveries++;
        stat.shaUsed = currentSha;
        result = await fetchAirbnbCalendarGraphql(l.externalId, currentSha, { today });
      }

      stat.daysReturned = result.daysReturned;
      stat.daysWithPrice = result.daysWithPrice;

      // Calendar failure is no longer fatal — we record it as a note in
      // stat.error but proceed to per-checkpoint Playwright quotes. The
      // empty-index branch in pricesForStay above synthesizes "presumed
      // available" checkpoints; the quote phase filters out actually-
      // unbooked windows by returning null totals.
      if (result.errors.length > 0 && result.daysReturned === 0) {
        stat.error = "calendar: " + result.errors.join("; ").slice(0, 180);
      }

      let checkpointRows = buildQuoteRows(l.id, result, new Date(), today);
      if (Number.isFinite(maxCheckpointsPerListing)) {
        checkpointRows = checkpointRows.slice(0, maxCheckpointsPerListing);
      }
      stat.checkpointsAttempted = checkpointRows.length;
      stat.fullyAvailableCheckpoints = checkpointRows.filter(
        (cr) => cr.fullyAvailable,
      ).length;
      console.error(
        `[airbnb-pricing] listing ${l.id} (${l.externalId}): ` +
          `${checkpointRows.length} checkpoints to quote`,
      );

      // Per-checkpoint full-fee quote enrichment. We call the
      // reservation-flow endpoint for EVERY emitted checkpoint so the
      // four target columns (cleaning_fee_usd, service_fee_usd,
      // taxes_usd, total_price_usd) are populated on every Airbnb row
      // we insert.
      //
      // Rows whose quote returns no usable breakdown (network failure,
      // SHA rotation we couldn't recover from, parser miss) are dropped
      // entirely rather than written calendar-only — owners need full
      // numbers to compare to PVRPV, and a half-row would silently
      // poison those comparisons.
      const enrichedRows: InsertListingPriceQuote[] = [];
      if (skipFullQuotes || !currentQuoteSha) {
        // Canary mode: keep calendar-only rows.
        for (const cr of checkpointRows) enrichedRows.push(cr.row);
      } else {
        let cpIdx = 0;
        for (const cr of checkpointRows) {
          cpIdx++;
          const t0 = Date.now();
          let q = await fetchAirbnbQuote(
            l.externalId,
            currentQuoteSha,
            {
              checkin: cr.checkpoint.checkin,
              checkout: cr.checkpoint.checkout,
              guestCount: cr.checkpoint.guestCount,
            },
          );

          if (q.staleSha) {
            // Re-discover once per RUN, not per listing — this matches
            // how the calendar SHA self-heals.
            stat.staleQuoteShaRetried = true;
            const fresh = await getOrDiscoverQuoteSha({ forceRediscover: true });
            currentQuoteSha = fresh.sha;
            quoteShaRediscoveries++;
            stat.quoteShaUsed = currentQuoteSha;
            q = await fetchAirbnbQuote(
              l.externalId,
              currentQuoteSha,
              {
                checkin: cr.checkpoint.checkin,
                checkout: cr.checkpoint.checkout,
                guestCount: cr.checkpoint.guestCount,
              },
            );
          }

          const hasBreakdown =
            q.totalPriceUsd !== null ||
            q.cleaningFeeUsd !== null ||
            q.serviceFeeUsd !== null ||
            q.taxesUsd !== null ||
            q.accommodationUsd !== null;

          if (hasBreakdown) {
            applyQuoteToRow(cr.row, q);
            // Defensive belt-and-braces: applyQuoteToRow defaults
            // missing components to 0, but assert here so a future
            // edit can never silently regress the non-null contract.
            if (
              cr.row.cleaningFeeUsd !== null &&
              cr.row.serviceFeeUsd !== null &&
              cr.row.taxesUsd !== null &&
              cr.row.totalPriceUsd !== null
            ) {
              enrichedRows.push(cr.row);
              stat.quotesEnriched++;
              // Only count enrichments on fully-available checkpoints
              // toward the rate numerator — that's the universe whose
              // denominator we tracked above. A successful enrichment
              // on a partially-available checkpoint is gravy, not
              // signal.
              if (cr.fullyAvailable) stat.quotesEnrichedFullyAvailable++;
            } else {
              stat.quotesFailed++;
            }
          } else {
            // No usable quote → drop the row rather than write half-data.
            stat.quotesFailed++;
          }
          const elapsed = Date.now() - t0;
          const totalStr = q.totalPriceUsd !== null ? `$${q.totalPriceUsd}` : "—";
          const errStr = q.errors.length > 0 ? ` err=${q.errors[0].slice(0, 80)}` : "";
          console.error(
            `[airbnb-pricing]   cp ${cpIdx}/${checkpointRows.length} ` +
              `${cr.checkpoint.checkin}→${cr.checkpoint.checkout} ` +
              `total=${totalStr} ${elapsed}ms${errStr}`,
          );
        }
      }

      const rows = enrichedRows;
      if (!dryRun) {
        stat.quotesWritten = await insertQuotes(rows);
      } else {
        stat.quotesWritten = rows.length; // would-have-written count
      }
      stat.ok = true;
      totalQuotes += stat.quotesWritten;
      totalDaysWithPrice += stat.daysWithPrice;
      totalQuotesEnriched += stat.quotesEnriched;
      totalQuotesFailed += stat.quotesFailed;
      // Only count the enrichment numerator/denominator when we
      // actually attempted enrichment — canary mode (skipFullQuotes)
      // would otherwise look like a 0% enrichment rate and trip the
      // alert.
      if (!skipFullQuotes && currentQuoteSha) {
        totalFullyAvailableCheckpoints += stat.fullyAvailableCheckpoints;
        totalQuotesEnrichedFullyAvailable += stat.quotesEnrichedFullyAvailable;
      }
    } catch (e) {
      stat.error = (e as Error).message.slice(0, 200);
    }
    perListing.push(stat);
  }

  const ok = perListing.filter((p) => p.ok).length;
  const failed = perListing.length - ok;

  // ── Pass/fail signal ────────────────────────────────────────────────
  // Order matters: "fail" rules fire first, then "warn", then "ok".
  let alertLevel: "ok" | "warn" | "fail" = "ok";
  let alertReason = "";
  if (perListing.length > 0 && ok === 0) {
    alertLevel = "fail";
    alertReason = `All ${perListing.length} listings failed — Airbnb pricing has gone dark`;
  } else if (perListing.length > 0 && totalQuotes === 0 && !dryRun) {
    alertLevel = "fail";
    alertReason = "0 quotes written despite a non-empty cohort";
  } else if (shaRediscoveries > 1) {
    alertLevel = "fail";
    alertReason = `Calendar SHA rediscovered ${shaRediscoveries} times in one run — persisted-query rotation is unstable`;
  } else if (quoteShaRediscoveries > 1) {
    alertLevel = "fail";
    alertReason = `Quote SHA rediscovered ${quoteShaRediscoveries} times in one run — persisted-query rotation is unstable`;
  } else if (perListing.length === 0) {
    alertLevel = "warn";
    alertReason = "No Airbnb listings matched the cohort filter";
  } else if (failed > 0 && failed * 2 >= perListing.length) {
    alertLevel = "warn";
    alertReason = `${failed}/${perListing.length} listings failed (>=50%)`;
  }

  const result: AirbnbPricingRunResult = {
    summary: {
      attempted: perListing.length,
      ok,
      failed,
      totalQuotesWritten: totalQuotes,
      totalDaysWithPrice,
      totalQuotesEnriched,
      totalQuotesFailed,
      totalFullyAvailableCheckpoints,
      totalQuotesEnrichedFullyAvailable,
      enrichmentRate: totalFullyAvailableCheckpoints > 0
        ? totalQuotesEnrichedFullyAvailable / totalFullyAvailableCheckpoints
        : null,
      shaSource: initial.source,
      quoteShaSource: initialQuote.source,
      shaRediscoveriesDuringRun: shaRediscoveries,
      quoteShaRediscoveriesDuringRun: quoteShaRediscoveries,
      alertLevel,
      alertReason,
    },
    listings: perListing,
  };

  // Persist this run's summary so the freshness/alert endpoint has
  // cross-run history to evaluate the enrichment-rate trend against
  // (see evaluateEnrichmentAlert in airbnb-pricing-monitor.ts).
  //
  // Canary (skipFullQuotes) runs are stored too — they're a real
  // signal that calendar-SHA discovery worked today — but flagged with
  // runKind="canary" so the alert math can ignore them. Their
  // `enrichmentRate` is null by construction (no full-quote attempts),
  // so they would already be filtered out by `evaluateEnrichmentAlert`,
  // but the explicit kind makes the intent obvious to anyone scanning
  // the table.
  //
  // Dry runs are skipped entirely — they're a test hook, not history.
  if (!dryRun) {
    try {
      await db.insert(airbnbPricingRunSummariesTable).values({
        ranAt: new Date(),
        runKind: skipFullQuotes ? "canary" : "full",
        listingsAttempted: result.summary.attempted,
        listingsOk: result.summary.ok,
        listingsFailed: result.summary.failed,
        totalQuotesWritten: result.summary.totalQuotesWritten,
        totalQuotesEnriched: result.summary.totalQuotesEnriched,
        totalQuotesFailed: result.summary.totalQuotesFailed,
        totalFullyAvailableCheckpoints:
          result.summary.totalFullyAvailableCheckpoints,
        quotesEnrichedFullyAvailable:
          result.summary.totalQuotesEnrichedFullyAvailable,
        enrichmentRate: result.summary.enrichmentRate,
        rawSummaryJson: result.summary as unknown as Record<string, unknown>,
      });
    } catch (err) {
      // Persistence is best-effort: a failure here must not turn a
      // successful pricing run into a 5xx for the caller. The row is
      // diagnostic, not authoritative. Log at warn level so silent
      // history loss is still discoverable in the server logs — the
      // freshness endpoint depends on this table to detect parser
      // regressions.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "airbnb-pricing-runner: failed to persist run summary",
      );
    }
  }

  return result;
  } finally {
    // Always release the headless Chromium spawned by the quote adapter,
    // even if the run threw partway through. Otherwise the cron process
    // would hang on the live browser handle.
    await shutdownQuoteBrowser();
  }
}

