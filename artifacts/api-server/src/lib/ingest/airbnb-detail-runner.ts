/**
 * ingest/airbnb-detail-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single-listing enrichment: fetch a /rooms/{id} page in browser mode,
 * parse it via airbnb-detail-adapter, persist the result to listing_details.
 *
 * Kept deliberately small and DB-aware. Discovery code is NOT touched.
 *
 * One row per call → preserves the versioned-history contract on
 * listing_details (the table is append-only by design).
 */

import { db } from "@workspace/db";
import { listingDetailsTable, rentalListingsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { fetchWithBrowser } from "./browser-fetch.js";
import {
  fetchAirbnbDetailHybrid,
  HybridFetchError,
  type HybridFetchObservability,
} from "./raw-fetch.js";
import { parseAirbnbDetailHtml, type AirbnbDetailParse } from "./airbnb-detail-adapter.js";
import { logger } from "../logger.js";

export interface EnrichResult {
  listingId: number;
  url: string;
  outcome: "enriched" | "parse_fail" | "blocked" | "delisted" | "error";
  parseStatus?: AirbnbDetailParse["parseStatus"];
  /** Number of normalized fields that came back non-null (excluding nested helpers). */
  filledFieldCount?: number;
  /** What the parser/adapter complained about (field-level absences). */
  parseErrors?: string[];
  /** Network/transport message if outcome === "error" or "blocked". */
  errorMessage?: string;
  /** Snapshot of normalized fields for reporting (not persisted here — DB has it). */
  normalized?: AirbnbDetailParse["normalized"];
  /**
   * Per-listing fetch-path metrics. Populated for every outcome (including
   * blocked/delisted/error) so post-batch comparisons across the three fetch
   * modes can be assembled from logs alone, without re-fetching.
   *
   * `fetchMode` records WHICH transport produced the body that drove the
   * outcome — for "browser" it'll always be "browser"; for "raw" it'll be
   * "raw"; for "hybrid" it'll be either "raw" (raw succeeded) or
   * "browser-fallback" (raw was unusable, browser ran).
   */
  fetch?: HybridFetchObservability & {
    /** AIRBNB_DETAIL_FETCH_MODE value at the time of the call. */
    requestedMode: AirbnbDetailFetchMode;
    /** Total wall time across raw + (optional) browser, in ms. */
    totalMs: number;
  };
}

/** Runtime-selectable fetch-path. Default is "browser" so a deploy with no
 *  env change preserves current production behavior exactly. */
export type AirbnbDetailFetchMode = "browser" | "raw" | "hybrid";

function readFetchMode(): AirbnbDetailFetchMode {
  const v = (process.env.AIRBNB_DETAIL_FETCH_MODE ?? "browser").trim().toLowerCase();
  if (v === "raw" || v === "hybrid" || v === "browser") return v;
  // Unknown values silently degrade to the safe default rather than throwing —
  // an env typo should not take the enrichment loop down.
  logger.warn({ requestedMode: v }, "airbnb-detail-runner: unrecognized AIRBNB_DETAIL_FETCH_MODE, defaulting to 'browser'");
  return "browser";
}

interface EnrichOpts {
  /** Per-page timeout (ms) for the browser fetch. Default 25s. */
  timeoutMs?: number;
  /**
   * Hard wall-clock cap on the entire enrichOneAirbnbListing call.
   * Guarantees the loop progresses even if Playwright/Chromium hangs
   * (which happens on some captcha pages whose background pings prevent
   * `networkidle` from firing AND keep `page.content()` blocked).
   * Default 70s = 25s + retry 25s + 20s safety margin.
   */
  hardCapMs?: number;
  /** When true, don't insert — just return the parse for inspection. */
  dryRun?: boolean;
}

/** Race a promise against a wall-clock timeout that rejects with a tagged error. */
function withHardCap<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hard cap ${ms}ms exceeded: ${tag}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Block heuristic. Airbnb returns ~200-600KB on every page (real or
 * interstitial), so size alone is unreliable. Two signals work in practice:
 *
 *   1. Explicit captcha / bot-wall markers (PerimeterX "px-captcha",
 *      DataDome "/distil_r_", "Access Denied", "are you a human").
 *      We scan the WHOLE page (case-insensitive) since these markers
 *      sometimes live deep in inline scripts, not the head.
 *
 *   2. Negative anchor — a real listing page ALWAYS embeds either a
 *      JSON-LD VacationRental block or an Apollo DemandStayListing
 *      node. If neither is present, the page is functionally a wall
 *      even when no captcha string appears (rate-limit interstitials
 *      occasionally just serve a blank shell).
 *
 * The two-signal check lets us distinguish blocks from parse failures
 * cleanly in the report.
 */
/**
 * Delisted-page detector. Airbnb serves an `app/views/routes/helpful_404.html.erb`
 * template (HTTP 200, ~2671 bytes, byte-stable across listings) when a host has
 * removed a listing the discovery layer previously found. Without this check
 * the runner classifies these as "blocked" (the body trips `looksBlocked`'s
 * <40KB threshold) — which inflates the apparent block rate and hides the
 * actual cause. We split delisted out so reports can compute "% success on
 * live listings" honestly. The persisted row still suppresses re-enrichment
 * via the same listing_details candidate-query mechanism as blocked rows.
 *
 * Detection is deliberately conservative: a small body AND at least one of
 * the template's stable markers. Either marker on its own is sufficient so a
 * minor Airbnb-side template tweak (e.g. dropping the sourcegraph comment)
 * doesn't silently re-route us back to the noisy 'blocked' bucket.
 */
function looksDelisted(html: string): { delisted: boolean; reason?: string } {
  if (html.length > 6_000) return { delisted: false };
  if (html.includes("helpful_404.html.erb") ||
      html.includes("404 Page Not Found - Airbnb") ||
      /<title>\s*404\b/i.test(html)) {
    return { delisted: true, reason: `airbnb helpful_404 template ${html.length}b` };
  }
  return { delisted: false };
}

function looksBlocked(html: string): { blocked: boolean; reason?: string } {
  if (html.length < 40_000) return { blocked: true, reason: `short body ${html.length}b` };

  const lower = html.toLowerCase();
  // Hard bot-wall markers — unambiguous interstitials that ONLY appear on
  // genuinely blocked pages. We deliberately do NOT include the bare token
  // "captcha" here: Airbnb preloads reCAPTCHA Enterprise on every PDP for
  // the booking flow, so the substring shows up in benign script tags on
  // perfectly normal listing pages (same false-positive we already removed
  // for search-page block detection in `airbnb-discovery-wrapper.ts`).
  if (lower.includes("px-captcha") || lower.includes("perimeterx") ||
      lower.includes("/distil_r_") || lower.includes("access denied") ||
      lower.includes("are you a human") || lower.includes("blocked by the airbnb") ||
      lower.includes("pardon our interruption") || lower.includes("/forbidden")) {
    return { blocked: true, reason: "captcha/bot-wall markers detected" };
  }

  // Note: missing SSR anchors (no JSON-LD AND no DemandStayListing) are
  // intentionally NOT classified as blocked here. Some real PDPs hydrate
  // late — Apollo state can arrive after networkidle, and the parser may
  // still be able to recover something useful. We let the parser try, and
  // downstream classification (parseStatus = 'parse_fail') will tag pages
  // that genuinely yielded no data. Only the hard markers above and the
  // short-body check trip the block classification.
  return { blocked: false };
}

/** Count non-null leaves in normalized fields (for the report). */
function countFilled(n: AirbnbDetailParse["normalized"]): number {
  let c = 0;
  if (n.title !== null) c++;
  if (n.description !== null) c++;
  if (n.propertyType !== null) c++;
  if (n.bedrooms !== null) c++;
  if (n.bathrooms !== null) c++;
  if (n.maxGuests !== null) c++;
  if (n.bedCount !== null) c++;
  if (n.amenities !== null) c++;
  if (n.latitude !== null) c++;
  if (n.longitude !== null) c++;
  if (n.hostName !== null) c++;
  if (n.ratingOverall !== null) c++;
  if (n.reviewCount !== null) c++;
  if (n.imageCount !== null) c++;
  if (n.externalListingId !== null) c++;
  if (n.pdpType !== null) c++;
  if (n.petsAllowed !== null) c++;
  return c;
}

/**
 * Selector that the browser path waits for before reading the rendered HTML.
 * Either anchor is sufficient for the parser to extract usable structured
 * data — requiring both was over-restrictive and produced PARSE_FAIL on
 * pages where one anchor lands well after the other.
 */
const HYDRATION_SELECTOR =
  'script[type="application/ld+json"], script[id^="data-deferred-state"]';

/**
 * Browser-mode fetch helper. Two-pass with one transport-only retry, both
 * bounded by hardCapMs. Behavior is byte-identical to pre-Phase-A code so
 * a deploy without an env-var change preserves current production
 * outcomes exactly.
 */
async function fetchHtmlBrowserMode(
  url: string,
  timeoutMs: number,
  hardCapMs: number,
): Promise<{ html: string; ms: number }> {
  const t0 = Date.now();
  try {
    const html = await withHardCap(
      fetchWithBrowser(url, {
        timeoutMs,
        waitForSelector: HYDRATION_SELECTOR,
        fallbackOnTimeout: true,
      }),
      timeoutMs + 8_000,
      `fetch pass-1 ${url}`,
    );
    return { html, ms: Date.now() - t0 };
  } catch (err) {
    const remaining = hardCapMs - (Date.now() - t0);
    if (remaining < 8_000) {
      throw new Error(`pass-1 failed and no retry budget: ${(err as Error).message.slice(0, 200)}`);
    }
    try {
      const html = await withHardCap(
        fetchWithBrowser(url, {
          timeoutMs: Math.min(timeoutMs, remaining - 4_000),
          waitForSelector: HYDRATION_SELECTOR,
          fallbackOnTimeout: true,
        }),
        remaining - 2_000,
        `fetch pass-2 ${url}`,
      );
      return { html, ms: Date.now() - t0 };
    } catch (err2) {
      throw new Error(`fetch failed twice: ${(err2 as Error).message.slice(0, 200)}`);
    }
  }
}

/** Synthesize a "didn't even attempt" observability record for the error path. */
function emptyFetchObs(mode: AirbnbDetailFetchMode, totalMs: number): HybridFetchObservability {
  return {
    fetchMode: mode === "browser" ? "browser" : "raw",
    rawAttempted: mode !== "browser",
    rawSucceeded: false,
    rawStatus: null,
    rawMs: null,
    rawFallbackReason: null,
    browserUsed: mode === "browser",
    browserMs: mode === "browser" ? totalMs : null,
  };
}

/** Single structured log line per enrichment, regardless of outcome. The
 *  shape is stable so post-batch analyses can `jq` over the workflow logs. */
function logEnrichOutcome(result: EnrichResult): void {
  logger.info(
    {
      evt: "airbnb_detail_enriched",
      listingId: result.listingId,
      url: result.url,
      outcome: result.outcome,
      parseStatus: result.parseStatus,
      filledFieldCount: result.filledFieldCount,
      fetch: result.fetch,
      errorMessage: result.errorMessage,
    },
    "airbnb-detail enrichment outcome",
  );
}

/**
 * Enrich one listing. Errors are caught and translated into outcomes —
 * the caller's loop should NEVER abort on a single page.
 *
 * Fetch transport is selected at runtime via AIRBNB_DETAIL_FETCH_MODE:
 *   - "browser" (default): browser-only, two-pass with one retry. Identical
 *     to pre-Phase-A behavior.
 *   - "raw": raw HTTP via proxy only. No browser fallback — raw failures
 *     surface as outcome=error. Used for clean A/B measurement.
 *   - "hybrid": raw first, browser fallback when raw is unusable
 *     (captcha/perimeterx markers, transport error, or short non-delisted
 *     body). Successful raw responses skip the browser entirely.
 *
 * Per-listing fetch metrics are attached to EnrichResult.fetch and emitted
 * as a structured log line so we can compare modes from logs alone.
 */
export async function enrichOneAirbnbListing(
  listingId: number,
  url: string,
  opts: EnrichOpts = {}
): Promise<EnrichResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const hardCapMs = opts.hardCapMs ?? 70_000;
  const requestedMode = readFetchMode();

  // ── Fetch (mode-dispatched) ────────────────────────────────────────────
  const fetchT0 = Date.now();
  let html: string;
  let fetchObs: HybridFetchObservability;
  try {
    if (requestedMode === "browser") {
      const r = await fetchHtmlBrowserMode(url, timeoutMs, hardCapMs);
      html = r.html;
      fetchObs = {
        fetchMode: "browser",
        rawAttempted: false,
        rawSucceeded: false,
        rawStatus: null,
        rawMs: null,
        rawFallbackReason: null,
        browserUsed: true,
        browserMs: r.ms,
      };
    } else {
      // raw or hybrid — orchestrator handles raw + (optional) browser fallback.
      const r = await fetchAirbnbDetailHybrid(url, {
        timeoutMs,
        allowBrowserFallback: requestedMode === "hybrid",
        browserWaitForSelector: HYDRATION_SELECTOR,
      });
      html = r.html;
      fetchObs = r.observability;
    }
  } catch (err) {
    const totalMs = Date.now() - fetchT0;
    // Browser-mode error messages are preserved verbatim (no extra slice
    // beyond what fetchHtmlBrowserMode already does internally) so this
    // branch is byte-identical to pre-Phase-A semantics — callers / log
    // grep patterns can still rely on the original "pass-1 failed..." /
    // "fetch failed twice..." strings.  Raw/hybrid messages get a mode
    // prefix so post-batch analysis can distinguish browser-path from
    // raw-path failures at a glance.
    const errMsg = (err as Error).message;
    const errorMessage = requestedMode === "browser"
      ? errMsg
      : `fetch failed (${requestedMode}): ${errMsg.slice(0, 200)}`;
    // Raw/hybrid throw HybridFetchError carrying real raw-attempt metrics
    // (rawStatus, rawMs, rawFallbackReason). Preserve them for Phase B
    // failure-cohort analysis instead of nulling everything out.
    const obs = err instanceof HybridFetchError
      ? err.observability
      : emptyFetchObs(requestedMode, totalMs);
    const result: EnrichResult = {
      listingId, url,
      outcome: "error",
      errorMessage,
      fetch: { ...obs, requestedMode, totalMs },
    };
    logEnrichOutcome(result);
    return result;
  }
  const totalFetchMs = Date.now() - fetchT0;
  const fetchAttachment = { ...fetchObs, requestedMode, totalMs: totalFetchMs };

  // Delisted check runs FIRST — these pages would otherwise fail the
  // looksBlocked < 40KB threshold and get tagged as blocked. Persist with
  // parseStatus = 'delisted' so downstream queries can distinguish dead
  // links from genuine bot-walls.
  const delisted = looksDelisted(html);
  if (delisted.delisted) {
    if (!opts.dryRun) {
      await db.insert(listingDetailsTable).values({
        listingId,
        enrichedAt: new Date(),
        parseVersion: "airbnb-detail-v1",
        rawPayload: { kind: "delisted-stub", htmlBytes: html.length, headHash: html.slice(0, 200) },
        normalizedFields: null,
        parseStatus: "delisted",
        parseErrors: [delisted.reason ?? "delisted"],
      });
    }
    const result: EnrichResult = {
      listingId, url, outcome: "delisted", errorMessage: delisted.reason,
      fetch: fetchAttachment,
    };
    logEnrichOutcome(result);
    return result;
  }

  const block = looksBlocked(html);
  if (block.blocked) {
    // Record the block as a parse_status='blocked' placeholder row so the
    // candidate query (LEFT JOIN listing_details / id IS NULL) skips this
    // listing on subsequent passes — otherwise a chronically captcha-walled
    // ID would consume the same fetch budget every batch. Stores a tiny
    // raw-payload stub for diagnostics; the ingest history is queryable
    // by parse_status. The row is non-authoritative — discovery is
    // unaffected, and a future re-enrichment pass can still overwrite
    // (the table is append-only and uses MAX(enriched_at) for the latest).
    if (!opts.dryRun) {
      await db.insert(listingDetailsTable).values({
        listingId,
        enrichedAt: new Date(),
        parseVersion: "airbnb-detail-v1",
        rawPayload: { kind: "blocked-stub", htmlBytes: html.length, headHash: html.slice(0, 200) },
        normalizedFields: null,
        parseStatus: "blocked",
        parseErrors: [block.reason ?? "blocked"],
      });
    }
    const result: EnrichResult = {
      listingId, url, outcome: "blocked", errorMessage: block.reason,
      fetch: fetchAttachment,
    };
    logEnrichOutcome(result);
    return result;
  }

  const parsed = parseAirbnbDetailHtml(html);
  const filled = countFilled(parsed.normalized);

  if (parsed.parseStatus === "parse_fail") {
    // Persist the row so we have a record of the attempt + raw fragments.
    if (!opts.dryRun) {
      await db.insert(listingDetailsTable).values({
        listingId,
        enrichedAt: new Date(),
        parseVersion: parsed.parseVersion,
        rawPayload: parsed.raw as unknown as object,
        normalizedFields: parsed.normalized as unknown as object,
        parseStatus: "parse_fail",
        parseErrors: parsed.parseErrors,
      });
    }
    const result: EnrichResult = {
      listingId, url, outcome: "parse_fail",
      parseStatus: parsed.parseStatus,
      filledFieldCount: filled,
      parseErrors: parsed.parseErrors,
      normalized: parsed.normalized,
      fetch: fetchAttachment,
    };
    logEnrichOutcome(result);
    return result;
  }

  if (!opts.dryRun) {
    await db.insert(listingDetailsTable).values({
      listingId,
      enrichedAt: new Date(),
      parseVersion: parsed.parseVersion,
      rawPayload: parsed.raw as unknown as object,
      normalizedFields: parsed.normalized as unknown as object,
      parseStatus: parsed.parseStatus, // "ok" | "partial"
      parseErrors: parsed.parseErrors.length > 0 ? parsed.parseErrors : null,
    });

    // Back-write canonical attribute columns to rental_listings so the comp
    // engine can query bedrooms/bathrooms/max_guests directly without joining
    // listing_details JSON. GREATEST never destroys a real existing value
    // (incoming 0 stays at the larger existing count); COALESCE preserves an
    // existing non-null lat/lng/rating instead of overwriting with null.
    const n = parsed.normalized;
    await db.execute(sql`
      UPDATE rental_listings
      SET
        bedrooms       = GREATEST(rental_listings.bedrooms,  ${n.bedrooms  ?? 0}),
        bathrooms      = GREATEST(rental_listings.bathrooms, ${n.bathrooms ?? 0}),
        max_guests     = COALESCE(rental_listings.max_guests,     ${n.maxGuests   ?? null}),
        latitude       = COALESCE(rental_listings.latitude,       ${n.latitude    ?? null}),
        longitude      = COALESCE(rental_listings.longitude,      ${n.longitude   ?? null}),
        rating_overall = COALESCE(rental_listings.rating_overall, ${n.ratingOverall ?? null}),
        review_count   = COALESCE(rental_listings.review_count,   ${n.reviewCount  ?? null}),
        updated_at     = NOW()
      WHERE id = ${listingId}
    `);
  }

  const result: EnrichResult = {
    listingId, url,
    outcome: "enriched",
    parseStatus: parsed.parseStatus,
    filledFieldCount: filled,
    parseErrors: parsed.parseErrors,
    normalized: parsed.normalized,
    fetch: fetchAttachment,
  };
  logEnrichOutcome(result);
  return result;
}
