/**
 * ingest/airbnb-graphql-pricing-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "Path 2" Airbnb pricing adapter: replicates the client-side
 * `PdpAvailabilityCalendar` GraphQL persisted-query call that ships with
 * Airbnb's PDP, so we can recover the per-night prices that the public
 * /api/v2 calendar endpoint stripped.
 *
 * Why this exists:
 *   - airbnb-calendar-adapter.ts (path 1) gives us availability for free
 *     but its `price` object is always `{}` — Airbnb moved per-night
 *     pricing to a client-side GraphQL fetch issued AFTER hydration.
 *   - The GraphQL operation (`PdpAvailabilityCalendar`) is a "persisted
 *     query" — the request URL embeds a SHA256 hash of the query text;
 *     the server rejects anything with the wrong hash. The hash rotates
 *     ~weekly when Airbnb redeploys the operation.
 *
 * Strategy (one-time SHA discovery + cheap replays):
 *   1. Discovery: launch Playwright once, navigate to a real Airbnb PDP,
 *      intercept the GraphQL request the page itself fires, capture the
 *      SHA from the URL path. Persist to a tiny JSON cache file so we
 *      don't pay the Playwright cost on every replay.
 *   2. Replay: every subsequent fetch is a plain HTTP GET via the
 *      residential proxy (undici + ProxyAgent — same transport as
 *      raw-fetch.ts). One call per listing returns 12 months × ~30 days
 *      of priced+available days.
 *   3. Self-healing: if a replay returns the GraphQL "PersistedQueryNotFound"
 *      shape (Airbnb rotated the hash), the result carries `staleSha:true`
 *      so the caller can re-discover and retry.
 *
 * No DB writes. No shared state beyond a small on-disk SHA cache.
 */

import { fetch as undiciFetch, ProxyAgent } from "undici";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { discoverAirbnbWebApiKey } from "./airbnb-calendar-adapter.js";

const GRAPHQL_HOST = "https://www.airbnb.com";
const GRAPHQL_BASE = `${GRAPHQL_HOST}/api/v3/PdpAvailabilityCalendar`;
const OPERATION_NAME = "PdpAvailabilityCalendar";

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Cache file for the persisted-query SHA hash. Lives in the OS tmp dir
 * by default — survives across runs but doesn't pollute the repo. The
 * env var override is mainly for tests.
 */
const SHA_CACHE_PATH =
  process.env.AIRBNB_GRAPHQL_SHA_CACHE_PATH ??
  path.join(os.tmpdir(), "airbnb-graphql-sha.json");

/**
 * How long a cached SHA is considered fresh. Airbnb's persisted-query
 * hash rotates roughly weekly when they redeploy; we re-discover after
 * 5 days to leave headroom before the rotation hits.
 */
const SHA_FRESH_MS = 5 * 24 * 60 * 60 * 1000;

/**
 * Hard fallback: a recent known-good SHA. Used when discovery fails AND
 * the cache is empty, so a single Playwright hiccup doesn't kill an
 * entire daily run. Kept inline (not in env) so we're never blocked on
 * ops to set a secret. Will go stale eventually — that's fine, the
 * runner re-discovers on staleSha=true.
 */
const FALLBACK_SHA =
  "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";

export interface AirbnbGraphqlDay {
  /** YYYY-MM-DD */
  date: string;
  /** Per-night base price in USD. Null if Airbnb returned no price for this day. */
  nightlyPriceUsd: number | null;
  available: boolean;
  minimumNights: number | null;
  maximumNights: number | null;
}

export interface AirbnbGraphqlCalendarResult {
  source: "airbnb_graphql";
  listingId: string;
  /** SHA used for THIS fetch (useful for log debugging). */
  shaUsed: string;
  /** True if Airbnb rejected the SHA — caller should re-discover and retry. */
  staleSha: boolean;
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  errors: string[];
  days: AirbnbGraphqlDay[];
}

export interface FetchAirbnbGraphqlOpts {
  /** Number of forward months to fetch (default 12). */
  monthsCount?: number;
  /** Per-fetch timeout in ms (default 25s). */
  timeoutMs?: number;
  /** Override "today" anchor (test hook). */
  today?: Date;
  /** Override the public web API key (test hook). */
  apiKey?: string;
  /** Override PROXY_URL (mostly for tests). */
  proxyUrl?: string;
}

interface ShaCacheFile {
  sha: string;
  capturedAt: number; // epoch ms
}

/** Read the cached SHA from disk. Returns null if missing/corrupt/expired. */
export async function loadCachedSha(now: number = Date.now()): Promise<string | null> {
  try {
    const raw = await fs.readFile(SHA_CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw) as ShaCacheFile;
    if (!parsed || typeof parsed.sha !== "string" || !/^[a-f0-9]{40,}$/i.test(parsed.sha)) {
      return null;
    }
    if (typeof parsed.capturedAt !== "number") return null;
    if (now - parsed.capturedAt > SHA_FRESH_MS) return null;
    return parsed.sha;
  } catch {
    return null;
  }
}

/** Persist the SHA to disk. Best-effort — failure is logged but not thrown. */
export async function saveSha(sha: string, now: number = Date.now()): Promise<void> {
  const payload: ShaCacheFile = { sha, capturedAt: now };
  try {
    await fs.writeFile(SHA_CACHE_PATH, JSON.stringify(payload), "utf8");
  } catch (e) {
    // Non-fatal — next discovery just rebuilds it.
    console.warn(`[airbnb-graphql] failed to persist SHA cache: ${(e as Error).message}`);
  }
}

/**
 * Discover the persisted-query SHA by visiting an Airbnb PDP under
 * Playwright and intercepting the GraphQL request the page issues
 * itself. Falls back to FALLBACK_SHA only when discovery fails AND
 * there is no cache to fall back on (the caller decides).
 *
 * `seedListingId` should be a known-active Airbnb listing — any one
 * works since the persisted-query SHA is per-OPERATION, not per-listing.
 */
export async function discoverPersistedQuerySha(opts: {
  seedListingId?: string;
  timeoutMs?: number;
} = {}): Promise<string> {
  const seed = opts.seedListingId ?? "21684999"; // long-lived public listing
  const timeoutMs = opts.timeoutMs ?? 30_000;

  // Lazy import — Playwright is heavy and the api-server should not pull
  // it in for every request that imports this file.
  const { fetchWithBrowser: _unused } = await import("./browser-fetch.js");
  void _unused; // ensure the module is loaded so playwright is resolved
  const { chromium } = await import("playwright");

  const proxyRaw = process.env.PROXY_URL ?? "";
  let proxy: { server: string; username?: string; password?: string } | undefined;
  if (proxyRaw) {
    try {
      const u = new URL(proxyRaw);
      proxy = {
        server: `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
      };
    } catch {
      // Bad PROXY_URL — proceed without proxy; discovery often still works.
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(proxy ? { proxy } : {}),
  });
  try {
    const ctx = await browser.newContext({
      userAgent: REALISTIC_UA,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
    });
    const page = await ctx.newPage();

    // The request we want lives at /api/v3/PdpAvailabilityCalendar/<sha>?...
    // We capture the SHA the moment the browser makes the call.
    const shaPromise = new Promise<string>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`SHA discovery timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      page.on("request", (req) => {
        const url = req.url();
        if (!url.includes("/api/v3/PdpAvailabilityCalendar/")) return;
        const m = url.match(/\/api\/v3\/PdpAvailabilityCalendar\/([a-f0-9]{40,})/i);
        if (m && m[1]) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
    });

    // Block heavy media but allow the GraphQL request.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") return route.abort();
      return route.continue();
    });

    // Navigate; the calendar GraphQL fires automatically after hydration.
    const navP = page.goto(`https://www.airbnb.com/rooms/${seed}`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    }).catch(() => null);

    const sha = await Promise.race([
      shaPromise,
      navP.then(() => shaPromise), // also wait through nav errors
    ]);

    return sha;
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}

/**
 * Get a usable SHA: prefer cache, then discover, then FALLBACK_SHA.
 * Always persists the result back to cache when it came from discovery.
 *
 * `forceRediscover` skips the cache step — used when a replay returned
 * staleSha and we know the cached value is dead.
 */
export async function getOrDiscoverSha(opts: {
  forceRediscover?: boolean;
  seedListingId?: string;
  timeoutMs?: number;
} = {}): Promise<{ sha: string; source: "cache" | "discovered" | "fallback" }> {
  if (!opts.forceRediscover) {
    const cached = await loadCachedSha();
    if (cached) return { sha: cached, source: "cache" };
  }
  try {
    const sha = await discoverPersistedQuerySha({
      seedListingId: opts.seedListingId,
      timeoutMs: opts.timeoutMs,
    });
    await saveSha(sha);
    return { sha, source: "discovered" };
  } catch (e) {
    console.warn(`[airbnb-graphql] SHA discovery failed: ${(e as Error).message}`);
    return { sha: FALLBACK_SHA, source: "fallback" };
  }
}

interface RawDay {
  calendarDate?: string;
  available?: boolean;
  minNights?: number | null;
  maxNights?: number | null;
  price?: Record<string, unknown> | null;
}

interface RawMonth {
  month?: number;
  year?: number;
  days?: RawDay[];
}

interface RawGraphqlResponse {
  data?: {
    merlin?: {
      pdpAvailabilityCalendar?: {
        calendarMonths?: RawMonth[];
      };
    };
  };
  errors?: Array<{ message?: string; extensions?: { classification?: string; code?: string } }>;
}

/** Pull a number out of the various price-shape variants Airbnb has shipped. */
function extractNightlyUsd(price: Record<string, unknown> | null | undefined): number | null {
  if (!price || typeof price !== "object") return null;
  // Try the modern shapes first, then fall back to legacy.
  const candidates: unknown[] = [
    (price.perNight as { amount?: number } | undefined)?.amount,
    (price.perNightDiscounted as { amount?: number } | undefined)?.amount,
    (price.localPrice as { amount?: number } | undefined)?.amount,
    (price.localAdjustedPrice as { amount?: number } | undefined)?.amount,
    (price as { amount?: number }).amount,
  ];
  // Last-ditch: parse "$240" or "MX$1,234" out of any *Formatted string.
  for (const k of Object.keys(price)) {
    if (k.toLowerCase().includes("formatted")) {
      const v = (price as Record<string, unknown>)[k];
      if (typeof v === "string") {
        const m = v.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
        if (m) candidates.push(Number(m[1]));
      }
    }
  }
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return null;
}

/**
 * Replay the persisted-query GraphQL call through the residential proxy
 * for one listing. Returns a normalized per-day result + a staleSha flag
 * so the caller can decide whether to re-discover.
 */
export async function fetchAirbnbCalendarGraphql(
  listingExternalId: string,
  sha: string,
  opts: FetchAirbnbGraphqlOpts = {},
): Promise<AirbnbGraphqlCalendarResult> {
  const monthsCount = opts.monthsCount ?? 12;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const today = opts.today ?? new Date();
  const month = today.getUTCMonth() + 1;
  const year = today.getUTCFullYear();

  const result: AirbnbGraphqlCalendarResult = {
    source: "airbnb_graphql",
    listingId: listingExternalId,
    shaUsed: sha,
    staleSha: false,
    daysReturned: 0,
    daysWithPrice: 0,
    daysAvailable: 0,
    daysUnavailable: 0,
    errors: [],
    days: [],
  };

  if (!listingExternalId || !/^\d+$/.test(listingExternalId)) {
    result.errors.push(`invalid listing id: ${listingExternalId}`);
    return result;
  }
  if (!sha || !/^[a-f0-9]{40,}$/i.test(sha)) {
    result.errors.push(`invalid sha: ${sha}`);
    return result;
  }

  const apiKey = opts.apiKey ?? (await discoverAirbnbWebApiKey(timeoutMs));

  // Variables shape mirrors what the PDP itself sends. The listingId is
  // a STRING (Airbnb accepts both legacy 9-digit and post-2022 long-form
  // IDs here — that's the whole point of using path 2).
  const variables = {
    request: {
      count: monthsCount,
      listingId: listingExternalId,
      month,
      year,
    },
  };
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: sha },
  };

  const url =
    `${GRAPHQL_BASE}/${sha}` +
    `?operationName=${encodeURIComponent(OPERATION_NAME)}` +
    `&locale=en&currency=USD` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

  const proxyUrl = opts.proxyUrl ?? process.env.PROXY_URL;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  let raw: RawGraphqlResponse;
  try {
    const r = await undiciFetch(url, {
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        "user-agent": REALISTIC_UA,
        "accept": "application/json",
        "x-airbnb-api-key": apiKey,
        "x-airbnb-graphql-platform": "web",
        "x-airbnb-graphql-platform-client": "minimalist-niobe",
        "accept-language": "en-US,en;q=0.9",
        "referer": `https://www.airbnb.com/rooms/${listingExternalId}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (r.status !== 200) {
      // 410 Gone is Airbnb's signal for "this persisted query is dead".
      // Some deploys also use 400 with PersistedQueryNotFound in the body.
      result.staleSha = r.status === 410 || /PersistedQueryNotFound/i.test(text);
      result.errors.push(`http ${r.status}: ${text.slice(0, 160)}`);
      return result;
    }
    if (text.length < 5) {
      result.errors.push(`empty body (${text.length}b)`);
      return result;
    }
    try {
      raw = JSON.parse(text) as RawGraphqlResponse;
    } catch (e) {
      result.errors.push(`json parse: ${(e as Error).message.slice(0, 160)}`);
      return result;
    }
  } catch (e) {
    result.errors.push(`fetch error: ${(e as Error).message.slice(0, 160)}`);
    return result;
  }

  // GraphQL-level errors (200 OK, but the body says PersistedQueryNotFound).
  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    const msg = raw.errors.map((e) => e?.message ?? "").join("; ");
    if (/PersistedQueryNotFound/i.test(msg) ||
        raw.errors.some((e) => e?.extensions?.code === "PERSISTED_QUERY_NOT_FOUND")) {
      result.staleSha = true;
    }
    result.errors.push(`graphql: ${msg.slice(0, 160)}`);
    return result;
  }

  const months = raw.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths ?? [];
  if (months.length === 0) {
    result.errors.push("no calendarMonths in response");
    return result;
  }

  for (const m of months) {
    const days = Array.isArray(m.days) ? m.days : [];
    for (const d of days) {
      if (!d || typeof d.calendarDate !== "string") continue;
      const nightlyPriceUsd = extractNightlyUsd(d.price ?? null);
      const available = d.available === true;
      const minimumNights =
        typeof d.minNights === "number" && Number.isFinite(d.minNights) ? d.minNights : null;
      const maximumNights =
        typeof d.maxNights === "number" && Number.isFinite(d.maxNights) ? d.maxNights : null;
      result.days.push({
        date: d.calendarDate,
        nightlyPriceUsd,
        available,
        minimumNights,
        maximumNights,
      });
      result.daysReturned++;
      if (nightlyPriceUsd !== null) result.daysWithPrice++;
      if (available) result.daysAvailable++;
      else result.daysUnavailable++;
    }
  }

  return result;
}
