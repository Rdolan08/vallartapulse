/**
 * vacation-vallarta-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Scraper for https://www.vacationvallarta.com — a Squarespace site operated by
 * Vacation Vallarta, a boutique PV property-management company specialising in
 * luxury villas and high-end condos in the Zona Romantica / Amapas corridor.
 *
 * Strategy
 *  1. Fetch the home-page HTML → extract all /<slug> internal links.
 *  2. For each slug that looks like a listing (not /inquire, /pv-info etc.),
 *     fetch the individual page and extract structured data from the rich-text
 *     Squarespace blocks using regex patterns.
 *  3. Return a NormalizedRentalListing[] ready for persistNormalized().
 *
 * Squarespace page data is entirely server-side rendered, so plain HTTP fetch
 * works without a headless browser.
 */

import https from "node:https";
import type { NormalizedRentalListing } from "./types.js";

const BASE_URL = "https://www.vacationvallarta.com";
const SOURCE   = "vacation_vallarta" as const;

/** Squarespace slugs that are navigation / info pages — not listings. */
const NON_LISTING_SLUGS = new Set([
  "help-me-choose", "inquire", "pv-info", "puerto-vallarta-escape",
  "new-page", "gallery", "about", "contact", "blog", "testimonials",
  "home", "search", "sitemap",
]);

// ── HTTP helper ───────────────────────────────────────────────────────────────

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Cache-Control":   "no-cache",
};

function fetchHtml(url: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: DEFAULT_HEADERS, timeout: timeoutMs }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) return fetchHtml(loc.startsWith("http") ? loc : BASE_URL + loc, timeoutMs).then(resolve, reject);
        return reject(new Error(`Redirect without location from ${url}`));
      }
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on("error", reject);
  });
}

// ── Text-extraction helpers ────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s{2,}/g, " ").trim();
}

function extractTitle(html: string, slug: string): string {
  // Try OG title first (most reliable)
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1];
  if (ogTitle && ogTitle.length > 3 && !ogTitle.toLowerCase().includes("vacation vallarta")) return ogTitle.trim();

  // Try first <h1> or <h2>
  const h = html.match(/<h[12][^>]*>([^<]{4,100})<\/h[12]>/i)?.[1];
  if (h) return stripTags(h).trim();

  // Fallback: humanize slug
  return slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function extractNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ""));
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return undefined;
}

function extractBedrooms(text: string): number | undefined {
  return extractNumber(text, [
    /(\d+)\s*(?:bedroom|bed(?:room)?s?)\b/i,
    /(\d+)\s*BR\b/,
    /(\d+)\s*bed\b(?!room)/i,
  ]);
}

function extractBathrooms(text: string): number | undefined {
  return extractNumber(text, [
    /(\d+(?:\.\d)?)\s*bath(?:room)?s?\b/i,
    /(\d+(?:\.\d)?)\s*baths\b/i,
  ]);
}

function extractGuests(text: string): number | undefined {
  return extractNumber(text, [
    /sleep(?:s|ing)?\s+(\d+)\s*(?:guest|people|person)/i,
    /(?:up\s+to\s+)?(\d+)\s*guest/i,
    /(?:up\s+to\s+)?(\d+)\s*people/i,
    /capacity[:\s]+(\d+)/i,
  ]);
}

function extractPrice(text: string): number | undefined {
  // Match "$1,800/night" or "$1800 per night" — avoid cleaning fee amounts
  const patterns = [
    /\$\s*([\d,]+)\s*(?:\/night|per night|nightly)/i,
    /(?:rate|price)[:\s]+\$\s*([\d,]+)/i,
    /(?:starting at|from)\s+\$\s*([\d,]+)/i,
  ];
  const raw = extractNumber(text, patterns);
  // Reject obviously wrong values (under $50 = probably a fee/deposit, over $50k = parse error)
  if (raw !== undefined && (raw < 50 || raw > 50_000)) return undefined;
  return raw;
}

function extractCleaningFee(text: string): number | undefined {
  return extractNumber(text, [
    /\$\s*([\d,]+)\s*(?:cleaning fee|service fee)/i,
    /cleaning fee[:\s]+\$\s*([\d,]+)/i,
  ]);
}

function extractMinNights(text: string): number | undefined {
  return extractNumber(text, [
    /(\d+)[-\s]*night\s+minimum/i,
    /minimum\s+(?:stay|nights?)[:\s]+(\d+)/i,
    /min(?:imum)?\s+(\d+)\s+night/i,
  ]);
}

function extractSqft(text: string): number | undefined {
  return extractNumber(text, [
    /([\d,]+)\s*(?:\+)?\s*sq(?:uare)?\s*f(?:eet|t)\b/i,
    /([\d,]+)\s*(?:\+)?\s*sq\s*ft/i,
  ]);
}

function extractNeighborhood(text: string): string | undefined {
  const lc = text.toLowerCase();
  // Order matters — more specific first
  if (lc.includes("romantic zone") || lc.includes("zona romantica") || lc.includes("los muertos")) return "Zona Romantica";
  if (lc.includes("amapas") || lc.includes("conchas chinas")) return "Amapas";
  if (lc.includes("marina vallarta") || lc.includes("the marina")) return "Marina Vallarta";
  if (lc.includes("5 de diciembre")) return "5 de Diciembre";
  if (lc.includes("new vallarta") || lc.includes("nuevo vallarta")) return "Nuevo Vallarta";
  if (lc.includes("mismaloya") || lc.includes("boca de tomatlan")) return "Mismaloya";
  if (lc.includes("punta mita")) return "Punta Mita";
  if (lc.includes("sayulita")) return "Sayulita";
  if (lc.includes("bucerias") || lc.includes("bucerías")) return "Bucerias";
  // "Old Town" ambiguous — keep as-is
  if (lc.includes("old town")) return "Old Town";
  if (lc.includes("downtown") || lc.includes("el centro")) return "Centro";
  return undefined;
}

function extractAmenities(text: string): string[] {
  const amenities: string[] = [];
  const lc = text.toLowerCase();

  const checks: [RegExp | string, string][] = [
    [/private\s+(?:infinity\s+)?pool/i,    "Private pool"],
    [/infinity\s+pool/i,                   "Infinity pool"],
    ["heated pool",                         "Heated pool"],
    [/rooftop\s+pool/i,                    "Rooftop pool"],
    ["pool",                                "Pool"],
    [/hot\s*tub|jacuzzi/i,                 "Hot tub / Jacuzzi"],
    ["beachfront",                          "Beachfront"],
    ["beach access",                        "Beach access"],
    [/steps?\s+to\s+(?:the\s+)?beach/i,    "Steps to beach"],
    ["ocean view",                          "Ocean view"],
    ["bay view",                            "Bay view"],
    [/banderas\s+bay/i,                     "Banderas Bay view"],
    ["air conditioning",                    "Air conditioning"],
    ["air-conditioning",                    "Air conditioning"],
    [/\bac\b/i,                             "Air conditioning"],
    ["wifi",                                "WiFi"],
    ["wi-fi",                               "WiFi"],
    ["internet",                            "WiFi"],
    [/full(?:y\s+)?(?:equipped\s+)?kitchen/i, "Full kitchen"],
    ["chef",                                "Chef service"],
    ["maid service",                        "Maid service"],
    ["daily maid",                          "Daily maid service"],
    ["concierge",                           "Concierge"],
    ["waiter",                              "Waiter / butler"],
    ["butler",                              "Waiter / butler"],
    ["washer",                              "Washer / Dryer"],
    ["dryer",                               "Washer / Dryer"],
    ["washer/dryer",                        "Washer / Dryer"],
    [/smart\s+tv|cable\s+tv|\btv\b/i,      "TV"],
    ["bbq",                                 "BBQ grill"],
    ["grill",                               "BBQ grill"],
    ["gym",                                 "Gym"],
    ["fitness",                             "Gym"],
    ["parking",                             "Parking"],
    ["garage",                              "Parking"],
    [/pet(?:\s+|-)?friendly/i,             "Pet friendly"],
    [/elevator|lift/i,                      "Elevator"],
    ["balcony",                             "Balcony"],
    ["terrace",                             "Terrace / rooftop"],
    ["rooftop",                             "Terrace / rooftop"],
    ["staffed",                             "Fully staffed"],
    ["staff",                               "Staffed property"],
    ["game room",                           "Game room"],
    ["theater",                             "Home theater"],
    ["private dock",                        "Private dock"],
    ["boat",                                "Boat access"],
  ];

  const seen = new Set<string>();
  for (const [pattern, label] of checks) {
    const match = typeof pattern === "string"
      ? lc.includes(pattern.toLowerCase())
      : pattern.test(text);
    if (match && !seen.has(label)) {
      seen.add(label);
      amenities.push(label);
    }
  }
  return amenities;
}

// ── Building name detection ────────────────────────────────────────────────────

function buildingFromSlug(slug: string): string | undefined {
  if (slug.startsWith("plazamar-") || slug === "pm-506") return "Plazamar";
  return undefined;
}

function propertyTypeFromSlug(slug: string): string {
  if (slug.startsWith("plazamar-") || slug === "pm-506") return "Condo";
  if (slug.startsWith("villa-") || slug === "casa-yvonneka" || slug === "marea-alta" || slug === "marea-baja") return "Villa";
  return "Vacation Rental";
}

// ── Slug discovery ─────────────────────────────────────────────────────────────

async function discoverSlugs(): Promise<string[]> {
  const html = await fetchHtml(BASE_URL + "/");
  const raw = new Set<string>();

  // Match both relative /slug and absolute https://www.vacationvallarta.com/slug
  const hrefRe = /href="(?:https?:\/\/www\.vacationvallarta\.com)?\/([a-z0-9][a-z0-9-]{2,}(?:\/[a-z0-9-]+)?)(?:[/?#][^"]*)?"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html)) !== null) {
    const slug = m[1].split("/")[0]; // take first path segment only
    if (slug && slug.length > 2 && !slug.includes(".")) raw.add(slug);
  }

  return [...raw].filter(s => !NON_LISTING_SLUGS.has(s));
}

// ── Per-listing scraper ───────────────────────────────────────────────────────

async function scrapeListing(slug: string): Promise<NormalizedRentalListing | null> {
  const url = `${BASE_URL}/${slug}`;
  let html: string;
  try {
    html = await fetchHtml(url);
  } catch {
    return null; // 404 or timeout — skip
  }

  // Strip all HTML to plain text for extraction
  const fullText = stripTags(html);

  const title      = extractTitle(html, slug);
  const bedrooms   = extractBedrooms(fullText);
  const bathrooms  = extractBathrooms(fullText);
  const maxGuests  = extractGuests(fullText);
  const price      = extractPrice(fullText);
  const cleaning   = extractCleaningFee(fullText);
  const minNights  = extractMinNights(fullText);
  const sqft       = extractSqft(fullText);
  const neighborhood = extractNeighborhood(fullText);
  const amenities  = extractAmenities(fullText);
  const building   = buildingFromSlug(slug);
  const propType   = propertyTypeFromSlug(slug);

  // Skip pages with no useful listing data (info / navigation pages)
  if (!bedrooms && !price && !maxGuests) return null;

  return {
    source:            SOURCE,
    source_listing_id: slug,
    source_url:        url,
    title,
    neighborhood:      neighborhood ?? "Old Town",
    building_name:     building,
    property_type:     propType,
    bedrooms,
    bathrooms,
    max_guests:        maxGuests,
    sqft,
    price_nightly_usd: price,
    cleaning_fee_usd:  cleaning,
    min_nights:        minNights,
    amenities_raw:     amenities,
    scraped_at:        new Date().toISOString(),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scrape all Vacation Vallarta listings.
 * Returns an array of normalized listings (skipping non-listing pages).
 */
export async function fetchAllVacationVallartaListings(
  opts: { delayMs?: number } = {}
): Promise<NormalizedRentalListing[]> {
  const delay = opts.delayMs ?? 800;
  const slugs  = await discoverSlugs();
  const results: NormalizedRentalListing[] = [];

  for (const slug of slugs) {
    const listing = await scrapeListing(slug);
    if (listing) results.push(listing);
    await new Promise(r => setTimeout(r, delay));
  }

  return results;
}

/**
 * Scrape a single Vacation Vallarta listing by URL or slug.
 */
export async function fetchVacationVallartaListing(
  urlOrSlug: string
): Promise<NormalizedRentalListing | null> {
  const slug = urlOrSlug.includes("vacationvallarta.com")
    ? urlOrSlug.split("/").filter(Boolean).pop() ?? urlOrSlug
    : urlOrSlug.replace(/^\//, "");
  return scrapeListing(slug);
}
