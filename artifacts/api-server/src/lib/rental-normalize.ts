/**
 * rental-normalize.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure normalization utilities for the rental listings ingestion pipeline.
 * No I/O — all functions are synchronous and side-effect free.
 */

// ── Neighborhood normalization ─────────────────────────────────────────────

/** The 7 canonical neighborhood names used everywhere in the system. */
export const CANONICAL_NEIGHBORHOODS = [
  "Zona Romantica",
  "Amapas",
  "Centro",
  "5 de Diciembre",
  "Marina Vallarta",
  "Hotel Zone",
  "Versalles",
] as const;

export type CanonicalNeighborhood = (typeof CANONICAL_NEIGHBORHOODS)[number];

/**
 * Maps raw strings (scraped from Airbnb/VRBO) → canonical neighborhood.
 * Keys are lowercased and trimmed before lookup.
 */
const NEIGHBORHOOD_MAP: Record<string, CanonicalNeighborhood> = {
  // Zona Romantica aliases
  "zona romantica": "Zona Romantica",
  "zona romántica": "Zona Romantica",
  "romantic zone": "Zona Romantica",
  "romantic zone / old town": "Zona Romantica",
  "old town": "Zona Romantica",
  "col. emiliano zapata": "Zona Romantica",
  "emiliano zapata": "Zona Romantica",
  "los muertos": "Zona Romantica",
  "olas altas": "Zona Romantica",
  "zona romantica / emiliano zapata": "Zona Romantica",
  "south side": "Zona Romantica",

  // Amapas / Conchas Chinas aliases
  "amapas": "Amapas",
  "conchas chinas": "Amapas",
  "conchas chinas / amapas": "Amapas",
  "amapas / conchas chinas": "Amapas",
  "conchas chinas/amapas": "Amapas",
  "puerto vallarta south": "Amapas",
  "el nogalito": "Amapas",

  // Centro aliases
  "centro": "Centro",
  "el centro": "Centro",
  "downtown": "Centro",
  "downtown puerto vallarta": "Centro",
  "centro histórico": "Centro",
  "centro historico": "Centro",
  "gringo gulch": "Centro",
  "col. centro": "Centro",

  // 5 de Diciembre aliases
  "5 de diciembre": "5 de Diciembre",
  "cinco de diciembre": "5 de Diciembre",
  "col. 5 de diciembre": "5 de Diciembre",
  "5 diciembre": "5 de Diciembre",
  "north side": "5 de Diciembre",

  // Marina Vallarta aliases
  "marina vallarta": "Marina Vallarta",
  "marina": "Marina Vallarta",
  "the marina": "Marina Vallarta",
  "puerto vallarta marina": "Marina Vallarta",
  "marina golf": "Marina Vallarta",

  // Hotel Zone aliases
  "hotel zone": "Hotel Zone",
  "zona hotelera": "Hotel Zone",
  "hotel corridor": "Hotel Zone",
  "hotel strip": "Hotel Zone",
  "las glorias": "Hotel Zone",
  "playa las glorias": "Hotel Zone",
  "zona hotelera norte": "Hotel Zone",

  // Versalles aliases
  "versalles": "Versalles",
  "versailles": "Versalles",
  "col. versalles": "Versalles",
  "versalles / pitillal": "Versalles",

  // ── PVRPV URL-segment aliases (kebab-case from URL path) ──────────────────
  "old-town": "Zona Romantica",
  "old town": "Zona Romantica",
  "los-muertos-beach": "Zona Romantica",
  "los muertos beach": "Zona Romantica",
  "amapas": "Amapas",
  "conchas-chinas": "Amapas",
  "marina-vallarta": "Marina Vallarta",
  "north-hotel-zone": "Hotel Zone",
  "north hotel zone": "Hotel Zone",
  "hotel-zone": "Hotel Zone",
  "5-de-diciembre": "5 de Diciembre",
  // fringe PVRPV neighborhoods → best-fit canonical
  "alta-vista": "Centro",
  "alta vista": "Centro",
  "el-caloso": "Centro",
  "el caloso": "Centro",
  "fluvial": "Centro",
  "pitillal": "Versalles",
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
  // Pool
  {
    key: "private_pool",
    category: "pool",
    label: "Private Pool",
    labelEs: "Alberca Privada",
    description: "Dedicated pool for the listing's guests only",
    aliases: ["private pool", "private swimming pool", "alberca privada", "pool - private"],
  },
  {
    key: "shared_pool",
    category: "pool",
    label: "Shared Pool",
    labelEs: "Alberca Compartida",
    aliases: ["shared pool", "community pool", "building pool", "pool - shared", "pool"],
  },
  {
    key: "hot_tub",
    category: "pool",
    label: "Hot Tub / Jacuzzi",
    labelEs: "Jacuzzi",
    aliases: ["hot tub", "jacuzzi", "whirlpool", "heated spa", "tina de hidromasaje"],
  },

  // Beach / water
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

  // View
  {
    key: "ocean_view",
    category: "view",
    label: "Ocean View",
    labelEs: "Vista al Mar",
    aliases: ["ocean view", "sea view", "bay view", "water view", "vista al mar", "ocean views"],
  },
  {
    key: "mountain_view",
    category: "view",
    label: "Mountain / Jungle View",
    labelEs: "Vista a la Montaña / Selva",
    aliases: ["mountain view", "jungle view", "garden view", "tropical view"],
  },

  // Kitchen
  {
    key: "full_kitchen",
    category: "kitchen",
    label: "Full Kitchen",
    labelEs: "Cocina Completa",
    description: "Stove, oven, refrigerator, and basic cookware",
    aliases: [
      "full kitchen", "kitchen", "full equipped kitchen", "fully equipped kitchen",
      "cocina equipada", "cocina completa",
    ],
  },
  {
    key: "kitchenette",
    category: "kitchen",
    label: "Kitchenette",
    labelEs: "Kitchenette",
    aliases: ["kitchenette", "mini kitchen", "mini fridge", "basic kitchen"],
  },

  // Laundry
  {
    key: "washer_dryer",
    category: "laundry",
    label: "Washer & Dryer",
    labelEs: "Lavadora y Secadora",
    aliases: ["washer", "dryer", "washer/dryer", "washer & dryer", "laundry", "in-unit laundry"],
  },

  // Climate
  {
    key: "air_conditioning",
    category: "climate",
    label: "Air Conditioning",
    labelEs: "Aire Acondicionado",
    aliases: [
      "air conditioning", "ac", "a/c", "central air", "mini split",
      "aire acondicionado", "split ac",
    ],
  },

  // Connectivity
  {
    key: "wifi",
    category: "connectivity",
    label: "WiFi",
    labelEs: "WiFi",
    aliases: ["wifi", "wi-fi", "wireless", "internet", "high-speed wifi", "fast wifi"],
  },

  // Safety
  {
    key: "gated_community",
    category: "safety",
    label: "Gated Community",
    labelEs: "Fraccionamiento Cerrado",
    aliases: ["gated", "gated community", "gated complex", "guarded", "24hr security"],
  },

  // Parking
  {
    key: "parking",
    category: "parking",
    label: "Parking",
    labelEs: "Estacionamiento",
    aliases: ["parking", "free parking", "private parking", "garage", "estacionamiento"],
  },

  // Outdoor
  {
    key: "rooftop_terrace",
    category: "outdoor",
    label: "Rooftop / Terrace",
    labelEs: "Rooftop / Terraza",
    aliases: ["rooftop", "terrace", "rooftop terrace", "balcony", "patio", "terraza"],
  },

  // Pet
  {
    key: "pet_friendly",
    category: "pet",
    label: "Pet Friendly",
    labelEs: "Acepta Mascotas",
    aliases: ["pets allowed", "pet friendly", "pet-friendly", "dogs allowed", "cats allowed"],
  },

  // Workspace
  {
    key: "dedicated_workspace",
    category: "workspace",
    label: "Dedicated Workspace",
    labelEs: "Área de Trabajo",
    aliases: ["workspace", "dedicated workspace", "desk", "home office", "work space"],
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

// ── Data confidence scoring ────────────────────────────────────────────────

/**
 * Field weights used in the confidence score formula.
 * Total weight = 100. Score = Σ(weight × present ? 1 : 0) / 100.
 */
const CONFIDENCE_WEIGHTS = {
  title: 5,
  sourceUrl: 5,
  neighborhoodNormalized: 10,  // bonus if normalization succeeded (vs "unclassified")
  bedrooms: 15,
  bathrooms: 10,
  nightlyPriceUsd: 20,
  ratingOverall: 8,
  reviewCount: 7,
  latitude: 5,
  longitude: 5,
  maxGuests: 5,
  amenitiesNormalized: 5,      // at least 1 normalized amenity
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
