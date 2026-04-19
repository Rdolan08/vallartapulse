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

import { fetch as undiciFetch, ProxyAgent } from "undici";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// ── HTTP helper ───────────────────────────────────────────────────────────────

// Routes through PROXY_URL (Decodo residential) when set — VRBO returns a
// "Bot or Not?" 429 challenge to datacenter IPs (Railway, GitHub Actions),
// so direct fetches yield zero listings. Falls back to direct fetch when
// PROXY_URL is unset (local dev). Uses undici for native gzip/brotli
// decompression and automatic redirect following.
async function get(url: string): Promise<string> {
  const proxyUrl = process.env.PROXY_URL;
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await undiciFetch(url, {
      method: "GET",
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });

    if (res.status === 403 || res.status === 429) {
      throw new Error(`HTTP ${res.status} (rate-limited)`);
    }
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

// ── Listing ID extraction ─────────────────────────────────────────────────────

function extractListingIds(html: string): string[] {
  const ids = new Set<string>();

  // Pattern 1: href="/1234567" or href="/1234567ha" (listing detail links)
  const hrefPattern = /href="\/(\d{5,9})(ha)?(?:[?"/]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = hrefPattern.exec(html)) !== null) {
    ids.add(m[1] + (m[2] ?? ""));
  }

  // Pattern 2: embedded JSON "listingId":"1234567" or "propertyId":"1234567"
  const jsonPattern = /"(?:listingId|propertyId|unitId)"\s*:\s*"?(\d{5,9})"?/g;
  while ((m = jsonPattern.exec(html)) !== null) {
    ids.add(m[1]);
  }

  // Pattern 3: data-target="/1234567" or data-href="/1234567"
  const dataPattern = /data-(?:target|href)="\/(\d{5,9})(ha)?(?:[?"/]|$)/g;
  while ((m = dataPattern.exec(html)) !== null) {
    ids.add(m[1] + (m[2] ?? ""));
  }

  return Array.from(ids);
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

  const urls = PV_SEARCH_URLS.slice(0, maxPages);

  for (const searchUrl of urls) {
    try {
      const html = await get(searchUrl);
      const ids = extractListingIds(html);
      ids.forEach(id => allIds.add(id));
      pagesScraped++;
    } catch (err) {
      errors.push(`${searchUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  const listingUrls = Array.from(allIds).map(id => `https://www.vrbo.com/${id}`);
  return { listingUrls, pagesScraped, errors };
}
