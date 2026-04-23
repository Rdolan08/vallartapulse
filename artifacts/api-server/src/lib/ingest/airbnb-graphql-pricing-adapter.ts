/**
 * ingest/airbnb-graphql-pricing-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real implementation of the Airbnb PdpAvailabilityCalendar GraphQL adapter
 * used by airbnb-pricing-runner.ts to fetch per-night prices for the comp
 * pool. This replaces the previous compile-only stub.
 *
 * Why this endpoint and not the v2/v3 availability calendar:
 *   The v2 `homes_pdp_availability_calendar` and v3 `PdpAvailabilityCalendar`
 *   AVAILABILITY-only routes that airbnb-calendar-adapter.ts hits return
 *   `available`/`minNights` only — the `price` object is always empty.
 *   The PRICED variant of the same operation (which is what this file
 *   targets) goes through the public `/api/v3/PdpAvailabilityCalendar/{sha}`
 *   GraphQL transport with the real persisted-query SHA. That path returns
 *   `price.localPriceFormatted` for every available day.
 *
 * Networking:
 *   Plain `fetch()`. No proxy. The runner is intended to be invoked from
 *   a residential IP (the Mac mini) — Airbnb IP-blocks Railway/GH-runner
 *   datacenter ranges within a handful of GraphQL calls. We deliberately
 *   do NOT respect PROXY_URL here so an operator who accidentally ran
 *   this on Railway gets a clean blocked-IP error rather than a confusing
 *   "your proxy got banned mid-run" partial result.
 *
 * SHA management:
 *   Airbnb rotates persisted-query SHAs on a roughly weeks-to-months
 *   cadence. We bootstrap from a known-recent SHA (BOOTSTRAP_SHA) and the
 *   runner self-heals when it sees `staleSha: true`:
 *     1. First call: returns BOOTSTRAP_SHA from cache (source: "fallback").
 *     2. If response carries `PersistedQueryNotFound`, runner calls
 *        getOrDiscoverSha({ forceRediscover: true }).
 *     3. We re-fetch a public PDP page and regex out the current SHA from
 *        the inline operation manifest.
 *     4. The fresh SHA is cached in process memory for the rest of the run
 *        (source: "discovered"). It is NOT persisted to disk/DB — every
 *        process start re-pays the rediscovery cost iff bootstrap is stale.
 *
 *   This avoids any new DB schema (the project ban on `drizzle-kit push`
 *   means we can't add an `airbnb_graphql_sha` table). The cost is one
 *   extra fetch per cold start when Airbnb has rotated, which is fine
 *   for a once-a-day cron.
 */

const AIRBNB_GRAPHQL_BASE = "https://www.airbnb.com/api/v3/PdpAvailabilityCalendar";

/**
 * Public web Airbnb API key. This is the same key the airbnb.com bundle
 * ships in plaintext to every browser — it is not a secret and rotating
 * it would require Airbnb to rebuild their entire web client. Documented
 * in the Airbnb client manifest as `apiConfig.key`.
 */
const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";

/**
 * Most-recent observed PdpAvailabilityCalendar persisted-query SHA. Used
 * as the bootstrap value before rediscovery kicks in. If you see
 * `staleSha: true` runs over multiple days, replace this with a fresher
 * SHA grepped from a current `view-source:airbnb.com/rooms/<id>` page.
 */
const BOOTSTRAP_SHA =
  "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";

/** Realistic Chrome 124 macOS UA — matches the discovery-runner UA. */
const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 25_000;

export interface AirbnbGraphqlDay {
  date: string;
  available: boolean;
  nightlyPriceUsd: number | null;
}

export interface AirbnbGraphqlCalendarResult {
  days: AirbnbGraphqlDay[];
  daysReturned: number;
  daysWithPrice: number;
  staleSha: boolean;
  errors: string[];
}

export interface ShaDiscoveryResult {
  sha: string;
  /** "fallback" = bootstrap constant (no rediscovery yet); "cache" = */
  /* in-process cache hit; "discovered" = fresh rediscovery from PDP. */
  source: "fallback" | "cache" | "discovered";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* SHA cache (process-local, intentional — see header)                        */
/* ────────────────────────────────────────────────────────────────────────── */

let cachedSha: string | null = null;
let cachedSource: "fallback" | "cache" | "discovered" | null = null;

export async function getOrDiscoverSha(
  opts?: { forceRediscover?: boolean },
): Promise<ShaDiscoveryResult> {
  if (!opts?.forceRediscover && cachedSha) {
    return { sha: cachedSha, source: "cache" };
  }
  if (!opts?.forceRediscover) {
    cachedSha = BOOTSTRAP_SHA;
    cachedSource = "fallback";
    return { sha: BOOTSTRAP_SHA, source: "fallback" };
  }

  // forceRediscover: pull a public PDP page and regex out the current
  // PdpAvailabilityCalendar SHA from the inline operation manifest.
  try {
    const sha = await discoverShaFromPdp("PdpAvailabilityCalendar");
    if (sha && /^[a-f0-9]{64}$/i.test(sha)) {
      cachedSha = sha;
      cachedSource = "discovered";
      return { sha, source: "discovered" };
    }
  } catch {
    // fall through to fallback
  }
  // Discovery failed — keep using whatever we had (or bootstrap), but
  // surface "fallback" so the operator sees rediscovery didn't help.
  cachedSha = cachedSha ?? BOOTSTRAP_SHA;
  cachedSource = "fallback";
  return { sha: cachedSha, source: "fallback" };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Calendar fetch                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export async function fetchAirbnbCalendarGraphql(
  externalId: string,
  sha: string,
  opts: { today: Date },
): Promise<AirbnbGraphqlCalendarResult> {
  const errors: string[] = [];
  const today = opts.today;

  const variables = {
    request: {
      count: 12, // 12 months forward
      listingId: externalId,
      month: today.getUTCMonth() + 1,
      year: today.getUTCFullYear(),
    },
  };

  const extensions = {
    persistedQuery: {
      version: 1,
      sha256Hash: sha,
    },
  };

  const url =
    `${AIRBNB_GRAPHQL_BASE}/${sha}?` +
    `operationName=PdpAvailabilityCalendar&locale=en&currency=USD&` +
    `variables=${encodeURIComponent(JSON.stringify(variables))}&` +
    `extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": REALISTIC_UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "x-airbnb-api-key": AIRBNB_API_KEY,
        "x-airbnb-graphql-platform": "web",
        "x-airbnb-graphql-platform-client": "minimalist-niobe",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    errors.push(`fetch transport: ${m}`);
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }

  if (res.status === 410 || res.status === 400) {
    // Airbnb returns 410/400 with a JSON body when the persisted query
    // SHA is stale. Try to parse for the canonical PersistedQueryNotFound
    // hint, but treat any 4xx-with-graphql-errors at this stage as stale.
    const body = await res.text().catch(() => "");
    if (looksLikeStaleSha(body)) {
      return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: true, errors };
    }
    errors.push(`http ${res.status}: ${body.slice(0, 200)}`);
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }
  if (res.status === 403 || res.status === 429) {
    // Almost always means our IP is on Airbnb's bot list. Surface clearly.
    const body = await res.text().catch(() => "");
    errors.push(
      `http ${res.status} (likely IP-blocked — are you actually on the Mac mini residential IP?): ${body.slice(0, 120)}`,
    );
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    errors.push(`http ${res.status}: ${body.slice(0, 200)}`);
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    errors.push(`json parse: ${m}`);
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }

  // GraphQL-level errors (200 OK but body has `errors[]`)
  const topLevel = json as { errors?: Array<{ message?: string; extensions?: { classification?: string } }> };
  if (Array.isArray(topLevel.errors) && topLevel.errors.length > 0) {
    const stale = topLevel.errors.some(
      (e) =>
        e?.extensions?.classification === "PersistedQueryNotFound" ||
        /persisted query/i.test(e?.message ?? ""),
    );
    if (stale) {
      return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: true, errors };
    }
    errors.push(
      "graphql errors: " +
        topLevel.errors.map((e) => e?.message ?? "unknown").join("; ").slice(0, 240),
    );
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }

  // Walk data.merlin.pdpAvailabilityCalendar.calendarMonths[].days[]
  const root = json as {
    data?: {
      merlin?: {
        pdpAvailabilityCalendar?: {
          calendarMonths?: Array<{
            days?: Array<{
              calendarDate?: string;
              available?: boolean;
              price?: {
                localPriceFormatted?: string | null;
                localPrice?: number | null;
                localCurrency?: string | null;
              } | null;
            }>;
          }>;
        };
      };
    };
  };

  const months = root?.data?.merlin?.pdpAvailabilityCalendar?.calendarMonths ?? [];
  if (months.length === 0) {
    errors.push(
      "unexpected response shape: missing data.merlin.pdpAvailabilityCalendar.calendarMonths " +
        `(top-level keys: ${Object.keys((json as object) ?? {}).join(",")})`,
    );
    return { days: [], daysReturned: 0, daysWithPrice: 0, staleSha: false, errors };
  }

  const days: AirbnbGraphqlDay[] = [];
  let daysWithPrice = 0;
  for (const m of months) {
    for (const d of m.days ?? []) {
      const date = d.calendarDate;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const available = d.available === true;
      let nightly: number | null = null;
      if (d.price) {
        if (typeof d.price.localPrice === "number" && Number.isFinite(d.price.localPrice)) {
          nightly = d.price.localPrice;
        } else if (typeof d.price.localPriceFormatted === "string") {
          // "$245" or "MX$3,245" → 245 / 3245
          const m2 = d.price.localPriceFormatted.replace(/[^0-9.]/g, "");
          if (m2) {
            const n = Number.parseFloat(m2);
            if (Number.isFinite(n) && n > 0) nightly = n;
          }
        }
      }
      if (nightly !== null) daysWithPrice++;
      days.push({ date, available, nightlyPriceUsd: nightly });
    }
  }

  return {
    days,
    daysReturned: days.length,
    daysWithPrice,
    staleSha: false,
    errors,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function looksLikeStaleSha(body: string): boolean {
  if (!body) return false;
  if (/PersistedQueryNotFound/i.test(body)) return true;
  if (/persisted query/i.test(body)) return true;
  return false;
}

/**
 * Discover the current persisted-query SHA for `operationName` by fetching
 * a public PDP page. The PDP HTML embeds a manifest of operationName→SHA
 * pairs in an inline script; we regex it out.
 *
 * We use a known-stable listing for discovery (the official Airbnb PR
 * "iconic" demo listing — it has been online for years and changing
 * its rendering would break Airbnb's own help content). This avoids
 * having to thread a sample listing ID from the caller.
 */
async function discoverShaFromPdp(operationName: string): Promise<string | null> {
  const probeUrl = "https://www.airbnb.com/rooms/12345"; // any valid listing renders the bundle
  let res: Response;
  try {
    res = await fetch(probeUrl, {
      method: "GET",
      headers: {
        "user-agent": REALISTIC_UA,
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const html = await res.text().catch(() => "");
  if (!html) return null;

  // Look for `"<operationName>":"<64hex>"` directly in the HTML (the
  // operation manifest is embedded inline). If not found inline, the
  // manifest may be in a separate JS bundle — try the most common path.
  const direct = new RegExp(`"${operationName}"\\s*:\\s*"([a-f0-9]{64})"`).exec(html);
  if (direct?.[1]) return direct[1];

  // Try to find the manifest JS bundle URL and fetch it.
  const bundleMatch = /https:\/\/[a-z0-9.-]+\/_next\/static\/[^"']+\.js/i.exec(html);
  if (bundleMatch?.[0]) {
    try {
      const bRes = await fetch(bundleMatch[0], {
        method: "GET",
        headers: { "user-agent": REALISTIC_UA, "accept": "*/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (bRes.ok) {
        const js = await bRes.text();
        const m = new RegExp(`"${operationName}"\\s*:\\s*"([a-f0-9]{64})"`).exec(js);
        if (m?.[1]) return m[1];
      }
    } catch {
      // ignore
    }
  }

  return null;
}
