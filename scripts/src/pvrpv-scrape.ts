/**
 * pvrpv-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * First-pass PVRPV listing scraper.
 *
 * Fetches 25–50 listings from pvrpv.com, parses each detail page,
 * normalizes the data, and ingests into rental_listings via Drizzle.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/pvrpv-scrape.ts
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
const MAX_LISTINGS = 50;
const MIN_DELAY_MS = 1200; // be polite

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

// ── Inlined normalization (mirrors rental-normalize.ts) ───────────────────────

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

const AMENITY_ALIAS_MAP: Record<string, string> = {
  "private pool": "private_pool",
  "private swimming pool": "private_pool",
  "pool - private": "private_pool",
  "shared pool": "shared_pool",
  "community pool": "shared_pool",
  "building pool": "shared_pool",
  "pool - shared": "shared_pool",
  pool: "shared_pool",
  "hot tub": "hot_tub",
  jacuzzi: "hot_tub",
  whirlpool: "hot_tub",
  "rooftop pool": "shared_pool",
  "infinity pool": "shared_pool",
  beachfront: "beachfront",
  "on the beach": "beachfront",
  "beach access": "beach_access",
  "near beach": "beach_access",
  "ocean view": "ocean_view",
  "sea view": "ocean_view",
  "bay view": "ocean_view",
  "ocean views": "ocean_view",
  "mountain view": "mountain_view",
  "jungle view": "mountain_view",
  "garden view": "mountain_view",
  "full kitchen": "full_kitchen",
  kitchen: "full_kitchen",
  "fully equipped kitchen": "full_kitchen",
  kitchenette: "kitchenette",
  "mini kitchen": "kitchenette",
  washer: "washer_dryer",
  dryer: "washer_dryer",
  "washer/dryer": "washer_dryer",
  "washer & dryer": "washer_dryer",
  laundry: "washer_dryer",
  "laundry - washer (in unit)": "washer_dryer",
  "laundry - dryer (in unit)": "washer_dryer",
  "air conditioning": "air_conditioning",
  "climate control (air conditioning)": "air_conditioning",
  ac: "air_conditioning",
  "a/c": "air_conditioning",
  "central air": "air_conditioning",
  wifi: "wifi",
  "wi-fi": "wifi",
  internet: "wifi",
  "high-speed wifi": "wifi",
  gated: "gated_community",
  "gated community": "gated_community",
  "gated complex": "gated_community",
  "24hr security": "gated_community",
  "24-hour security": "gated_community",
  "security (24 hours)": "gated_community",
  parking: "parking",
  "parking (in complex)": "parking",
  "free parking": "parking",
  terrace: "rooftop_terrace",
  rooftop: "rooftop_terrace",
  "outdoor space (patio / deck)": "rooftop_terrace",
  "balcony / terrace": "rooftop_terrace",
  patio: "rooftop_terrace",
  balcony: "rooftop_terrace",
  "pets allowed": "pet_friendly",
  "pet friendly": "pet_friendly",
  "workspace": "dedicated_workspace",
  "dedicated workspace": "dedicated_workspace",
  desk: "dedicated_workspace",
};

function normalizeAmenities(rawList: string[]): string[] {
  const keys = new Set<string>();
  for (const item of rawList) {
    const key = AMENITY_ALIAS_MAP[item.trim().toLowerCase()];
    if (key) keys.add(key);
  }
  return Array.from(keys).sort();
}

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
  // Handles both name= and property= meta tags
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
  // https://www.pvrpv.com/puerto-vallarta/{neighborhood}/{type}/{slug}
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
 * "molino-de-agua-605" → "Molino De Agua"
 * "v-golf-803" → "V Golf"
 */
function buildingNameFromSlug(slug: string): string {
  // Split on "-unit-", "-ph", "-pent", "-studio", digit-only run at end
  const stripped = slug
    .replace(/-unit-.*$/, "")
    .replace(/-ph\d.*$/, "")
    .replace(/-\d+[a-z]?$/, "")   // trailing number like -803, -405, -306
    .replace(/-\d+$/, "");

  return stripped
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
    .trim();
}

/** Parse the og:title to get a clean listing title. */
function extractTitle(html: string): string | null {
  const raw = extractMeta(html, "og:title");
  if (!raw) return null;
  // "Paramount Bay - Villa Serena unit 407C in Amapas, Puerto Vallarta - Condo in Puerto Vallarta"
  // Strip " - Condo in Puerto Vallarta" / " - Studio in Puerto Vallarta" / " - Penthouse in ..."  suffix
  return raw
    .replace(/\s*-\s*(Condo|Studio|Penthouse|House|Villa|Apartment)\s+in\s+Puerto\s+Vallarta.*$/i, "")
    .trim();
}

/** Extract lat/lon from meta geo.position ("lat;lon") or JSON-LD. */
function extractLatLon(html: string): { lat: number | null; lon: number | null } {
  // <meta name="geo.position" content="20.595016064461056;-105.238514870108890" />
  const geoPos = extractMeta(html, "geo.position");
  if (geoPos) {
    const [latStr, lonStr] = geoPos.split(";");
    const lat = parseFloat(latStr ?? "");
    const lon = parseFloat(lonStr ?? "");
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
  }
  // Fallback: JSON-LD
  const latM = html.match(/"latitude"\s*:\s*"([\d.\-]+)"/);
  const lonM = html.match(/"longitude"\s*:\s*"([\d.\-]+)"/);
  if (latM && lonM) {
    return { lat: parseFloat(latM[1]), lon: parseFloat(lonM[1]) };
  }
  return { lat: null, lon: null };
}

/**
 * Extract property specs from the About tab.
 * Looks for <label>Key:</label> Value patterns.
 */
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

  // "224.38 Square Meter/ 2414.33  Square Feet" → take feet value
  let sqft: number | null = null;
  if (squareRaw) {
    const feetM = squareRaw.match(/([\d,]+\.?\d*)\s*Square\s*Feet/i);
    if (feetM) sqft = parseFloat(feetM[1].replace(/,/g, ""));
  }

  return {
    bedrooms: !isNaN(bedrooms!) ? bedrooms : null,
    bathrooms: !isNaN(bathrooms!) ? bathrooms : null,
    maxGuests: !isNaN(maxGuests!) ? maxGuests : null,
    sqft,
    neighborhoodRaw: areaRaw,
  };
}

/** Extract all amenity strings from .property-amenities li elements. */
function extractAmenities(html: string): string[] {
  const amenities: string[] = [];
  // Match each property-amenities block
  const blocks = html.matchAll(/<li[^>]*property-amenities[^>]*>[\s\S]*?<\/li>/gi);
  for (const block of blocks) {
    // Get text inside icon-box div, after the <i> icon tag
    const m = block[0].match(/<i[^>]*><\/i>\s*([^<\n]+)/i);
    if (m?.[1]) {
      const text = m[1].trim();
      if (text) amenities.push(text);
    }
  }
  return amenities;
}

/**
 * Extract nightly price and min nights from the FIRST upcoming rates row.
 * Returns the most current/first-listed rate.
 */
function extractRates(html: string): { nightlyPriceUsd: number | null; minNights: number | null } {
  // Find the rates table
  const tableM = html.match(/<div[^>]*id="rates-table"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) return { nightlyPriceUsd: null, minNights: null };

  // Find first data row (after header row)
  const rows = tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  let isFirst = true;
  for (const row of rows) {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi))
      .map((c) => c[1].replace(/<[^>]+>/g, "").trim());

    if (cells.length < 4) continue;
    if (isFirst) { isFirst = false; continue; } // skip header-like rows

    // cells[1] = "$ 330.00 USD" (nightly), cells[4] = min nights
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

/** Extract rating and review count from the reviews tab. */
function extractReviews(html: string): { ratingOverall: number | null; reviewCount: number | null } {
  // <h3 id="reviews"> 23 Reviews</h3>
  const countM = html.match(/<h3[^>]*id="reviews"[^>]*>\s*(\d+)\s*Reviews?\s*<\/h3>/i);
  // <p>... 4.7 · 23 Customer Reviews</p>
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
  amenitiesCount: number;
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

// ── Main scrape + ingest logic ────────────────────────────────────────────────

async function collectListingUrls(): Promise<string[]> {
  const allUrls: string[] = [];
  const seen = new Set<string>();
  let page = 1;

  console.log("Collecting listing URLs from index pages...");

  while (allUrls.length < MAX_LISTINGS * 2 && page <= 6) {
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

  // Prioritize preferred neighborhoods
  const PRIO = ["amapas", "conchas-chinas", "old-town", "los-muertos-beach", "marina-vallarta"];
  allUrls.sort((a, b) => {
    const na = extractNeighborhoodSlug(a);
    const nb = extractNeighborhoodSlug(b);
    return PRIO.indexOf(na) - PRIO.indexOf(nb);
  });

  return allUrls.slice(0, MAX_LISTINGS);
}

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
    amenitiesCount: 0,
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

  // ── Extract all fields ──
  const title = extractTitle(html);
  const { lat, lon } = extractLatLon(html);
  const specs = extractSpecs(html);
  const amenitiesRaw = extractAmenities(html);
  const { nightlyPriceUsd, minNights } = extractRates(html);
  const { ratingOverall, reviewCount } = extractReviews(html);
  const buildingName = buildingNameFromSlug(slug);

  // neighborhood_raw: prefer "Area:" field, fall back to URL slug
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

  // ── Populate result for QA ──
  result.title = title;
  result.neighborhoodNormalized = neighborhoodNormalized;
  result.bedrooms = specs.bedrooms;
  result.bathrooms = specs.bathrooms;
  result.maxGuests = specs.maxGuests;
  result.nightlyPriceUsd = nightlyPriceUsd;
  result.amenitiesCount = amenitiesNormalized.length;
  result.buildingName = buildingName || null;
  result.ratingOverall = ratingOverall;
  result.reviewCount = reviewCount;
  result.lat = lat;
  result.lon = lon;
  result.confidence = confidence;
  result.warnings = warnings;

  // ── Insert into DB ──
  try {
    const [row] = await db
      .insert(rentalListingsTable)
      .values({
        sourcePlatform: SOURCE_PLATFORM,
        sourceUrl: url,
        externalId: slug,
        title: title ?? slug,
        neighborhoodRaw: neighborhoodRaw,
        neighborhoodNormalized,
        buildingName: buildingName || null,
        latitude: lat,
        longitude: lon,
        distanceToBeachM: null,
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
          bedrooms: sql`excluded.bedrooms`,
          bathrooms: sql`excluded.bathrooms`,
          maxGuests: sql`excluded.max_guests`,
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

  console.log("\n" + "═".repeat(70));
  console.log("PVRPV SCRAPE — QA REPORT");
  console.log("═".repeat(70));
  console.log(`Total attempted:         ${results.length}`);
  console.log(`Successfully ingested:   ${succeeded.length}`);
  console.log(`Failed (fetch/DB error): ${failed.length}`);

  // Breakdown by neighborhood
  const byNeighborhood: Record<string, number> = {};
  for (const r of succeeded) {
    byNeighborhood[r.neighborhoodNormalized] = (byNeighborhood[r.neighborhoodNormalized] ?? 0) + 1;
  }
  console.log("\n── By normalized neighborhood ──");
  for (const [n, c] of Object.entries(byNeighborhood).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.padEnd(25)} ${c}`);
  }

  // Field coverage
  const hasBedrooms = succeeded.filter((r) => r.bedrooms != null).length;
  const hasBathrooms = succeeded.filter((r) => r.bathrooms != null).length;
  const hasPrice = succeeded.filter((r) => r.nightlyPriceUsd != null).length;
  const hasAmenities = succeeded.filter((r) => r.amenitiesCount > 0).length;
  const hasBuilding = succeeded.filter((r) => r.buildingName != null).length;
  const hasRating = succeeded.filter((r) => r.ratingOverall != null).length;
  const hasReviews = succeeded.filter((r) => r.reviewCount != null).length;
  const hasLatLon = succeeded.filter((r) => r.lat != null && r.lon != null).length;

  console.log("\n── Field coverage (of successfully ingested) ──");
  const pct = (n: number) => `${n}/${succeeded.length} (${Math.round((n / succeeded.length) * 100)}%)`;
  console.log(`  bedrooms:              ${pct(hasBedrooms)}`);
  console.log(`  bathrooms:             ${pct(hasBathrooms)}`);
  console.log(`  nightly_price_usd:     ${pct(hasPrice)}`);
  console.log(`  amenities (≥1):        ${pct(hasAmenities)}`);
  console.log(`  building_name:         ${pct(hasBuilding)}`);
  console.log(`  rating_overall:        ${pct(hasRating)}`);
  console.log(`  review_count:          ${pct(hasReviews)}`);
  console.log(`  latitude / longitude:  ${pct(hasLatLon)}`);

  // Confidence stats
  const scores = succeeded.map((r) => r.confidence);
  const avgConf = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const minConf = Math.min(...scores);
  const maxConf = Math.max(...scores);
  console.log("\n── Data confidence score ──");
  console.log(`  Average:  ${avgConf.toFixed(3)}`);
  console.log(`  Min:      ${minConf.toFixed(3)}`);
  console.log(`  Max:      ${maxConf.toFixed(3)}`);

  // Low confidence listings
  const lowConf = succeeded.filter((r) => r.confidence < 0.7);
  if (lowConf.length > 0) {
    console.log(`\n── Low-confidence listings (< 0.70) — ${lowConf.length} total ──`);
    for (const r of lowConf.sort((a, b) => a.confidence - b.confidence)) {
      console.log(`\n  [${r.confidence.toFixed(3)}] ${r.slug}`);
      console.log(`    Title: ${r.title ?? "(none)"}`);
      console.log(`    Neighborhood: ${r.neighborhoodNormalized}`);
      console.log(`    Bedrooms: ${r.bedrooms ?? "?"}, Price: ${r.nightlyPriceUsd ? `$${r.nightlyPriceUsd}` : "?"}`);
      if (r.warnings.length) console.log(`    Warnings: ${r.warnings.join(" | ")}`);
    }
  }

  // Errors
  if (failed.length > 0) {
    console.log(`\n── Errors ──`);
    for (const r of failed) {
      console.log(`  ${r.slug}: ${r.error}`);
    }
  }

  // Parsing issues summary
  const allWarningTypes: Record<string, number> = {};
  for (const r of succeeded) {
    for (const w of r.warnings) {
      const key = w.replace(/".*"/, '"<value>"');
      allWarningTypes[key] = (allWarningTypes[key] ?? 0) + 1;
    }
  }
  if (Object.keys(allWarningTypes).length > 0) {
    console.log("\n── Top parsing issues / field gaps ──");
    const sorted = Object.entries(allWarningTypes).sort((a, b) => b[1] - a[1]);
    for (const [issue, count] of sorted) {
      console.log(`  [${count}x] ${issue}`);
    }
  }

  console.log("\n" + "═".repeat(70));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  PVRPV First-Pass Scraper — VallartaPulse                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Target: up to ${MAX_LISTINGS} listings from ${[...TARGET_NEIGHBORHOODS].join(", ")}\n`);

  const urls = await collectListingUrls();
  console.log(`\nCollected ${urls.length} target listing URLs to process.\n`);

  const results: IngestResult[] = [];
  let i = 0;
  for (const url of urls) {
    i++;
    const slug = extractSlug(url);
    const neighborhood = extractNeighborhoodSlug(url);
    process.stdout.write(`[${String(i).padStart(2)}/${urls.length}] ${neighborhood}/${slug.slice(0, 40)}... `);

    const result = await scrapeListing(url);

    if (result.error) {
      console.log(`✗ ${result.error}`);
    } else {
      const priceStr = result.nightlyPriceUsd ? `$${result.nightlyPriceUsd}` : "no price";
      const bdStr = result.bedrooms != null ? `${result.bedrooms}BR` : "?BR";
      console.log(
        `✓ id=${result.dbId} ${bdStr} ${priceStr} conf=${result.confidence.toFixed(2)} ` +
          (result.warnings.length ? `⚠ ${result.warnings.length} warnings` : "")
      );
    }

    results.push(result);
    if (i < urls.length) await sleep(MIN_DELAY_MS);
  }

  printQAReport(results);

  // Close DB pool
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
