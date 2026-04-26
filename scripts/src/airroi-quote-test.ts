/**
 * scripts/src/airroi-quote-test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DB-free single-listing tester for AirROI's /listings/future/rates endpoint.
 * Calls the public REST API directly to validate, in one shot:
 *
 *   - auth: AIRROI_API_KEY round-trips OK
 *   - response shape: date / available / rate / min_nights as documented
 *   - data quality: numeric ranges, date span, % of days with rate / available
 *   - quota / rate limits: surfaces every X-* and RateLimit-* response header
 *   - cost signal: response size + AirROI's own usage headers if they expose them
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run airroi:test -- <externalId> [currency=usd]
 *
 * Examples:
 *   # MarshmallowTown (our known-good test listing), USD
 *   pnpm --filter @workspace/scripts run airroi:test -- 53116610
 *
 *   # Same listing, MXN — useful sanity check that currency arg works
 *   pnpm --filter @workspace/scripts run airroi:test -- 53116610 mxn
 *
 * Output: structured JSON with summary stats and first/last 5 rate rows
 * for eyeball spot-check against Airbnb's actual page.
 *
 * Returns:
 *   0 = HTTP 200 with non-empty rates[]
 *   1 = setup error (missing key, network failure)
 *   2 = HTTP error or empty response
 */

const ENDPOINT = "https://api.airroi.com/listings/future/rates";
const DEFAULT_LISTING = "53116610";

interface AirroiRate {
  date: string;
  available: boolean;
  rate: number | null;
  min_nights: number | null;
}

interface AirroiResponse {
  currency?: string;
  rates?: AirroiRate[];
  [k: string]: unknown;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function main(): Promise<number> {
  const apiKey = process.env.AIRROI_API_KEY;
  if (!apiKey) {
    console.error("ERROR: AIRROI_API_KEY env var not set. Add it to .env on the mini.");
    return 1;
  }

  const [externalId = DEFAULT_LISTING, currency = "usd"] = process.argv.slice(2);
  const url = `${ENDPOINT}?id=${encodeURIComponent(externalId)}&currency=${encodeURIComponent(currency)}`;

  console.log(
    JSON.stringify({
      event: "airroi-test.start",
      externalId,
      currency,
      url,
      ts: new Date().toISOString(),
    }),
  );

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-api-key": apiKey } });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "airroi-test.network-error",
        message: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - t0,
      }),
    );
    return 1;
  }
  const elapsedMs = Date.now() - t0;

  // Surface every header we might care about — quota, rate-limit, content
  const headerSummary: Record<string, string> = {};
  for (const [k, v] of res.headers.entries()) {
    if (/^(x-|ratelimit|content-length|content-type|date|retry-after)/i.test(k)) {
      headerSummary[k] = v;
    }
  }

  const bodyText = await res.text();
  let body: AirroiResponse | null = null;
  try {
    body = JSON.parse(bodyText) as AirroiResponse;
  } catch {
    // leave body=null — we'll surface raw text on the error path
  }

  if (!res.ok || !body) {
    console.error(
      JSON.stringify(
        {
          event: "airroi-test.http-error",
          status: res.status,
          statusText: res.statusText,
          elapsedMs,
          headers: headerSummary,
          bodyPreview: bodyText.slice(0, 1500),
        },
        null,
        2,
      ),
    );
    return 2;
  }

  const rates = Array.isArray(body.rates) ? body.rates : [];
  const available = rates.filter((r) => r.available);
  const withRate = rates.filter((r) => r.rate !== null && r.rate !== undefined);
  const rateValues = withRate.map((r) => r.rate as number);
  const dates = rates.map((r) => r.date).sort();

  console.log(
    JSON.stringify(
      {
        event: "airroi-test.done",
        elapsedMs,
        status: res.status,
        responseBytes: bodyText.length,
        headers: headerSummary,
        summary: {
          currency: body.currency ?? null,
          totalDays: rates.length,
          availableDays: available.length,
          daysWithPrice: withRate.length,
          coveragePct: rates.length > 0 ? Math.round((withRate.length / rates.length) * 100) : 0,
          dateRange:
            dates.length > 0 ? { first: dates[0], last: dates[dates.length - 1] } : null,
          rateStats:
            rateValues.length > 0
              ? {
                  min: Math.min(...rateValues),
                  max: Math.max(...rateValues),
                  median: median(rateValues),
                }
              : null,
        },
        firstFive: rates.slice(0, 5),
        lastFive: rates.slice(-5),
        extraFields: Object.keys(body).filter((k) => k !== "rates" && k !== "currency"),
      },
      null,
      2,
    ),
  );

  return rates.length > 0 ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
