/**
 * rental-normalize.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure normalization utilities for the rental listings ingestion pipeline.
 * No I/O — all functions are synchronous and side-effect free.
 */

// ── Neighborhood normalization ─────────────────────────────────────────────

/**
 * Canonical neighborhood names covering all of greater Bahía de Banderas —
 * Puerto Vallarta (Jalisco) and the Riviera Nayarit (Nayarit state) side.
 *
 * IMPORTANT: "Old Town" is intentionally kept as its own canonical because it
 * can refer to either Zona Romantica (south of Río Cuale) or 5 de Diciembre
 * (north of Río Cuale near the Malecón). Without lat/lng, we cannot determine
 * which side. Use lat/lng disambiguation when available: listings south of
 * ~20.607 °N → Zona Romantica; north of that line and near the Malecón → Centro
 * or 5 de Diciembre.
 */
export const CANONICAL_NEIGHBORHOODS = [
  // ── Puerto Vallarta (Jalisco) ──────────────────────────────────────────────
  "Zona Romantica",        // Colonia Emiliano Zapata, Los Muertos Beach, Olas Altas — south of Río Cuale
  "Amapas",               // Hillside south of ZR; includes Conchas Chinas, Las Gemelas, El Nogalito
  "Mismaloya",            // Further south; La Jolla de Mismaloya, Las Ánimas
  "Old Town",             // Ambiguous historic center — could be ZR or 5-de-Dic; keep when lat/lng absent
  "Centro",               // El Centro, historic downtown, Gringo Gulch, Malecón area, near Cathedral
  "5 de Diciembre",       // North of Río Cuale, south of Hotel Zone; includes Lázaro Cárdenas
  "Hotel Zone",           // Zona Hotelera Norte; Las Glorias, Los Tules
  "Versalles",            // Col. Versalles, residential between Hotel Zone and Fluvial
  "Fluvial Vallarta",     // Near airport; Col. Fluvial Vallarta
  "Marina Vallarta",      // Marina, golf course, high-rise condos, near airport
  "Pitillal",             // Inland col. north; Col. Pitillal, El Iztatal
  // ── Greater Bay / Riviera Nayarit (Nayarit state) ─────────────────────────
  "Nuevo Vallarta",       // Nayarit state; Vidanta, Hard Rock, Marival zone
  "Bucerias",             // Nayarit; local town north of NV
  "La Cruz de Huanacaxtle", // Nayarit; La Cruz marina village
  "Punta Mita",           // Nayarit; Four Seasons, St. Regis, gated estates
  "El Anclote",           // Nayarit; between La Cruz and Punta Mita
  "Sayulita",             // Nayarit; surf town ~40 min north
  "San Pancho",           // Nayarit; San Francisco, artsy village north of Sayulita
] as const;

export type CanonicalNeighborhood = (typeof CANONICAL_NEIGHBORHOODS)[number];

/**
 * Maps raw strings (scraped from Airbnb/VRBO/PVRPV/agencies) → canonical neighborhood.
 * Keys are lowercased and trimmed before lookup.
 *
 * NOTE: "old town" alone maps to "Old Town" (ambiguous). Only map to Zona Romantica
 * when the raw string explicitly includes "romantic zone" or is south of the river.
 */
const NEIGHBORHOOD_MAP: Record<string, CanonicalNeighborhood> = {
  // ── Zona Romantica ────────────────────────────────────────────────────────
  "zona romantica": "Zona Romantica",
  "zona romántica": "Zona Romantica",
  "romantic zone": "Zona Romantica",
  "romantic zone / old town": "Zona Romantica",
  "old town romantic zone": "Zona Romantica",
  "old town / romantic zone": "Zona Romantica",
  "col. emiliano zapata": "Zona Romantica",
  "emiliano zapata": "Zona Romantica",
  "los muertos": "Zona Romantica",
  "los muertos beach": "Zona Romantica",
  "olas altas": "Zona Romantica",
  "zona romantica / emiliano zapata": "Zona Romantica",
  "emiliano zapata / zona romantica": "Zona Romantica",
  "south of the river": "Zona Romantica",
  "south side": "Zona Romantica",
  "zr": "Zona Romantica",
  // PVRPV URL slugs
  "los-muertos-beach": "Zona Romantica",
  "zona-romantica": "Zona Romantica",

  // ── Old Town (ambiguous — do NOT assume ZR) ──────────────────────────────
  "old town": "Old Town",
  "old-town": "Old Town",
  "historic center": "Old Town",
  "historic district": "Old Town",
  "downtown old town": "Old Town",
  "old town pv": "Old Town",
  "old town puerto vallarta": "Old Town",

  // ── Amapas / Conchas Chinas ───────────────────────────────────────────────
  "amapas": "Amapas",
  "conchas chinas": "Amapas",
  "conchas chinas / amapas": "Amapas",
  "amapas / conchas chinas": "Amapas",
  "conchas chinas/amapas": "Amapas",
  "conchas-chinas": "Amapas",
  "conchas-chinas / amapas": "Amapas",
  "las gemelas": "Amapas",
  "el nogalito": "Amapas",
  "south of pv": "Amapas",
  "puerto vallarta south": "Amapas",
  "garza blanca": "Amapas",   // Garza Blanca resort is in the Amapas/Conchas Chinas corridor
  "garza-blanca": "Amapas",
  "punta negra": "Amapas",    // South of Conchas Chinas, same south bay corridor
  "punta-negra": "Amapas",

  // ── Mismaloya ─────────────────────────────────────────────────────────────
  "mismaloya": "Mismaloya",
  "la jolla de mismaloya": "Mismaloya",
  "jolla de mismaloya": "Mismaloya",
  "las animas": "Mismaloya",
  "las ánimas": "Mismaloya",
  "boca de tomatlan": "Mismaloya",
  "boca de tomatlán": "Mismaloya",
  "boca": "Mismaloya",
  "quimixto": "Mismaloya",
  "yelapa": "Mismaloya",

  // ── Centro ────────────────────────────────────────────────────────────────
  "centro": "Centro",
  "el centro": "Centro",
  "downtown": "Centro",
  "downtown puerto vallarta": "Centro",
  "centro histórico": "Centro",
  "centro historico": "Centro",
  "gringo gulch": "Centro",
  "col. centro": "Centro",
  "malecon": "Centro",
  "malecón": "Centro",
  "near cathedral": "Centro",
  "cathedral": "Centro",
  "alta vista": "Centro",
  "alta-vista": "Centro",
  "el caloso": "Centro",
  "el-caloso": "Centro",

  // ── 5 de Diciembre ────────────────────────────────────────────────────────
  "5 de diciembre": "5 de Diciembre",
  "cinco de diciembre": "5 de Diciembre",
  "col. 5 de diciembre": "5 de Diciembre",
  "5 diciembre": "5 de Diciembre",
  "5th of december": "5 de Diciembre",
  "five of december": "5 de Diciembre",
  "5-de-diciembre": "5 de Diciembre",
  "colonia 5 de diciembre": "5 de Diciembre",
  "lázaro cárdenas": "5 de Diciembre",
  "lazaro cardenas": "5 de Diciembre",
  "lazaro-cardenas": "5 de Diciembre",
  "lázaro-cárdenas": "5 de Diciembre",
  "north of the river": "5 de Diciembre",
  "north side": "5 de Diciembre",

  // ── Hotel Zone ────────────────────────────────────────────────────────────
  "hotel zone": "Hotel Zone",
  "zona hotelera": "Hotel Zone",
  "hotel corridor": "Hotel Zone",
  "hotel strip": "Hotel Zone",
  "las glorias": "Hotel Zone",
  "playa las glorias": "Hotel Zone",
  "los tules": "Hotel Zone",
  "zona hotelera norte": "Hotel Zone",
  "north hotel zone": "Hotel Zone",
  "north-hotel-zone": "Hotel Zone",
  "hotel-zone": "Hotel Zone",

  // ── Versalles ─────────────────────────────────────────────────────────────
  "versalles": "Versalles",
  "versailles": "Versalles",
  "col. versalles": "Versalles",
  "versalles / pitillal": "Versalles",
  "colonia versalles": "Versalles",

  // ── Fluvial Vallarta ──────────────────────────────────────────────────────
  "fluvial vallarta": "Fluvial Vallarta",
  "fluvial": "Fluvial Vallarta",
  "col. fluvial": "Fluvial Vallarta",
  "fluvial-vallarta": "Fluvial Vallarta",

  // ── Marina Vallarta ───────────────────────────────────────────────────────
  "marina vallarta": "Marina Vallarta",
  "marina": "Marina Vallarta",
  "the marina": "Marina Vallarta",
  "puerto vallarta marina": "Marina Vallarta",
  "marina golf": "Marina Vallarta",
  "marina-vallarta": "Marina Vallarta",
  "marina golf course": "Marina Vallarta",
  "peninsula marina": "Marina Vallarta",

  // ── Pitillal ──────────────────────────────────────────────────────────────
  "pitillal": "Pitillal",
  "col. pitillal": "Pitillal",
  "colonia pitillal": "Pitillal",
  "el iztatal": "Pitillal",
  "iztatal": "Pitillal",

  // ── Nuevo Vallarta ────────────────────────────────────────────────────────
  "nuevo vallarta": "Nuevo Vallarta",
  "nuevo-vallarta": "Nuevo Vallarta",
  "nv": "Nuevo Vallarta",
  "vidanta": "Nuevo Vallarta",
  "grand mayan": "Nuevo Vallarta",
  "hard rock hotel vallarta": "Nuevo Vallarta",
  "marival": "Nuevo Vallarta",
  "paradise village": "Nuevo Vallarta",
  "playa escondida": "Nuevo Vallarta",

  // ── Bucerias ──────────────────────────────────────────────────────────────
  "bucerias": "Bucerias",
  "bucerías": "Bucerias",
  "bucerias, nayarit": "Bucerias",

  // ── La Cruz de Huanacaxtle ────────────────────────────────────────────────
  "la cruz de huanacaxtle": "La Cruz de Huanacaxtle",
  "la cruz": "La Cruz de Huanacaxtle",
  "huanacaxtle": "La Cruz de Huanacaxtle",

  // ── Punta Mita ────────────────────────────────────────────────────────────
  "punta mita": "Punta Mita",
  "punta de mita": "Punta Mita",
  "four seasons punta mita": "Punta Mita",
  "el anclote / punta mita": "El Anclote",
  "punta mita / sayulita": "Punta Mita",
  "punta mita estates": "Punta Mita",

  // ── El Anclote ────────────────────────────────────────────────────────────
  "el anclote": "El Anclote",
  "anclote": "El Anclote",

  // ── Sayulita ──────────────────────────────────────────────────────────────
  "sayulita": "Sayulita",
  "sayulita, nayarit": "Sayulita",

  // ── San Pancho ────────────────────────────────────────────────────────────
  "san pancho": "San Pancho",
  "san francisco": "San Pancho",
  "san francisco, nayarit": "San Pancho",
};

/**
 * Normalizes a raw neighborhood string.
 * Returns null if the string cannot be matched — do not silently default.
 */
export function normalizeNeighborhood(raw: string): CanonicalNeighborhood | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return NEIGHBORHOOD_MAP[key] ?? null;
}

// ── Amenity normalization ──────────────────────────────────────────────────

/** All canonical amenity keys and their category/label metadata. */
export const AMENITY_CATALOG: ReadonlyArray<{
  key: string;
  category: string;
  label: string;
  labelEs: string;
  description?: string;
  /** Raw strings that map to this key (lowercased, for matching) */
  aliases: string[];
}> = [
  // ── Pool ──────────────────────────────────────────────────────────────────
  {
    key: "private_pool",
    category: "pool",
    label: "Private Pool",
    labelEs: "Alberca Privada",
    description: "Dedicated pool for the listing's guests only",
    aliases: [
      "private pool", "private swimming pool", "alberca privada",
      "pool - private", "plunge pool", "lap pool",
    ],
  },
  {
    key: "shared_pool",
    category: "pool",
    label: "Shared Pool",
    labelEs: "Alberca Compartida",
    aliases: [
      "shared pool", "community pool", "building pool", "pool - shared",
      "pool (in complex)", "rooftop pool", "infinity pool",
      "pool", "heated pool", "outdoor pool",
    ],
  },
  {
    key: "hot_tub",
    category: "pool",
    label: "Hot Tub / Jacuzzi",
    labelEs: "Jacuzzi",
    aliases: ["hot tub", "jacuzzi", "whirlpool", "heated spa", "tina de hidromasaje", "spa"],
  },

  // ── Beach / water ─────────────────────────────────────────────────────────
  {
    key: "beachfront",
    category: "beach",
    label: "Beachfront",
    labelEs: "Frente al Mar",
    description: "Direct beach access from the property",
    aliases: ["beachfront", "on the beach", "beach front", "steps to beach", "frente al mar"],
  },
  {
    key: "beach_access",
    category: "beach",
    label: "Beach Access",
    labelEs: "Acceso a la Playa",
    aliases: ["beach access", "near beach", "walk to beach", "beach nearby", "close to beach"],
  },

  // ── View ──────────────────────────────────────────────────────────────────
  {
    key: "ocean_view",
    category: "view",
    label: "Ocean View",
    labelEs: "Vista al Mar",
    aliases: [
      "ocean view", "sea view", "bay view", "water view", "vista al mar",
      "ocean views", "bay views", "banderas bay view", "partial ocean view",
    ],
  },
  {
    key: "mountain_view",
    category: "view",
    label: "Mountain / Jungle View",
    labelEs: "Vista a la Montaña / Selva",
    aliases: ["mountain view", "jungle view", "garden view", "tropical view", "mountain views"],
  },

  // ── Kitchen ───────────────────────────────────────────────────────────────
  {
    key: "full_kitchen",
    category: "kitchen",
    label: "Full Kitchen",
    labelEs: "Cocina Completa",
    description: "Stove, oven, refrigerator, and basic cookware",
    aliases: [
      "full kitchen", "kitchen", "full equipped kitchen", "fully equipped kitchen",
      "cocina equipada", "cocina completa", "cooktop", "stove", "oven",
      "blender", "coffee maker", "toaster", "coffee maker / kettle",
    ],
  },
  {
    key: "dishwasher",
    category: "kitchen",
    label: "Dishwasher",
    labelEs: "Lavavajillas",
    aliases: ["dishwasher", "lavavajillas"],
  },
  {
    key: "kitchenette",
    category: "kitchen",
    label: "Kitchenette",
    labelEs: "Kitchenette",
    aliases: ["kitchenette", "mini kitchen", "mini fridge", "basic kitchen"],
  },
  {
    key: "bbq_grill",
    category: "outdoor",
    label: "BBQ Grill",
    labelEs: "Asador / BBQ",
    aliases: [
      "bbq grill", "bbq grill (in unit)", "bbq", "barbecue", "grill",
      "outdoor grill", "gas bbq", "charcoal grill",
    ],
  },

  // ── Laundry ───────────────────────────────────────────────────────────────
  {
    key: "washer_dryer",
    category: "laundry",
    label: "Washer & Dryer",
    labelEs: "Lavadora y Secadora",
    aliases: [
      "washer", "dryer", "washer/dryer", "washer & dryer", "laundry",
      "in-unit laundry", "laundry - washer (in unit)", "laundry - dryer (in unit)",
      "washer & dryer (in unit)", "washing machine",
    ],
  },
  {
    key: "iron",
    category: "laundry",
    label: "Iron & Ironing Board",
    labelEs: "Plancha y Tabla de Planchar",
    aliases: ["iron", "ironing board", "iron & ironing board", "plancha"],
  },
  {
    key: "linens_provided",
    category: "comfort",
    label: "Linens Provided",
    labelEs: "Ropa de Cama Incluida",
    aliases: ["bed linens", "linens", "linens provided", "towels", "towels & linens"],
  },

  // ── Climate ───────────────────────────────────────────────────────────────
  {
    key: "air_conditioning",
    category: "climate",
    label: "Air Conditioning",
    labelEs: "Aire Acondicionado",
    aliases: [
      "air conditioning", "ac", "a/c", "central air", "mini split",
      "aire acondicionado", "split ac", "climate control (air conditioning)",
      "central air conditioning",
    ],
  },
  {
    key: "ceiling_fan",
    category: "climate",
    label: "Ceiling Fan",
    labelEs: "Ventilador de Techo",
    aliases: ["ceiling fan", "ceiling fans", "climate control (ceiling fan)", "ventilador"],
  },

  // ── Entertainment ─────────────────────────────────────────────────────────
  {
    key: "smart_tv",
    category: "entertainment",
    label: "Smart TV",
    labelEs: "Smart TV",
    aliases: ["smart tv", "tv", "television", "cable tv", "streaming", "netflix", "cable"],
  },

  // ── Connectivity ──────────────────────────────────────────────────────────
  {
    key: "wifi",
    category: "connectivity",
    label: "WiFi",
    labelEs: "WiFi",
    aliases: ["wifi", "wi-fi", "wireless", "internet", "high-speed wifi", "fast wifi", "broadband"],
  },

  // ── Safety ────────────────────────────────────────────────────────────────
  {
    key: "gated_community",
    category: "safety",
    label: "Gated / 24hr Security",
    labelEs: "Fraccionamiento Cerrado / Seguridad 24h",
    aliases: [
      "gated", "gated community", "gated complex", "guarded",
      "24hr security", "24-hour security", "security (24 hours)",
      "security guard", "doorman",
    ],
  },
  {
    key: "private_entrance",
    category: "safety",
    label: "Private Entrance",
    labelEs: "Entrada Privada",
    aliases: [
      "private entrance", "private entrance (to the unit)", "private entry",
      "keypad entry", "self check-in",
    ],
  },

  // ── Parking ───────────────────────────────────────────────────────────────
  {
    key: "parking",
    category: "parking",
    label: "Parking",
    labelEs: "Estacionamiento",
    aliases: [
      "parking", "free parking", "private parking", "garage",
      "estacionamiento", "parking (in complex)", "assigned parking",
      "covered parking",
    ],
  },

  // ── Outdoor ───────────────────────────────────────────────────────────────
  {
    key: "rooftop_terrace",
    category: "outdoor",
    label: "Rooftop / Terrace / Balcony",
    labelEs: "Rooftop / Terraza / Balcón",
    aliases: [
      "rooftop", "terrace", "rooftop terrace", "balcony", "patio", "terraza",
      "outdoor space (patio / deck)", "balcony / terrace", "deck",
      "outdoor living area",
    ],
  },
  {
    key: "elevator",
    category: "accessibility",
    label: "Elevator",
    labelEs: "Elevador",
    aliases: ["elevator", "elevator (in complex)", "lift", "elevador"],
  },

  // ── Guest policies ────────────────────────────────────────────────────────
  {
    key: "pet_friendly",
    category: "pet",
    label: "Pet Friendly",
    labelEs: "Acepta Mascotas",
    aliases: ["pets allowed", "pet friendly", "pet-friendly", "dogs allowed", "cats allowed"],
  },
  {
    key: "child_friendly",
    category: "other",
    label: "Child Friendly",
    labelEs: "Acepta Niños",
    aliases: ["children permitted", "kids allowed", "child friendly", "family friendly"],
  },

  // ── Workspace ─────────────────────────────────────────────────────────────
  {
    key: "dedicated_workspace",
    category: "workspace",
    label: "Dedicated Workspace",
    labelEs: "Área de Trabajo",
    aliases: ["workspace", "dedicated workspace", "desk", "home office", "work space", "office"],
  },
];

/** Build a flat alias → key map at module load time for O(1) lookup. */
const AMENITY_ALIAS_MAP = new Map<string, string>();
for (const amenity of AMENITY_CATALOG) {
  for (const alias of amenity.aliases) {
    AMENITY_ALIAS_MAP.set(alias.toLowerCase(), amenity.key);
  }
}

/**
 * Normalizes an array of raw amenity strings to canonical keys.
 * Unrecognized amenities are silently dropped (they remain in amenities_raw).
 */
export function normalizeAmenities(rawAmenities: unknown): string[] {
  if (!Array.isArray(rawAmenities)) return [];

  const keys = new Set<string>();
  for (const item of rawAmenities) {
    if (typeof item !== "string") continue;
    const alias = item.trim().toLowerCase();
    const key = AMENITY_ALIAS_MAP.get(alias);
    if (key) keys.add(key);
  }
  return Array.from(keys).sort();
}

// ── Beach distance ─────────────────────────────────────────────────────────

/**
 * Named beach access points used for distance_to_beach_m calculation.
 * Each entry is a publicly known beach access point in or near Puerto Vallarta.
 * Coordinates verified against Google Maps / OpenStreetMap.
 */
export const BEACH_REFERENCE_POINTS: ReadonlyArray<{
  name: string;
  lat: number;
  lon: number;
}> = [
  { name: "Playa Los Muertos (Zona Romantica)",       lat: 20.6040, lon: -105.2382 },
  { name: "Playa Olas Altas (Zona Romantica South)",  lat: 20.6055, lon: -105.2378 },
  { name: "Playa Camarones (Centro / Malecon)",       lat: 20.6178, lon: -105.2363 },
  { name: "Conchas Chinas Beach",                     lat: 20.5942, lon: -105.2354 },
  { name: "Playa de Oro (Hotel Zone)",                lat: 20.6503, lon: -105.2393 },
  { name: "Marina Vallarta Beach",                    lat: 20.6848, lon: -105.2673 },
  { name: "Playa Las Glorias (Hotel Zone North)",     lat: 20.6620, lon: -105.2396 },
];

/**
 * Haversine straight-line distance between two geographic points, in meters.
 * Accuracy: ±0.3% at distances under 10 km (sufficient for intra-city use).
 */
export function haversineM(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6_371_000; // Earth mean radius, meters
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Returns the straight-line distance in meters from a point to the
 * nearest beach reference point.  Returns null if lat/lon are null.
 */
export function distanceToNearestBeachM(
  lat: number | null,
  lon: number | null
): number | null {
  if (lat == null || lon == null) return null;
  let min = Infinity;
  for (const p of BEACH_REFERENCE_POINTS) {
    const d = haversineM(lat, lon, p.lat, p.lon);
    if (d < min) min = d;
  }
  return Math.round(min);
}

// ── sqft / sqm parsing ────────────────────────────────────────────────────

const SQM_TO_SQFT = 10.7639;

/**
 * Parses a raw "Square Space" string from PVRPV into sqft.
 * Handles:
 *   "224.38 Square Meter/ 2414.33  Square Feet"  → 2414.33 ft²
 *   "85 m² / 914 sq ft"                           → 914 ft²
 *   "75 Square Meters"                            → converted: 75 × 10.764 = 807 ft²
 *   "950 Square Feet"                             → 950 ft²
 *
 * Returns { sqft, convertedFromSqm } where convertedFromSqm=true means
 * the value was derived from square meters and a warning should be emitted.
 */
export function parseSqft(raw: string | null | undefined): {
  sqft: number | null;
  convertedFromSqm: boolean;
} {
  if (!raw) return { sqft: null, convertedFromSqm: false };

  // Try explicit feet value first
  const feetM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Feet|sq\.?\s*ft\.?)/i);
  if (feetM) {
    const val = parseFloat(feetM[1].replace(/,/g, ""));
    if (!isNaN(val) && val > 0) return { sqft: Math.round(val), convertedFromSqm: false };
  }

  // Fall back to square meters and convert
  const meterM = raw.match(/([\d,]+\.?\d*)\s*(?:Square\s*Met(?:er|re)s?|m²|sq\.?\s*m\.?)/i);
  if (meterM) {
    const sqm = parseFloat(meterM[1].replace(/,/g, ""));
    if (!isNaN(sqm) && sqm > 0) {
      return { sqft: Math.round(sqm * SQM_TO_SQFT), convertedFromSqm: true };
    }
  }

  return { sqft: null, convertedFromSqm: false };
}

// ── Data confidence scoring ────────────────────────────────────────────────

/**
 * Field weights used in the confidence score formula.
 * Total weight = 100. Score = Σ(weight × present ? 1 : 0) / 100.
 */
const CONFIDENCE_WEIGHTS = {
  title: 5,
  sourceUrl: 5,
  neighborhoodNormalized: 10,
  bedrooms: 15,
  bathrooms: 10,
  nightlyPriceUsd: 20,
  ratingOverall: 8,
  reviewCount: 7,
  latitude: 5,
  longitude: 5,
  maxGuests: 5,
  amenitiesNormalized: 5,
} as const;

export interface ConfidenceInput {
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
}

/** Returns a 0–1 confidence score based on field completeness. */
export function computeConfidenceScore(fields: ConfidenceInput): number {
  let score = 0;

  if (fields.title?.trim()) score += CONFIDENCE_WEIGHTS.title;
  if (fields.sourceUrl?.trim()) score += CONFIDENCE_WEIGHTS.sourceUrl;
  if (fields.neighborhoodNormalized && fields.neighborhoodNormalized !== "unclassified")
    score += CONFIDENCE_WEIGHTS.neighborhoodNormalized;
  if (fields.bedrooms != null && fields.bedrooms >= 0)
    score += CONFIDENCE_WEIGHTS.bedrooms;
  if (fields.bathrooms != null && fields.bathrooms > 0)
    score += CONFIDENCE_WEIGHTS.bathrooms;
  if (fields.nightlyPriceUsd != null && fields.nightlyPriceUsd > 0)
    score += CONFIDENCE_WEIGHTS.nightlyPriceUsd;
  if (fields.ratingOverall != null && fields.ratingOverall >= 0 && fields.ratingOverall <= 5)
    score += CONFIDENCE_WEIGHTS.ratingOverall;
  if (fields.reviewCount != null && fields.reviewCount >= 0)
    score += CONFIDENCE_WEIGHTS.reviewCount;
  if (fields.latitude != null) score += CONFIDENCE_WEIGHTS.latitude;
  if (fields.longitude != null) score += CONFIDENCE_WEIGHTS.longitude;
  if (fields.maxGuests != null && fields.maxGuests > 0)
    score += CONFIDENCE_WEIGHTS.maxGuests;
  if (fields.amenitiesNormalized && fields.amenitiesNormalized.length > 0)
    score += CONFIDENCE_WEIGHTS.amenitiesNormalized;

  return parseFloat((score / 100).toFixed(3));
}
