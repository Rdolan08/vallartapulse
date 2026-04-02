/**
 * booking-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Booking.com Distribution API adapter — vacation rentals only (non-hotel).
 *
 * Fetches apartments, holiday homes, villas, and serviced apartments in the
 * Puerto Vallarta / Bahía de Banderas area using the Booking.com affiliate
 * Distribution JSON API.
 *
 * Setup
 * ─────
 *   1. Create a free affiliate account at:
 *        https://www.booking.com/affiliate-partner-program.html
 *   2. Set two environment secrets:
 *        BOOKING_AFFILIATE_ID   — your numeric affiliate ID (shown in the portal)
 *        BOOKING_API_KEY        — your API key (generated in the portal)
 *
 * API Docs: https://developers.booking.com/demandapi/
 *
 * Property type IDs used (all non-hotel vacation-rental types):
 *   203 = Apartment        204 = Holiday home     206 = Chalet
 *   213 = Villa            231 = Serviced apartment
 *
 * Note: Nightly price is indicative (min rack rate), not a specific-date quote.
 * For date-specific availability, use the separate Demand API rate-check call.
 */

import https from "node:https";
import type { NormalizedRentalListing } from "./types.js";

const SOURCE = "booking_com" as const;

// Non-hotel property types to request from Booking.com
const VR_TYPE_IDS = [203, 204, 206, 213, 231];
// Max rows per API call (Booking.com cap is usually 1000)
const PAGE_SIZE = 1000;

// Puerto Vallarta region bounding box (used to filter results when city IDs aren't resolved)
const PV_BOUNDS = { latMin: 20.5, latMax: 20.75, lonMin: -105.35, lonMax: -105.15 };
// Riviera Nayarit extension
const RN_BOUNDS = { latMin: 20.75, latMax: 21.0, lonMin: -105.4, lonMax: -105.2 };

// ── Credential helpers ────────────────────────────────────────────────────────

export interface BookingCredentials {
  affiliateId: string;
  apiKey: string;
}

export function getBookingCredentials(): BookingCredentials | null {
  const affiliateId = process.env["BOOKING_AFFILIATE_ID"];
  const apiKey = process.env["BOOKING_API_KEY"];
  if (!affiliateId || !apiKey) return null;
  return { affiliateId, apiKey };
}

function basicAuth(creds: BookingCredentials): string {
  return Buffer.from(`${creds.affiliateId}:${creds.apiKey}`).toString("base64");
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchJson(url: string, auth: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          "User-Agent": "VallartaPulse-DataIngestion/1.0",
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error(`Non-JSON response: ${text.slice(0, 200)}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

const BASE = "https://distribution-xml.booking.com/json/bookings";

// ── City ID resolution ────────────────────────────────────────────────────────

// Booking.com city IDs for PV + Riviera Nayarit (cached after first lookup)
let cachedCityIds: number[] | null = null;

async function resolveCityIds(creds: BookingCredentials): Promise<number[]> {
  if (cachedCityIds) return cachedCityIds;

  const auth = basicAuth(creds);
  // Search for Puerto Vallarta and nearby coastal cities in MX
  const searches = [
    `${BASE}.getCities?affiliateid=${creds.affiliateId}&city_name=Puerto+Vallarta&country_code=MX&languagecode=en`,
    `${BASE}.getCities?affiliateid=${creds.affiliateId}&city_name=Nuevo+Vallarta&country_code=MX&languagecode=en`,
    `${BASE}.getCities?affiliateid=${creds.affiliateId}&city_name=Bucerias&country_code=MX&languagecode=en`,
    `${BASE}.getCities?affiliateid=${creds.affiliateId}&city_name=Sayulita&country_code=MX&languagecode=en`,
  ];

  const ids: number[] = [];
  for (const url of searches) {
    try {
      const data = await fetchJson(url, auth) as { result?: Array<{ city_id: number }> };
      const found = (data.result ?? []).map((c) => c.city_id).filter(Boolean);
      ids.push(...found);
    } catch {
      // ignore individual city lookup failures
    }
  }

  if (ids.length === 0) {
    throw new Error("Could not resolve any Booking.com city IDs for PV region");
  }

  cachedCityIds = [...new Set(ids)];
  return cachedCityIds;
}

// ── Property fetch ────────────────────────────────────────────────────────────

interface BookingProperty {
  hotel_id: number;
  name: string;
  address: string;
  city: string;
  country: string;
  latitude?: number;
  longitude?: number;
  class?: number;
  hotel_type_id?: number;
  url?: string;
  review_score?: number;
  review_nr?: number;
  min_rate?: number;
  max_rate?: number;
  currency_code?: string;
  max_persons?: number;
  nr_rooms?: number;
  facilities?: Array<{ facility_id: number; name: string }>;
  room_info?: Array<{
    room_name?: string;
    max_persons?: number;
    bedrooms?: number;
  }>;
}

async function fetchPropertiesForCity(
  cityId: number,
  creds: BookingCredentials,
): Promise<BookingProperty[]> {
  const auth = basicAuth(creds);
  const typeIds = VR_TYPE_IDS.join(",");
  const url =
    `${BASE}.getHotels` +
    `?affiliateid=${creds.affiliateId}` +
    `&city_ids=${cityId}` +
    `&hotel_type_ids=${typeIds}` +
    `&languagecode=en` +
    `&currency_code=USD` +
    `&extras=hotel_facilities,room_info,hotel_info` +
    `&rows=${PAGE_SIZE}`;

  const data = await fetchJson(url, auth) as { result?: BookingProperty[] };
  return data.result ?? [];
}

// ── Amenity mapping ───────────────────────────────────────────────────────────

// Booking.com facility_id → our canonical amenity keys
const FACILITY_MAP: Record<number, string> = {
  // Swimming pools
  7:   "pool",
  301: "pool",
  // Air conditioning
  11:  "ac",
  16:  "ac",
  // WiFi
  107: "wifi",
  109: "wifi",
  // Kitchen
  9:   "kitchen",
  25:  "kitchen",
  // Washer
  17:  "washer",
  // Parking
  2:   "parking",
  184: "parking",
  // Gym / fitness
  11:  "gym",
  // Beach access
  96:  "beach_access",
  210: "beach_access",
  // Hot tub / jacuzzi
  85:  "hot_tub",
  // TV
  44:  "tv",
  // Balcony / terrace
  54:  "balcony",
  251: "balcony",
  // BBQ
  36:  "bbq",
  // Elevator
  21:  "elevator",
  // Pets
  4:   "pets",
  // Concierge
  170: "concierge",
};

function mapFacilities(facilities: BookingProperty["facilities"]): string[] {
  if (!facilities?.length) return [];
  const set = new Set<string>();
  for (const f of facilities) {
    const key = FACILITY_MAP[f.facility_id];
    if (key) set.add(key);
  }
  return [...set];
}

// ── Bedroom extraction ────────────────────────────────────────────────────────

function extractBedrooms(prop: BookingProperty): number | undefined {
  // Try room_info first (vacation rentals often expose this)
  if (prop.room_info?.length) {
    const br = prop.room_info[0]?.bedrooms;
    if (br && br > 0) return br;
    // Fallback: parse room name for "1 bedroom", "2 bedrooms", etc.
    const nameMatch = (prop.room_info[0]?.room_name ?? "").match(/(\d+)\s*bedroom/i);
    if (nameMatch) return parseInt(nameMatch[1]);
  }
  // Try property name
  const nameMatch = prop.name.match(/(\d+)\s*(?:bed(?:room)?|br)\b/i);
  if (nameMatch) return parseInt(nameMatch[1]);
  // Studio inference
  if (/studio/i.test(prop.name)) return 0;
  return undefined;
}

// ── Normalization ─────────────────────────────────────────────────────────────

function isInPvRegion(lat?: number, lon?: number): boolean {
  if (lat == null || lon == null) return false;
  return (
    (lat >= PV_BOUNDS.latMin && lat <= PV_BOUNDS.latMax && lon >= PV_BOUNDS.lonMin && lon <= PV_BOUNDS.lonMax) ||
    (lat >= RN_BOUNDS.latMin && lat <= RN_BOUNDS.latMax && lon >= RN_BOUNDS.lonMin && lon <= RN_BOUNDS.lonMax)
  );
}

function normalizeProperty(prop: BookingProperty): NormalizedRentalListing | null {
  // Filter out properties outside the PV/RN geographic area
  if (prop.latitude != null && !isInPvRegion(prop.latitude, prop.longitude)) {
    return null;
  }

  const amenities = mapFacilities(prop.facilities);
  const bedrooms = extractBedrooms(prop);

  const nightlyPrice = prop.min_rate ?? null;

  const listing: NormalizedRentalListing = {
    source: SOURCE,
    source_listing_id: String(prop.hotel_id),
    source_url: prop.url ?? `https://www.booking.com/hotel/mx/${prop.hotel_id}.html`,
    title: prop.name,
    neighborhood: prop.city ?? "Puerto Vallarta",
    property_type: "condo",
    bedrooms,
    max_guests: prop.max_persons ?? (prop.room_info?.[0]?.max_persons ?? undefined),
    price_nightly_usd: nightlyPrice,
    latitude: prop.latitude ?? null,
    longitude: prop.longitude ?? null,
    amenities_raw: (prop.facilities ?? []).map((f) => f.name),
    amenities_normalized: amenities,
    rating_value: prop.review_score ? prop.review_score / 2 : null, // Booking uses 0–10, normalize to 0–5
    review_count: prop.review_nr ?? null,
    scraped_at: new Date().toISOString(),
  };

  return listing;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface BookingFetchResult {
  ok: boolean;
  count: number;
  listings: NormalizedRentalListing[];
  skipped: number;
  error?: string;
  note?: string;
}

/**
 * Fetch all non-hotel vacation rentals in the PV/RN region from Booking.com.
 * Returns empty results (not an error) when credentials are not configured.
 */
export async function fetchAllBookingListings(): Promise<BookingFetchResult> {
  const creds = getBookingCredentials();
  if (!creds) {
    return {
      ok: false,
      count: 0,
      listings: [],
      skipped: 0,
      note: "BOOKING_AFFILIATE_ID and/or BOOKING_API_KEY not set. Sign up at https://www.booking.com/affiliate-partner-program.html to enable this source.",
    };
  }

  try {
    const cityIds = await resolveCityIds(creds);
    const allProps: BookingProperty[] = [];

    for (const cityId of cityIds) {
      const props = await fetchPropertiesForCity(cityId, creds);
      allProps.push(...props);
    }

    // Deduplicate by hotel_id across city searches
    const seen = new Set<number>();
    const unique = allProps.filter((p) => {
      if (seen.has(p.hotel_id)) return false;
      seen.add(p.hotel_id);
      return true;
    });

    const listings: NormalizedRentalListing[] = [];
    let skipped = 0;
    for (const prop of unique) {
      const normalized = normalizeProperty(prop);
      if (normalized) {
        listings.push(normalized);
      } else {
        skipped++;
      }
    }

    return { ok: true, count: listings.length, listings, skipped };
  } catch (err) {
    return {
      ok: false,
      count: 0,
      listings: [],
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fetch a single Booking.com property by its hotel_id.
 */
export async function fetchBookingProperty(hotelId: string): Promise<NormalizedRentalListing> {
  const creds = getBookingCredentials();
  if (!creds) {
    throw new Error("Booking.com credentials not configured (BOOKING_AFFILIATE_ID / BOOKING_API_KEY)");
  }

  const auth = basicAuth(creds);
  const typeIds = VR_TYPE_IDS.join(",");
  const url =
    `${BASE}.getHotels` +
    `?affiliateid=${creds.affiliateId}` +
    `&hotel_ids=${hotelId}` +
    `&hotel_type_ids=${typeIds}` +
    `&languagecode=en` +
    `&currency_code=USD` +
    `&extras=hotel_facilities,room_info,hotel_info`;

  const data = await fetchJson(url, auth) as { result?: BookingProperty[] };
  const prop = (data.result ?? [])[0];
  if (!prop) throw new Error(`No property found for hotel_id=${hotelId}`);

  const normalized = normalizeProperty(prop);
  if (!normalized) throw new Error(`Property ${hotelId} is outside the PV/RN region`);
  return normalized;
}
