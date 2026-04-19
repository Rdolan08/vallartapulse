/**
 * ingest/airbnb-calendar-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily-grain calendar adapter for Airbnb (availability only).
 *
 * Why this exists (April 2026 spike result):
 *   The brief's path-1 spike — try the legacy /api/v2/calendar_months endpoint —
 *   surfaced a partial win: that exact route returns 404 route_not_found, BUT
 *   its sibling /api/v2/homes_pdp_availability_calendar still works against
 *   plain HTTP (no proxy required) for the public web API key embedded in
 *   www.airbnb.com's homepage.
 *
 * What it returns:
 *   ✓ Per-day availability for 365 days (available/unavailable, min/max nights).
 *   ✗ Nightly price — Airbnb stripped per-day prices from this endpoint at
 *     some point (the `price` object is always `{}`). Verified across 4
 *     listing IDs and 6 query-format permutations (with_conditions,
 *     for_remarketing, for_web_with_date, for_mobile_pdp, with adults
 *     param, etc.). The non-empty variants either return `2b` empty bodies
 *     or 404. Per-day prices have moved to the client-side
 *     PdpAvailabilityCalendar GraphQL call (path 2 in data-feeding.md),
 *     which requires a rotating persisted-query SHA hash.
 *
 * Therefore: this adapter populates `rental_prices_by_date` with
 *   {nightlyPriceUsd: null, availabilityStatus: "available"|"unavailable"}.
 * The comp model still benefits — owner-facing question "what % of
 * comparable Airbnb listings are booked for NYE 2026?" is answerable
 * from availability alone, even without nightly prices. Pricing waits
 * for path 2.
 *
 * Pure parser / single HTTP call. No I/O beyond `fetch`. No DB writes.
 *
 * Endpoint:
 *   GET https://www.airbnb.com/api/v2/homes_pdp_availability_calendar
 *     ?key=<public-web-api-key>
 *     &currency=USD&locale=en
 *     &listing_id=<id>
 *     &month=<starting-month>&year=<starting-year>
 *     &count=<number-of-months>
 *
 * The public web API key is embedded in https://www.airbnb.com/'s SSR
 * payload (`"api_config":{...,"key":"..."}`). It rotates rarely
 * (multi-year cadence — current value matches the one Airbnb shipped
 * publicly for years). We re-discover it on every adapter call so a
 * rotation is self-healing.
 */

const PUBLIC_HOMEPAGE = "https://www.airbnb.com/";
const CALENDAR_BASE = "https://www.airbnb.com/api/v2/homes_pdp_availability_calendar";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Last-known-good public web API key. Used as a hot fallback when the
 * homepage-key fetch fails (rate limit, transient HTML shape change),
 * so a single hiccup doesn't kill an entire daily run.
 */
const FALLBACK_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

export interface AirbnbCalendarDay {
  /** YYYY-MM-DD */
  date: string;
  /** Always null for Airbnb — see file header. */
  nightlyPriceUsd: number | null;
  /** "available" | "unavailable" | "unknown" */
  availabilityStatus: "available" | "unavailable" | "unknown";
  minimumNights: number | null;
}

export interface AirbnbCalendarResult {
  source: "airbnb";
  listingId: string;
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  errors: string[];
  days: AirbnbCalendarDay[];
}

export interface FetchAirbnbCalendarOpts {
  /** Number of forward months to fetch (default 12 — covers ~365 days). */
  monthsCount?: number;
  /** Per-fetch timeout in ms (default 20s). */
  timeoutMs?: number;
  /** Override the public API key (test hook). */
  apiKey?: string;
  /** Override "today" anchor used for month/year params (test hook). */
  today?: Date;
}

const KEY_RE_LIST: RegExp[] = [
  /"api_config":\{[^}]*"key":"([a-z0-9]{20,})"/,
  /"baseUrl":"\/api","key":"([a-z0-9]{20,})"/,
];

/**
 * Discover the public web API key from www.airbnb.com's SSR HTML.
 * Returns the fallback key on any failure — we never fail a run because
 * of a missing key when we have a known-good one.
 */
export async function discoverAirbnbWebApiKey(timeoutMs = 15_000): Promise<string> {
  try {
    const r = await fetch(PUBLIC_HOMEPAGE, {
      headers: { "user-agent": USER_AGENT, "accept": "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status !== 200) return FALLBACK_KEY;
    const html = await r.text();
    for (const re of KEY_RE_LIST) {
      const m = html.match(re);
      if (m && m[1]) return m[1];
    }
    return FALLBACK_KEY;
  } catch {
    return FALLBACK_KEY;
  }
}

interface RawDay {
  date: string;
  available?: boolean;
  min_nights?: number | null;
  max_nights?: number | null;
  price?: Record<string, unknown> | null;
}

interface RawCalendarResponse {
  calendar_months?: Array<{ month: number; year: number; days?: RawDay[] }>;
}

/**
 * Fetch the next-12-months availability calendar for one Airbnb listing.
 *
 * Idempotent and side-effect-free. Caller is responsible for persisting.
 * Always returns a fully-shaped AirbnbCalendarResult — errors are
 * collected on `.errors` rather than thrown, so a single listing's
 * partial failure doesn't kill a batch.
 */
export async function fetchAirbnbCalendar(
  listingExternalId: string,
  opts: FetchAirbnbCalendarOpts = {},
): Promise<AirbnbCalendarResult> {
  const monthsCount = opts.monthsCount ?? 12;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const today = opts.today ?? new Date();
  const month = today.getUTCMonth() + 1;
  const year = today.getUTCFullYear();

  const errors: string[] = [];
  const result: AirbnbCalendarResult = {
    source: "airbnb",
    listingId: listingExternalId,
    daysReturned: 0,
    daysWithPrice: 0,
    daysAvailable: 0,
    daysUnavailable: 0,
    errors,
    days: [],
  };

  if (!listingExternalId || !/^\d+$/.test(listingExternalId)) {
    errors.push(`invalid listing id: ${listingExternalId}`);
    return result;
  }

  const key = opts.apiKey ?? (await discoverAirbnbWebApiKey(timeoutMs));

  const url =
    `${CALENDAR_BASE}?key=${encodeURIComponent(key)}` +
    `&currency=USD&locale=en` +
    `&listing_id=${encodeURIComponent(listingExternalId)}` +
    `&month=${month}&year=${year}&count=${monthsCount}`;

  let raw: RawCalendarResponse;
  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        "accept": "application/json",
        "x-airbnb-api-key": key,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (r.status !== 200) {
      errors.push(`http ${r.status}: ${text.slice(0, 120)}`);
      return result;
    }
    if (text.length < 10) {
      errors.push(`empty body (${text.length}b)`);
      return result;
    }
    try {
      raw = JSON.parse(text) as RawCalendarResponse;
    } catch (e) {
      errors.push(`json parse: ${(e as Error).message.slice(0, 120)}`);
      return result;
    }
  } catch (e) {
    errors.push(`fetch error: ${(e as Error).message.slice(0, 120)}`);
    return result;
  }

  const months = Array.isArray(raw.calendar_months) ? raw.calendar_months : [];
  if (months.length === 0) {
    errors.push("no calendar_months in response (listing likely delisted or unsupported)");
    return result;
  }

  for (const m of months) {
    const days = Array.isArray(m.days) ? m.days : [];
    for (const d of days) {
      if (!d || typeof d.date !== "string") continue;
      const status: AirbnbCalendarDay["availabilityStatus"] =
        d.available === true
          ? "available"
          : d.available === false
            ? "unavailable"
            : "unknown";
      const minNights =
        typeof d.min_nights === "number" && Number.isFinite(d.min_nights)
          ? d.min_nights
          : null;
      // Per file header: price object is always empty in this response.
      // We still inspect it so if Airbnb ever restores price data we
      // pick it up automatically (no schema change needed).
      let priceUsd: number | null = null;
      if (d.price && typeof d.price === "object") {
        const p = d.price as Record<string, unknown>;
        const candidates = [
          (p.local_price as { amount?: number } | undefined)?.amount,
          (p.native_price as { amount?: number } | undefined)?.amount,
          (p.local_adjusted_price as { amount?: number } | undefined)?.amount,
          (p.local_price_formatted as number | undefined),
        ];
        for (const c of candidates) {
          if (typeof c === "number" && Number.isFinite(c) && c > 0) {
            priceUsd = c;
            break;
          }
        }
      }
      result.days.push({
        date: d.date,
        nightlyPriceUsd: priceUsd,
        availabilityStatus: status,
        minimumNights: minNights,
      });
      result.daysReturned++;
      if (priceUsd !== null) result.daysWithPrice++;
      if (status === "available") result.daysAvailable++;
      else if (status === "unavailable") result.daysUnavailable++;
    }
  }

  return result;
}
