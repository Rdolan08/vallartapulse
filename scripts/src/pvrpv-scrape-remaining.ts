/**
 * pvrpv-scrape-remaining.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot script that fetches ONLY the PVRPV listings not yet in the DB.
 * Queries existing source_urls first, then skips them during the collection phase.
 * Safe to run multiple times (upserts).
 */

import { sql, inArray } from "drizzle-orm";
import { db, rentalListingsTable } from "@workspace/db";

const BASE_URL = "https://www.pvrpv.com";
const SOURCE_PLATFORM = "pvrpv";
const MIN_DELAY_MS = 700;

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

// ── Normalization (mirrors pvrpv-scrape.ts) ───────────────────────────────────

const NEIGHBORHOOD_MAP: Record<string, string> = {
  "zona romantica": "Zona Romantica", "zona romántica": "Zona Romantica",
  "romantic zone": "Zona Romantica", "old town": "Zona Romantica",
  "old-town": "Zona Romantica", "los muertos": "Zona Romantica",
  "los-muertos-beach": "Zona Romantica", "los muertos beach": "Zona Romantica",
  "olas altas": "Zona Romantica", "emiliano zapata": "Zona Romantica",
  "south side": "Zona Romantica", amapas: "Amapas",
  "conchas chinas": "Amapas", "conchas-chinas": "Amapas",
  "conchas chinas / amapas": "Amapas", "marina vallarta": "Marina Vallarta",
  "marina-vallarta": "Marina Vallarta", marina: "Marina Vallarta",
  "hotel zone": "Hotel Zone", "hotel-zone": "Hotel Zone",
  "north-hotel-zone": "Hotel Zone", "norte hotel zone": "Hotel Zone",
  "zona hotelera": "Hotel Zone", centro: "Centro",
  "el centro": "Centro", downtown: "Centro",
  "alta-vista": "Centro", "alta vista": "Centro",
  "el-caloso": "Centro", fluvial: "Centro",
  "5 de diciembre": "5 de Diciembre", "5-de-diciembre": "5 de Diciembre",
  "cinco de diciembre": "5 de Diciembre", versalles: "Versalles",
  versailles: "Versalles", pitillal: "Versalles",
};
function normalizeNeighborhood(raw: string): string {
  return NEIGHBORHOOD_MAP[raw.trim().toLowerCase().replace(/\s+/g, " ")] ?? "unclassified";
}

const AMENITY_ALIAS_MAP: Record<string, string> = {
  "private pool": "private_pool", "private swimming pool": "private_pool",
  "pool - private": "private_pool", "plunge pool": "private_pool",
  "shared pool": "shared_pool", "community pool": "shared_pool",
  "building pool": "shared_pool", "pool - shared": "shared_pool",
  "pool (in complex)": "shared_pool", "rooftop pool": "shared_pool",
  "infinity pool": "shared_pool", "heated pool": "shared_pool",
  "outdoor pool": "shared_pool", pool: "shared_pool",
  "hot tub": "hot_tub", jacuzzi: "hot_tub", whirlpool: "hot_tub", spa: "hot_tub",
  beachfront: "beachfront", "on the beach": "beachfront",
  "beach access": "beach_access", "near beach": "beach_access",
  "ocean view": "ocean_view", "sea view": "ocean_view", "bay view": "ocean_view",
  "ocean views": "ocean_view", "banderas bay view": "ocean_view",
  "mountain view": "mountain_view", "jungle view": "mountain_view",
  "full kitchen": "full_kitchen", kitchen: "full_kitchen",
  "fully equipped kitchen": "full_kitchen", cooktop: "full_kitchen",
  stove: "full_kitchen", oven: "full_kitchen", blender: "full_kitchen",
  "coffee maker": "full_kitchen", toaster: "full_kitchen",
  "coffee maker / kettle": "full_kitchen", kitchenette: "kitchenette",
  "mini kitchen": "kitchenette", dishwasher: "dishwasher",
  "bbq grill": "bbq_grill", "bbq grill (in unit)": "bbq_grill",
  bbq: "bbq_grill", barbecue: "bbq_grill", grill: "bbq_grill",
  washer: "washer_dryer", dryer: "washer_dryer", "washer/dryer": "washer_dryer",
  "washer & dryer": "washer_dryer", "washer & dryer (in unit)": "washer_dryer",
  laundry: "washer_dryer", "in-unit laundry": "washer_dryer",
  "laundry - washer (in unit)": "washer_dryer", "laundry - dryer (in unit)": "washer_dryer",
  "washing machine": "washer_dryer", iron: "iron", "ironing board": "iron",
  "iron & ironing board": "iron", "bed linens": "linens_provided",
  linens: "linens_provided", "linens provided": "linens_provided",
  towels: "linens_provided", "air conditioning": "air_conditioning",
  "climate control (air conditioning)": "air_conditioning",
  "central air conditioning": "air_conditioning", "mini split": "air_conditioning",
  "split ac": "air_conditioning", ac: "air_conditioning", "a/c": "air_conditioning",
  "ceiling fan": "ceiling_fan", "ceiling fans": "ceiling_fan",
  "climate control (ceiling fan)": "ceiling_fan",
  "smart tv": "smart_tv", tv: "smart_tv", television: "smart_tv",
  "cable tv": "smart_tv", streaming: "smart_tv", netflix: "smart_tv",
  wifi: "wifi", "wi-fi": "wifi", internet: "wifi", "high-speed wifi": "wifi",
  gated: "gated_community", "gated community": "gated_community",
  "gated complex": "gated_community", "24hr security": "gated_community",
  "24-hour security": "gated_community", "security (24 hours)": "gated_community",
  "security guard": "gated_community", doorman: "gated_community",
  "private entrance": "private_entrance",
  "private entrance (to the unit)": "private_entrance",
  "keypad entry": "private_entrance",
  parking: "parking", "parking (in complex)": "parking",
  "free parking": "parking", garage: "parking", "assigned parking": "parking",
  terrace: "rooftop_terrace", rooftop: "rooftop_terrace",
  "rooftop terrace": "rooftop_terrace", "outdoor space (patio / deck)": "rooftop_terrace",
  "balcony / terrace": "rooftop_terrace", patio: "rooftop_terrace",
  balcony: "rooftop_terrace", deck: "rooftop_terrace",
  elevator: "elevator", "elevator (in complex)": "elevator", lift: "elevator",
  "pets allowed": "pet_friendly", "pet friendly": "pet_friendly",
  "children permitted": "child_friendly", "family friendly": "child_friendly",
  workspace: "dedicated_workspace", "dedicated workspace": "dedicated_workspace",
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

// ── Beach distance ────────────────────────────────────────────────────────────

const BEACH_POINTS = [
  { lat: 20.6040, lon: -105.2382 }, { lat: 20.6055, lon: -105.2378 },
  { lat: 20.6178, lon: -105.2363 }, { lat: 20.5942, lon: -105.2354 },
  { lat: 20.6503, lon: -105.2393 }, { lat: 20.6620, lon: -105.2396 },
  { lat: 20.6848, lon: -105.2673 },
];
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180, φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180, Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function distanceToNearestBeachM(lat: number | null, lon: number | null): number | null {
  if (lat == null || lon == null) return null;
  let min = Infinity;
  for (const p of BEACH_POINTS) { const d = haversineM(lat, lon, p.lat, p.lon); if (d < min) min = d; }
  return Math.round(min);
}

// ── sqft parsing ──────────────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;
function parseSqft(raw: string | null): { sqft: number | null; convertedFromSqm: boolean } {
  if (!raw) return { sqft: null, convertedFromSqm: false };
  const feetM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Feet|sq\.?\s*ft\.?)/i);
  if (feetM) { const v = parseFloat(feetM[1].replace(/,/g, "")); if (!isNaN(v) && v > 0) return { sqft: Math.round(v), convertedFromSqm: false }; }
  const mM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Met(?:er|re)s?|m²|sq\.?\s*m\.?)/i);
  if (mM) { const v = parseFloat(mM[1].replace(/,/g, "")); if (!isNaN(v) && v > 0) return { sqft: Math.round(v * SQM_TO_SQFT), convertedFromSqm: true }; }
  return { sqft: null, convertedFromSqm: false };
}

// ── Confidence ────────────────────────────────────────────────────────────────

function computeConfidence(f: {
  title?: string | null; sourceUrl?: string | null; neighborhoodNormalized?: string | null;
  bedrooms?: number | null; bathrooms?: number | null; nightlyPriceUsd?: number | null;
  ratingOverall?: number | null; reviewCount?: number | null;
  latitude?: number | null; longitude?: number | null; maxGuests?: number | null;
  amenitiesNormalized?: string[] | null;
}): number {
  let s = 0;
  if (f.title?.trim()) s += 5; if (f.sourceUrl?.trim()) s += 5;
  if (f.neighborhoodNormalized && f.neighborhoodNormalized !== "unclassified") s += 10;
  if (f.bedrooms != null && f.bedrooms >= 0) s += 15; if (f.bathrooms != null && f.bathrooms > 0) s += 10;
  if (f.nightlyPriceUsd != null && f.nightlyPriceUsd > 0) s += 20;
  if (f.ratingOverall != null) s += 8; if (f.reviewCount != null) s += 7;
  if (f.latitude != null) s += 5; if (f.longitude != null) s += 5;
  if (f.maxGuests != null && f.maxGuests > 0) s += 5;
  if (f.amenitiesNormalized && f.amenitiesNormalized.length > 0) s += 5;
  return parseFloat((s / 100).toFixed(3));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Parsers ───────────────────────────────────────────────────────────────────

function extractMeta(html: string, p: string): string | null {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, "i"))
    ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, "i"));
  return m?.[1]?.trim() ?? null;
}
function extractListingUrls(html: string): string[] {
  const matches = html.matchAll(/href="(https:\/\/www\.pvrpv\.com\/puerto-vallarta\/([^/"?]+)\/[^/"?]+\/[^/"?]+)"/g);
  const seen = new Set<string>(), urls: string[] = [];
  for (const m of matches) { if (!seen.has(m[1]) && TARGET_NEIGHBORHOODS.has(m[2])) { seen.add(m[1]); urls.push(m[1]); } }
  return urls;
}
function extractNeighborhoodSlug(url: string): string {
  return url.replace("https://www.pvrpv.com/puerto-vallarta/", "").split("/")[0] ?? "";
}
function extractSlug(url: string): string { return url.split("/").pop() ?? ""; }
function buildingNameFromSlug(slug: string): string {
  return slug.replace(/-unit-.*$/, "").replace(/-ph\d.*$/, "").replace(/-pent.*$/, "")
    .replace(/-\d+[a-z]?$/, "").replace(/-\d+$/, "")
    .split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ").trim();
}
function extractTitle(html: string): string | null {
  return extractMeta(html, "og:title")
    ?.replace(/\s*-\s*(Condo|Studio|Penthouse|House|Villa|Apartment)\s+in\s+Puerto\s+Vallarta.*$/i, "").trim() ?? null;
}
function extractLatLon(html: string): { lat: number | null; lon: number | null } {
  const geoPos = extractMeta(html, "geo.position");
  if (geoPos) { const [a, b] = geoPos.split(";"); const lat = parseFloat(a ?? ""), lon = parseFloat(b ?? ""); if (!isNaN(lat) && !isNaN(lon)) return { lat, lon }; }
  const latM = html.match(/"latitude"\s*:\s*"([\d.\-]+)"/), lonM = html.match(/"longitude"\s*:\s*"([\d.\-]+)"/);
  if (latM && lonM) return { lat: parseFloat(latM[1]), lon: parseFloat(lonM[1]) };
  return { lat: null, lon: null };
}
function extractSpec(html: string, label: string): string | null {
  return html.match(new RegExp(`<label>\\s*${label}\\s*</label>\\s*([^<]+)`, "i"))?.[1]?.trim() ?? null;
}
function extractSpecs(html: string) {
  const br = extractSpec(html, "Bed\\(s\\):"), ba = extractSpec(html, "Bath\\(s\\):"),
    sl = extractSpec(html, "Sleeps\\(s\\):"), sq = extractSpec(html, "Square Space:"), ar = extractSpec(html, "Area:");
  const bedrooms = br != null ? parseInt(br, 10) : null;
  const bathrooms = ba != null ? parseFloat(ba) : null;
  const maxGuests = sl != null ? parseInt(sl, 10) : null;
  const { sqft, convertedFromSqm } = parseSqft(sq);
  return {
    bedrooms: bedrooms != null && !isNaN(bedrooms) ? bedrooms : null,
    bathrooms: bathrooms != null && !isNaN(bathrooms) ? bathrooms : null,
    maxGuests: maxGuests != null && !isNaN(maxGuests) ? maxGuests : null,
    sqft, sqftConvertedFromSqm: convertedFromSqm, neighborhoodRaw: ar,
  };
}
function extractAmenities(html: string): string[] {
  const out: string[] = [];
  for (const b of html.matchAll(/<li[^>]*property-amenities[^>]*>[\s\S]*?<\/li>/gi)) {
    const m = b[0].match(/<i[^>]*><\/i>\s*([^<\n]+)/i);
    if (m?.[1]?.trim()) out.push(m[1].trim());
  }
  return out;
}
function extractRates(html: string): { nightlyPriceUsd: number | null; minNights: number | null } {
  const tableM = html.match(/<div[^>]*id="rates-table"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) return { nightlyPriceUsd: null, minNights: null };
  let isFirst = true;
  for (const row of tableM[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(c => c[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length < 4) continue; if (isFirst) { isFirst = false; continue; }
    const priceM = cells[1]?.match(/\$\s*([\d,]+\.?\d*)/);
    const nightlyPriceUsd = priceM ? parseFloat(priceM[1].replace(/,/g, "")) : null;
    const minNights = cells[4]?.match(/^\d+$/) ? parseInt(cells[4], 10) : null;
    if (nightlyPriceUsd && nightlyPriceUsd > 0) return { nightlyPriceUsd, minNights };
  }
  return { nightlyPriceUsd: null, minNights: null };
}
function extractReviews(html: string): { ratingOverall: number | null; reviewCount: number | null } {
  const countM = html.match(/<h3[^>]*id="reviews"[^>]*>\s*(\d+)\s*Reviews?\s*<\/h3>/i);
  const ratingM = html.match(/(\d+\.\d+)\s*&#183;\s*(\d+)\s*Customer\s*Reviews?/i);
  return {
    reviewCount: countM ? parseInt(countM[1], 10) : ratingM ? parseInt(ratingM[2], 10) : null,
    ratingOverall: ratingM ? parseFloat(ratingM[1]) : null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load already-ingested source URLs from DB
  const existingRows = await db
    .select({ sourceUrl: rentalListingsTable.sourceUrl })
    .from(rentalListingsTable)
    .where(sql`source_platform = 'pvrpv'`);
  const existingUrls = new Set(existingRows.map(r => r.sourceUrl));
  console.log(`Already in DB: ${existingUrls.size} listings — will skip these.`);

  // 2. Collect all listing URLs from index pages
  const allUrls: string[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 9; page++) {
    const indexUrl = `${BASE_URL}/puerto-vallarta/?page=${(page - 1) * 30}`;
    try {
      const html = await fetchHtml(indexUrl);
      const urls = extractListingUrls(html);
      for (const u of urls) { if (!seen.has(u)) { seen.add(u); allUrls.push(u); } }
    } catch (e) { console.warn(`Page ${page} failed: ${e}`); }
    await sleep(MIN_DELAY_MS);
  }
  console.log(`Total target URLs found: ${allUrls.length}`);

  // 3. Filter to only new ones
  const newUrls = allUrls.filter(u => !existingUrls.has(u));
  console.log(`New (not yet in DB): ${newUrls.length} listings to scrape.\n`);

  let succeeded = 0, failed = 0;

  for (let i = 0; i < newUrls.length; i++) {
    const url = newUrls[i];
    const slug = extractSlug(url);
    const neighborhoodSlug = extractNeighborhoodSlug(url);
    const shortSlug = slug.length > 42 ? slug.slice(0, 42) + "…" : slug;
    process.stdout.write(`[${String(i + 1).padStart(3)}/${newUrls.length}] ${neighborhoodSlug}/${shortSlug}... `);

    try {
      const html = await fetchHtml(url);
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
      const confidence = computeConfidence({
        title, sourceUrl: url, neighborhoodNormalized,
        bedrooms: specs.bedrooms, bathrooms: specs.bathrooms, nightlyPriceUsd,
        ratingOverall, reviewCount, latitude: lat, longitude: lon,
        maxGuests: specs.maxGuests, amenitiesNormalized,
      });

      const [row] = await db.insert(rentalListingsTable).values({
        sourcePlatform: SOURCE_PLATFORM, sourceUrl: url, externalId: slug,
        title: title ?? slug, neighborhoodRaw, neighborhoodNormalized,
        buildingName: buildingName || null, latitude: lat, longitude: lon,
        distanceToBeachM, bedrooms: specs.bedrooms ?? 0, bathrooms: specs.bathrooms ?? 0,
        maxGuests: specs.maxGuests, sqft: specs.sqft,
        amenitiesRaw: amenitiesRaw.length > 0 ? amenitiesRaw : null,
        amenitiesNormalized: amenitiesNormalized.length > 0 ? amenitiesNormalized : null,
        ratingOverall, ratingCount: reviewCount, reviewCount,
        reviewSentimentScore: null, nightlyPriceUsd, cleaningFeeUsd: null, minNights,
        scrapedAt: new Date(), dataConfidenceScore: confidence, isActive: true,
      })
      .onConflictDoUpdate({
        target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
        set: {
          title: sql`excluded.title`, neighborhoodNormalized: sql`excluded.neighborhood_normalized`,
          buildingName: sql`excluded.building_name`, latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`, distanceToBeachM: sql`excluded.distance_to_beach_m`,
          bedrooms: sql`excluded.bedrooms`, bathrooms: sql`excluded.bathrooms`,
          sqft: sql`excluded.sqft`, amenitiesRaw: sql`excluded.amenities_raw`,
          amenitiesNormalized: sql`excluded.amenities_normalized`,
          ratingOverall: sql`excluded.rating_overall`, reviewCount: sql`excluded.review_count`,
          nightlyPriceUsd: sql`excluded.nightly_price_usd`, scrapedAt: sql`excluded.scraped_at`,
          dataConfidenceScore: sql`excluded.data_confidence_score`, updatedAt: new Date(),
        },
      })
      .returning({ id: rentalListingsTable.id });

      const sqftStr = specs.sqft != null ? ` sqft=${specs.sqft}${specs.sqftConvertedFromSqm ? "(c)" : ""}` : "";
      console.log(`✓ id=${row?.id} ${specs.bedrooms}BR $${nightlyPriceUsd} amen=${amenitiesNormalized.length}/${amenitiesRaw.length}${sqftStr} beach=${distanceToBeachM}m conf=${confidence.toFixed(2)}`);
      succeeded++;
    } catch (e) {
      console.log(`✗ ${e}`);
      failed++;
    }

    if (i < newUrls.length - 1) await sleep(MIN_DELAY_MS);
  }

  console.log(`\nDone. Ingested: ${succeeded}  Failed: ${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
