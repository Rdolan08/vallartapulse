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
import { getProxyAgent, type FetchMode } from "./http-proxy.js";
import { fetchWithBrowser } from "./browser-fetch.js";

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

export interface AirbnbHttpGetOpts {
  /** Fetch mode: "direct" | "proxy" (default; uses PROXY_URL) | "unblocker" (uses UNBLOCKER_URL). */
  fetchMode?: FetchMode;
  /** Redirect-recursion guard; callers should not set this. */
  redirects?: number;
}

export function airbnbHttpGet(url: string, opts?: AirbnbHttpGetOpts | number): Promise<string> {
  // Backward compat: previous signature was (url, redirects: number).
  const o: AirbnbHttpGetOpts = typeof opts === "number" ? { redirects: opts } : (opts ?? {});
  return get(url, o.fetchMode ?? "proxy", o.redirects ?? 0);
}

async function get(url: string, fetchMode: FetchMode, redirects: number): Promise<string> {
  if (redirects > 5) throw new Error("Too many redirects");
  // Browser mode: short-circuit the node http stack entirely. Chromium handles
  // its own proxy, redirects, JS rendering, and cookie storage. Airbnb's SPA
  // renders cards client-side after a GraphQL fetch, so we MUST be in a real
  // browser context to see /rooms/* in the rendered HTML.
  if (fetchMode === "browser") {
    return fetchWithBrowser(url, {
      timeoutMs: 30_000,
      // Once any /rooms/ link appears in the DOM, the search GraphQL query
      // has resolved and we have something extractable. Card containers vary
      // across Airbnb A/B variants, so anchor on /rooms/ links instead.
      waitForSelector: "a[href*='/rooms/']",
      fallbackOnTimeout: true,
    });
  }
  const parsed = new URL(url);
  const mod = parsed.protocol === "https:" ? https : http;
  const proxyAgent = await getProxyAgent(fetchMode);
  return new Promise((resolve, reject) => {
    const req = (mod as typeof https).request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: { ...BROWSER_HEADERS, Host: parsed.hostname },
        ...(proxyAgent ? { agent: proxyAgent } : {}),
      },
      (res: IncomingMessage) => {
        const encoding = (res.headers["content-encoding"] ?? "") as string;

        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(get(new URL(res.headers.location, url).toString(), fetchMode, redirects + 1));
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

export interface SearchCard {
  id: string;
  name?: string;
  bedrooms?: number;
  bathrooms?: number;
  maxGuests?: number;
  /** Displayed nightly price (parsed from "$245" or `pricingQuote.rate.amount`). */
  price?: number;
  /** Displayed total stay price (parsed from "$735 total" secondary line). */
  totalPrice?: number;
  /** ISO currency code (USD, MXN, …) when present. */
  priceCurrency?: string;
  /** Free-text qualifier from primaryLine ("night", "month", …). */
  priceQualifier?: string;
  rating?: number;
  reviews?: number;
  /** Free-text location label as displayed on the card (city / area string). */
  city?: string;
  lat?: number;
  lng?: number;
  roomType?: string;
  /** Direct image URL for the card's primary photo. */
  thumbnail?: string;
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
export function extractSearchCards(html: string): SearchCard[] {
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

    // ── Airbnb StaySearchResult shape: { listing: {...}, pricingQuote: {...} }
    // This is the canonical card object from the staysSearch GraphQL response
    // (modern Airbnb SPA). We try this rich-shape extractor first; it's
    // additive, so falling through to the generic walker below is safe.
    tryAirbnbStayResult(obj, cards);

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

// ── Airbnb StaySearchResult-shape rich extractor ─────────────────────────────
//
// Modern Airbnb search responses (April 2026) serialize each card as a flat
// `StaySearchResult` object — there is no `{listing, pricingQuote}` wrapper.
// Verified shape (per live HTML inspection 2026-04-18):
//   {
//     __typename: "StaySearchResult",
//     avgRatingA11yLabel: "4.83 out of 5 average rating, 139 reviews",
//     avgRatingLocalized: "4.83 (139)",
//     structuredDisplayPrice: {
//       primaryLine: { discountedPrice|price, originalPrice?, qualifier,
//                      accessibilityLabel },
//       secondaryLine: { price?, accessibilityLabel? } | null,
//       displayPriceStyle: "TOTAL_ONLY" | "PER_NIGHT_ONLY" | …,
//     },
//     contextualPictures: [ { picture: "https://a0.muscache.com/…" }, … ],
//     title: "Condo in Puerto Vallarta",
//     subtitle: "Stunning condo in SOHO by …",
//     nameLocalized: { localizedStringWithTranslationPreference: "…" },
//     demandStayListing: {
//       id: "RGVtYW5kU3RheUxpc3Rpbmc6MTE5NjQzNjIwMDU1MDYzMjA0NQ==",
//       location: { coordinate: { latitude, longitude } },
//       description: { name: { localizedStringWithTranslationPreference } },
//     },
//   }
//
// All assignments are guarded so a missing field never invalidates the card;
// the listing ID captured by the /rooms/ regex pass remains the sole
// validity requirement (a card may exist with id only).

function tryAirbnbStayResult(
  obj: Record<string, unknown>,
  cards: Map<string, SearchCard>
): void {
  // Detect the StaySearchResult shape: either by typename or by the presence
  // of the modern price wrapper. Bail out cheaply if neither is present.
  const typename = obj["__typename"];
  const sdp = obj["structuredDisplayPrice"] as Record<string, unknown> | undefined;
  if (typename !== "StaySearchResult" && !sdp) return;

  // Listing ID lives in `demandStayListing.id` as a base64-encoded
  // GraphQL global-id of the form "DemandStayListing:1196436200550632045".
  const dsl = obj["demandStayListing"] as Record<string, unknown> | undefined;
  let id: string | undefined;
  if (dsl) {
    const rawId = dsl["id"];
    if (typeof rawId === "string" && rawId.length > 0) {
      id = decodeStayListingId(rawId);
    }
  }
  if (!id || !/^\d{7,12}$/.test(id)) return;

  const card = cards.get(id) ?? { id };
  let updated = false;

  // ── Title ──────────────────────────────────────────────────────────────────
  // `subtitle` is the host-supplied descriptive name (e.g. "Stunning condo in
  // SOHO by Maxwell Residences"); `title` is the property-type bucket
  // (e.g. "Condo in Puerto Vallarta"). Prefer the descriptive name when
  // available; fall back to the localized name then the bucket title.
  const nameLocalized = obj["nameLocalized"] as Record<string, unknown> | undefined;
  const localizedName = nameLocalized?.["localizedStringWithTranslationPreference"];
  const subtitle = obj["subtitle"];
  const title = obj["title"];
  let chosenName: string | undefined;
  if (typeof subtitle === "string" && subtitle.length > 2) chosenName = subtitle;
  else if (typeof localizedName === "string" && localizedName.length > 2) chosenName = localizedName;
  else if (typeof title === "string" && title.length > 2) chosenName = title;
  if (chosenName && !card.name) {
    card.name = chosenName.slice(0, 300);
    updated = true;
  }

  // ── Thumbnail ──────────────────────────────────────────────────────────────
  const pics = obj["contextualPictures"] as unknown[] | undefined;
  if (Array.isArray(pics) && pics.length > 0) {
    const first = pics[0] as Record<string, unknown> | undefined;
    if (first) {
      const url = (first["picture"] ?? first["baseUrl"] ?? first["url"]) as string | undefined;
      if (typeof url === "string" && url.startsWith("http") && !card.thumbnail) {
        card.thumbnail = url;
        updated = true;
      }
    }
  }

  // ── Rating + reviews from a11y label ───────────────────────────────────────
  const ratingLabel =
    (obj["avgRatingA11yLabel"] as string | undefined) ??
    (obj["avgRatingLocalized"] as string | undefined);
  if (typeof ratingLabel === "string") {
    const parsed = parseRatingLabel(ratingLabel);
    if (parsed.rating !== null && card.rating === undefined) {
      card.rating = parsed.rating;
      updated = true;
    }
    if (parsed.reviews !== null && card.reviews === undefined) {
      card.reviews = parsed.reviews;
      updated = true;
    }
  }

  // ── Coordinates ────────────────────────────────────────────────────────────
  const loc = dsl?.["location"] as Record<string, unknown> | undefined;
  const coord = loc?.["coordinate"] as Record<string, unknown> | undefined;
  if (coord) {
    const lat = coord["latitude"];
    const lng = coord["longitude"];
    if (typeof lat === "number" && card.lat === undefined) { card.lat = lat; updated = true; }
    if (typeof lng === "number" && card.lng === undefined) { card.lng = lng; updated = true; }
  }

  // ── Pricing ────────────────────────────────────────────────────────────────
  // structuredDisplayPrice.primaryLine carries the displayed price string.
  // displayPriceStyle tells us whether it's a per-night or per-stay number;
  // qualifier ("for N nights" / "night") is the human-readable hint and is
  // also a reliable fallback when the style field is missing.
  if (sdp) {
    const primary = sdp["primaryLine"] as Record<string, unknown> | undefined;
    const styleRaw = sdp["displayPriceStyle"];
    const style = typeof styleRaw === "string" ? styleRaw.toUpperCase() : "";
    if (primary) {
      // Displayed price string: discountedPrice (sale) > price (regular).
      const priceStr =
        (typeof primary["discountedPrice"] === "string" ? primary["discountedPrice"] : undefined) ??
        (typeof primary["price"] === "string" ? primary["price"] : undefined);
      const parsedPrice = parseMoney(priceStr as string | undefined);
      const currency = parseCurrency(priceStr as string | undefined);
      const qualifier = primary["qualifier"];
      const qStr = typeof qualifier === "string" ? qualifier : "";

      // Classify: per-stay total vs per-night.
      const isTotal =
        style === "TOTAL_ONLY" ||
        /\bfor\s+\d+\s+nights?\b/i.test(qStr) ||
        /\btotal\b/i.test(qStr);

      if (parsedPrice !== null) {
        if (isTotal && card.totalPrice === undefined) {
          card.totalPrice = parsedPrice;
          updated = true;
        } else if (!isTotal && card.price === undefined) {
          card.price = parsedPrice;
          updated = true;
        }
      }
      if (currency && !card.priceCurrency) { card.priceCurrency = currency; updated = true; }
      if (qStr && !card.priceQualifier) { card.priceQualifier = qStr.slice(0, 40); updated = true; }
    }

    // secondaryLine sometimes carries a per-night breakdown when primary is total
    const secondary = sdp["secondaryLine"] as Record<string, unknown> | undefined;
    if (secondary) {
      const sPriceStr =
        (typeof secondary["discountedPrice"] === "string" ? secondary["discountedPrice"] : undefined) ??
        (typeof secondary["price"] === "string" ? secondary["price"] : undefined);
      const sParsed = parseMoney(sPriceStr as string | undefined);
      if (sParsed !== null) {
        // If primary is total and secondary is present, secondary is usually nightly.
        if (card.price === undefined && card.totalPrice !== undefined) {
          card.price = sParsed; updated = true;
        } else if (card.totalPrice === undefined && card.price !== undefined) {
          card.totalPrice = sParsed; updated = true;
        }
      }
    }
  }

  if (updated) cards.set(id, card);
}

/**
 * Decode a base64 GraphQL global-id of the form "DemandStayListing:NNNN"
 * back to the numeric Airbnb listing ID. Returns undefined when the input
 * is not a recognisable encoded id.
 */
function decodeStayListingId(b64: string): string | undefined {
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf-8");
    const m = decoded.match(/(?:DemandStayListing|StayListing|Listing):(\d{7,12})/);
    if (m) return m[1];
  } catch {
    /* fallthrough */
  }
  // Some builds expose the numeric id directly.
  if (/^\d{7,12}$/.test(b64)) return b64;
  return undefined;
}

/**
 * Extract a 3-letter ISO currency code from a money string.
 * "$8,537 MXN" → "MXN" ; "$245" → undefined ; "USD 245" → "USD".
 */
function parseCurrency(s: string | undefined): string | undefined {
  if (typeof s !== "string") return undefined;
  const m = s.match(/\b([A-Z]{3})\b/);
  return m ? m[1] : undefined;
}

/**
 * Parse a money string into a plain number. Tolerates currency symbols,
 * thousands separators, and trailing qualifiers ("$1,234 total" → 1234).
 * Returns null when no digits are present.
 */
function parseMoney(s: string | undefined): number | null {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/[, \u00A0]/g, "");
  const m = cleaned.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse Airbnb's accessibility rating label into (rating, reviews).
 * Examples handled:
 *   "4.92 out of 5 average rating, 88 reviews" → { 4.92, 88 }
 *   "4.92 (88)"                                → { 4.92, 88 }
 *   "Rated 4.8 out of 5 from 12 reviews"       → { 4.8, 12 }
 *   "New"                                       → { null, null }
 */
function parseRatingLabel(
  s: string
): { rating: number | null; reviews: number | null } {
  const ratingM = s.match(/(\d+\.\d+)/);
  const reviewsM =
    s.match(/(\d+)\s*reviews?/i) ??
    s.match(/from\s+(\d+)/i) ??
    s.match(/\((\d+)\)/);
  const rating = ratingM ? parseFloat(ratingM[1]) : null;
  const reviews = reviewsM ? parseInt(reviewsM[1], 10) : null;
  return {
    rating: rating !== null && rating > 0 && rating <= 5 ? rating : null,
    reviews: reviews !== null && Number.isFinite(reviews) ? reviews : null,
  };
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

export function normalizeCard(card: SearchCard): NormalizedRentalListing | null {
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
      const html = await get(searchUrl, "proxy", 0);
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
