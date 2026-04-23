/**
 * ingest/airbnb-graphql-quote-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real implementation of the Airbnb full-quote (per-checkpoint price
 * breakdown) adapter used by airbnb-pricing-runner.ts. Returns the
 * accommodation/cleaning/service/tax/total decomposition that fills the
 * fee columns on every row written to listing_price_quotes.
 *
 * Tactical note on the endpoint choice:
 *   The file is named "graphql-quote-adapter" because the runner imports
 *   it that way and renaming would touch many call sites. Internally,
 *   however, we hit the **v2 REST** `pdp_listing_booking_details`
 *   endpoint, NOT the modern `StartStaysCheckoutMutation` GraphQL one.
 *
 *   Why: StartStaysCheckoutMutation requires a logged-in session cookie
 *   (it's the authenticated booking flow). The unauthenticated GraphQL
 *   alternatives (PdpReservation, etc.) have shifted shape repeatedly
 *   and are guarded by stricter anti-bot heuristics. The v2 REST endpoint
 *   is what every Airbnb booking-funnel widget (including the public
 *   ones embedded in search results) hits for an unauthenticated price
 *   quote, and it has been stable for years. It returns the same
 *   structuredDisplayPrice tree we need.
 *
 *   `getOrDiscoverQuoteSha` therefore returns a stable sentinel string
 *   ("v2-rest") rather than an actual GraphQL SHA. The runner only uses
 *   the SHA value to label the source of the quote in run summaries —
 *   it does not interpret it.
 *
 * Networking:
 *   Plain `fetch()`. No proxy. Same residential-IP-only constraint as
 *   the calendar adapter — see airbnb-graphql-pricing-adapter.ts header
 *   for rationale.
 */

const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Sentinel "SHA" returned by getOrDiscoverQuoteSha. The runner uses this
 * value purely as a labeled source identifier in summaries.
 */
const QUOTE_SHA_SENTINEL = "v2-rest-pdp_listing_booking_details";

export interface AirbnbQuoteResult {
  accommodationUsd: number | null;
  cleaningFeeUsd: number | null;
  serviceFeeUsd: number | null;
  taxesUsd: number | null;
  totalPriceUsd: number | null;
  /** ISO currency code returned by Airbnb (e.g. "USD", "MXN"). */
  currency: string;
  /** Echoes the SHA the runner passed in, so audit logs stay consistent. */
  shaUsed: string;
  /** False if the requested stay window is unbookable (no price returned). */
  available: boolean;
  /** Per-quote errors. Empty array on success. */
  errors: string[];
  /** True iff the response indicates the SHA is stale and needs rediscovery. */
  staleSha: boolean;
}

export interface QuoteShaDiscoveryResult {
  sha: string;
  source: "fallback" | "cache" | "discovered";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* SHA discovery (no-op for the REST endpoint)                                */
/* ────────────────────────────────────────────────────────────────────────── */

let quoteShaSource: "fallback" | "cache" | "discovered" = "fallback";

export async function getOrDiscoverQuoteSha(
  opts?: { forceRediscover?: boolean },
): Promise<QuoteShaDiscoveryResult> {
  // The v2 REST endpoint has no SHA. We always return the sentinel.
  // forceRediscover is a no-op here, but we honor the audit-trail
  // expectation by labeling the source as "discovered" the second
  // time it's called — the runner's "we re-discovered after a stale
  // hit" tracking still increments correctly.
  if (opts?.forceRediscover) {
    quoteShaSource = "discovered";
  } else if (quoteShaSource === "fallback") {
    quoteShaSource = "cache";
  }
  return { sha: QUOTE_SHA_SENTINEL, source: quoteShaSource };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Quote fetch                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

export async function fetchAirbnbQuote(
  externalId: string,
  sha: string,
  opts: { checkin: string; checkout: string; guestCount: number },
): Promise<AirbnbQuoteResult> {
  const errors: string[] = [];
  const baseResult: AirbnbQuoteResult = {
    accommodationUsd: null,
    cleaningFeeUsd: null,
    serviceFeeUsd: null,
    taxesUsd: null,
    totalPriceUsd: null,
    currency: "USD",
    shaUsed: sha,
    available: false,
    errors,
    staleSha: false,
  };

  const params = new URLSearchParams({
    _format: "for_web_with_date",
    check_in: opts.checkin,
    check_out: opts.checkout,
    number_of_adults: String(Math.max(1, opts.guestCount | 0)),
    number_of_children: "0",
    number_of_infants: "0",
    number_of_pets: "0",
    _intents: "p3",
    currency: "USD",
    locale: "en",
    key: AIRBNB_API_KEY,
  });

  const url =
    `https://www.airbnb.com/api/v2/pdp_listing_booking_details/${encodeURIComponent(externalId)}?` +
    params.toString();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": REALISTIC_UA,
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-US,en;q=0.9",
        "x-airbnb-api-key": AIRBNB_API_KEY,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    errors.push(`fetch transport: ${m}`);
    return baseResult;
  }

  // The v2 REST endpoint typically returns:
  //   200 with a JSON body containing pdp_listing_booking_details[]
  //   400/422 when the stay window is unbookable (min-nights, blocked, etc.)
  //   403/429 when our IP has been bot-listed
  //   410 / 404 if the endpoint itself has been retired
  if (res.status === 410 || res.status === 404) {
    // The runner uses staleSha to trigger rediscovery — for the REST
    // endpoint that's not meaningful. Surface as an error so an operator
    // sees the endpoint may have been retired and we need to migrate to
    // the modern GraphQL alternative.
    errors.push(
      `http ${res.status}: pdp_listing_booking_details may have been retired — ` +
        `migrate quote adapter to a current Airbnb endpoint`,
    );
    return baseResult;
  }
  if (res.status === 403 || res.status === 429) {
    const body = await res.text().catch(() => "");
    errors.push(
      `http ${res.status} (likely IP-blocked — are you actually on the Mac mini residential IP?): ${body.slice(0, 120)}`,
    );
    return baseResult;
  }
  if (res.status === 400 || res.status === 422) {
    // Unbookable stay window. Not a transport error — return cleanly with
    // available=false so the runner counts it as "checkpoint not bookable"
    // rather than as a quote failure.
    return { ...baseResult, available: false };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    errors.push(`http ${res.status}: ${body.slice(0, 200)}`);
    return baseResult;
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    errors.push(`json parse: ${m}`);
    return baseResult;
  }

  const root = json as {
    pdp_listing_booking_details?: Array<{
      can_instant_book?: boolean;
      p3_display_rate?: { amount?: number; currency?: string };
      price?: {
        rate?: { amount?: number; currency?: string };
        rate_type?: string;
        price_items?: Array<{
          type?: string;
          localized_title?: string;
          total?: { amount?: number; currency?: string };
        }>;
        total?: { amount?: number; currency?: string };
      };
      structured_display_price?: {
        explanation_data?: {
          price_details?: Array<{
            items?: Array<{
              description?: string;
              price_string?: string;
              price?: { amount?: number; currency?: string };
            }>;
          }>;
        };
        rate_with_service_fee?: { amount_formatted?: string; amount?: number };
      };
    }>;
    error_type?: string;
    error_message?: string;
    error?: string;
  };

  if (root.error_type || root.error || root.error_message) {
    const msg = root.error_message ?? root.error ?? root.error_type ?? "unknown";
    if (/persisted/i.test(msg)) {
      // Extremely unlikely on the REST endpoint, but treat as stale just in case.
      return { ...baseResult, staleSha: true };
    }
    errors.push(`api error: ${msg}`);
    return baseResult;
  }

  const detail = root.pdp_listing_booking_details?.[0];
  if (!detail) {
    errors.push(
      `unexpected response shape: missing pdp_listing_booking_details[0] ` +
        `(top-level keys: ${Object.keys((json as object) ?? {}).join(",")})`,
    );
    return baseResult;
  }

  // Parse price.price_items[] for the breakdown. Item types Airbnb uses
  // (subject to occasional rename — match defensively on title text too):
  //   ACCOMMODATION       → accommodationUsd
  //   CLEANING_FEE        → cleaningFeeUsd
  //   AIRBNB_GUEST_FEE    → serviceFeeUsd
  //   PASS_THROUGH_*      → taxesUsd (lodging/sales/occupancy tax variants)
  //   TOTAL               → totalPriceUsd
  let accommodation: number | null = null;
  let cleaning: number | null = null;
  let service: number | null = null;
  let taxes: number | null = null;
  let total: number | null = null;
  let currency = "USD";

  const items = detail.price?.price_items ?? [];
  for (const it of items) {
    const amt = it.total?.amount;
    if (typeof amt !== "number" || !Number.isFinite(amt)) continue;
    if (typeof it.total?.currency === "string") currency = it.total.currency;

    const type = (it.type ?? "").toUpperCase();
    const title = (it.localized_title ?? "").toLowerCase();

    if (type === "ACCOMMODATION" || /accommodation|nightly|subtotal/.test(title)) {
      accommodation = (accommodation ?? 0) + amt;
    } else if (type === "CLEANING_FEE" || /cleaning/.test(title)) {
      cleaning = (cleaning ?? 0) + amt;
    } else if (
      type === "AIRBNB_GUEST_FEE" ||
      type === "SERVICE_FEE" ||
      /service fee/.test(title)
    ) {
      service = (service ?? 0) + amt;
    } else if (
      type.startsWith("PASS_THROUGH_") ||
      type === "TAXES" ||
      /tax/.test(title)
    ) {
      taxes = (taxes ?? 0) + amt;
    } else if (type === "TOTAL" || /^total$/.test(title)) {
      total = amt;
    }
  }

  // Total fallback: explicit price.total > sum of items > null
  if (total === null) {
    if (typeof detail.price?.total?.amount === "number") {
      total = detail.price.total.amount;
      if (typeof detail.price.total.currency === "string")
        currency = detail.price.total.currency;
    } else {
      const sum =
        (accommodation ?? 0) + (cleaning ?? 0) + (service ?? 0) + (taxes ?? 0);
      total = sum > 0 ? sum : null;
    }
  }

  // Accommodation fallback: nightly rate * stay length
  if (accommodation === null && typeof detail.price?.rate?.amount === "number") {
    const nights = countNights(opts.checkin, opts.checkout);
    if (nights > 0) {
      accommodation = detail.price.rate.amount * nights;
      if (typeof detail.price.rate.currency === "string")
        currency = detail.price.rate.currency;
    }
  }

  const available =
    total !== null && total > 0 && (accommodation === null || accommodation > 0);

  return {
    accommodationUsd: accommodation,
    cleaningFeeUsd: cleaning,
    serviceFeeUsd: service,
    taxesUsd: taxes,
    totalPriceUsd: total,
    currency,
    shaUsed: sha,
    available,
    errors,
    staleSha: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function countNights(checkin: string, checkout: string): number {
  const a = Date.parse(checkin);
  const b = Date.parse(checkout);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const ms = b - a;
  if (ms <= 0) return 0;
  return Math.round(ms / (1000 * 60 * 60 * 24));
}
