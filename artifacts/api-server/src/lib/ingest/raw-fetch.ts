/**
 * ingest/raw-fetch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Raw HTTP transport via the residential proxy (no browser).
 *
 * Why this exists alongside browser-fetch:
 *   - Investigation showed Airbnb's /rooms/{id} pages already SSR a complete
 *     hydration payload (JSON-LD VacationRental, Apollo data-deferred-state,
 *     og:title meta) in the FIRST HTTP response — no JS execution required.
 *   - A single proxied HTTP request returns 460–540KB of fully-parseable HTML
 *     in ~1s, vs. the browser path's 10–30s budget per page.
 *   - We keep the browser path as the proven fallback for cases where the raw
 *     fetch is genuinely walled (captcha / perimeterx interstitials), since
 *     those interstitials specifically target non-browser TLS+JS fingerprints.
 *
 * This module is INERT until a caller wires it in. The detail runner is
 * unchanged — wiring is a separate, controlled change so we can A/B the
 * approach first.
 */

// Use undici's own fetch (not Node's native) — undici v8's ProxyAgent
// dispatcher contract is incompatible with Node 24's bundled fetch
// ("invalid onRequestStart method"). undici.fetch keeps the contract
// internal-consistent and is the supported usage path for ProxyAgent.
import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * Realistic Chrome 124 macOS UA — matches the browser-fetch user-agent so
 * Airbnb sees the same client identity across both transports. Picked
 * specifically because Airbnb's PDP responds with the full SSR payload
 * for this UA + proxy combo (verified against 4 distinct listing IDs).
 */
const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Default headers — full set a real Chrome navigation would send. */
function defaultHeaders(): Record<string, string> {
  return {
    "user-agent": REALISTIC_UA,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  };
}

export interface RawFetchOpts {
  /** Per-request timeout (ms). Default 25s — generous; raw fetch typically completes in ~1s. */
  timeoutMs?: number;
  /** Override PROXY_URL (mostly for tests). */
  proxyUrl?: string;
}

export interface RawFetchResult {
  url: string;
  status: number;
  bytes: number;
  ms: number;
  html: string;
  /** Final URL after redirects (Airbnb sometimes 30x's to a localized variant). */
  finalUrl: string;
}

/**
 * Single-shot raw HTTP fetch through the residential proxy.
 * Throws on transport / proxy / timeout errors. Non-2xx responses are
 * returned (not thrown) so callers can inspect the body.
 */
export async function fetchAirbnbRaw(
  url: string,
  opts: RawFetchOpts = {}
): Promise<RawFetchResult> {
  const proxyUrl = opts.proxyUrl ?? process.env.PROXY_URL;
  if (!proxyUrl) throw new Error("PROXY_URL not set — raw HTTP fetch unavailable");
  const timeoutMs = opts.timeoutMs ?? 25_000;

  const t0 = Date.now();
  const agent = new ProxyAgent(proxyUrl);
  const res = await undiciFetch(url, {
    dispatcher: agent,
    headers: defaultHeaders(),
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  return {
    url,
    status: res.status,
    bytes: html.length,
    ms: Date.now() - t0,
    html,
    finalUrl: res.url,
  };
}

/**
 * "Should we retry this with the browser?" predicate.
 *
 * Returns `unusable: true` when the raw response shows a hallmark of a
 * non-browser block (captcha walls, perimeterx interstitials, distil_r,
 * "access denied", or a tiny body that ISN'T a recognized delisted-page
 * template).
 *
 * Critically does NOT mark the response unusable when:
 *   - Body is the well-known 2671-byte helpful_404 template (genuinely
 *     delisted — browser would just return the same thing). Detected by
 *     the marker strings used in airbnb-detail-runner.looksDelisted().
 *   - Body is a normal-sized PDP without obvious wall markers (the parser
 *     can take it from here; even if structured anchors are missing, the
 *     og:title fallback in the adapter usually rescues it).
 *
 * Heuristic mirrors looksBlocked + looksDelisted from the runner so the
 * three predicates stay aligned. If any of them are tightened in the
 * future, this should be tightened too.
 */
export function rawFetchLooksUnusable(html: string, status: number): { unusable: boolean; reason?: string } {
  // Transport-level non-2xx → always unusable.
  if (status < 200 || status >= 300) {
    return { unusable: true, reason: `http ${status}` };
  }

  // Recognize delisted FIRST so we don't flag it as "unusable / try browser".
  // Mirrors looksDelisted() in airbnb-detail-runner.ts — kept inline (not
  // imported) to keep this module self-contained for the comparison harness.
  if (html.length <= 6_000) {
    if (html.includes("helpful_404.html.erb") ||
        html.includes("404 Page Not Found - Airbnb") ||
        /<title>\s*404\b/i.test(html)) {
      return { unusable: false, reason: "delisted (browser would return same)" };
    }
    return { unusable: true, reason: `short body ${html.length}b (not delisted-shaped)` };
  }

  const lower = html.toLowerCase();
  if (lower.includes("px-captcha") || lower.includes("perimeterx") ||
      lower.includes("/distil_r_") || lower.includes("access denied") ||
      lower.includes("are you a human") || lower.includes("blocked by the airbnb") ||
      lower.includes("pardon our interruption") || lower.includes("/forbidden")) {
    return { unusable: true, reason: "captcha / bot-wall markers" };
  }

  return { unusable: false };
}

// ─────────────────────────────────────────────────────────────────────────
// Hybrid orchestrator: try raw first, fall back to browser when raw is
// unusable. Used by the airbnb detail runner when AIRBNB_DETAIL_FETCH_MODE
// is set to "hybrid". Lives here (not in a separate file) so the predicate
// + the orchestration that depends on it stay co-located.
// ─────────────────────────────────────────────────────────────────────────

import { fetchWithBrowser } from "./browser-fetch.js";

export interface HybridFetchOpts {
  /** Per-attempt timeout for raw and (separately) browser. Default 25s each. */
  timeoutMs?: number;
  /**
   * If true, fall back to the browser path when the raw response trips
   * `rawFetchLooksUnusable`. If false, raw failures surface as a thrown
   * error (used for the "raw" mode where we explicitly want to evaluate
   * raw without the browser safety net).
   */
  allowBrowserFallback?: boolean;
  /**
   * Selector to wait for in browser mode — same default as the runner's
   * pass-1 call, so behavior is identical when we do fall back.
   */
  browserWaitForSelector?: string;
}

export interface HybridFetchObservability {
  /** Which transport produced the body that's returned. */
  fetchMode: "raw" | "browser-fallback" | "browser";
  /** Did we attempt raw at all? */
  rawAttempted: boolean;
  /** Did the raw response come back AND pass rawFetchLooksUnusable? */
  rawSucceeded: boolean;
  /** Status code from the raw attempt (null if raw not attempted). */
  rawStatus: number | null;
  /** Wall-clock ms for the raw attempt (null if raw not attempted). */
  rawMs: number | null;
  /** If raw was unusable, why we fell back. Null if raw succeeded or was skipped. */
  rawFallbackReason: string | null;
  /** True iff the browser path was used (either as fallback or as primary). */
  browserUsed: boolean;
  /** Wall-clock ms for the browser attempt (null if browser not used). */
  browserMs: number | null;
}

export interface HybridFetchResult {
  html: string;
  bytes: number;
  observability: HybridFetchObservability;
}

/**
 * Error thrown by `fetchAirbnbDetailHybrid` when raw is unusable AND
 * `allowBrowserFallback` is false (i.e. "raw" mode). Carries the partial
 * observability captured during the raw attempt so the caller can persist
 * `rawStatus`, `rawMs`, and `rawFallbackReason` in its log/return shape
 * — important for Phase B failure-cohort analysis.
 */
export class HybridFetchError extends Error {
  readonly observability: HybridFetchObservability;
  constructor(message: string, observability: HybridFetchObservability) {
    super(message);
    this.name = "HybridFetchError";
    this.observability = observability;
  }
}

/**
 * Try raw first; fall back to the browser path when the raw body looks
 * unusable AND `allowBrowserFallback` is true. The returned observability
 * payload is the source of truth for per-listing comparison metrics.
 */
export async function fetchAirbnbDetailHybrid(
  url: string,
  opts: HybridFetchOpts = {}
): Promise<HybridFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const allowFallback = opts.allowBrowserFallback ?? true;
  const browserSelector = opts.browserWaitForSelector ??
    'script[type="application/ld+json"], script[id^="data-deferred-state"]';

  // ── Raw attempt ─────────────────────────────────────────────────────
  let rawErr: Error | null = null;
  let rawBytes = 0;
  let rawHtml = "";
  let rawStatus: number | null = null;
  let rawMs: number | null = null;
  try {
    const r = await fetchAirbnbRaw(url, { timeoutMs });
    rawHtml = r.html;
    rawBytes = r.bytes;
    rawStatus = r.status;
    rawMs = r.ms;
  } catch (err) {
    rawErr = err as Error;
  }

  // If raw threw outright, treat it as unusable for the predicate.
  let usable: ReturnType<typeof rawFetchLooksUnusable>;
  if (rawErr) {
    usable = { unusable: true, reason: `raw transport error: ${rawErr.message.slice(0, 120)}` };
  } else {
    usable = rawFetchLooksUnusable(rawHtml, rawStatus ?? 0);
  }

  if (!usable.unusable) {
    return {
      html: rawHtml,
      bytes: rawBytes,
      observability: {
        fetchMode: "raw",
        rawAttempted: true,
        rawSucceeded: true,
        rawStatus,
        rawMs,
        rawFallbackReason: null,
        browserUsed: false,
        browserMs: null,
      },
    };
  }

  // ── Browser fallback (only in hybrid mode) ─────────────────────────
  if (!allowFallback) {
    throw new HybridFetchError(
      `raw fetch unusable and fallback disabled: ${usable.reason}`,
      {
        fetchMode: "raw",
        rawAttempted: true,
        rawSucceeded: false,
        rawStatus,
        rawMs,
        rawFallbackReason: usable.reason ?? "raw unusable",
        browserUsed: false,
        browserMs: null,
      },
    );
  }

  const bt0 = Date.now();
  let html: string;
  try {
    html = await fetchWithBrowser(url, {
      timeoutMs,
      waitForSelector: browserSelector,
      fallbackOnTimeout: true,
    });
  } catch (browserErr) {
    // Both transports failed. Re-throw as HybridFetchError so the caller
    // still gets structured raw-attempt metrics — without this, the
    // outer catch would see a plain Error and lose rawStatus/rawMs/
    // rawFallbackReason, defeating the purpose of the fallback path's
    // observability for Phase B failure-cohort analysis.
    throw new HybridFetchError(
      `raw unusable + browser fallback failed: raw=[${usable.reason}] browser=[${(browserErr as Error).message.slice(0, 160)}]`,
      {
        fetchMode: "browser-fallback",
        rawAttempted: true,
        rawSucceeded: false,
        rawStatus,
        rawMs,
        rawFallbackReason: usable.reason ?? "raw unusable",
        browserUsed: true,
        browserMs: Date.now() - bt0,
      },
    );
  }
  const browserMs = Date.now() - bt0;

  return {
    html,
    bytes: html.length,
    observability: {
      fetchMode: "browser-fallback",
      rawAttempted: true,
      rawSucceeded: false,
      rawStatus,
      rawMs,
      rawFallbackReason: usable.reason ?? "raw unusable",
      browserUsed: true,
      browserMs,
    },
  };
}
