/**
 * ingest/airroi-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Forward-rate calendar adapter for Airbnb listings via AirROI's
 * `/listings/future/rates` endpoint.
 *
 * Why this exists (April 2026):
 *   The legacy paths — airbnb-calendar-adapter (no prices, only availability)
 *   and the GraphQL quote pipeline (broken since 04-19, requires browser
 *   automation through residential proxy) — leave us with stale or absent
 *   pricing data. AirROI's commercial API surfaces both per-night
 *   availability AND per-night rate in a single HTTPS call, no proxy
 *   required, no headless browser, no captcha exposure.
 *
 * What it returns:
 *   ✓ Per-day availability (boolean) for ~340 forward days
 *   ✓ Per-day nightly rate (in requested currency, default USD)
 *   ✓ Per-day minimum-nights requirement
 *   ✗ Fee breakdown (cleaning, service, taxes) — AirROI does not surface
 *     these. The `listing_price_quotes` table remains the home of full
 *     priced quotes; this adapter populates only `rental_prices_by_date`.
 *
 * Reliability profile (observed April 2026 spike):
 *   - Cold-start AWS Lambda invocations frequently hit AirROI's internal
 *     29-second API Gateway timeout, returning 504
 *     `InternalServerErrorException`. Subsequent invocations against
 *     the same listing typically warm-path in <12s.
 *   - This adapter wraps the fetch in retry-with-backoff for that exact
 *     case. Default schedule: 3 attempts spaced 5s, 15s apart.
 *
 * Pure parser / fetch + retry. No I/O beyond HTTPS. No DB writes.
 *
 * Cost: $0.10 per successful call (confirmed from AirROI usage
 * dashboard 2026-04-26 — earlier `$0.015/call` figure was a stale
 * pre-billing estimate). Caller is responsible for budget enforcement
 * (e.g. AIRROI_MAX_LISTINGS cap).
 */

const AIRROI_BASE = "https://api.airroi.com";

export interface AirroiDay {
  date: string; // YYYY-MM-DD
  available: boolean;
  rate: number | null;
  min_nights: number | null;
}

export interface AirroiAttempt {
  attemptNum: number;
  status: number | null; // null = network/timeout error before any HTTP response
  elapsedMs: number;
  error?: string;
}

export interface AirroiCalendarResult {
  externalId: string;
  currency: string;
  days: AirroiDay[];
  finalStatus: number;
  totalElapsedMs: number;
  attemptCount: number;
  attempts: AirroiAttempt[];
  rawHeaders: Record<string, string>;
}

export interface AirroiCalendarOptions {
  /** Required AirROI API key. Caller resolves from env. */
  apiKey: string;
  /** ISO-4217 lowercase code. Default "usd". */
  currency?: string;
  /** Total attempts including the first try. Default 3. */
  maxAttempts?: number;
  /** Sleep before retry N+1 (ms). Length should be maxAttempts-1. Default [5000, 15000]. */
  backoffSchedule?: number[];
  /**
   * Per-attempt fetch timeout. Default 60s — well above AirROI's own
   * 29s API Gateway timeout, so we always observe their 504 rather than
   * being aborted ourselves.
   */
  perAttemptTimeoutMs?: number;
}

export class AirroiFetchError extends Error {
  constructor(
    message: string,
    public readonly externalId: string,
    public readonly attempts: AirroiAttempt[],
    public readonly lastStatus: number | null,
    public readonly lastBody?: unknown,
  ) {
    super(message);
    this.name = "AirroiFetchError";
  }
}

const DEFAULT_BACKOFF_MS = [5_000, 15_000];
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PER_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_CURRENCY = "usd";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractDays(body: unknown): AirroiDay[] {
  if (body == null || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  // Documented shape uses `dates`. Defensive: also probe top-level array
  // and any first array-of-objects with a `date` key.
  if (Array.isArray(obj.dates)) return obj.dates as AirroiDay[];
  if (Array.isArray(body)) return body as AirroiDay[];
  for (const v of Object.values(obj)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === "object" &&
      v[0] !== null &&
      "date" in (v[0] as object) &&
      "available" in (v[0] as object)
    ) {
      return v as AirroiDay[];
    }
  }
  return [];
}

function extractCurrency(body: unknown, requested: string): string {
  if (body && typeof body === "object" && "currency" in body) {
    const c = (body as { currency?: unknown }).currency;
    if (typeof c === "string" && c.length > 0) return c;
  }
  return requested.toUpperCase();
}

async function singleAttempt(
  url: string,
  apiKey: string,
  perAttemptTimeoutMs: number,
): Promise<{
  status: number;
  body: unknown;
  headers: Record<string, string>;
  elapsedMs: number;
}> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), perAttemptTimeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: ctrl.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON response body; leave as null
    }
    return { status: res.status, body, headers, elapsedMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the AirROI forward-rate calendar for one external listing ID.
 * Retries transient failures (5xx + 408/429 + network errors). Throws
 * `AirroiFetchError` if all attempts fail. Returns rich result with
 * per-attempt diagnostics on success.
 */
export async function fetchAirroiCalendar(
  externalId: string,
  opts: AirroiCalendarOptions,
): Promise<AirroiCalendarResult> {
  if (!externalId || !/^\d+$/.test(externalId)) {
    throw new Error(`AirROI requires a numeric external id; got ${JSON.stringify(externalId)}`);
  }
  const currency = (opts.currency ?? DEFAULT_CURRENCY).toLowerCase();
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = opts.backoffSchedule ?? DEFAULT_BACKOFF_MS;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? DEFAULT_PER_ATTEMPT_TIMEOUT_MS;
  const url = `${AIRROI_BASE}/listings/future/rates?id=${encodeURIComponent(externalId)}&currency=${encodeURIComponent(currency)}`;

  const attempts: AirroiAttempt[] = [];
  const startedAt = Date.now();
  let lastBody: unknown = undefined;
  let lastStatus: number | null = null;
  let lastHeaders: Record<string, string> = {};

  for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
    try {
      const { status, body, headers, elapsedMs } = await singleAttempt(
        url,
        opts.apiKey,
        perAttemptTimeoutMs,
      );
      lastStatus = status;
      lastBody = body;
      lastHeaders = headers;

      if (status === 200) {
        const days = extractDays(body);
        if (days.length === 0) {
          attempts.push({
            attemptNum,
            status,
            elapsedMs,
            error: "200-but-no-days-in-response",
          });
          // Empty 200 isn't a transient infrastructure issue — likely
          // listing-specific (delisted, no calendar data). Fail fast.
          throw new AirroiFetchError(
            `AirROI returned 200 but no days for listing ${externalId}`,
            externalId,
            attempts,
            status,
            body,
          );
        }
        attempts.push({ attemptNum, status, elapsedMs });
        return {
          externalId,
          currency: extractCurrency(body, currency),
          days,
          finalStatus: status,
          totalElapsedMs: Date.now() - startedAt,
          attemptCount: attemptNum,
          attempts,
          rawHeaders: headers,
        };
      }

      // Non-200: record + decide retry
      attempts.push({
        attemptNum,
        status,
        elapsedMs,
        error: `non-200-status-${status}`,
      });
      if (!RETRYABLE_STATUS.has(status) || attemptNum === maxAttempts) {
        throw new AirroiFetchError(
          `AirROI returned ${status} for listing ${externalId} (attempt ${attemptNum}/${maxAttempts})`,
          externalId,
          attempts,
          status,
          body,
        );
      }
      // Retryable + more attempts available — fall through to backoff
    } catch (e) {
      if (e instanceof AirroiFetchError) throw e; // already accounted for, do not wrap
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({
        attemptNum,
        status: null,
        elapsedMs: 0,
        error: `network-or-timeout: ${msg}`,
      });
      if (attemptNum === maxAttempts) {
        throw new AirroiFetchError(
          `AirROI fetch exhausted ${maxAttempts} attempts for ${externalId}: ${msg}`,
          externalId,
          attempts,
          null,
        );
      }
    }

    // Sleep before next attempt
    const wait = backoff[attemptNum - 1] ?? backoff[backoff.length - 1] ?? 5_000;
    await sleep(wait);
  }

  // Loop exit without return/throw should be impossible, but guard anyway:
  throw new AirroiFetchError(
    `AirROI fetch loop exited without resolution for ${externalId}`,
    externalId,
    attempts,
    lastStatus,
    lastBody ?? lastHeaders,
  );
}

/**
 * Map AirROI's day-array → InsertRentalPriceByDate rows ready for upsert.
 *
 * Availability mapping (see schema rental_prices_by_date.availabilityStatus):
 *   AirROI {available: true}  → "available"
 *   AirROI {available: false} → "booked"
 *
 * Why "booked" not "blocked": AirROI doesn't distinguish booked-by-guest vs
 * blocked-by-host. The conservative read for PV market intelligence is
 * "booked" since hosts don't typically blackout 80%+ of their calendar.
 * Revisit if downstream analytics need the distinction — would require a
 * separate booked/blocked signal AirROI doesn't currently expose.
 */
export interface MappedRow {
  listingId: number;
  date: string;
  nightlyPriceUsd: number | null;
  availabilityStatus: "available" | "booked";
  minimumNights: number | null;
  scrapedAt: Date;
}

export function mapAirroiToInsertRows(
  listingId: number,
  result: AirroiCalendarResult,
  scrapedAt: Date,
): MappedRow[] {
  return result.days.map((d) => ({
    listingId,
    date: d.date,
    nightlyPriceUsd: d.rate,
    availabilityStatus: d.available ? "available" : "booked",
    minimumNights: d.min_nights,
    scrapedAt,
  }));
}
