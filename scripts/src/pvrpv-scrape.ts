/**
 * pvrpv-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PVRPV listing scraper for VallartaPulse.
 *
 * Fetches up to MAX_LISTINGS listings from pvrpv.com, parses each detail page,
 * normalizes the data, and upserts into rental_listings via Drizzle.
 * Idempotent: re-running updates existing rows.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run scrape:pvrpv
 *
 * Target neighborhoods (PVRPV URL segments → canonical):
 *   old-town, los-muertos-beach  → Zona Romantica
 *   amapas, conchas-chinas       → Amapas
 *   marina-vallarta              → Marina Vallarta
 *
 * Limits: MAX_LISTINGS total, MIN_DELAY_MS between HTTP requests.
 */

import { sql } from "drizzle-orm";
import { db, rentalListingsTable } from "@workspace/db";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://www.pvrpv.com";
const SOURCE_PLATFORM = "pvrpv";
const MAX_LISTINGS = 100;
const MIN_DELAY_MS = 700; // courtesy delay between requests

const TARGET_NEIGHBORHOODS = new Set([
  "old-town",
  "los-muertos-beach",
  "amapas",
  "conchas-chinas",
  "marina-vallarta",
]);

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// ── Neighborhood normalization ────────────────────────────────────────────────

const NEIGHBORHOOD_MAP: Record<string, string> = {
  "zona romantica": "Zona Romantica",
  "zona romántica": "Zona Romantica",
  "romantic zone": "Zona Romantica",
  "old town": "Zona Romantica",
  "old-town": "Zona Romantica",
  "los muertos": "Zona Romantica",
  "los-muertos-beach": "Zona Romantica",
  "los muertos beach": "Zona Romantica",
  "olas altas": "Zona Romantica",
  "emiliano zapata": "Zona Romantica",
  "south side": "Zona Romantica",
  amapas: "Amapas",
  "conchas chinas": "Amapas",
  "conchas-chinas": "Amapas",
  "conchas chinas / amapas": "Amapas",
  "marina vallarta": "Marina Vallarta",
  "marina-vallarta": "Marina Vallarta",
  marina: "Marina Vallarta",
  "hotel zone": "Hotel Zone",
  "hotel-zone": "Hotel Zone",
  "north-hotel-zone": "Hotel Zone",
  "north hotel zone": "Hotel Zone",
  "zona hotelera": "Hotel Zone",
  centro: "Centro",
  "el centro": "Centro",
  downtown: "Centro",
  "alta-vista": "Centro",
  "alta vista": "Centro",
  "el-caloso": "Centro",
  fluvial: "Centro",
  "5 de diciembre": "5 de Diciembre",
  "5-de-diciembre": "5 de Diciembre",
  "cinco de diciembre": "5 de Diciembre",
  versalles: "Versalles",
  versailles: "Versalles",
  pitillal: "Versalles",
};

function normalizeNeighborhood(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return NEIGHBORHOOD_MAP[key] ?? "unclassified";
}

// ── Amenity normalization ─────────────────────────────────────────────────────
// Expanded to cover all known PVRPV amenity label formats.

const AMENITY_ALIAS_MAP: Record<string, string> = {
  // Pool
  "private pool": "private_pool",
  "private swimming pool": "private_pool",
  "pool - private": "private_pool",
  "plunge pool": "private_pool",
  "shared pool": "shared_pool",
  "community pool": "shared_pool",
  "building pool": "shared_pool",
  "pool - shared": "shared_pool",
  "pool (in complex)": "shared_pool",
  "rooftop pool": "shared_pool",
  "infinity pool": "shared_pool",
  "heated pool": "shared_pool",
  "outdoor pool": "shared_pool",
  pool: "shared_pool",
  "hot tub": "hot_tub",
  jacuzzi: "hot_tub",
  whirlpool: "hot_tub",
  spa: "hot_tub",

  // Beach
  beachfront: "beachfront",
  "on the beach": "beachfront",
  "beach front": "beachfront",
  "steps to beach": "beachfront",
  "beach access": "beach_access",
  "near beach": "beach_access",
  "walk to beach": "beach_access",

  // View
  "ocean view": "ocean_view",
  "sea view": "ocean_view",
  "bay view": "ocean_view",
  "ocean views": "ocean_view",
  "banderas bay view": "ocean_view",
  "partial ocean view": "ocean_view",
  "mountain view": "mountain_view",
  "jungle view": "mountain_view",
  "garden view": "mountain_view",
  "mountain views": "mountain_view",

  // Kitchen
  "full kitchen": "full_kitchen",
  kitchen: "full_kitchen",
  "fully equipped kitchen": "full_kitchen",
  "full equipped kitchen": "full_kitchen",
  cooktop: "full_kitchen",
  stove: "full_kitchen",
  oven: "full_kitchen",
  blender: "full_kitchen",
  "coffee maker": "full_kitchen",
  toaster: "full_kitchen",
  "coffee maker / kettle": "full_kitchen",
  "kitchenette": "kitchenette",
  "mini kitchen": "kitchenette",
  "mini fridge": "kitchenette",
  dishwasher: "dishwasher",
  lavavajillas: "dishwasher",

  // BBQ
  "bbq grill": "bbq_grill",
  "bbq grill (in unit)": "bbq_grill",
  bbq: "bbq_grill",
  barbecue: "bbq_grill",
  grill: "bbq_grill",
  "outdoor grill": "bbq_grill",

  // Laundry
  washer: "washer_dryer",
  dryer: "washer_dryer",
  "washer/dryer": "washer_dryer",
  "washer & dryer": "washer_dryer",
  "washer & dryer (in unit)": "washer_dryer",
  laundry: "washer_dryer",
  "in-unit laundry": "washer_dryer",
  "laundry - washer (in unit)": "washer_dryer",
  "laundry - dryer (in unit)": "washer_dryer",
  "washing machine": "washer_dryer",
  iron: "iron",
  "ironing board": "iron",
  "iron & ironing board": "iron",
  plancha: "iron",

  // Linens
  "bed linens": "linens_provided",
  linens: "linens_provided",
  "linens provided": "linens_provided",
  towels: "linens_provided",
  "towels & linens": "linens_provided",

  // Climate
  "air conditioning": "air_conditioning",
  "climate control (air conditioning)": "air_conditioning",
  "central air conditioning": "air_conditioning",
  "central air": "air_conditioning",
  "mini split": "air_conditioning",
  "split ac": "air_conditioning",
  ac: "air_conditioning",
  "a/c": "air_conditioning",
  "ceiling fan": "ceiling_fan",
  "ceiling fans": "ceiling_fan",
  "climate control (ceiling fan)": "ceiling_fan",
  ventilador: "ceiling_fan",

  // Entertainment
  "smart tv": "smart_tv",
  tv: "smart_tv",
  television: "smart_tv",
  "cable tv": "smart_tv",
  streaming: "smart_tv",
  netflix: "smart_tv",
  cable: "smart_tv",

  // Connectivity
  wifi: "wifi",
  "wi-fi": "wifi",
  internet: "wifi",
  "high-speed wifi": "wifi",
  broadband: "wifi",

  // Safety
  gated: "gated_community",
  "gated community": "gated_community",
  "gated complex": "gated_community",
  guarded: "gated_community",
  "24hr security": "gated_community",
  "24-hour security": "gated_community",
  "security (24 hours)": "gated_community",
  "security guard": "gated_community",
  doorman: "gated_community",
  "private entrance": "private_entrance",
  "private entrance (to the unit)": "private_entrance",
  "private entry": "private_entrance",
  "keypad entry": "private_entrance",
  "self check-in": "private_entrance",

  // Parking
  parking: "parking",
  "parking (in complex)": "parking",
  "free parking": "parking",
  garage: "parking",
  estacionamiento: "parking",
  "assigned parking": "parking",
  "covered parking": "parking",

  // Outdoor
  terrace: "rooftop_terrace",
  rooftop: "rooftop_terrace",
  "rooftop terrace": "rooftop_terrace",
  "outdoor space (patio / deck)": "rooftop_terrace",
  "balcony / terrace": "rooftop_terrace",
  patio: "rooftop_terrace",
  balcony: "rooftop_terrace",
  deck: "rooftop_terrace",
  "outdoor living area": "rooftop_terrace",

  // Accessibility
  elevator: "elevator",
  "elevator (in complex)": "elevator",
  lift: "elevator",
  elevador: "elevator",

  // Guest policies
  "pets allowed": "pet_friendly",
  "pet friendly": "pet_friendly",
  "pet-friendly": "pet_friendly",
  "dogs allowed": "pet_friendly",
  "children permitted": "child_friendly",
  "kids allowed": "child_friendly",
  "family friendly": "child_friendly",

  // Workspace
  workspace: "dedicated_workspace",
  "dedicated workspace": "dedicated_workspace",
  desk: "dedicated_workspace",
  "home office": "dedicated_workspace",
};

function normalizeAmenities(rawList: string[]): string[] {
  const keys = new Set<string>();
  for (const item of rawList) {
    const key = AMENITY_ALIAS_MAP[item.trim().toLowerCase()];
    if (key) keys.add(key);
  }
  return Array.from(keys).sort();
}

// ── Beach distance (Haversine) ────────────────────────────────────────────────

/**
 * Named beach access points for distance_to_beach_m calculation.
 * Straight-line approximation; accuracy ±0.3% at <10 km (adequate for PV).
 */
const BEACH_POINTS = [
  { name: "Playa Los Muertos (ZR)",      lat: 20.6040, lon: -105.2382 },
  { name: "Playa Olas Altas (ZR South)", lat: 20.6055, lon: -105.2378 },
  { name: "Playa Camarones (Malecon)",   lat: 20.6178, lon: -105.2363 },
  { name: "Conchas Chinas Beach",        lat: 20.5942, lon: -105.2354 },
  { name: "Playa de Oro (Hotel Zone)",   lat: 20.6503, lon: -105.2393 },
  { name: "Playa Las Glorias (HZ North)",lat: 20.6620, lon: -105.2396 },
  { name: "Marina Vallarta Beach",       lat: 20.6848, lon: -105.2673 },
];

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceToNearestBeachM(lat: number | null, lon: number | null): number | null {
  if (lat == null || lon == null) return null;
  let min = Infinity;
  for (const p of BEACH_POINTS) {
    const d = haversineM(lat, lon, p.lat, p.lon);
    if (d < min) min = d;
  }
  return Math.round(min);
}

// ── sqft / sqm parsing ────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;

function parseSqft(raw: string | null | undefined): {
  sqft: number | null;
  convertedFromSqm: boolean;
} {
  if (!raw) return { sqft: null, convertedFromSqm: false };

  // Prefer explicit square feet value
  const feetM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Feet|sq\.?\s*ft\.?)/i);
  if (feetM) {
    const val = parseFloat(feetM[1].replace(/,/g, ""));
    if (!isNaN(val) && val > 0) return { sqft: Math.round(val), convertedFromSqm: false };
  }

  // Fall back to square meters → convert to sqft
  const meterM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Met(?:er|re)s?|m²|sq\.?\s*m\.?)/i);
  if (meterM) {
    const sqm = parseFloat(meterM[1].replace(/,/g, ""));
    if (!isNaN(sqm) && sqm > 0) {
      return { sqft: Math.round(sqm * SQM_TO_SQFT), convertedFromSqm: true };
    }
  }

  return { sqft: null, convertedFromSqm: false };
}

// ── Confidence scoring ────────────────────────────────────────────────────────

function computeConfidence(fields: {
  title?: string | null;
  sourceUrl?: string | null;
  neighborhoodNormalized?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  nightlyPriceUsd?: number | null;
  ratingOverall?: number | null;
  reviewCount?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  maxGuests?: number | null;
  amenitiesNormalized?: string[] | null;
}): number {
  let score = 0;
  if (fields.title?.trim()) score += 5;
  if (fields.sourceUrl?.trim()) score += 5;
  if (fields.neighborhoodNormalized && fields.neighborhoodNormalized !== "unclassified") score += 10;
  if (fields.bedrooms != null && fields.bedrooms >= 0) score += 15;
  if (fields.bathrooms != null && fields.bathrooms > 0) score += 10;
  if (fields.nightlyPriceUsd != null && fields.nightlyPriceUsd > 0) score += 20;
  if (fields.ratingOverall != null) score += 8;
  if (fields.reviewCount != null && fields.reviewCount >= 0) score += 7;
  if (fields.latitude != null) score += 5;
  if (fields.longitude != null) score += 5;
  if (fields.maxGuests != null && fields.maxGuests > 0) score += 5;
  if (fields.amenitiesNormalized && fields.amenitiesNormalized.length > 0) score += 5;
  return parseFloat((score / 100).toFixed(3));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── HTML parsers ──────────────────────────────────────────────────────────────

function extractMeta(html: string, property: string): string | null {
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i"));
  return m?.[1]?.trim() ?? null;
}

function extractListingUrls(html: string): string[] {
  const matches = html.matchAll(
    /href="(https:\/\/www\.pvrpv\.com\/puerto-vallarta\/([^/"?]+)\/[^/"?]+\/[^/"?]+)"/g
  );
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const m of matches) {
    const url = m[1];
    const neighborhood = m[2];
    if (!seen.has(url) && TARGET_NEIGHBORHOODS.has(neighborhood)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

function extractNeighborhoodSlug(url: string): string {
  const parts = url.replace("https://www.pvrpv.com/puerto-vallarta/", "").split("/");
  return parts[0] ?? "";
}

function extractSlug(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Derive a building name from the listing slug.
 * "paramount-bay-villa-serena-unit-407c" → "Paramount Bay Villa Serena"
 */
function buildingNameFromSlug(slug: string): string {
  const stripped = slug
    .replace(/-unit-.*$/, "")
    .replace(/-ph\d.*$/, "")
    .replace(/-pent.*$/, "")
    .replace(/-studio.*$/, "")
    .replace(/-\d+[a-z]?$/, "")
    .replace(/-\d+$/, "");

  return stripped
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

function extractTitle(html: string): string | null {
  const raw = extractMeta(html, "og:title");
  if (!raw) return null;
  return raw
    .replace(/\s*-\s*(Condo|Studio|Penthouse|House|Villa|Apartment)\s+in\s+Puerto\s+Vallarta.*$/i, "")
    .trim();
}

function extractLatLon(html: string): { lat: number | null; lon: number | null } {
  const geoPos = extractMeta(html, "geo.position");
  if (geoPos) {
    const [latStr, lonStr] = geoPos.split(";");
    const lat = parseFloat(latStr ?? "");
    const lon = parseFloat(lonStr ?? "");
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
  }
  const latM = html.match(/"latitude"\s*:\s*"([\d.\-]+)"/);
  const lonM = html.match(/"longitude"\s*:\s*"([\d.\-]+)"/);
  if (latM && lonM) {
    return { lat: parseFloat(latM[1]), lon: parseFloat(lonM[1]) };
  }
  return { lat: null, lon: null };
}

function extractSpec(html: string, label: string): string | null {
  const m = html.match(
    new RegExp(`<label>\\s*${label}\\s*</label>\\s*([^<]+)`, "i")
  );
  return m?.[1]?.trim() ?? null;
}

function extractSpecs(html: string): {
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  sqft: number | null;
  sqftConvertedFromSqm: boolean;
  neighborhoodRaw: string | null;
} {
  const bedroomsRaw = extractSpec(html, "Bed\\(s\\):");
  const bathroomsRaw = extractSpec(html, "Bath\\(s\\):");
  const sleepsRaw = extractSpec(html, "Sleeps\\(s\\):");
  const squareRaw = extractSpec(html, "Square Space:");
  const areaRaw = extractSpec(html, "Area:");

  const bedrooms = bedroomsRaw != null ? parseInt(bedroomsRaw, 10) : null;
  const bathrooms = bathroomsRaw != null ? parseFloat(bathroomsRaw) : null;
  const maxGuests = sleepsRaw != null ? parseInt(sleepsRaw, 10) : null;

  const { sqft, convertedFromSqm } = parseSqft(squareRaw);

  return {
    bedrooms: bedrooms != null && !isNaN(bedrooms) ? bedrooms : null,
    bathrooms: bathrooms != null && !isNaN(bathrooms) ? bathrooms : null,
    maxGuests: maxGuests != null && !isNaN(maxGuests) ? maxGuests : null,
    sqft,
    sqftConvertedFromSqm: convertedFromSqm,
    neighborhoodRaw: areaRaw,
  };
}

function extractAmenities(html: string): string[] {
  const amenities: string[] = [];
  const blocks = html.matchAll(/<li[^>]*property-amenities[^>]*>[\s\S]*?<\/li>/gi);
  for (const block of blocks) {
    const m = block[0].match(/<i[^>]*><\/i>\s*([^<\n]+)/i);
    if (m?.[1]) {
      const text = m[1].trim();
      if (text) amenities.push(text);
    }
  }
  return amenities;
}

function extractRates(html: string): { nightlyPriceUsd: number | null; minNights: number | null } {
  const tableM = html.match(/<div[^>]*id="rates-table"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) return { nightlyPriceUsd: null, minNights: null };

  const rows = tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  let isFirst = true;
  for (const row of rows) {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map((c) => c[1].replace(/<[^>]+>/g, "").trim());

    if (cells.length < 4) continue;
    if (isFirst) { isFirst = false; continue; }

    const priceM = cells[1]?.match(/\$\s*([\d,]+\.?\d*)/);
    const minM = cells[4]?.match(/^\d+$/);

    const nightlyPriceUsd = priceM ? parseFloat(priceM[1].replace(/,/g, "")) : null;
    const minNights = minM ? parseInt(cells[4], 10) : null;

    if (nightlyPriceUsd && nightlyPriceUsd > 0) {
      return { nightlyPriceUsd, minNights };
    }
  }
  return { nightlyPriceUsd: null, minNights: null };
}

function extractReviews(html: string): { ratingOverall: number | null; reviewCount: number | null } {
  const countM = html.match(/<h3[^>]*id="reviews"[^>]*>\s*(\d+)\s*Reviews?\s*<\/h3>/i);
  const ratingM = html.match(/(\d+\.\d+)\s*&#183;\s*(\d+)\s*Customer\s*Reviews?/i);

  const reviewCount = countM ? parseInt(countM[1], 10) : ratingM ? parseInt(ratingM[2], 10) : null;
  const ratingOverall = ratingM ? parseFloat(ratingM[1]) : null;

  return { ratingOverall, reviewCount };
}

// ── QA types ──────────────────────────────────────────────────────────────────

interface IngestResult {
  url: string;
  slug: string;
  neighborhoodSlug: string;
  neighborhoodNormalized: string;
  title: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  nightlyPriceUsd: number | null;
  sqft: number | null;
  sqftConvertedFromSqm: boolean;
  distanceToBeachM: number | null;
  amenitiesRaw: string[];
  amenitiesNormalized: string[];
  buildingName: string | null;
  ratingOverall: number | null;
  reviewCount: number | null;
  lat: number | null;
  lon: number | null;
  confidence: number;
  dbId: number | null;
  error: string | null;
  warnings: string[];
}

// ── Listing URL collection ────────────────────────────────────────────────────

async function collectListingUrls(): Promise<string[]> {
  const allUrls: string[] = [];
  const seen = new Set<string>();
  let page = 1;

  console.log("Collecting listing URLs from index pages...");

  // Fetch enough pages to exceed MAX_LISTINGS (30 listings/page)
  const maxPages = Math.ceil((MAX_LISTINGS * 2) / 30) + 2;

  while (allUrls.length < MAX_LISTINGS * 2 && page <= maxPages) {
    const indexUrl = `${BASE_URL}/puerto-vallarta/?page=${(page - 1) * 30}`;
    console.log(`  Fetching index page ${page}: ${indexUrl}`);

    try {
      const html = await fetchHtml(indexUrl);
      const urls = extractListingUrls(html);
      let added = 0;
      for (const u of urls) {
        if (!seen.has(u)) {
          seen.add(u);
          allUrls.push(u);
          added++;
        }
      }
      console.log(`    → Found ${urls.length} target listings (+${added} new). Total: ${allUrls.length}`);
    } catch (e) {
      console.warn(`    ⚠ Failed to fetch page ${page}: ${e}`);
    }

    await sleep(MIN_DELAY_MS);
    page++;
  }

  // Prioritize: marina-vallarta first (least represented), then amapas/ZR
  const PRIO = ["marina-vallarta", "amapas", "conchas-chinas", "old-town", "los-muertos-beach"];
  allUrls.sort((a, b) => {
    const na = extractNeighborhoodSlug(a);
    const nb = extractNeighborhoodSlug(b);
    const ia = PRIO.indexOf(na);
    const ib = PRIO.indexOf(nb);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return allUrls.slice(0, MAX_LISTINGS);
}

// ── Scrape + ingest a single listing ─────────────────────────────────────────

async function scrapeListing(url: string): Promise<IngestResult> {
  const slug = extractSlug(url);
  const neighborhoodSlug = extractNeighborhoodSlug(url);
  const result: IngestResult = {
    url,
    slug,
    neighborhoodSlug,
    neighborhoodNormalized: "unclassified",
    title: null,
    bedrooms: null,
    bathrooms: null,
    maxGuests: null,
    nightlyPriceUsd: null,
    sqft: null,
    sqftConvertedFromSqm: false,
    distanceToBeachM: null,
    amenitiesRaw: [],
    amenitiesNormalized: [],
    buildingName: null,
    ratingOverall: null,
    reviewCount: null,
    lat: null,
    lon: null,
    confidence: 0,
    dbId: null,
    error: null,
    warnings: [],
  };

  let html: string;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    result.error = `Fetch failed: ${e}`;
    return result;
  }

  // ── Parse all fields ──
  const title = extractTitle(html);
  const { lat, lon } = extractLatLon(html);
  const specs = extractSpecs(html);
  const amenitiesRaw = extractAmenities(html);
  const { nightlyPriceUsd, minNights } = extractRates(html);
  const { ratingOverall, reviewCount } = extractReviews(html);
  const buildingName = buildingNameFromSlug(slug);
  const distanceToBeachM = distanceToNearestBeachM(lat, lon);

  const neighborhoodRaw = specs.neighborhoodRaw ?? neighborhoodSlug;
  const neighborhoodNormalized = normalizeNeighborhood(neighborhoodRaw);
  const amenitiesNormalized = normalizeAmenities(amenitiesRaw);

  // ── Warnings ──
  const warnings: string[] = [];
  if (neighborhoodNormalized === "unclassified")
    warnings.push(`Neighborhood not recognized: "${neighborhoodRaw}"`);
  if (specs.bedrooms == null) warnings.push("bedrooms missing");
  if (specs.bathrooms == null) warnings.push("bathrooms missing");
  if (nightlyPriceUsd == null) warnings.push("nightly_price_usd missing");
  if (lat == null) warnings.push("latitude missing");
  if (specs.sqft == null) warnings.push("sqft missing");
  if (specs.sqftConvertedFromSqm) warnings.push("sqft converted from sqm (no explicit ft² on listing)");
  if (amenitiesNormalized.length === 0) warnings.push("no amenities normalized");

  // ── Confidence ──
  const confidence = computeConfidence({
    title,
    sourceUrl: url,
    neighborhoodNormalized,
    bedrooms: specs.bedrooms,
    bathrooms: specs.bathrooms,
    nightlyPriceUsd,
    ratingOverall,
    reviewCount,
    latitude: lat,
    longitude: lon,
    maxGuests: specs.maxGuests,
    amenitiesNormalized,
  });

  // ── Populate result ──
  result.title = title;
  result.neighborhoodNormalized = neighborhoodNormalized;
  result.bedrooms = specs.bedrooms;
  result.bathrooms = specs.bathrooms;
  result.maxGuests = specs.maxGuests;
  result.nightlyPriceUsd = nightlyPriceUsd;
  result.sqft = specs.sqft;
  result.sqftConvertedFromSqm = specs.sqftConvertedFromSqm;
  result.distanceToBeachM = distanceToBeachM;
  result.amenitiesRaw = amenitiesRaw;
  result.amenitiesNormalized = amenitiesNormalized;
  result.buildingName = buildingName || null;
  result.ratingOverall = ratingOverall;
  result.reviewCount = reviewCount;
  result.lat = lat;
  result.lon = lon;
  result.confidence = confidence;
  result.warnings = warnings;

  // ── Upsert into DB ──
  try {
    const [row] = await db
      .insert(rentalListingsTable)
      .values({
        sourcePlatform: SOURCE_PLATFORM,
        sourceUrl: url,
        externalId: slug,
        title: title ?? slug,
        neighborhoodRaw,
        neighborhoodNormalized,
        buildingName: buildingName || null,
        latitude: lat,
        longitude: lon,
        distanceToBeachM,
        bedrooms: specs.bedrooms ?? 0,
        bathrooms: specs.bathrooms ?? 0,
        maxGuests: specs.maxGuests,
        sqft: specs.sqft,
        amenitiesRaw: amenitiesRaw.length > 0 ? amenitiesRaw : null,
        amenitiesNormalized: amenitiesNormalized.length > 0 ? amenitiesNormalized : null,
        ratingOverall,
        ratingCount: reviewCount,
        reviewCount,
        reviewSentimentScore: null,
        nightlyPriceUsd,
        cleaningFeeUsd: null,
        minNights,
        scrapedAt: new Date(),
        dataConfidenceScore: confidence,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
        set: {
          title: sql`excluded.title`,
          neighborhoodRaw: sql`excluded.neighborhood_raw`,
          neighborhoodNormalized: sql`excluded.neighborhood_normalized`,
          buildingName: sql`excluded.building_name`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          distanceToBeachM: sql`excluded.distance_to_beach_m`,
          // Preserve known attribute values when re-scraping. PVRPV's HTML
          // sometimes drops the "Bed(s):" / "Bath(s):" markers on partial
          // detail pages, in which case `specs.bedrooms` falls back to the
          // 0-default at insert. Without GREATEST, a re-scrape of a stale
          // page would erase a real value previously written by a richer
          // crawl (or by a Phase 2d-ext airbnb back-write into the same
          // sourceUrl key). Same rationale as rental-ingest.ts.
          bedrooms: sql`GREATEST(${rentalListingsTable.bedrooms}, excluded.bedrooms)`,
          bathrooms: sql`GREATEST(${rentalListingsTable.bathrooms}, excluded.bathrooms)`,
          maxGuests: sql`COALESCE(${rentalListingsTable.maxGuests}, excluded.max_guests)`,
          sqft: sql`excluded.sqft`,
          amenitiesRaw: sql`excluded.amenities_raw`,
          amenitiesNormalized: sql`excluded.amenities_normalized`,
          ratingOverall: sql`excluded.rating_overall`,
          ratingCount: sql`excluded.rating_count`,
          reviewCount: sql`excluded.review_count`,
          nightlyPriceUsd: sql`excluded.nightly_price_usd`,
          minNights: sql`excluded.min_nights`,
          scrapedAt: sql`excluded.scraped_at`,
          dataConfidenceScore: sql`excluded.data_confidence_score`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: rentalListingsTable.id });

    result.dbId = row?.id ?? null;
  } catch (e) {
    result.error = `DB insert failed: ${e}`;
  }

  return result;
}

// ── QA report ─────────────────────────────────────────────────────────────────

function printQAReport(results: IngestResult[]): void {
  const succeeded = results.filter((r) => r.dbId != null);
  const failed = results.filter((r) => r.error != null);
  const n = succeeded.length;
  const pct = (k: number) => `${k}/${n} (${n > 0 ? Math.round((k / n) * 100) : 0}%)`;

  console.log("\n" + "═".repeat(70));
  console.log("PVRPV SCRAPE — QA REPORT");
  console.log("═".repeat(70));
  console.log(`Total attempted:         ${results.length}`);
  console.log(`Successfully ingested:   ${n}`);
  console.log(`Failed (fetch/DB error): ${failed.length}`);

  // ── By neighborhood ──────────────────────────────────────────────────────
  const byNeighborhood: Record<string, number> = {};
  for (const r of succeeded) {
    byNeighborhood[r.neighborhoodNormalized] = (byNeighborhood[r.neighborhoodNormalized] ?? 0) + 1;
  }
  console.log("\n── By normalized neighborhood ──");
  for (const [n, c] of Object.entries(byNeighborhood).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.padEnd(25)} ${c}`);
  }

  // ── Field coverage ───────────────────────────────────────────────────────
  const hasBedrooms = succeeded.filter((r) => r.bedrooms != null).length;
  const hasBathrooms = succeeded.filter((r) => r.bathrooms != null).length;
  const hasPrice = succeeded.filter((r) => r.nightlyPriceUsd != null).length;
  const hasAmenities = succeeded.filter((r) => r.amenitiesNormalized.length > 0).length;
  const hasBuilding = succeeded.filter((r) => r.buildingName != null).length;
  const hasRating = succeeded.filter((r) => r.ratingOverall != null).length;
  const hasReviews = succeeded.filter((r) => r.reviewCount != null).length;
  const hasLatLon = succeeded.filter((r) => r.lat != null && r.lon != null).length;
  const hasSqft = succeeded.filter((r) => r.sqft != null).length;
  const hasSqftDirect = succeeded.filter((r) => r.sqft != null && !r.sqftConvertedFromSqm).length;
  const hasSqftConverted = succeeded.filter((r) => r.sqft != null && r.sqftConvertedFromSqm).length;
  const hasBeachDist = succeeded.filter((r) => r.distanceToBeachM != null).length;

  console.log("\n── Field coverage (of successfully ingested) ──");
  console.log(`  bedrooms:              ${pct(hasBedrooms)}`);
  console.log(`  bathrooms:             ${pct(hasBathrooms)}`);
  console.log(`  nightly_price_usd:     ${pct(hasPrice)}`);
  console.log(`  amenities (≥1 norm.):  ${pct(hasAmenities)}`);
  console.log(`  building_name:         ${pct(hasBuilding)}`);
  console.log(`  rating_overall:        ${pct(hasRating)}`);
  console.log(`  review_count:          ${pct(hasReviews)}`);
  console.log(`  latitude / longitude:  ${pct(hasLatLon)}`);
  console.log(`  sqft (total):          ${pct(hasSqft)}`);
  console.log(`    ↳ direct ft² parse:  ${hasSqftDirect}`);
  console.log(`    ↳ converted from m²: ${hasSqftConverted}`);
  console.log(`  distance_to_beach_m:   ${pct(hasBeachDist)}`);

  // ── Avg normalized amenities per listing ─────────────────────────────────
  const avgAmenities =
    succeeded.reduce((a, r) => a + r.amenitiesNormalized.length, 0) / (n || 1);
  const avgRaw = succeeded.reduce((a, r) => a + r.amenitiesRaw.length, 0) / (n || 1);
  console.log(
    `\n  Avg normalized amenity keys/listing: ${avgAmenities.toFixed(1)}` +
    ` (raw labels scraped: ${avgRaw.toFixed(1)} avg)`
  );

  // ── Top amenities by frequency ───────────────────────────────────────────
  const amenityFreq: Record<string, number> = {};
  for (const r of succeeded) {
    for (const k of r.amenitiesNormalized) {
      amenityFreq[k] = (amenityFreq[k] ?? 0) + 1;
    }
  }
  const sortedAmenities = Object.entries(amenityFreq).sort((a, b) => b[1] - a[1]);
  console.log("\n── Top normalized amenities (by frequency) ──");
  for (const [key, count] of sortedAmenities.slice(0, 20)) {
    const bar = "█".repeat(Math.round((count / n) * 20));
    console.log(`  ${key.padEnd(22)} ${String(count).padStart(3)}  ${bar} ${Math.round((count / n) * 100)}%`);
  }

  // ── Unmatched raw amenity labels ─────────────────────────────────────────
  const unmatchedFreq: Record<string, number> = {};
  for (const r of succeeded) {
    for (const raw of r.amenitiesRaw) {
      const normalized = AMENITY_ALIAS_MAP[raw.trim().toLowerCase()];
      if (!normalized) {
        unmatchedFreq[raw] = (unmatchedFreq[raw] ?? 0) + 1;
      }
    }
  }
  const topUnmatched = Object.entries(unmatchedFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  if (topUnmatched.length > 0) {
    console.log("\n── Unmatched raw amenity labels (top 20) ──");
    for (const [label, count] of topUnmatched) {
      console.log(`  [${String(count).padStart(2)}] "${label}"`);
    }
  }

  // ── Avg price by neighborhood & bedrooms ─────────────────────────────────
  console.log("\n── Avg nightly price by neighborhood + bedrooms ──");
  type PriceGroup = { prices: number[]; count: number };
  const priceGroups: Record<string, PriceGroup> = {};
  for (const r of succeeded) {
    if (r.nightlyPriceUsd == null || r.bedrooms == null) continue;
    const key = `${r.neighborhoodNormalized} | ${r.bedrooms}BR`;
    if (!priceGroups[key]) priceGroups[key] = { prices: [], count: 0 };
    priceGroups[key].prices.push(r.nightlyPriceUsd);
    priceGroups[key].count++;
  }
  const priceRows = Object.entries(priceGroups)
    .map(([k, g]) => ({
      key: k,
      count: g.count,
      avg: Math.round(g.prices.reduce((a, b) => a + b, 0) / g.count),
      min: Math.round(Math.min(...g.prices)),
      max: Math.round(Math.max(...g.prices)),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  console.log("  " + "Group".padEnd(35) + "N".padStart(4) + "  Avg".padStart(6) + "  Min".padStart(6) + "  Max".padStart(6));
  console.log("  " + "─".repeat(58));
  for (const row of priceRows) {
    console.log(
      `  ${row.key.padEnd(35)}${String(row.count).padStart(4)}` +
      `  $${String(row.avg).padStart(5)}  $${String(row.min).padStart(5)}  $${String(row.max).padStart(5)}`
    );
  }

  // ── Beach distance stats ─────────────────────────────────────────────────
  const beachDists = succeeded.filter((r) => r.distanceToBeachM != null).map((r) => r.distanceToBeachM!);
  if (beachDists.length > 0) {
    const avgDist = Math.round(beachDists.reduce((a, b) => a + b, 0) / beachDists.length);
    const minDist = Math.round(Math.min(...beachDists));
    const maxDist = Math.round(Math.max(...beachDists));
    const under500 = beachDists.filter((d) => d <= 500).length;
    const under1000 = beachDists.filter((d) => d <= 1000).length;
    console.log("\n── Beach distance (straight-line) ──");
    console.log(`  Average:          ${avgDist}m`);
    console.log(`  Nearest:          ${minDist}m`);
    console.log(`  Farthest:         ${maxDist}m`);
    console.log(`  ≤500m (5 min):    ${under500}/${beachDists.length} listings`);
    console.log(`  ≤1000m (12 min):  ${under1000}/${beachDists.length} listings`);
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const scores = succeeded.map((r) => r.confidence);
  const avgConf = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const minConf = Math.min(...scores);
  const maxConf = Math.max(...scores);
  console.log("\n── Data confidence score ──");
  console.log(`  Average:  ${avgConf.toFixed(3)}`);
  console.log(`  Min:      ${minConf.toFixed(3)}`);
  console.log(`  Max:      ${maxConf.toFixed(3)}`);

  // ── Low-confidence listings ──────────────────────────────────────────────
  const lowConf = succeeded.filter((r) => r.confidence < 0.90);
  if (lowConf.length > 0) {
    console.log(`\n── Listings below 0.90 confidence (${lowConf.length} total) ──`);
    for (const r of lowConf.sort((a, b) => a.confidence - b.confidence)) {
      console.log(`\n  [${r.confidence.toFixed(3)}] ${r.slug}`);
      console.log(`    Neighborhood: ${r.neighborhoodNormalized}  Bedrooms: ${r.bedrooms ?? "?"}  Price: $${r.nightlyPriceUsd ?? "?"}`);
      if (r.warnings.length > 0) console.log(`    Warnings: ${r.warnings.join(" | ")}`);
    }
  }

  // ── Failures ────────────────────────────────────────────────────────────
  if (failed.length > 0) {
    console.log(`\n── Failed listings (${failed.length}) ──`);
    for (const r of failed) {
      console.log(`  ${r.slug}: ${r.error}`);
    }
  }

  console.log("\n" + "═".repeat(70));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  PVRPV Scraper — VallartaPulse                              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Target: up to ${MAX_LISTINGS} listings from: old-town, los-muertos-beach, amapas, conchas-chinas, marina-vallarta`);
  console.log(`Amenity alias map: ${Object.keys(AMENITY_ALIAS_MAP).length} entries`);
  console.log(`Beach reference points: ${BEACH_POINTS.length}`);
  console.log();

  const urls = await collectListingUrls();
  console.log(`\nCollected ${urls.length} target listing URLs to process.\n`);

  const results: IngestResult[] = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const slug = extractSlug(url);
    const neighborhoodSlug = extractNeighborhoodSlug(url);
    const shortSlug = slug.length > 42 ? slug.slice(0, 42) + "…" : slug;

    process.stdout.write(`[${String(i + 1).padStart(3)}/${urls.length}] ${neighborhoodSlug}/${shortSlug}... `);

    const result = await scrapeListing(url);
    results.push(result);

    if (result.error) {
      console.log(`✗ ERROR: ${result.error}`);
    } else {
      const sqftStr = result.sqft != null
        ? ` sqft=${result.sqft}${result.sqftConvertedFromSqm ? "(conv)" : ""}`
        : "";
      const distStr = result.distanceToBeachM != null
        ? ` beach=${result.distanceToBeachM}m`
        : "";
      console.log(
        `✓ id=${result.dbId} ${result.bedrooms}BR $${result.nightlyPriceUsd}` +
        ` amen=${result.amenitiesNormalized.length}/${result.amenitiesRaw.length}` +
        `${sqftStr}${distStr} conf=${result.confidence.toFixed(2)}`
      );
    }

    if (i < urls.length - 1) await sleep(MIN_DELAY_MS);
  }

  printQAReport(results);
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
