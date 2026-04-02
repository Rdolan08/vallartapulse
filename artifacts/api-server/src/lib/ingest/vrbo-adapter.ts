/**
 * ingest/vrbo-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real VRBO (Expedia Group) listing scraper.
 *
 * Strategy:
 *  1. Fetch the listing page using full browser-simulation headers.
 *     VRBO returns 1MB+ HTML from datacenter IPs when Sec-Fetch-* headers
 *     are present — no residential proxy required.
 *  2. Parse structured data in priority order:
 *       a. JSON-LD  (LodgingBusiness / VacationRental schema)
 *       b. OG / meta tags  (title, description, image)
 *       c. Inline JSON patterns  (bedrooms, bathrooms, sleeps, lat, lng)
 *  3. Normalise all fields into NormalizedRentalListing.
 *
 * URL formats accepted:
 *   https://www.vrbo.com/1234567
 *   https://www.vrbo.com/1234567ha
 *   https://www.homeaway.com/1234567
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import type { IncomingMessage } from "http";
import type { NormalizedRentalListing } from "./types.js";
import { normalizeNeighborhood } from "../rental-normalize.js";

export const SOURCE = "vrbo" as const;

// ── HTTP helper ───────────────────────────────────────────────────────────────

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
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

function get(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;

    const req = (mod as typeof https).request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { ...BROWSER_HEADERS, Host: parsed.hostname },
      },
      (res: IncomingMessage) => {
        const encoding = (res.headers["content-encoding"] ?? "") as string;

        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
        }

        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          try {
            if (encoding.includes("br")) return resolve(zlib.brotliDecompressSync(buf).toString("utf-8"));
            if (encoding.includes("gzip")) return resolve(zlib.gunzipSync(buf).toString("utf-8"));
            if (encoding.includes("deflate")) return resolve(zlib.inflateSync(buf).toString("utf-8"));
          } catch {}
          resolve(buf.toString("utf-8"));
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(25_000, () => { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

// ── ID extractor ──────────────────────────────────────────────────────────────

function extractListingId(url: string): string {
  // Matches: /1234567, /1234567ha, /vacation-rentals/.../1234567
  const m = url.match(/\/(\d{5,9})(ha)?(?:[?/]|$)/);
  return m ? m[1] + (m[2] ?? "") : url.split("/").filter(Boolean).pop() ?? url;
}

// ── JSON-LD parser ────────────────────────────────────────────────────────────

interface JsonLdProperty {
  name?: string;
  description?: string;
  address?: {
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string;
    streetAddress?: string;
  };
  geo?: { latitude?: number; longitude?: number };
  aggregateRating?: { ratingValue?: number; reviewCount?: number };
  amenityFeature?: Array<{ name?: string; value?: boolean | string }>;
  numberOfBedrooms?: number | string;
  numberOfBathroomsTotal?: number | string;
  numberOfRooms?: number | string;
  accommodationCategory?: string;
  floorSize?: { value?: number; unitCode?: string };
  occupancy?: { maxOccupancy?: number; minOccupancy?: number };
  priceRange?: string;
}

function parseJsonLd(html: string): JsonLdProperty | null {
  const matches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs);
  for (const m of matches) {
    try {
      const d = JSON.parse(m[1]) as Record<string, unknown>;
      const type = d["@type"] as string;
      if (
        type === "LodgingBusiness" ||
        type === "VacationRental" ||
        type === "Accommodation" ||
        type === "Resort" ||
        type === "Product"
      ) {
        return d as JsonLdProperty;
      }
    } catch {}
  }
  return null;
}

// ── Inline JSON pattern parser ────────────────────────────────────────────────

interface InlineData {
  bedrooms?: number;
  bathrooms?: number;
  sleeps?: number;
  lat?: number;
  lng?: number;
  price?: number;
  rating?: number;
  reviews?: number;
  city?: string;
  neighborhood?: string;
  title?: string;
  propertyType?: string;
}

const INLINE_PATTERNS: Array<{ key: string; field: keyof InlineData; type: "number" | "string"; patterns: RegExp[] }> = [
  {
    key: "bedrooms",
    field: "bedrooms",
    type: "number",
    patterns: [
      /"bedrooms"\s*:\s*(\d+)/,
      /"bedroomCount"\s*:\s*(\d+)/,
      /"numberOfBedrooms"\s*:\s*"?(\d+)/,
    ],
  },
  {
    key: "bathrooms",
    field: "bathrooms",
    type: "number",
    patterns: [
      /"bathrooms"\s*:\s*(\d+\.?\d*)/,
      /"bathroomCount"\s*:\s*(\d+\.?\d*)/,
      /"numberOfBathroomsTotal"\s*:\s*"?(\d+\.?\d*)/,
    ],
  },
  {
    key: "sleeps",
    field: "sleeps",
    type: "number",
    patterns: [/"sleeps"\s*:\s*(\d+)/, /"maxSleep"\s*:\s*(\d+)/, /"occupancy"\s*:\s*(\d+)/],
  },
  {
    key: "lat",
    field: "lat",
    type: "number",
    patterns: [/"latitude"\s*:\s*(-?\d+\.\d+)/, /"lat"\s*:\s*(-?\d+\.\d+)/],
  },
  {
    key: "lng",
    field: "lng",
    type: "number",
    patterns: [/"longitude"\s*:\s*(-?\d+\.\d+)/, /"lon(?:g|gitude)?"\s*:\s*(-?\d+\.\d+)/],
  },
  {
    key: "rating",
    field: "rating",
    type: "number",
    patterns: [/"averageRating"\s*:\s*(\d+\.?\d*)/, /"ratingValue"\s*:\s*(\d+\.?\d*)/],
  },
  {
    key: "reviews",
    field: "reviews",
    type: "number",
    patterns: [/"reviewCount"\s*:\s*(\d+)/, /"reviewsCount"\s*:\s*(\d+)/],
  },
  {
    key: "price",
    field: "price",
    type: "number",
    patterns: [
      /"nightlyPrice"\s*:\s*(\d+\.?\d*)/,
      /"baseRatePerNight"\s*:\s*(\d+\.?\d*)/,
    ],
  },
  {
    key: "city",
    field: "city",
    type: "string",
    patterns: [/"city"\s*:\s*"([^"]+)"/, /"addressLocality"\s*:\s*"([^"]+)"/],
  },
  {
    key: "neighborhood",
    field: "neighborhood",
    type: "string",
    patterns: [/"neighborhood"\s*:\s*"([^"]+)"/],
  },
  {
    key: "propertyType",
    field: "propertyType",
    type: "string",
    patterns: [/"propertyType"\s*:\s*"([^"]+)"/, /"unitType"\s*:\s*"([^"]+)"/],
  },
];

function parseInline(html: string): InlineData {
  const result: InlineData = {};
  for (const { field, type, patterns } of INLINE_PATTERNS) {
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        if (type === "number") {
          const n = parseFloat(m[1]);
          if (!isNaN(n)) (result as Record<string, unknown>)[field] = n;
        } else {
          (result as Record<string, unknown>)[field] = m[1];
        }
        break;
      }
    }
  }
  return result;
}

// ── Meta tag parser ───────────────────────────────────────────────────────────

function parseMeta(html: string): { title?: string; description?: string } {
  const t =
    html.match(/property="og:title"\s+content="([^"]+)"/)?.[1] ??
    html.match(/<title>([^<]+)<\/title>/)?.[1];
  const d =
    html.match(/name="description"\s+content="([^"]+)"/)?.[1] ??
    html.match(/property="og:description"\s+content="([^"]+)"/)?.[1];
  return {
    title: t ? t.replace(/\s*\|\s*Vrbo.*$/i, "").replace(/\s*\|\s*VRBO.*$/i, "").trim() : undefined,
    description: d,
  };
}

// ── Amenity normaliser ────────────────────────────────────────────────────────

function extractAmenities(ld: JsonLdProperty): string[] {
  if (!ld.amenityFeature?.length) return [];
  return ld.amenityFeature
    .filter((a) => a.name && a.value !== false)
    .map((a) => a.name!)
    .filter(Boolean);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchVrboListing(url: string): Promise<NormalizedRentalListing> {
  // Normalise URL to canonical VRBO format
  const listingId = extractListingId(url);
  const canonical = url.includes("vrbo.com")
    ? `https://www.vrbo.com/${listingId}`
    : `https://www.vrbo.com/${listingId}`;

  const html = await get(canonical);

  // Parse in priority order
  const ld = parseJsonLd(html);
  const inline = parseInline(html);
  const meta = parseMeta(html);

  // Bedrooms / bathrooms / guests
  const bedrooms =
    (typeof ld?.numberOfBedrooms === "number" ? ld.numberOfBedrooms : undefined) ??
    (typeof ld?.numberOfBedrooms === "string" ? parseInt(ld.numberOfBedrooms) || undefined : undefined) ??
    inline.bedrooms;

  const bathrooms =
    (typeof ld?.numberOfBathroomsTotal === "number" ? ld.numberOfBathroomsTotal : undefined) ??
    (typeof ld?.numberOfBathroomsTotal === "string" ? parseFloat(ld.numberOfBathroomsTotal) || undefined : undefined) ??
    inline.bathrooms;

  const maxGuests =
    (ld?.occupancy?.maxOccupancy) ??
    inline.sleeps;

  // Price
  const price = inline.price ?? null;

  // Location
  const city = ld?.address?.addressLocality ?? inline.city;
  const rawNeighborhood = inline.neighborhood ?? city;
  const neighborhood_normalized = rawNeighborhood
    ? (normalizeNeighborhood(rawNeighborhood) ?? rawNeighborhood)
    : undefined;

  // Rating / reviews
  const rating =
    (typeof ld?.aggregateRating?.ratingValue === "number" ? ld.aggregateRating.ratingValue : undefined) ??
    inline.rating ??
    null;
  const reviews =
    (typeof ld?.aggregateRating?.reviewCount === "number" ? ld.aggregateRating.reviewCount : undefined) ??
    inline.reviews ??
    null;

  // Lat / lng
  const lat = (typeof ld?.geo?.latitude === "number" ? ld.geo.latitude : undefined) ?? inline.lat ?? null;
  const lng = (typeof ld?.geo?.longitude === "number" ? ld.geo.longitude : undefined) ?? inline.lng ?? null;

  // Title
  const title = ld?.name ?? meta.title;

  // Amenities
  const amenities_raw = ld ? extractAmenities(ld) : [];

  // Property type
  const propertyType = ld?.accommodationCategory ?? inline.propertyType;

  return {
    source: SOURCE,
    source_listing_id: listingId,
    source_url: canonical,
    title,
    neighborhood: rawNeighborhood,
    neighborhood_normalized: neighborhood_normalized as string | undefined,
    property_type: propertyType,
    bedrooms,
    bathrooms,
    max_guests: maxGuests,
    price_nightly_usd: price,
    latitude: lat,
    longitude: lng,
    amenities_raw: amenities_raw.length > 0 ? amenities_raw : undefined,
    rating_value: rating,
    review_count: reviews,
    scraped_at: new Date().toISOString(),
  };
}
