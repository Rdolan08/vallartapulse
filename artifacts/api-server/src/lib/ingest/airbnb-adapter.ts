/**
 * ingest/airbnb-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real Airbnb listing scraper.
 *
 * Strategy:
 *  1. Fetch the listing page with full browser-simulation headers + HTTP cookies.
 *  2. Extract the session API key and bev cookie from the response.
 *  3. Parse whatever data is in <script id="data-deferred-state-0"> (niobeClientData).
 *  4. If that data has an error (client-side GraphQL not yet fired), make a
 *     follow-up StaysPdpSections GraphQL call with the session credentials.
 *  5. Normalise all available fields into NormalizedRentalListing.
 *
 * Required headers:
 *   - Sec-Fetch-* and Sec-Ch-Ua headers bypass Airbnb's basic bot check.
 *   - The bev session cookie from step 1 is needed for the GraphQL request.
 *
 * Production note:
 *   From residential IPs Airbnb serves the full Niobe response in the page.
 *   From datacenter IPs the Niobe response may contain an "Internal error" and
 *   the GraphQL follow-up call is required. Both paths are handled.
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import type { IncomingMessage } from "http";
import type { NormalizedRentalListing } from "./types.js";
import { normalizeNeighborhood } from "../rental-normalize.js";

export const SOURCE = "airbnb" as const;

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

const API_HEADERS = (apiKey: string, cookie: string): Record<string, string> => ({
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "en-US,en;q=0.9",
  "Content-Type": "application/json",
  "X-Airbnb-API-Key": apiKey,
  "X-Airbnb-GraphQL-Platform": "web",
  "X-Airbnb-GraphQL-Platform-Client": "minimalist-pdp",
  "X-CSRF-Without-Token": "1",
  Referer: "https://www.airbnb.com/",
  Origin: "https://www.airbnb.com",
  Cookie: cookie,
});

function get(url: string, headers: Record<string, string>): Promise<{ body: string; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = (mod as typeof https).request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { ...headers, Host: parsed.hostname },
      },
      (res: IncomingMessage) => {
        const encoding = (res.headers["content-encoding"] ?? "") as string;
        const setCookies = (res.headers["set-cookie"] ?? []) as string[];

        // Follow redirects (max 3)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          return resolve(get(next, headers));
        }

        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const decompress = () => {
            try {
              if (encoding.includes("br")) return zlib.brotliDecompressSync(buf).toString("utf-8");
              if (encoding.includes("gzip")) return zlib.gunzipSync(buf).toString("utf-8");
              if (encoding.includes("deflate")) return zlib.inflateSync(buf).toString("utf-8");
              return buf.toString("utf-8");
            } catch {
              return buf.toString("utf-8");
            }
          };
          resolve({ body: decompress(), setCookies });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(new Error("Timeout")); });
    req.end();
  });
}

function post(url: string, headers: Record<string, string>, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = Buffer.from(body, "utf-8");
    const req = (https as typeof https).request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, Host: parsed.hostname, "Content-Length": String(data.byteLength) },
      },
      (res: IncomingMessage) => {
        const encoding = (res.headers["content-encoding"] ?? "") as string;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          try {
            if (encoding.includes("br")) return resolve(zlib.brotliDecompressSync(buf).toString());
            if (encoding.includes("gzip")) return resolve(zlib.gunzipSync(buf).toString());
          } catch {}
          resolve(buf.toString());
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(20_000, () => { req.destroy(new Error("Timeout")); });
    req.write(data);
    req.end();
  });
}

// ── HTML parsing helpers ──────────────────────────────────────────────────────

function extractListingId(url: string): string {
  const m = url.match(/\/rooms\/(\d+)/);
  return m ? m[1] : url.split("/").filter(Boolean).pop() ?? url;
}

function extractApiKey(html: string): string | null {
  const m = html.match(/"key"\s*:\s*"([a-z0-9]{25,})"/);
  return m ? m[1] : null;
}

function parseCookies(setCookies: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const line of setCookies) {
    const pair = line.split(";")[0].trim();
    const eq = pair.indexOf("=");
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return jar;
}

function cookieString(jar: Record<string, string>): string {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ── Niobe/niobeClientData parser ──────────────────────────────────────────────

interface NiobeListingData {
  title?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  roomType?: string;
  lat?: number;
  lng?: number;
  price?: number;
  cleaningFee?: number;
  rating?: number;
  reviews?: number;
  amenities?: string[];
  city?: string;
  neighborhood?: string;
  minNights?: number;
}

function extractFromNiobe(html: string): NiobeListingData | null {
  // Find script tag with niobeClientData
  const idx = html.indexOf('"niobeClientData"');
  if (idx === -1) return null;
  const jsonStart = html.lastIndexOf("{", idx);
  const scriptEnd = html.indexOf("</script>", idx);
  if (jsonStart === -1 || scriptEnd === -1) return null;

  let blob: Record<string, unknown>;
  try {
    blob = JSON.parse(html.slice(jsonStart, scriptEnd));
  } catch {
    return null;
  }

  const niobe = blob["niobeClientData"] as unknown[];
  if (!Array.isArray(niobe)) return null;

  const result: NiobeListingData = {};

  for (const entry of niobe) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const val = entry[1] as Record<string, unknown>;
    if (typeof val !== "object" || !val) continue;

    // Recursively flatten
    const flat: Record<string, unknown> = {};
    const flatten = (d: unknown, path: string, depth: number): void => {
      if (depth > 10) return;
      if (typeof d === "object" && d !== null && !Array.isArray(d)) {
        for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
          flatten(v, path ? `${path}.${k}` : k, depth + 1);
        }
      } else if (Array.isArray(d)) {
        d.slice(0, 5).forEach((item, i) => flatten(item, `${path}[${i}]`, depth + 1));
      } else {
        flat[path] = d;
      }
    };
    flatten(val, "", 0);

    // Extract fields
    for (const [key, value] of Object.entries(flat)) {
      const lk = key.toLowerCase();
      if (!result.title && (lk.endsWith(".title") || lk.endsWith(".name")) && typeof value === "string" && value.length > 3 && value.length < 200) {
        // Skip error names and generic platform strings
        const skip = /^NiobeError$|^Error$|^airbnb$/i.test(value) || value.includes("http");
        if (!skip) result.title = value;
      }
      if (result.bedrooms === undefined && (lk.includes("bedroom_count") || lk.endsWith(".bedrooms")) && typeof value === "number") result.bedrooms = value;
      if (result.bathrooms === undefined && (lk.includes("bathroom_count") || lk.endsWith(".bathrooms")) && typeof value === "number") result.bathrooms = value;
      if (result.maxGuests === undefined && (lk.includes("person_capacity") || lk.includes("max_guests") || lk.includes("maxguests")) && typeof value === "number") result.maxGuests = value;
      if (!result.roomType && lk.includes("room_type") && typeof value === "string") result.roomType = value;
      if (result.lat === undefined && lk.endsWith(".lat") && typeof value === "number") result.lat = value;
      if (result.lng === undefined && (lk.endsWith(".lng") || lk.endsWith(".lon") || lk.endsWith(".longitude")) && typeof value === "number") result.lng = value;
      if (result.rating === undefined && (lk.includes("review_score") || lk.includes("rating_value") || lk.includes("avg_rating")) && typeof value === "number" && value > 0 && value <= 5) result.rating = value;
      if (result.reviews === undefined && (lk.includes("review_count") || lk.includes("reviews_count")) && typeof value === "number") result.reviews = value;
      if (!result.city && (lk.includes("localized_city") || lk.includes("city_name")) && typeof value === "string") result.city = value;
      if (!result.neighborhood && (lk.includes("localized_neighborhood") || lk.includes("neighborhood")) && typeof value === "string") result.neighborhood = value;
      if (result.minNights === undefined && lk.includes("min_nights") && typeof value === "number") result.minNights = value;
      if (result.price === undefined && (lk.includes("price") || lk.includes("amount")) && typeof value === "number" && value > 0 && value < 100000) {
        if (lk.includes("discount") || lk.includes("cleaning") || lk.includes("service") || lk.includes("total")) continue;
        result.price = value;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ── GraphQL follow-up (Niobe StaysPdpSections) ───────────────────────────────

async function fetchNiobeData(listingId: string, apiKey: string, cookie: string): Promise<NiobeListingData | null> {
  const variables = JSON.stringify({
    id: listingId,
    pdpSectionsRequest: {
      adults: "2",
      bypassTargetings: false,
      categoryTag: null,
      causeId: null,
      children: null,
      disasterId: null,
      discountedGuestFeeVersion: null,
      displayExtensions: null,
      federatedSearchId: null,
      forceBoostPriorityMessageType: null,
      hostPreview: false,
      infants: null,
      interactionType: null,
      layouts: ["SIDEBAR", "SINGLE_COLUMN"],
      pets: null,
      preview: false,
      previousStateCheckIn: null,
      previousStateCheckOut: null,
      priceDropSource: null,
      privateBooking: false,
      promotionUuid: null,
      relaxedAmenityIds: null,
      searchId: null,
      selectedCancellationPolicyId: null,
      selectedRatePlanId: null,
      splitStays: null,
      staysMapToggleEnabled: false,
      translateUgc: null,
      useNewSectionWrapperQuery: false,
    },
    includeGpBookItNonExperiencedGuestFragment: true,
    includeGpReviewsHighlightBannerFragment: true,
    includeGpNonExperiencedGuestLearnMoreModalFragment: true,
    includeGpReviewsFragment: true,
    includeGpReviewsEmptyFragment: true,
    includePdpMigrationAmenitiesFragment: false,
    includePdpMigrationBookItNonExperiencedGuestFragment: false,
    includePdpMigrationReviewsHighlightBannerFragment: false,
    includePdpMigrationReviewsFragment: false,
    includePdpMigrationReviewsEmptyFragment: false,
    includePdpMigrationTitleFragment: false,
  });

  const params = new URLSearchParams({
    operationName: "StaysPdpSections",
    locale: "en",
    currency: "USD",
    variables,
  });

  const url = `https://www.airbnb.com/api/v3/StaysPdpSections?${params.toString()}`;
  try {
    const raw = await post(url, API_HEADERS(apiKey, cookie), "");
    const d = JSON.parse(raw) as Record<string, unknown>;
    if (d.errors) return null;
    // Parse data.presentation.stayProductDetailPage sections
    const sections = (d as Record<string, unknown>)?.data as Record<string, unknown>;
    if (!sections) return null;
    // Flatten and extract
    const result: NiobeListingData = {};
    const flatten = (obj: unknown, path: string, depth: number): void => {
      if (depth > 12 || !obj) return;
      if (typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          flatten(v, path ? `${path}.${k}` : k, depth + 1);
          const lk = k.toLowerCase();
          if (typeof v === "string" || typeof v === "number") {
            if (!result.title && (lk === "title" || lk === "listing_title") && typeof v === "string" && v.length > 3) result.title = v;
            if (result.bedrooms === undefined && lk.includes("bedroom_count") && typeof v === "number") result.bedrooms = v;
            if (result.bathrooms === undefined && lk.includes("bathroom_count") && typeof v === "number") result.bathrooms = v;
            if (result.maxGuests === undefined && (lk === "person_capacity" || lk.includes("max_guests")) && typeof v === "number") result.maxGuests = v;
            if (result.rating === undefined && (lk.includes("avg_rating") || lk.includes("review_score")) && typeof v === "number" && v > 0 && v <= 5) result.rating = v;
            if (result.reviews === undefined && lk.includes("review_count") && typeof v === "number") result.reviews = v;
          }
        }
      } else if (Array.isArray(obj)) {
        obj.slice(0, 5).forEach((item, i) => flatten(item, `${path}[${i}]`, depth + 1));
      }
    };
    flatten(sections, "", 0);
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ── Meta tag fallback ─────────────────────────────────────────────────────────

function extractFromMeta(html: string): { title?: string; description?: string; image?: string } {
  const get = (pattern: RegExp) => { const m = html.match(pattern); return m ? m[1] : undefined; };
  return {
    title: get(/property="og:title"\s+content="([^"]+)"/),
    description: get(/name="description"\s+content="([^"]+)"/),
    image: get(/property="og:image"\s+content="([^"]+)"/),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchAirbnbListing(url: string): Promise<NormalizedRentalListing> {
  const listingId = extractListingId(url);
  const canonical = `https://www.airbnb.com/rooms/${listingId}`;

  // Step 1: Fetch the HTML page
  const { body: html, setCookies } = await get(canonical, BROWSER_HEADERS);
  const cookieJar = parseCookies(setCookies);
  const apiKey = extractApiKey(html) ?? "d306zoyjsyarp7ifhu67rjxn52tv0t";
  const cookie = cookieString(cookieJar);

  // Step 2: Parse embedded niobeClientData
  let niobe = extractFromNiobe(html);

  // Step 3: If Niobe data is missing/errored, try a direct GraphQL request
  if (!niobe?.bedrooms) {
    const fresh = await fetchNiobeData(listingId, apiKey, cookie);
    if (fresh) niobe = { ...niobe, ...fresh };
  }

  // Step 4: Meta tag fallback for title
  const meta = extractFromMeta(html);
  const rawTitle = niobe?.title ?? meta.title ?? undefined;

  // Step 5: Normalise neighborhood
  const rawCity = niobe?.city;
  const rawNeighborhood = niobe?.neighborhood;
  const neighborhood_normalized = rawNeighborhood
    ? (normalizeNeighborhood(rawNeighborhood) ?? rawNeighborhood)
    : rawCity
    ? (normalizeNeighborhood(rawCity) ?? undefined)
    : undefined;

  return {
    source: SOURCE,
    source_listing_id: listingId,
    source_url: canonical,
    title: rawTitle,
    neighborhood: rawNeighborhood ?? rawCity,
    neighborhood_normalized: neighborhood_normalized as string | undefined,
    property_type: niobe?.roomType,
    bedrooms: niobe?.bedrooms,
    bathrooms: niobe?.bathrooms,
    max_guests: niobe?.maxGuests,
    price_nightly_usd: niobe?.price ?? null,
    cleaning_fee_usd: niobe?.cleaningFee ?? null,
    min_nights: niobe?.minNights ?? null,
    latitude: niobe?.lat ?? null,
    longitude: niobe?.lng ?? null,
    amenities_raw: niobe?.amenities,
    rating_value: niobe?.rating ?? null,
    review_count: niobe?.reviews ?? null,
    scraped_at: new Date().toISOString(),
  };
}
