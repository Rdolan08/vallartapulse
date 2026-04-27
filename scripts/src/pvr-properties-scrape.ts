/**
 * pvr-properties-scrape.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PVR Properties listing scraper for VallartaPulse.
 *
 * Reads PVR Properties' public Supabase view, normalizes each vacation rental,
 * and upserts into rental_listings. Idempotent: re-running updates existing rows.
 *
 * Usage:
 *   PVR_PROPERTIES_DRY_RUN=1 pnpm --filter @workspace/scripts run scrape:pvr-properties
 *   DATABASE_URL="$RAILWAY_DATABASE_URL" pnpm --filter @workspace/scripts run scrape:pvr-properties
 *
 * Optional env knobs:
 *   PVR_PROPERTIES_MAX_LISTINGS      total listing cap (default: 500)
 *   PVR_PROPERTIES_PAGE_SIZE         API page size (default: 100)
 *   PVR_PROPERTIES_MIN_DELAY_MS      courtesy delay between API pages (default: 500)
 *   PVR_PROPERTIES_DRY_RUN=1         parse + QA only; skip DB writes
 *   PVR_PROPERTIES_MXN_PER_USD       MXN→USD conversion rate (default: 17)
 *   PVR_PROPERTIES_MAX_NIGHTLY_USD   sanity cap for nightly USD (default: 100000)
 *   PVR_PROPERTIES_SUPABASE_URL      override source Supabase URL
 *   PVR_PROPERTIES_SUPABASE_ANON_KEY override public anon key
 */

const SOURCE_PLATFORM = "pvr_properties";
const SITE_BASE_URL = "https://pvrproperties.mx";
const DEFAULT_SUPABASE_URL = "https://pmstawrrvptolbmabcgc.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBtc3Rhd3JydnB0b2xibWFiY2djIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NzcyNDgsImV4cCI6MjA4ODM1MzI0OH0." +
  "tIh578p5FGji7WsSWYq_VbRYhy-HOGFjdAjOqDr7Cqk";

const DEFAULT_MAX_LISTINGS = 500;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MIN_DELAY_MS = 500;
const DEFAULT_MXN_PER_USD = 17;
const DEFAULT_MAX_NIGHTLY_USD = 100_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveFloatEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_LISTINGS = parsePositiveIntEnv("PVR_PROPERTIES_MAX_LISTINGS", DEFAULT_MAX_LISTINGS);
const PAGE_SIZE = parsePositiveIntEnv("PVR_PROPERTIES_PAGE_SIZE", DEFAULT_PAGE_SIZE);
const MIN_DELAY_MS = parsePositiveIntEnv("PVR_PROPERTIES_MIN_DELAY_MS", DEFAULT_MIN_DELAY_MS);
const DRY_RUN = process.env.PVR_PROPERTIES_DRY_RUN === "1";
const MXN_PER_USD = parsePositiveFloatEnv("PVR_PROPERTIES_MXN_PER_USD", DEFAULT_MXN_PER_USD);
const MAX_NIGHTLY_USD = parsePositiveFloatEnv(
  "PVR_PROPERTIES_MAX_NIGHTLY_USD",
  DEFAULT_MAX_NIGHTLY_USD,
);
const SUPABASE_URL = process.env.PVR_PROPERTIES_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.PVR_PROPERTIES_SUPABASE_ANON_KEY ?? DEFAULT_SUPABASE_ANON_KEY;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

interface PvrPropertiesRow {
  id: string;
  name?: string | null;
  property_type?: string | null;
  description?: string | null;
  bedrooms?: number | string | null;
  bathrooms?: number | string | null;
  number_of_beds?: number | string | null;
  max_guests?: number | string | null;
  min_nights?: number | string | null;
  max_nights?: number | string | null;
  location?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  zone?: string | null;
  development?: string | null;
  postal_code?: string | null;
  lat?: number | string | null;
  lng?: number | string | null;
  currency?: string | null;
  nightly_rate?: number | string | null;
  avg_price_per_night?: number | string | null;
  price_display_type?: string | null;
  booking_mode?: string | null;
  main_image?: string | null;
  images?: Array<{ url?: string; image_url?: string; sort_order?: number }> | null;
  amenities?: string | null;
  amenities_structured?: Array<{ name?: string; category?: string }> | null;
  recommended?: boolean | null;
  promoted?: boolean | null;
  new_property?: boolean | null;
  managed_by_pvr?: boolean | null;
  updated_at?: string | null;
  external_property_id?: number | string | null;
  city_obj?: { name?: string; state?: string; country?: string } | null;
  zone_obj?: { name?: string } | null;
  development_obj?: { name?: string } | null;
}

interface ScrapeResult {
  sourceUrl: string;
  externalId: string;
  title: string | null;
  neighborhoodRaw: string;
  neighborhoodNormalized: string;
  buildingName: string | null;
  propertyTypeRaw: string | null;
  propertyTypeNormalized: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  maxGuests: number | null;
  nightlyPriceUsd: number | null;
  nightlyPriceMxn: number | null;
  minNights: number | null;
  latitude: number | null;
  longitude: number | null;
  distanceToBeachM: number | null;
  amenitiesRaw: string[];
  amenitiesNormalized: string[];
  parentRegionBucket: string;
  confidence: number;
  dbId: number | null;
  error: string | null;
  warnings: string[];
}

const NEIGHBORHOOD_MAP: Record<string, string> = {
  "zona romantica": "Zona Romantica",
  "zona romántica": "Zona Romantica",
  "romantic zone": "Zona Romantica",
  "old town": "Zona Romantica",
  "los muertos": "Zona Romantica",
  amapas: "Amapas",
  "conchas chinas": "Amapas",
  "marina vallarta": "Marina Vallarta",
  marina: "Marina Vallarta",
  "zona hotelera": "Hotel Zone",
  "hotel zone": "Hotel Zone",
  centro: "Centro",
  "5 de diciembre": "5 de Diciembre",
  versalles: "Versalles",
  "punta mita": "Punta Mita",
  "punta de mita": "Punta Mita",
  "nuevo vallarta": "Nuevo Vallarta",
  "nuevo nayarit": "Nuevo Vallarta",
  bucerias: "Bucerias",
  "bucerías": "Bucerias",
  sayulita: "Sayulita",
  "la cruz": "La Cruz de Huanacaxtle",
  "la cruz de huanacaxtle": "La Cruz de Huanacaxtle",
  "cruz de huanacaxtle": "La Cruz de Huanacaxtle",
  careyes: "Careyes",
  "san pancho": "San Pancho",
  "san francisco": "San Pancho",
};

const AMENITY_ALIAS_MAP: Record<string, string> = {
  "air conditioning": "air_conditioning",
  ac: "air_conditioning",
  balcony: "rooftop_terrace",
  terrace: "rooftop_terrace",
  "bbq grill": "bbq_grill",
  "beach access": "beach_access",
  beachfront: "beachfront",
  butler: "concierge",
  concierge: "concierge",
  desk: "dedicated_workspace",
  dishwasher: "dishwasher",
  dryer: "washer_dryer",
  "washing area": "washer_dryer",
  elevator: "elevator",
  "equipped kitchen": "full_kitchen",
  kitchen: "full_kitchen",
  fridge: "full_kitchen",
  toaster: "full_kitchen",
  "fire extinguisher": "smoke_alarm",
  "fire siren": "smoke_alarm",
  fan: "ceiling_fan",
  gym: "gym",
  jacuzzi: "hot_tub",
  "mountain view": "mountain_view",
  "parking lot": "parking",
  pool: "shared_pool",
  "private pool": "private_pool",
  "safe vault": "safe",
  seaview: "ocean_view",
  "sea view": "ocean_view",
  tv: "smart_tv",
  wifi: "wifi",
};

const BEACH_POINTS = [
  { name: "Playa Los Muertos", lat: 20.6040, lon: -105.2382 },
  { name: "Playa Olas Altas", lat: 20.6055, lon: -105.2378 },
  { name: "Playa Camarones", lat: 20.6178, lon: -105.2363 },
  { name: "Conchas Chinas Beach", lat: 20.5942, lon: -105.2354 },
  { name: "Playa de Oro", lat: 20.6503, lon: -105.2393 },
  { name: "Marina Vallarta Beach", lat: 20.6848, lon: -105.2673 },
  { name: "Nuevo Vallarta Beach", lat: 20.7021, lon: -105.2966 },
  { name: "Bucerias Beach", lat: 20.7565, lon: -105.3349 },
  { name: "Punta Mita Beach", lat: 20.7724, lon: -105.5162 },
  { name: "Sayulita Beach", lat: 20.8687, lon: -105.4406 },
];

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNeighborhood(raw: string): string {
  const key = normalizeText(raw);
  return NEIGHBORHOOD_MAP[key] ?? (raw.trim() || "unclassified");
}

function normalizePropertyType(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = normalizeText(raw);
  if (["villa", "house", "casa"].includes(normalized)) return "villa";
  if (["condo", "apartment", "departamento", "penthouse"].includes(normalized)) return "condo";
  if (normalized === "hotel") return "hotel";
  return normalized || null;
}

function parentRegionFor(row: PvrPropertiesRow): string {
  const state = normalizeText(String(row.state ?? row.city_obj?.state ?? ""));
  const city = normalizeText(String(row.city ?? row.city_obj?.name ?? ""));
  if (state.includes("nayarit")) return "riviera_nayarit";
  if (city.includes("punta mita") || city.includes("bucer") || city.includes("sayulita")) {
    return "riviera_nayarit";
  }
  return "puerto_vallarta";
}

function num(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function int(raw: unknown): number | null {
  const parsed = num(raw);
  return parsed == null ? null : Math.round(parsed);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) seen.add(trimmed);
  }
  return Array.from(seen);
}

function extractAmenities(row: PvrPropertiesRow): string[] {
  const structured = Array.isArray(row.amenities_structured)
    ? row.amenities_structured.map((a) => a.name)
    : [];
  const flat = row.amenities
    ? row.amenities.split(",").map((a) => a.trim()).filter(Boolean)
    : [];
  return uniqueStrings([...structured, ...flat]);
}

function normalizeAmenities(rawList: string[]): string[] {
  const keys = new Set<string>();
  for (const item of rawList) {
    const key = AMENITY_ALIAS_MAP[normalizeText(item)];
    if (key) keys.add(key);
  }
  return Array.from(keys).sort();
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function distanceToNearestBeachM(lat: number | null, lon: number | null): number | null {
  if (lat == null || lon == null) return null;
  let min = Infinity;
  for (const point of BEACH_POINTS) {
    const d = haversineM(lat, lon, point.lat, point.lon);
    if (d < min) min = d;
  }
  return Math.round(min);
}

function nightlyUsd(row: PvrPropertiesRow): {
  usd: number | null;
  mxn: number | null;
  warning: string | null;
} {
  const amount = num(row.avg_price_per_night ?? row.nightly_rate);
  if (amount == null || amount <= 0) return { usd: null, mxn: null, warning: null };
  const currency = String(row.currency ?? "USD").toUpperCase();
  const converted =
    currency === "USD"
      ? { usd: amount, mxn: null }
      : currency === "MXN"
        ? { usd: Math.round((amount / MXN_PER_USD) * 100) / 100, mxn: amount }
        : { usd: null, mxn: null };

  if (converted.usd != null && converted.usd > MAX_NIGHTLY_USD) {
    return {
      usd: null,
      mxn: converted.mxn,
      warning: `nightly_price_usd ${Math.round(converted.usd)} exceeds sanity cap ${MAX_NIGHTLY_USD}`,
    };
  }
  return { ...converted, warning: null };
}

function sourceUrl(row: PvrPropertiesRow): string {
  const slug = slugify(row.name ?? row.id);
  return `${SITE_BASE_URL}/listing-stay-detail/${slug}/${row.id}`;
}

function computeConfidence(fields: {
  title: string | null;
  sourceUrl: string | null;
  neighborhoodNormalized: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  nightlyPriceUsd: number | null;
  latitude: number | null;
  longitude: number | null;
  maxGuests: number | null;
  amenitiesNormalized: string[];
}): number {
  let score = 0;
  if (fields.title?.trim()) score += 10;
  if (fields.sourceUrl?.trim()) score += 5;
  if (fields.neighborhoodNormalized && fields.neighborhoodNormalized !== "unclassified") score += 15;
  if (fields.bedrooms != null && fields.bedrooms >= 0) score += 15;
  if (fields.bathrooms != null && fields.bathrooms > 0) score += 10;
  if (fields.nightlyPriceUsd != null && fields.nightlyPriceUsd > 0) score += 20;
  if (fields.latitude != null) score += 5;
  if (fields.longitude != null) score += 5;
  if (fields.maxGuests != null && fields.maxGuests > 0) score += 5;
  if (fields.amenitiesNormalized.length > 0) score += 10;
  return parseFloat((score / 100).toFixed(3));
}

function normalizeRow(row: PvrPropertiesRow): ScrapeResult {
  const title = row.name?.trim() ?? null;
  const url = sourceUrl(row);
  const neighborhoodRaw =
    row.zone_obj?.name ??
    row.zone ??
    row.city_obj?.name ??
    row.city ??
    row.development_obj?.name ??
    row.development ??
    "unclassified";
  const neighborhoodNormalized = normalizeNeighborhood(neighborhoodRaw);
  const buildingName = row.development_obj?.name ?? row.development ?? null;
  const propertyTypeRaw = row.property_type?.trim() ?? null;
  const propertyTypeNormalized = normalizePropertyType(propertyTypeRaw);
  const bedrooms = int(row.bedrooms);
  const bathrooms = num(row.bathrooms);
  const maxGuests = int(row.max_guests);
  const minNights = int(row.min_nights);
  const latitude = num(row.lat);
  const longitude = num(row.lng);
  const amenitiesRaw = extractAmenities(row);
  const amenitiesNormalized = normalizeAmenities(amenitiesRaw);
  const price = nightlyUsd(row);
  const warnings: string[] = [];

  if (!title) warnings.push("title missing");
  if (neighborhoodNormalized === "unclassified") warnings.push(`Neighborhood not recognized: "${neighborhoodRaw}"`);
  if (bedrooms == null) warnings.push("bedrooms missing");
  if (bathrooms == null) warnings.push("bathrooms missing");
  if (price.usd == null) warnings.push(`nightly_price_usd missing or unsupported currency: "${row.currency ?? ""}"`);
  if (price.warning) warnings.push(price.warning);
  if (latitude == null || longitude == null) warnings.push("latitude/longitude missing");
  if (amenitiesNormalized.length === 0) warnings.push("no amenities normalized");
  if (price.mxn != null) warnings.push(`converted MXN to USD using ${MXN_PER_USD} MXN/USD`);

  const distanceToBeachM = distanceToNearestBeachM(latitude, longitude);
  const confidence = computeConfidence({
    title,
    sourceUrl: url,
    neighborhoodNormalized,
    bedrooms,
    bathrooms,
    nightlyPriceUsd: price.usd,
    latitude,
    longitude,
    maxGuests,
    amenitiesNormalized,
  });

  return {
    sourceUrl: url,
    externalId: row.id,
    title,
    neighborhoodRaw,
    neighborhoodNormalized,
    buildingName,
    propertyTypeRaw,
    propertyTypeNormalized,
    bedrooms,
    bathrooms,
    maxGuests,
    nightlyPriceUsd: price.usd,
    nightlyPriceMxn: price.mxn,
    minNights,
    latitude,
    longitude,
    distanceToBeachM,
    amenitiesRaw,
    amenitiesNormalized,
    parentRegionBucket: parentRegionFor(row),
    confidence,
    dbId: null,
    error: null,
    warnings,
  };
}

async function fetchPage(offset: number, limit: number): Promise<{ rows: PvrPropertiesRow[]; total: number | null }> {
  const url = new URL("/rest/v1/public_properties_for_web", SUPABASE_URL);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "recommended.desc.nullslast,promoted.desc.nullslast,updated_at.desc.nullslast");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));

  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      Accept: "application/json",
      Prefer: "count=exact",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  const range = res.headers.get("content-range");
  const total = range?.match(/\/(\d+)$/)?.[1] ? parseInt(range.match(/\/(\d+)$/)![1], 10) : null;
  const rows = (await res.json()) as PvrPropertiesRow[];
  return { rows, total };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectRows(): Promise<PvrPropertiesRow[]> {
  const rows: PvrPropertiesRow[] = [];
  let offset = 0;
  let total: number | null = null;

  console.log("Collecting PVR Properties rows from public_properties_for_web...");
  while (rows.length < MAX_LISTINGS) {
    const limit = Math.min(PAGE_SIZE, MAX_LISTINGS - rows.length);
    console.log(`  Fetching API page offset=${offset} limit=${limit}`);
    const page = await fetchPage(offset, limit);
    if (total == null) total = page.total;
    rows.push(...page.rows);
    console.log(`    → Found ${page.rows.length}. Total collected: ${rows.length}${total != null ? `/${total}` : ""}`);
    if (page.rows.length < limit) break;
    if (total != null && rows.length >= total) break;
    offset += limit;
    await sleep(MIN_DELAY_MS);
  }
  return rows.slice(0, MAX_LISTINGS);
}

async function upsert(result: ScrapeResult): Promise<void> {
  try {
    const [{ sql }, { db, rentalListingsTable }] = await Promise.all([
      import("drizzle-orm"),
      import("@workspace/db"),
    ]);

    const [row] = await db
      .insert(rentalListingsTable)
      .values({
        sourcePlatform: SOURCE_PLATFORM,
        sourceUrl: result.sourceUrl,
        externalId: result.externalId,
        title: result.title ?? result.externalId,
        neighborhoodRaw: result.neighborhoodRaw,
        neighborhoodNormalized: result.neighborhoodNormalized,
        buildingName: result.buildingName,
        latitude: result.latitude,
        longitude: result.longitude,
        distanceToBeachM: result.distanceToBeachM,
        bedrooms: result.bedrooms ?? 0,
        bathrooms: result.bathrooms ?? 0,
        maxGuests: result.maxGuests,
        amenitiesRaw: result.amenitiesRaw.length > 0 ? result.amenitiesRaw : null,
        amenitiesNormalized: result.amenitiesNormalized.length > 0 ? result.amenitiesNormalized : null,
        ratingOverall: null,
        ratingCount: null,
        reviewCount: null,
        reviewSentimentScore: null,
        nightlyPriceUsd: result.nightlyPriceUsd,
        cleaningFeeUsd: null,
        minNights: result.minNights,
        scrapedAt: new Date(),
        dataConfidenceScore: result.confidence,
        isActive: true,
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        seenCount: 1,
        lifecycleStatus: "active",
        identityKey: `${SOURCE_PLATFORM}:${result.externalId}`,
        parentRegionBucket: result.parentRegionBucket,
        normalizedNeighborhoodBucket: result.neighborhoodNormalized,
        neighborhoodMappingConfidence: result.neighborhoodNormalized === "unclassified" ? "unknown" : "high",
        propertyTypeRaw: result.propertyTypeRaw,
        propertyTypeNormalized: result.propertyTypeNormalized,
        identityCheckedAt: new Date(),
        identityCheckStatus: "passed",
        cohortExcludedReason: null,
      })
      .onConflictDoUpdate({
        target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
        set: {
          externalId: sql`excluded.external_id`,
          title: sql`excluded.title`,
          neighborhoodRaw: sql`excluded.neighborhood_raw`,
          neighborhoodNormalized: sql`excluded.neighborhood_normalized`,
          buildingName: sql`excluded.building_name`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          distanceToBeachM: sql`excluded.distance_to_beach_m`,
          bedrooms: sql`excluded.bedrooms`,
          bathrooms: sql`excluded.bathrooms`,
          maxGuests: sql`excluded.max_guests`,
          amenitiesRaw: sql`excluded.amenities_raw`,
          amenitiesNormalized: sql`excluded.amenities_normalized`,
          nightlyPriceUsd: sql`excluded.nightly_price_usd`,
          minNights: sql`excluded.min_nights`,
          scrapedAt: sql`excluded.scraped_at`,
          dataConfidenceScore: sql`excluded.data_confidence_score`,
          isActive: true,
          lastSeenAt: sql`excluded.last_seen_at`,
          seenCount: sql`${rentalListingsTable.seenCount} + 1`,
          lifecycleStatus: "active",
          identityKey: sql`excluded.identity_key`,
          parentRegionBucket: sql`excluded.parent_region_bucket`,
          normalizedNeighborhoodBucket: sql`excluded.normalized_neighborhood_bucket`,
          neighborhoodMappingConfidence: sql`excluded.neighborhood_mapping_confidence`,
          propertyTypeRaw: sql`excluded.property_type_raw`,
          propertyTypeNormalized: sql`excluded.property_type_normalized`,
          identityCheckedAt: sql`excluded.identity_checked_at`,
          identityCheckStatus: sql`excluded.identity_check_status`,
          cohortExcludedReason: null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: rentalListingsTable.id });
    result.dbId = row?.id ?? null;
  } catch (e) {
    result.error = `DB insert failed: ${e}`;
  }
}

function printQAReport(results: ScrapeResult[]): void {
  const succeeded = DRY_RUN
    ? results.filter((r) => r.error == null)
    : results.filter((r) => r.dbId != null);
  const failed = results.filter((r) => r.error != null);
  const n = succeeded.length;
  const pct = (count: number) => `${count}/${n} (${n > 0 ? Math.round((count / n) * 100) : 0}%)`;

  console.log("\n" + "═".repeat(70));
  console.log("PVR PROPERTIES SCRAPE — QA REPORT");
  console.log("═".repeat(70));
  if (DRY_RUN) console.log("Mode: DRY RUN — no DB writes were attempted");
  console.log(`Total attempted:         ${results.length}`);
  console.log(`${DRY_RUN ? "Successfully parsed:" : "Successfully ingested:"}   ${n}`);
  console.log(`Failed (fetch/DB error): ${failed.length}`);
  console.log(`MXN→USD conversion:      ${MXN_PER_USD}`);
  console.log(`Nightly USD sanity cap:  ${MAX_NIGHTLY_USD}`);

  const byNeighborhood: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  for (const r of succeeded) {
    byNeighborhood[r.neighborhoodNormalized] = (byNeighborhood[r.neighborhoodNormalized] ?? 0) + 1;
    byRegion[r.parentRegionBucket] = (byRegion[r.parentRegionBucket] ?? 0) + 1;
  }

  console.log("\n── By region ──");
  for (const [region, count] of Object.entries(byRegion).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${region.padEnd(25)} ${count}`);
  }

  console.log("\n── By normalized neighborhood ──");
  for (const [hood, count] of Object.entries(byNeighborhood).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${hood.padEnd(30)} ${count}`);
  }

  const hasBedrooms = succeeded.filter((r) => r.bedrooms != null).length;
  const hasBathrooms = succeeded.filter((r) => r.bathrooms != null).length;
  const hasPrice = succeeded.filter((r) => r.nightlyPriceUsd != null).length;
  const hasMxnPrice = succeeded.filter((r) => r.nightlyPriceMxn != null).length;
  const hasAmenities = succeeded.filter((r) => r.amenitiesNormalized.length > 0).length;
  const hasBuilding = succeeded.filter((r) => r.buildingName != null).length;
  const hasLatLon = succeeded.filter((r) => r.latitude != null && r.longitude != null).length;
  const hasBeachDist = succeeded.filter((r) => r.distanceToBeachM != null).length;
  const hasGuests = succeeded.filter((r) => r.maxGuests != null).length;

  console.log("\n── Field coverage ──");
  console.log(`  bedrooms:              ${pct(hasBedrooms)}`);
  console.log(`  bathrooms:             ${pct(hasBathrooms)}`);
  console.log(`  nightly_price_usd:     ${pct(hasPrice)}`);
  console.log(`    ↳ converted from MXN:${hasMxnPrice.toString().padStart(6)}`);
  console.log(`  max_guests:            ${pct(hasGuests)}`);
  console.log(`  amenities (≥1 norm.):  ${pct(hasAmenities)}`);
  console.log(`  building_name:         ${pct(hasBuilding)}`);
  console.log(`  latitude / longitude:  ${pct(hasLatLon)}`);
  console.log(`  distance_to_beach_m:   ${pct(hasBeachDist)}`);

  const amenityCounts: Record<string, number> = {};
  for (const r of succeeded) {
    for (const amenity of r.amenitiesNormalized) {
      amenityCounts[amenity] = (amenityCounts[amenity] ?? 0) + 1;
    }
  }
  console.log("\n── Top normalized amenities ──");
  for (const [amenity, count] of Object.entries(amenityCounts).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${amenity.padEnd(24)} ${count.toString().padStart(4)}`);
  }

  const groups: Record<string, number[]> = {};
  for (const r of succeeded) {
    if (r.nightlyPriceUsd == null || r.bedrooms == null) continue;
    const key = `${r.neighborhoodNormalized} | ${r.bedrooms}BR`;
    (groups[key] ??= []).push(r.nightlyPriceUsd);
  }
  console.log("\n── Avg nightly USD by neighborhood + bedrooms ──");
  console.log(`  ${"Group".padEnd(40)} N   Avg   Min   Max`);
  for (const [group, prices] of Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]))) {
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const min = Math.round(Math.min(...prices));
    const max = Math.round(Math.max(...prices));
    console.log(`  ${group.padEnd(40)} ${String(prices.length).padStart(2)}  $${String(avg).padStart(5)}  $${String(min).padStart(5)}  $${String(max).padStart(5)}`);
  }

  const confidences = succeeded.map((r) => r.confidence);
  if (confidences.length > 0) {
    console.log("\n── Data confidence score ──");
    console.log(`  Average: ${(confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)}`);
    console.log(`  Min:     ${Math.min(...confidences).toFixed(3)}`);
    console.log(`  Max:     ${Math.max(...confidences).toFixed(3)}`);
  }

  const lowConfidence = succeeded.filter((r) => r.confidence < 0.9);
  if (lowConfidence.length > 0) {
    console.log(`\n── Listings below 0.90 confidence (${lowConfidence.length} total) ──`);
    for (const r of lowConfidence.slice(0, 20)) {
      console.log(`\n  [${r.confidence.toFixed(3)}] ${r.externalId} — ${r.title ?? "(untitled)"}`);
      console.log(`    Neighborhood: ${r.neighborhoodNormalized}  Bedrooms: ${r.bedrooms ?? "?"}  Price: ${r.nightlyPriceUsd != null ? `$${Math.round(r.nightlyPriceUsd)}` : "$?"}`);
      if (r.warnings.length > 0) console.log(`    Warnings: ${r.warnings.join(" | ")}`);
    }
  }

  if (failed.length > 0) {
    console.log("\n── Failures ──");
    for (const r of failed.slice(0, 20)) {
      console.log(`  ${r.externalId}: ${r.error}`);
    }
  }

  console.log("\n" + "═".repeat(70));
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  PVR Properties Scraper — VallartaPulse                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`Target: up to ${MAX_LISTINGS} listings${DRY_RUN ? " (dry-run)" : ""}`);
  console.log(`API page size: ${PAGE_SIZE}, delay ${MIN_DELAY_MS}ms`);
  console.log(`Source platform: ${SOURCE_PLATFORM}`);

  const rows = await collectRows();
  const results: ScrapeResult[] = [];

  console.log("\nNormalizing listings...");
  for (const row of rows) {
    const result = normalizeRow(row);
    if (!DRY_RUN) await upsert(result);
    results.push(result);
    const status = result.error ? "✗" : "✓";
    console.log(`  ${status} ${result.title ?? result.externalId} — ${result.neighborhoodNormalized} — $${result.nightlyPriceUsd != null ? Math.round(result.nightlyPriceUsd) : "?"}`);
  }

  printQAReport(results);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});

export {};
