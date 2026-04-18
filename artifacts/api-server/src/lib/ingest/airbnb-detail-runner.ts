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
import { listingDetailsTable } from "@workspace/db/schema";
import { fetchWithBrowser } from "./browser-fetch.js";
import { parseAirbnbDetailHtml, type AirbnbDetailParse } from "./airbnb-detail-adapter.js";

export interface EnrichResult {
  listingId: number;
  url: string;
  outcome: "enriched" | "parse_fail" | "blocked" | "error";
  parseStatus?: AirbnbDetailParse["parseStatus"];
  /** Number of normalized fields that came back non-null (excluding nested helpers). */
  filledFieldCount?: number;
  /** What the parser/adapter complained about (field-level absences). */
  parseErrors?: string[];
  /** Network/transport message if outcome === "error" or "blocked". */
  errorMessage?: string;
  /** Snapshot of normalized fields for reporting (not persisted here — DB has it). */
  normalized?: AirbnbDetailParse["normalized"];
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
 * Enrich one listing. Errors are caught and translated into outcomes —
 * the caller's loop should NEVER abort on a single page.
 *
 * The brief allows "no retries unless a page outright fails once". We
 * implement that as a single re-try on transport-level failure (no
 * re-try on parse_fail or block).
 */
export async function enrichOneAirbnbListing(
  listingId: number,
  url: string,
  opts: EnrichOpts = {}
): Promise<EnrichResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const hardCapMs = opts.hardCapMs ?? 70_000;

  // Pass 1
  let html: string;
  const t0 = Date.now();
  try {
    html = await withHardCap(
      fetchWithBrowser(url, {
        timeoutMs,
        // Wait for the JSON-LD bootstrapper — its presence implies the SSR
        // payload is in the DOM. networkidle is racing alongside it inside
        // fetchWithBrowser.
        waitForSelector: 'script[type="application/ld+json"]',
        fallbackOnTimeout: true,
      }),
      timeoutMs + 8_000,
      `fetch pass-1 ${url}`,
    );
  } catch (err) {
    // One transport-only retry, per the brief — but only if we still have
    // budget left under the hard cap.
    const remaining = hardCapMs - (Date.now() - t0);
    if (remaining < 8_000) {
      return {
        listingId, url,
        outcome: "error",
        errorMessage: `pass-1 failed and no retry budget: ${(err as Error).message.slice(0, 200)}`,
      };
    }
    try {
      html = await withHardCap(
        fetchWithBrowser(url, {
          timeoutMs: Math.min(timeoutMs, remaining - 4_000),
          waitForSelector: 'script[type="application/ld+json"]',
          fallbackOnTimeout: true,
        }),
        remaining - 2_000,
        `fetch pass-2 ${url}`,
      );
    } catch (err2) {
      return {
        listingId, url,
        outcome: "error",
        errorMessage: `fetch failed twice: ${(err2 as Error).message.slice(0, 200)}`,
      };
    }
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
    return { listingId, url, outcome: "blocked", errorMessage: block.reason };
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
    return {
      listingId, url, outcome: "parse_fail",
      parseStatus: parsed.parseStatus,
      filledFieldCount: filled,
      parseErrors: parsed.parseErrors,
      normalized: parsed.normalized,
    };
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
  }

  return {
    listingId, url,
    outcome: "enriched",
    parseStatus: parsed.parseStatus,
    filledFieldCount: filled,
    parseErrors: parsed.parseErrors,
    normalized: parsed.normalized,
  };
}
