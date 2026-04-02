/**
 * ingest/pvrpv-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Source adapter for www.pvrpv.com (Puerto Vallarta Rentals Por Vida).
 * Fetches a single listing page and returns a NormalizedRentalListing.
 *
 * Parse strategy:
 *   1. JSON-LD (schema.org/LodgingBusiness) → name
 *   2. <li> items  → specs (beds, baths, sqft, year, area, type, amenities)
 *   3. Price table → nightly rate (earliest upcoming / peak-season rate)
 *   4. Text patterns → rating, review count
 */

import type { NormalizedRentalListing, SourceKey } from "./types.js";
import { normalizeNeighborhood } from "../rental-normalize.js";

const SOURCE: SourceKey = "pvrpv";
const BASE_URL = "https://www.pvrpv.com";
const USER_AGENT = "VallartaPulse/1.0 (+https://www.vallartapulse.com)";

// ── HTML stripping ────────────────────────────────────────────────────────────

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ── JSON-LD extraction ────────────────────────────────────────────────────────

function extractJsonLd(html: string): Record<string, unknown> | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj["@type"] === "LodgingBusiness") return obj;
    } catch { /* skip */ }
  }
  return null;
}

// ── <li> spec extraction ──────────────────────────────────────────────────────

interface ParsedSpecs {
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  sqft?: number;
  yearBuilt?: number;
  area?: string;
  amenitiesRaw: string[];
}

const SPEC_PREFIXES = [
  "type:", "bed(s):", "bath(s):", "sleeps(s):", "square space:",
  "year built:", "country:", "state/ region:", "city:", "area:",
  "cleaning services:", "damage insurance:", "bed types:", "stairs:",
];

const JS_PATTERNS = /\b(var |window\.|function |document\.|gtag\(|dataLayer)/;

function isNavOrChrome(item: string): boolean {
  if (item.length > 300) return true;
  if (JS_PATTERNS.test(item)) return true;
  const nav = [
    "description", "amenities & video", "3d video", "calendar", "rates",
    "promotions", "policies", "reviews", "location", "kids allowed",
    "condo", "house", "penthouse", "studio", "villa",
    "5 de diciembre", "alta vista", "amapas", "conchas chinas", "downtown",
    "gringo gulch", "los muertos beach", "marina vallarta",
    "north hotel zone", "old town", "punta negra", "versalles",
  ];
  return nav.includes(item.toLowerCase());
}

function parseSpecs(html: string): ParsedSpecs {
  const amenitiesRaw: string[] = [];
  let propertyType: string | undefined;
  let bedrooms: number | undefined;
  let bathrooms: number | undefined;
  let maxGuests: number | undefined;
  let sqft: number | undefined;
  let yearBuilt: number | undefined;
  let area: string | undefined;

  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const raw = stripTags(m[1]);
    if (!raw || isNavOrChrome(raw)) continue;
    const lower = raw.toLowerCase();

    if (lower.startsWith("type:")) {
      propertyType = raw.slice(5).trim();
    } else if (lower.startsWith("bed(s):")) {
      bedrooms = parseInt(raw.replace(/[^\d]/g, ""));
    } else if (lower.startsWith("bath(s):")) {
      bathrooms = parseFloat(raw.replace(/[^0-9.]/g, ""));
    } else if (lower.startsWith("sleeps(s):")) {
      maxGuests = parseInt(raw.replace(/[^\d]/g, ""));
    } else if (lower.startsWith("square space:")) {
      const ft = raw.match(/([\d,]+\.?\d*)\s*square feet/i)?.[1]?.replace(/,/g, "");
      if (ft) sqft = parseFloat(ft);
    } else if (lower.startsWith("year built:")) {
      const yr = raw.match(/(\d{4})/)?.[1];
      if (yr) yearBuilt = parseInt(yr);
    } else if (lower.startsWith("area:")) {
      area = raw.slice(5).trim();
    } else if (!SPEC_PREFIXES.some(p => lower.startsWith(p)) && !isNavOrChrome(raw)) {
      amenitiesRaw.push(raw);
    }
  }

  return { propertyType, bedrooms, bathrooms, maxGuests, sqft, yearBuilt, area, amenitiesRaw };
}

// ── Price extraction ──────────────────────────────────────────────────────────

function extractBasePrice(html: string): number | null {
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const prices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const text = stripTags(m[1]);
    const match = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*USD/);
    if (match) {
      const p = parseFloat(match[1].replace(/,/g, ""));
      if (p > 0 && p < 50_000) prices.push(p);
    }
  }
  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)];
}

// ── Rating extraction ─────────────────────────────────────────────────────────

function extractRating(html: string): { rating: number | null; reviews: number | null } {
  const ratingMatch = html.match(/class="[^"]*rating[^"]*"[^>]*>([\d.]+)/i)
    ?? html.match(/([\d.]+)\s*(?:stars?|\/\s*5)/i);
  const reviewMatch = html.match(/(\d+)\s*reviews?/i);
  return {
    rating: ratingMatch ? parseFloat(ratingMatch[1]) : null,
    reviews: reviewMatch ? parseInt(reviewMatch[1]) : null,
  };
}

// ── Source ID from URL ────────────────────────────────────────────────────────

function extractSourceId(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.split("/").filter(Boolean).pop() ?? path;
  } catch {
    return url;
  }
}

// ── Main adapter ──────────────────────────────────────────────────────────────

export async function fetchPvrpvListing(
  url: string,
): Promise<NormalizedRentalListing> {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(20_000),
  });

  if (!resp.ok) {
    throw new Error(`PVRPV fetch failed: HTTP ${resp.status} for ${url}`);
  }

  const html = await resp.text();

  const jsonLd  = extractJsonLd(html);
  const specs   = parseSpecs(html);
  const price   = extractBasePrice(html);
  const { rating, reviews } = extractRating(html);

  const title = jsonLd?.["name"] as string | undefined
    ?? html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim();

  const rawArea = specs.area ?? "";
  const neighborhoodNormalized = normalizeNeighborhood(rawArea) ?? rawArea;

  return {
    source:            SOURCE,
    source_listing_id: extractSourceId(url),
    source_url:        url,
    title,
    neighborhood:            rawArea || undefined,
    neighborhood_normalized: neighborhoodNormalized as string || undefined,
    building_name:           undefined,
    property_type:     specs.propertyType,
    bedrooms:          specs.bedrooms,
    bathrooms:         specs.bathrooms,
    max_guests:        specs.maxGuests,
    sqft:              specs.sqft ?? null,
    year_built:        specs.yearBuilt ?? null,
    price_nightly_usd: price,
    amenities_raw:     specs.amenitiesRaw,
    rating_value:      rating,
    review_count:      reviews,
    scraped_at:        new Date().toISOString(),
  };
}

// ── Crawl helper: list PVRPV search results for a neighborhood ────────────────

export async function listPvrpvSearchUrls(
  neighborhood: string,
  maxPages = 3,
): Promise<string[]> {
  const urls: string[] = [];
  const slug = neighborhood.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  for (let page = 1; page <= maxPages; page++) {
    const searchUrl = `${BASE_URL}/puerto-vallarta/${slug}?page=${page}`;
    try {
      const resp = await fetch(searchUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) break;
      const html = await resp.text();
      const hrefs = [...html.matchAll(/href="(\/puerto-vallarta\/[^"]+\/[^"]+\/[^"]+)"/g)]
        .map(m => `${BASE_URL}${m[1]}`)
        .filter(u => !u.includes("?") && !urls.includes(u));
      if (hrefs.length === 0) break;
      urls.push(...hrefs);
    } catch { break; }
  }
  return [...new Set(urls)];
}
