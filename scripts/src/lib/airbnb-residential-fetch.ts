/**
 * scripts/src/lib/airbnb-residential-fetch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proxy-free HTTP transport for the residential discovery runner.
 *
 * Why this exists separate from artifacts/api-server/.../raw-fetch.ts:
 *
 *   The brief explicitly forbids datacenter fallback and proxy use for the
 *   home-residential discovery runner: "ignore PROXY_URL entirely and use
 *   the residential Mac mini IP only." raw-fetch.ts hard-throws if
 *   PROXY_URL is unset and cannot be reused under that constraint.
 *
 *   Same UA + headers + timeout contract as raw-fetch.ts so behavior is
 *   directly comparable, just without the ProxyAgent dispatcher. We also
 *   ignore PROXY_URL even if present in the environment — the residential
 *   runner must NEVER accidentally route through a datacenter proxy.
 *
 *   Uses Node's built-in fetch (Node 20+) deliberately so the script doesn't
 *   pull in undici as a script-level dependency just to bypass it.
 */

/**
 * Realistic Chrome 124 macOS UA — kept identical to raw-fetch.ts so the two
 * transports produce comparable Airbnb responses for the same listing.
 */
const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function defaultHeaders(): Record<string, string> {
  return {
    "user-agent": REALISTIC_UA,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
    "sec-ch-ua":
      '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
  };
}

export interface ResidentialFetchOpts {
  /** Per-request timeout (ms). Default 25s. */
  timeoutMs?: number;
}

export interface ResidentialFetchResult {
  url: string;
  status: number;
  bytes: number;
  ms: number;
  html: string;
  /** Final URL after redirects. */
  finalUrl: string;
}

/**
 * Single-shot direct HTTP fetch from the host's residential IP. Throws on
 * transport / timeout errors. Non-2xx responses are returned (not thrown)
 * so callers can inspect the body. PROXY_URL is intentionally ignored.
 */
export async function fetchAirbnbResidential(
  url: string,
  opts: ResidentialFetchOpts = {}
): Promise<ResidentialFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const t0 = Date.now();
  // Use Node's built-in fetch — no proxy dispatcher, no PROXY_URL respect,
  // ever. The host's residential IP is the only network identity used.
  const res = await fetch(url, {
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
 * "Should we treat this response as unusable?" predicate. Mirrors the
 * shape and intent of rawFetchLooksUnusable in raw-fetch.ts so the
 * runner's gating logic is unchanged regardless of which transport
 * actually served the request.
 */
export function residentialFetchLooksUnusable(
  html: string,
  status: number
): { unusable: boolean; reason?: string } {
  if (status < 200 || status >= 300) {
    return { unusable: true, reason: `http ${status}` };
  }
  if (html.length <= 6_000) {
    if (
      html.includes("helpful_404.html.erb") ||
      html.includes("404 Page Not Found - Airbnb") ||
      /<title>\s*404\b/i.test(html)
    ) {
      return { unusable: false, reason: "delisted (residential would return same)" };
    }
    return {
      unusable: true,
      reason: `short body ${html.length}b (not delisted-shaped)`,
    };
  }
  const lower = html.toLowerCase();
  if (
    lower.includes("px-captcha") ||
    lower.includes("perimeterx") ||
    lower.includes("/distil_r_") ||
    lower.includes("access denied") ||
    lower.includes("are you a human") ||
    lower.includes("blocked by the airbnb") ||
    lower.includes("pardon our interruption") ||
    lower.includes("/forbidden")
  ) {
    return { unusable: true, reason: "captcha / bot-wall markers" };
  }
  return { unusable: false };
}
