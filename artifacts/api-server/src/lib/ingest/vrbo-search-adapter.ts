/**
 * ingest/vrbo-search-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovers VRBO listing URLs from Puerto Vallarta search results pages.
 * VRBO serves full HTML from datacenter IPs when correct browser headers
 * are provided — no residential proxy required.
 *
 * Strategy:
 *  1. Fetch each PV search page (multiple pages supported).
 *  2. Extract listing IDs from href="/XXXXXXX" and href="/XXXXXXha" patterns.
 *  3. Return deduplicated listing URLs ready for fetchVrboListing().
 */

import { fetchWithBrowser } from "./browser-fetch.js";

// ── HTTP helper ───────────────────────────────────────────────────────────────

// VRBO's PerimeterX/HUMAN bot challenge ("Bot or Not?") returns HTTP 429 to
// raw HTTP fetches — including those through residential proxies — because
// the TLS/HTTP2 fingerprint and missing JS execution give them away. A real
// Chromium instance (browser-fetch.ts) presents an authentic fingerprint,
// executes the client-side JS, and returns the fully-rendered search page.
// PROXY_URL (Decodo residential) is plumbed in at the browser level by
// browser-fetch when the env var is set.
async function get(url: string): Promise<string> {
  // Wait for the listing-card area to render. VRBO uses a couple of selectors
  // depending on A/B variant — race them so we return as soon as anything
  // listing-shaped appears, but fall back to whatever HTML is loaded if
  // neither selector ever fires.
  return fetchWithBrowser(url, {
    timeoutMs: 30_000,
    waitForSelector: '[data-stid="property-listing"], a[href*="/12"], a[href^="/"][href*="ha"]',
    fallbackOnTimeout: true,
  });
}

// ── Listing ID extraction ─────────────────────────────────────────────────────

function extractListingIds(html: string): string[] {
  const ids = new Set<string>();
  let m: RegExpExecArray | null;

  // Modern VRBO uses /en-us/p1234567 or /p1234567ha for listing detail links.
  // Older HomeAway-era markup uses /1234567ha. Cover all observed shapes.
  // Match either href= or data-target=/data-href= attributes.
  const linkPattern =
    /(?:href|data-(?:target|href))="(?:https?:\/\/(?:www\.)?(?:vrbo|homeaway)\.com)?(?:\/[a-z]{2}-[a-z]{2})?\/p?(\d{6,9})(ha)?(?:[?"/#]|$)/gi;
  while ((m = linkPattern.exec(html)) !== null) {
    ids.add(m[1] + (m[2] ?? ""));
  }

  // Embedded JSON: "listingId":"1234567", "propertyId":"1234567",
  // "unitId":"1234567", "uuid":"1234567" — covers Next.js __NEXT_DATA__
  // and Apollo cache shapes used by VRBO today.
  const jsonPattern = /"(?:listingId|propertyId|unitId|listing_id|property_id)"\s*:\s*"?(\d{6,9})"?/g;
  while ((m = jsonPattern.exec(html)) !== null) {
    ids.add(m[1]);
  }

  return Array.from(ids);
}

/**
 * For debugging when discovery yields zero IDs: scrape the first ~10 unique
 * href values from the HTML so we can see what shape modern VRBO is using.
 * Truncated to keep log output sane.
 */
export function sampleHrefs(html: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /href="([^"]{1,160})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < limit) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    // Filter out obvious non-listing chrome (css, js, footer links, etc.)
    if (/\.(css|js|svg|png|jpg|woff)/i.test(href)) continue;
    if (/^(mailto:|tel:|#|javascript:)/i.test(href)) continue;
    out.push(href);
  }
  return out;
}

// ── Search URLs for Puerto Vallarta ───────────────────────────────────────────

const PV_SEARCH_URLS = [
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?page=2",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?page=3",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?page=4",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta/beachfront",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?sleeps=2",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?sleeps=4",
  "https://www.vrbo.com/vacation-rentals/mexico/jalisco/puerto-vallarta?sleeps=6",
];

export interface VrboDiscoveryResult {
  listingUrls: string[];
  pagesScraped: number;
  errors: string[];
  /** Sample hrefs from the first page when zero IDs were extracted — debug aid. */
  debugFirstPageHrefs?: string[];
}

export async function discoverVrboListings(opts?: {
  maxPages?: number;
  delayMs?: number;
}): Promise<VrboDiscoveryResult> {
  const maxPages = opts?.maxPages ?? PV_SEARCH_URLS.length;
  const delayMs = opts?.delayMs ?? 1500;
  const allIds = new Set<string>();
  const errors: string[] = [];
  let pagesScraped = 0;
  let firstHtml: string | null = null;

  const urls = PV_SEARCH_URLS.slice(0, maxPages);

  for (const searchUrl of urls) {
    try {
      const html = await get(searchUrl);
      if (firstHtml === null) firstHtml = html;
      const ids = extractListingIds(html);
      ids.forEach(id => allIds.add(id));
      pagesScraped++;
    } catch (err) {
      errors.push(`${searchUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  const listingUrls = Array.from(allIds).map(id => `https://www.vrbo.com/${id}`);
  const result: VrboDiscoveryResult = { listingUrls, pagesScraped, errors };
  if (allIds.size === 0 && firstHtml) {
    result.debugFirstPageHrefs = sampleHrefs(firstHtml);
  }
  return result;
}
