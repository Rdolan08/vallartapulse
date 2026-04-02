/**
 * rental-helpers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Front-end support layer for POST /api/rental/comps.
 *
 * Routes:
 *   GET  /api/rental/amenities           — canonical amenity key catalog
 *   GET  /api/rental/buildings           — known buildings + price stats
 *   POST /api/rental/comps/prepare       — input validation + building fuzzy match
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { rentalAmenitiesLookupTable, rentalListingsTable } from "@workspace/db/schema";
import { asc, isNotNull } from "drizzle-orm";
import { lookupBuilding } from "../lib/building-lookup";
import { mergeBuildingStats } from "../lib/building-lookup";

const router: IRouter = Router();

// ── Static amenity catalog (mirrors DB; used for validation without a DB call) ─

const CANONICAL_AMENITY_KEYS = new Set([
  "beach_access",
  "beachfront",
  "air_conditioning",
  "wifi",
  "full_kitchen",
  "kitchenette",
  "washer_dryer",
  "rooftop_terrace",
  "parking",
  "pet_friendly",
  "hot_tub",
  "private_pool",
  "shared_pool",
  "gated_community",
  "mountain_view",
  "ocean_view",
  "dedicated_workspace",
]);

// Common variants / typos that users submit → canonical key
const AMENITY_ALIASES: Record<string, string> = {
  // pool variants
  pool: "shared_pool",
  pools: "shared_pool",
  private_pool: "private_pool",
  "private pool": "private_pool",
  "shared pool": "shared_pool",
  jacuzzi: "hot_tub",
  "hot tub": "hot_tub",
  hottub: "hot_tub",
  spa: "hot_tub",
  // view variants
  "ocean view": "ocean_view",
  oceanview: "ocean_view",
  "sea view": "ocean_view",
  seaview: "ocean_view",
  "mountain view": "mountain_view",
  "jungle view": "mountain_view",
  mountainview: "mountain_view",
  // kitchen
  kitchen: "full_kitchen",
  "full kitchen": "full_kitchen",
  "full kitchen amenities": "full_kitchen",
  kitchenette: "kitchenette",
  // laundry
  washer: "washer_dryer",
  dryer: "washer_dryer",
  "washer dryer": "washer_dryer",
  "washer/dryer": "washer_dryer",
  laundry: "washer_dryer",
  // connectivity
  "wi-fi": "wifi",
  "wi fi": "wifi",
  internet: "wifi",
  // climate
  ac: "air_conditioning",
  "air conditioning": "air_conditioning",
  "air conditioner": "air_conditioning",
  "a/c": "air_conditioning",
  // outdoor
  terrace: "rooftop_terrace",
  rooftop: "rooftop_terrace",
  balcony: "rooftop_terrace",
  "rooftop terrace": "rooftop_terrace",
  // beach
  beachfront: "beachfront",
  "beach access": "beach_access",
  beach: "beach_access",
  // safety/parking
  "gated community": "gated_community",
  gated: "gated_community",
  // pets
  pets: "pet_friendly",
  "pet friendly": "pet_friendly",
  // workspace
  "dedicated workspace": "dedicated_workspace",
  workspace: "dedicated_workspace",
  "work space": "dedicated_workspace",
  "home office": "dedicated_workspace",
};

function normalizeAmenityKey(raw: string): { canonical: string | null; suggested: string | null } {
  const lowered = raw.toLowerCase().trim().replace(/[_-]/g, " ");
  // Exact canonical match
  if (CANONICAL_AMENITY_KEYS.has(raw)) return { canonical: raw, suggested: null };
  // Try underscore normalization
  const underscored = lowered.replace(/\s+/g, "_");
  if (CANONICAL_AMENITY_KEYS.has(underscored)) return { canonical: underscored, suggested: null };
  // Try alias map
  const aliased = AMENITY_ALIASES[lowered];
  if (aliased) return { canonical: aliased, suggested: null };
  // Try partial alias
  for (const [alias, canonical] of Object.entries(AMENITY_ALIASES)) {
    if (lowered.includes(alias) || alias.includes(lowered)) {
      return { canonical: null, suggested: canonical };
    }
  }
  return { canonical: null, suggested: null };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/rental/amenities
// ────────────────────────────────────────────────────────────────────────────

router.get("/rental/amenities", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(rentalAmenitiesLookupTable)
      .orderBy(asc(rentalAmenitiesLookupTable.category), asc(rentalAmenitiesLookupTable.amenityKey));

    const amenities = rows.map((r) => ({
      amenity_key: r.amenityKey,
      display_label: r.label,
      display_label_es: r.labelEs,
      category: r.category,
      description: r.description ?? null,
    }));

    // Group by category for convenience
    const byCategory: Record<string, typeof amenities> = {};
    for (const a of amenities) {
      if (!byCategory[a.category]) byCategory[a.category] = [];
      byCategory[a.category].push(a);
    }

    res.json({
      total: amenities.length,
      amenities,
      by_category: byCategory,
      note:
        "Use amenity_key values in the amenities_normalized array when calling POST /api/rental/comps. " +
        "Keys not in this list are silently ignored by the scoring engine.",
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch amenity lookup");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/rental/buildings
// ────────────────────────────────────────────────────────────────────────────

const SUPPORTED_NEIGHBORHOODS = ["Zona Romantica", "Amapas"] as const;
type SupportedNeighborhood = typeof SUPPORTED_NEIGHBORHOODS[number];

router.get("/rental/buildings", async (req, res) => {
  const neighborhood = req.query.neighborhood as string | undefined;

  if (neighborhood && !SUPPORTED_NEIGHBORHOODS.includes(neighborhood as SupportedNeighborhood)) {
    res.status(400).json({
      error: "Invalid neighborhood",
      message: `neighborhood must be one of: ${SUPPORTED_NEIGHBORHOODS.join(", ")}`,
    });
    return;
  }

  try {
    const rows = await db
      .select({
        buildingName: rentalListingsTable.buildingName,
        neighborhoodNormalized: rentalListingsTable.neighborhoodNormalized,
        nightlyPriceUsd: rentalListingsTable.nightlyPriceUsd,
      })
      .from(rentalListingsTable)
      .where(isNotNull(rentalListingsTable.buildingName));

    // Aggregate in JS for flexibility (dataset is small)
    const groups = new Map<string, { prices: number[]; cnt: number; nbhd: string }>();
    for (const r of rows) {
      if (!r.buildingName || !r.nightlyPriceUsd) continue;
      const key = `${r.buildingName}||${r.neighborhoodNormalized}`;
      const g = groups.get(key) ?? { prices: [], cnt: 0, nbhd: r.neighborhoodNormalized };
      g.prices.push(parseFloat(String(r.nightlyPriceUsd)));
      g.cnt++;
      groups.set(key, g);
    }

    const dbRows = [...groups.entries()].map(([key, g]) => {
      const [buildingName] = key.split("||");
      const sorted = [...g.prices].sort((a, b) => a - b);
      const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
      const avg = g.prices.reduce((a, b) => a + b, 0) / g.prices.length;
      return {
        building_name: buildingName,
        neighborhood_normalized: g.nbhd,
        cnt: g.cnt,
        avg_price: Math.round(avg),
        median_price: Math.round(median),
      };
    });

    let buildings = mergeBuildingStats(dbRows);

    // Filter by neighborhood if provided
    if (neighborhood) {
      buildings = buildings.filter((b) => b.neighborhood_normalized === neighborhood);
    }

    res.json({
      total: buildings.length,
      neighborhood_filter: neighborhood ?? null,
      buildings,
      note:
        "Pass canonical_building_name to POST /api/rental/comps as building_name. " +
        "Buildings with thin_sample=true do not generate a building premium adjustment. " +
        "Use POST /api/rental/comps/prepare to validate and resolve building names.",
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch building metadata");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/rental/comps/prepare
// ────────────────────────────────────────────────────────────────────────────

const PrepareRequestSchema = z.object({
  neighborhood_normalized: z.enum(SUPPORTED_NEIGHBORHOODS, {
    errorMap: () => ({
      message: `neighborhood_normalized must be one of: ${SUPPORTED_NEIGHBORHOODS.join(", ")}`,
    }),
  }),
  bedrooms: z.number().int().min(1).max(4),
  bathrooms: z.number().min(0.5).max(8),
  sqft: z.number().min(100).max(10000).optional().nullable(),
  distance_to_beach_m: z.number().min(0).max(5000),
  amenities_normalized: z.array(z.string()).default([]),
  rating_overall: z.number().min(1).max(5).optional().nullable(),
  building_name: z.string().optional().nullable(),
});

router.post("/rental/comps/prepare", (req, res) => {
  const parsed = PrepareRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request payload",
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const input = parsed.data;
  const warnings: string[] = [];
  const blockingErrors: string[] = [];

  // ── Building name resolution ────────────────────────────────────────────────
  let canonicalBuildingName: string | null = null;
  let buildingMatchConfidence: number | null = null;
  let buildingLookupResult = null;

  if (input.building_name) {
    const lookupRes = lookupBuilding(
      input.building_name,
      input.neighborhood_normalized as "Zona Romantica" | "Amapas"
    );
    buildingLookupResult = lookupRes;

    if (lookupRes.match) {
      canonicalBuildingName = lookupRes.match.canonical_building_name;
      buildingMatchConfidence = lookupRes.match.match_confidence;

      // Cross-neighborhood warning
      if (lookupRes.match.neighborhood_normalized !== input.neighborhood_normalized) {
        warnings.push(
          `Building "${lookupRes.match.canonical_building_name}" is in ${lookupRes.match.neighborhood_normalized}, ` +
          `not ${input.neighborhood_normalized}. Neighborhood mismatch — building premium will not be applied.`
        );
      } else if (lookupRes.match.confidence_tier === "medium") {
        warnings.push(
          lookupRes.warning ??
          `Partial building match: "${input.building_name}" → "${canonicalBuildingName}". Confirm this is correct.`
        );
      } else if (lookupRes.match.confidence_tier === "low") {
        warnings.push(
          lookupRes.warning ??
          `Low-confidence building match. Treating building as unknown — no premium applied.`
        );
        canonicalBuildingName = null; // don't use low-confidence matches
      }
    } else {
      warnings.push(
        lookupRes.warning ??
        `Building name "${input.building_name}" could not be matched. No building premium will be applied.`
      );
    }
  }

  // ── Amenity key validation ──────────────────────────────────────────────────
  const acceptedKeys: string[] = [];
  const rejectedKeys: string[] = [];
  const suggestedKeys: Array<{ input: string; suggestion: string }> = [];
  const cleanedAmenities: string[] = [];

  for (const key of input.amenities_normalized) {
    const { canonical, suggested } = normalizeAmenityKey(key);
    if (canonical) {
      if (!acceptedKeys.includes(canonical)) {
        acceptedKeys.push(canonical);
        cleanedAmenities.push(canonical);
      }
    } else if (suggested) {
      suggestedKeys.push({ input: key, suggestion: suggested });
      rejectedKeys.push(key);
    } else {
      rejectedKeys.push(key);
    }
  }

  if (rejectedKeys.length > 0 && suggestedKeys.length > 0) {
    warnings.push(
      `${rejectedKeys.length} amenity key(s) not recognized. ` +
      `Suggestions: ${suggestedKeys.map((s) => `"${s.input}" → "${s.suggestion}"`).join(", ")}. ` +
      `Use GET /api/rental/amenities for the full canonical list.`
    );
  } else if (rejectedKeys.length > 0) {
    warnings.push(
      `${rejectedKeys.length} amenity key(s) not recognized and will be ignored by the engine: ${rejectedKeys.join(", ")}. ` +
      `Use GET /api/rental/amenities for valid keys.`
    );
  }

  // ── Missing-field warnings ──────────────────────────────────────────────────
  if (!input.sqft) {
    warnings.push(
      "sqft not provided. Size scoring will be skipped and weight redistributed. " +
      "Providing sqft improves recommendation accuracy."
    );
  }

  if (!input.rating_overall) {
    warnings.push(
      "rating_overall not provided. Rating similarity scoring will be skipped."
    );
  }

  if (acceptedKeys.length === 0) {
    warnings.push(
      "No valid amenity keys provided. Amenity scoring will contribute 0 pts. " +
      "This significantly reduces comp-set quality. Use GET /api/rental/amenities for valid keys."
    );
  }

  // ── Thin-segment awareness ──────────────────────────────────────────────────
  if (input.neighborhood_normalized === "Amapas" && input.bedrooms >= 3) {
    warnings.push(
      `Amapas ${input.bedrooms}BR is a thin segment (< 8 listings). ` +
      "Expect a 'low' or 'medium' confidence label from the comps engine."
    );
  }

  const readyForComps = blockingErrors.length === 0;

  // ── Cleaned input (ready to pass to POST /api/rental/comps) ────────────────
  const cleanedInput = {
    neighborhood_normalized: input.neighborhood_normalized,
    bedrooms: input.bedrooms,
    bathrooms: input.bathrooms,
    sqft: input.sqft ?? null,
    distance_to_beach_m: input.distance_to_beach_m,
    amenities_normalized: cleanedAmenities,
    rating_overall: input.rating_overall ?? null,
    building_name: canonicalBuildingName,
  };

  res.json({
    ready_for_comps: readyForComps,
    cleaned_input: cleanedInput,

    building_resolution: input.building_name
      ? {
          input: input.building_name,
          canonical_building_name: canonicalBuildingName,
          match_confidence: buildingMatchConfidence,
          confidence_tier: buildingLookupResult?.match?.confidence_tier ?? null,
          match_strategy: buildingLookupResult?.match?.match_strategy ?? null,
          suggestions: buildingLookupResult?.suggestions ?? [],
        }
      : null,

    amenity_validation: {
      submitted: input.amenities_normalized,
      accepted_keys: acceptedKeys,
      rejected_keys: rejectedKeys,
      suggested_corrections: suggestedKeys,
    },

    warnings,
    blocking_errors: blockingErrors,

    next_step: readyForComps
      ? "POST /api/rental/comps with cleaned_input"
      : "Fix blocking_errors before calling POST /api/rental/comps",
  });
});

export default router;
