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
 *   ✗ Nightly price — Airbnb stripped per-day prices from these endpoints at
 *     some point. The legacy v2 `price` object is always `{}`; the v3
 *     GraphQL `price.localPriceFormatted` is always `null` for the public
 *     persisted-query (anonymous, no proxy). Per-day prices remain a
 *     residential-proxy + dated-quote problem (see `airbnb-checkpoints.ts`
 *     and `listing_price_quotes`).
 *
 * Two routes, dispatched by ID length (October 2026 update):
 *
 *   Short-form numeric IDs (≤ 10 digits, pre-2022 listings)
 *     GET /api/v2/homes_pdp_availability_calendar
 *     Battle-tested, no proxy, ~1s/listing.
 *
 *   Long-form numeric IDs (11-13 digits, post-2022 listings)
 *     GET /api/v3/PdpAvailabilityCalendar/<sha>
 *       (Apollo persisted-query GET; same key & UA story as v2)
 *     The legacy /api/v2/ endpoint silently returns
 *     `{"calendar_months":[]}` for these — Airbnb only exposes the new
 *     listings through the GraphQL surface their hydrated PDP uses.
 *     This is the same surface the deferred pricing work targets, so
 *     when prices are restored the response shape already carries
 *     them and we light up automatically.
 *
 * Therefore: this adapter populates `rental_prices_by_date` with
 *   {nightlyPriceUsd: null, availabilityStatus: "available"|"unavailable"}.
 * The comp model still benefits — owner-facing question "what % of
 * comparable Airbnb listings are booked for NYE 2026?" is answerable
 * from availability alone, even without nightly prices.
 *
 * Pure parser / single HTTP call. No I/O beyond `fetch`. No DB writes.
 *
 * The public web API key is embedded in https://www.airbnb.com/'s SSR
 * payload (`"api_config":{...,"key":"..."}`). It rotates rarely
 * (multi-year cadence — current value matches the one Airbnb shipped
 * publicly for years). We re-discover it on every adapter call so a
 * rotation is self-healing.
 *
 * The persisted-query SHA used for the v3 route is, by contrast,
 * pinned (no auto-rediscovery yet — see `GRAPHQL_PERSISTED_QUERY_SHA`
 * below). Rotation surfaces as a uniform `400 PersistedQueryNotFound`
 * per long-form listing, which the daily scrape's failure-rate guard
 * (`FAILURE_RATE_FAIL_THRESHOLD`) trips on so the rotation is
 * detected within one run rather than silently degrading coverage.
 * Refresh by snapshotting a fresh SHA off a hydrated PDP load.
 */

const PUBLIC_HOMEPAGE = "https://www.airbnb.com/";
const CALENDAR_BASE = "https://www.airbnb.com/api/v2/homes_pdp_availability_calendar";
const GRAPHQL_BASE = "https://www.airbnb.com/api/v3/PdpAvailabilityCalendar";

/**
 * Last-known-good Apollo persisted-query SHA for the
 * `PdpAvailabilityCalendar` GraphQL operation. Verified Oct 2026 against
 * both short- and long-form numeric IDs: returns 12 calendar months /
 * 365 days with `available`/`minNights`/`maxNights`. Same `price`
 * caveat as the v2 endpoint (`localPriceFormatted` is `null` over the
 * anonymous, no-proxy surface). Hash rotates rarely; if Airbnb rolls
 * it the v3 path returns `400 PersistedQueryNotFound` and the run
 * surfaces a uniform error per failing listing rather than corrupting
 * data — refresh by snapshotting the SHA from a fresh PDP load.
 */
const GRAPHQL_PERSISTED_QUERY_SHA =
  "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";

/**
 * Airbnb's pre-2022 numeric IDs are ≤ 10 digits and resolve on the
 * legacy v2 endpoint. Post-2022 ("long-form") IDs are 11+ digits and
 * only resolve on the v3 GraphQL surface. We dispatch by length; the
 * v2 endpoint silently returns an empty `calendar_months` array for
 * long-form IDs (status 200, body `{"calendar_months":[]}`), so length
 * is the only practical pre-flight signal.
 */
const LEGACY_ID_MAX_LENGTH = 10;

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

  // Long-form IDs (post-2022) only resolve on the v3 GraphQL surface; the
  // legacy v2 endpoint returns 200 / `{"calendar_months":[]}` for them.
  if (listingExternalId.length > LEGACY_ID_MAX_LENGTH) {
    return await fetchAirbnbCalendarV3(listingExternalId, {
      monthsCount,
      timeoutMs,
      apiKey: key,
      today,
    });
  }

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

interface RawV3Day {
  calendarDate?: string;
  available?: boolean;
  minNights?: number | null;
  maxNights?: number | null;
  price?: {
    localPriceFormatted?: string | number | null;
    [k: string]: unknown;
  } | null;
}

interface RawV3Response {
  data?: {
    merlin?: {
      pdpAvailabilityCalendar?: {
        calendarMonths?: Array<{ days?: RawV3Day[] }>;
      };
    };
  };
  errors?: Array<{ message?: string }>;
  error_code?: number;
  error_type?: string;
  error_message?: string;
}

/**
 * Fetch the next-12-months availability calendar via Airbnb's v3 GraphQL
 * `PdpAvailabilityCalendar` operation. Used for long-form numeric IDs
 * (post-2022 listings) which the legacy v2 endpoint cannot resolve, but
 * also accepts short-form IDs — the response shape is uniform regardless
 * of ID length.
 *
 * Anonymous (no proxy / no cookies) over the public web API key. Same
 * `price.localPriceFormatted = null` caveat as v2; lights up
 * automatically if Airbnb ever exposes prices on this surface.
 *
 * Idempotent and side-effect-free. Caller persists. All failures are
 * collected on `.errors` rather than thrown.
 */
export async function fetchAirbnbCalendarV3(
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
  const sha = GRAPHQL_PERSISTED_QUERY_SHA;

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
    `?operationName=PdpAvailabilityCalendar` +
    `&locale=en&currency=USD` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

  let raw: RawV3Response;
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
      raw = JSON.parse(text) as RawV3Response;
    } catch (e) {
      errors.push(`json parse: ${(e as Error).message.slice(0, 120)}`);
      return result;
    }
  } catch (e) {
    errors.push(`fetch error: ${(e as Error).message.slice(0, 120)}`);
    return result;
  }

  // Surface persisted-query rotation explicitly — the v3 surface returns
  // either a top-level `error_type` or a `data: null` + `errors[]` shape
  // depending on which Apollo gateway responds.
  if (raw.error_type || (Array.isArray(raw.errors) && raw.errors.length > 0)) {
    const msg =
      raw.error_message ||
      raw.errors?.map((e) => e.message).filter(Boolean).join("; ") ||
      raw.error_type ||
      "graphql error";
    errors.push(`graphql: ${String(msg).slice(0, 160)}`);
    return result;
  }

  const months = raw.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths ?? [];
  if (months.length === 0) {
    errors.push("no calendarMonths in response (listing likely delisted or unsupported)");
    return result;
  }

  for (const m of months) {
    const days = Array.isArray(m.days) ? m.days : [];
    for (const d of days) {
      if (!d || typeof d.calendarDate !== "string") continue;
      const status: AirbnbCalendarDay["availabilityStatus"] =
        d.available === true
          ? "available"
          : d.available === false
            ? "unavailable"
            : "unknown";
      const minNights =
        typeof d.minNights === "number" && Number.isFinite(d.minNights)
          ? d.minNights
          : null;
      // Same auto-fill rule as the v2 path: if Airbnb ever exposes a
      // numeric price on the anonymous surface we pick it up without a
      // schema or driver change.
      let priceUsd: number | null = null;
      const lpf = d.price?.localPriceFormatted;
      if (typeof lpf === "number" && Number.isFinite(lpf) && lpf > 0) {
        priceUsd = lpf;
      } else if (typeof lpf === "string") {
        const numeric = parseFloat(lpf.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(numeric) && numeric > 0) priceUsd = numeric;
      }
      result.days.push({
        date: d.calendarDate,
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
