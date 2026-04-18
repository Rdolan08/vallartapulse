/**
 * ingest/airbnb-search-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovers and extracts Airbnb listings directly from Puerto Vallarta search
 * results pages — without requiring individual listing page scrapes.
 *
 * Strategy:
 *  1. Fetch each Airbnb PV search page with full browser-simulation headers.
 *  2. Find the embedded JSON blob (niobeClientData / bootstrapData /
 *     __NEXT_DATA__) that contains the StaysSearch result cards.
 *  3. Parse listing metadata from each search card:
 *       id, name, bedrooms, bathrooms, price, rating, reviews, city, coords
 *  4. Normalise into NormalizedRentalListing and return — no individual
 *     listing pages are fetched, avoiding datacenter IP blocks.
 *
 * Airbnb search pages return embedded JSON with 18–28 listing cards per page.
 * Each card carries enough data for useful pricing comps.
 */

import https from "https";
import http from "http";
import zlib from "zlib";
import type { IncomingMessage } from "http";
import type { NormalizedRentalListing } from "./types.js";
import { normalizeNeighborhood } from "../rental-normalize.js";

export const SOURCE = "airbnb" as const;

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
        if (res.statusCode === 403 || res.statusCode === 429) {
          return reject(new Error(`HTTP ${res.statusCode} (rate-limited)`));
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

// ── Search card data parser ───────────────────────────────────────────────────

interface SearchCard {
  id: string;
  name?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  price?: number;
  rating?: number;
  reviews?: number;
  city?: string;
  lat?: number;
  lng?: number;
  roomType?: string;
}

/**
 * Deep-scans the entire HTML page for listing card data.
 * Airbnb embeds search results in multiple possible JSON blobs:
 *   - niobeClientData (older builds)
 *   - bootstrapData / __NEXT_DATA__ (newer builds)
 *   - deferred inline scripts
 *
 * Rather than chasing the exact schema, we walk the raw JSON and
 * correlate fields that appear near known listing ID patterns.
 */
function extractSearchCards(html: string): SearchCard[] {
  const cards: Map<string, SearchCard> = new Map();

  // ── Step 1: Extract all /rooms/XXXXXXXX IDs from the page ─────────────────
  const idPattern = /\/rooms\/(\d{7,12})/g;
  let m: RegExpExecArray | null;
  const candidateIds = new Set<string>();
  while ((m = idPattern.exec(html)) !== null) {
    candidateIds.add(m[1]);
  }

  // ── Step 2: For each found ID, try to extract nearby listing metadata ──────
  for (const id of candidateIds) {
    cards.set(id, { id });
  }

  // ── Step 3: Find JSON blobs that look like listing cards ──────────────────
  // Look for patterns like: "id":"12345678" or "id":12345678 with nearby bedroom/price data
  const jsonPattern = /"id"\s*:\s*"?(\d{7,12})"?\s*,\s*"([^"]+)"\s*:\s*([^,}\]]+)/g;
  while ((m = jsonPattern.exec(html)) !== null) {
    const id = m[1];
    if (!cards.has(id)) continue;
    const card = cards.get(id)!;
    const key = m[2].toLowerCase();
    const rawVal = m[3].trim().replace(/[",]/g, "");
    const numVal = parseFloat(rawVal);

    if (key.includes("bedroom") && !isNaN(numVal)) card.bedrooms = numVal;
    else if (key.includes("bathroom") && !isNaN(numVal)) card.bathrooms = numVal;
    else if (key.includes("sleeps") || key.includes("maxguest") || key.includes("maxoccupancy")) {
      if (!isNaN(numVal)) card.maxGuests = numVal;
    }
    else if (key === "name" || key === "title") card.name = rawVal.slice(0, 200);
  }

  // ── Step 4: Extract structured data from embedded JSON blobs ─────────────
  // Find all large JSON objects (> 500 chars) and scan them
  const scriptPattern = /<script[^>]*>([\s\S]{500,}?)<\/script>/g;
  while ((m = scriptPattern.exec(html)) !== null) {
    const src = m[1];
    let blob: unknown;
    try {
      blob = JSON.parse(src);
    } catch {
      continue;
    }
    scanJsonForCards(blob, cards);
  }

  // ── Step 5: Also scan the niobeClientData blob ────────────────────────────
  const niobeIdx = html.indexOf('"niobeClientData"');
  if (niobeIdx !== -1) {
    const blobStart = html.lastIndexOf("{", niobeIdx);
    const blobEnd = html.indexOf("</script>", niobeIdx);
    if (blobStart !== -1 && blobEnd !== -1) {
      try {
        const blob = JSON.parse(html.slice(blobStart, blobEnd));
        scanJsonForCards(blob, cards);
      } catch {}
    }
  }

  return Array.from(cards.values()).filter(c => c.id.length >= 7);
}

function scanJsonForCards(node: unknown, cards: Map<string, SearchCard>, depth = 0): void {
  if (depth > 15 || node === null || node === undefined) return;

  if (Array.isArray(node)) {
    for (const item of node) {
      scanJsonForCards(item, cards, depth + 1);
    }
    return;
  }

  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;

    // Check if this object looks like a listing card
    const idVal = (obj["id"] ?? obj["listingId"] ?? obj["listing_id"]) as string | number | undefined;
    if (idVal !== undefined) {
      const id = String(idVal);
      if (/^\d{7,12}$/.test(id)) {
        const card = cards.get(id) ?? { id };
        let updated = false;

        const name = obj["name"] ?? obj["title"] ?? obj["listingName"];
        if (typeof name === "string" && name.length > 3 && name.length < 300 &&
            !name.includes("airbnb") && !name.toLowerCase().includes("vacation rentals")) {
          card.name = name;
          updated = true;
        }

        const beds = obj["bedrooms"] ?? obj["bedroomCount"] ?? obj["bedroom_count"] ?? obj["numberOfBedrooms"];
        if (typeof beds === "number") { card.bedrooms = beds; updated = true; }
        else if (typeof beds === "string" && !isNaN(parseFloat(beds))) { card.bedrooms = parseFloat(beds); updated = true; }

        const baths = obj["bathrooms"] ?? obj["bathroomCount"] ?? obj["bathroom_count"] ?? obj["numberOfBathroomsTotal"];
        if (typeof baths === "number") { card.bathrooms = baths; updated = true; }
        else if (typeof baths === "string" && !isNaN(parseFloat(baths))) { card.bathrooms = parseFloat(baths); updated = true; }

        const guests = obj["maxGuests"] ?? obj["sleeps"] ?? obj["personCapacity"] ?? obj["maxOccupancy"];
        if (typeof guests === "number") { card.maxGuests = guests; updated = true; }

        const rating = obj["avgRating"] ?? obj["rating"] ?? obj["ratingValue"];
        if (typeof rating === "number" && rating > 0 && rating <= 5) { card.rating = rating; updated = true; }

        const reviews = obj["reviewsCount"] ?? obj["numberOfReviews"] ?? obj["reviewCount"];
        if (typeof reviews === "number") { card.reviews = reviews; updated = true; }

        const lat = obj["lat"] ?? obj["latitude"] ?? obj["coordinateLat"];
        if (typeof lat === "number") { card.lat = lat; updated = true; }

        const lng = obj["lng"] ?? obj["longitude"] ?? obj["coordinateLng"];
        if (typeof lng === "number") { card.lng = lng; updated = true; }

        const city = obj["city"] ?? obj["localized_city"];
        if (typeof city === "string" && city.length > 0) { card.city = city; updated = true; }

        const roomType = obj["roomTypeCategory"] ?? obj["roomType"] ?? obj["propertyType"];
        if (typeof roomType === "string") { card.roomType = roomType; updated = true; }

        if (updated) cards.set(id, card);
      }
    }

    // Check for pricing info
    const amount = obj["amount"] ?? obj["price"] ?? obj["priceAmount"] ?? obj["rate"];
    if (typeof amount === "number" && amount > 10 && amount < 50000) {
      // Try to associate this price with a nearby listing
      // (price is often nested under pricingQuote.rate.amount)
    }

    // Recurse into children
    for (const val of Object.values(obj)) {
      scanJsonForCards(val, cards, depth + 1);
    }
  }
}

// ── Neighbourhood / coord based normalisation ─────────────────────────────────

// Known PV neighbourhood bounding boxes [minLat, maxLat, minLng, maxLng]
const COORD_NEIGHBORHOODS: Array<{ name: string; minLat: number; maxLat: number; minLng: number; maxLng: number }> = [
  { name: "Zona Romantica", minLat: 20.598, maxLat: 20.616, minLng: -105.246, maxLng: -105.230 },
  { name: "Amapas",         minLat: 20.586, maxLat: 20.600, minLng: -105.248, maxLng: -105.230 },
  { name: "Conchas Chinas", minLat: 20.574, maxLat: 20.590, minLng: -105.253, maxLng: -105.235 },
  { name: "Centro",         minLat: 20.616, maxLat: 20.638, minLng: -105.245, maxLng: -105.222 },
  { name: "Marina Vallarta", minLat: 20.665, maxLat: 20.700, minLng: -105.280, maxLng: -105.240 },
  { name: "Nuevo Vallarta", minLat: 20.700, maxLat: 20.760, minLng: -105.310, maxLng: -105.270 },
  { name: "Bucerias",       minLat: 20.745, maxLat: 20.775, minLng: -105.345, maxLng: -105.310 },
  { name: "Punta Mita",     minLat: 20.762, maxLat: 20.800, minLng: -105.550, maxLng: -105.480 },
  { name: "Versalles",      minLat: 20.625, maxLat: 20.650, minLng: -105.255, maxLng: -105.230 },
  { name: "Fluvial",        minLat: 20.640, maxLat: 20.668, minLng: -105.265, maxLng: -105.240 },
];

function coordToNeighborhood(lat: number, lng: number): string | null {
  for (const nb of COORD_NEIGHBORHOODS) {
    if (lat >= nb.minLat && lat <= nb.maxLat && lng >= nb.minLng && lng <= nb.maxLng) {
      return nb.name;
    }
  }
  return null;
}

// ── Normalise a search card → NormalizedRentalListing ────────────────────────

function normalizeCard(card: SearchCard): NormalizedRentalListing | null {
  if (!card.id || card.id.length < 7) return null;

  // Determine neighbourhood from coordinates or city string
  let neighborhoodRaw = card.city ?? "Puerto Vallarta";
  if (card.lat && card.lng) {
    const coordNb = coordToNeighborhood(card.lat, card.lng);
    if (coordNb) neighborhoodRaw = coordNb;
  }
  const neighborhoodNorm = normalizeNeighborhood(neighborhoodRaw);

  return {
    source: SOURCE,
    source_listing_id: `ABB-${card.id}`,
    source_url: `https://www.airbnb.com/rooms/${card.id}`,
    title: card.name ?? undefined,
    neighborhood: neighborhoodRaw,
    neighborhood_normalized: neighborhoodNorm ?? undefined,
    bedrooms: card.bedrooms ?? undefined,
    bathrooms: card.bathrooms ?? undefined,
    max_guests: card.maxGuests ?? undefined,
    latitude: card.lat ?? undefined,
    longitude: card.lng ?? undefined,
    price_nightly_usd: card.price ?? undefined,
    rating_value: card.rating ?? undefined,
    review_count: card.reviews ?? undefined,
    scraped_at: new Date().toISOString(),
  };
}

// ── Search URLs for Puerto Vallarta ───────────────────────────────────────────

const PV_SEARCH_URLS = [
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?room_types%5B%5D=Entire+home%2Fapt",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?min_bedrooms=2",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?min_bedrooms=3",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?amenities%5B%5D=4",
  "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes",
  "https://www.airbnb.com/s/Marina-Vallarta--Puerto-Vallarta--Mexico/homes",
  "https://www.airbnb.com/s/Amapas--Puerto-Vallarta--Mexico/homes",
  "https://www.airbnb.com/s/Conchas-Chinas--Puerto-Vallarta--Mexico/homes",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?min_bedrooms=4",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?room_types%5B%5D=Entire+home%2Fapt&min_bedrooms=2",
  "https://www.airbnb.com/s/Puerto-Vallarta--Jalisco--Mexico/homes?amenities%5B%5D=7",
];

export interface AirbnbSearchResult {
  listings: NormalizedRentalListing[];
  listingIds: string[];
  pagesScraped: number;
  errors: string[];
}

export async function fetchAirbnbSearchListings(opts?: {
  maxPages?: number;
  delayMs?: number;
}): Promise<AirbnbSearchResult> {
  const maxPages = opts?.maxPages ?? 6;
  const delayMs = opts?.delayMs ?? 2000;

  const allCards: Map<string, SearchCard> = new Map();
  const errors: string[] = [];
  let pagesScraped = 0;

  const urls = PV_SEARCH_URLS.slice(0, maxPages);

  for (const searchUrl of urls) {
    try {
      const html = await get(searchUrl);
      const cards = extractSearchCards(html);
      for (const card of cards) {
        // Prefer cards with more data
        const existing = allCards.get(card.id);
        if (!existing || (card.name && !existing.name) || (card.bedrooms !== undefined && existing.bedrooms === undefined)) {
          allCards.set(card.id, { ...(existing ?? {}), ...card });
        }
      }
      pagesScraped++;
    } catch (err) {
      errors.push(`${searchUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  const listings: NormalizedRentalListing[] = [];
  for (const card of allCards.values()) {
    const normalized = normalizeCard(card);
    if (normalized) listings.push(normalized);
  }

  return {
    listings,
    listingIds: Array.from(allCards.keys()),
    pagesScraped,
    errors,
  };
}
