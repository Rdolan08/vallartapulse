/**
 * building-lookup.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Fuzzy building-name resolution for the VallartaPulse comps engine.
 *
 * The PVRPV dataset uses verbose, unit-level building names ("Molino De Agua
 * 701 Beach House", "Estrellita Del Mar 303 Star Light"). When a front-end
 * user types a building name, they typically use shorthand. This library maps
 * any reasonable user input to a canonical building name for engine lookup.
 *
 * MATCHING PIPELINE (applied in order, first match wins):
 *   1. Exact   — case-insensitive trim match on canonical name or alias
 *   2. Slug    — normalize to slug (lowercase, no accents, no punctuation)
 *                then exact match on slug table
 *   3. Suffix  — strip common noise words ("pv", "puerto vallarta", "unit N",
 *                "condo", "suite", "penthouse", "villa", "casa", "beach",
 *                "unit", floor numbers) then retry slug match
 *   4. Jaccard — compute token overlap with each candidate; accept if score ≥ 0.5
 *   5. Prefix  — canonical slug is a substring of the input slug (or vice versa)
 *
 * CONFIDENCE TIERS:
 *   ≥ 0.90  high   — safe to auto-apply; use canonical name directly
 *   0.65–0.89 medium — flag to user; still usable with a warning
 *   < 0.65  low    — do not auto-apply; return top-3 suggestions instead
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type BuildingNeighborhood = "Zona Romantica" | "Amapas";

export interface BuildingEntry {
  canonical: string;
  neighborhood: BuildingNeighborhood;
  aliases: string[]; // raw alias strings from the DB or PVRPV listings
  bedroomBrackets?: number[]; // bedrooms with ≥2 listings in this building
}

export interface BuildingMatchResult {
  canonical_building_name: string;
  neighborhood_normalized: BuildingNeighborhood;
  matched_alias: string;
  match_confidence: number;
  confidence_tier: "high" | "medium" | "low";
  match_strategy: string;
}

export interface BuildingLookupResult {
  input: string;
  match: BuildingMatchResult | null;
  suggestions: Array<{ canonical: string; neighborhood: string; score: number }>;
  warning: string | null;
}

// ── Canonical building catalog ────────────────────────────────────────────────
// Built from the full PVRPV dataset (125 listings). Every building with ≥1
// listing is included so the lookup can offer suggestions for thin buildings.
// Only buildings with ≥2 same-BR peers generate a building premium in the engine.

export const BUILDING_CATALOG: BuildingEntry[] = [
  // ── Zona Romantica ─────────────────────────────────────────────────────────
  {
    canonical: "Molino De Agua",
    neighborhood: "Zona Romantica",
    aliases: [
      "Molino De Agua 701 Beach House",
      "Molino De Agua 702",
      "Molino De Agua 703",
      "Molino De Agua 605",
      "Molino De Agua 606",
    ],
    bedroomBrackets: [1, 2],
  },
  {
    canonical: "Villa Sorpresa",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [1, 2, 3],
  },
  {
    canonical: "V399",
    neighborhood: "Zona Romantica",
    aliases: ["V 399", "V-399", "Villas 399"],
    bedroomBrackets: [1, 2],
  },
  {
    canonical: "Condominios Olas Altas",
    neighborhood: "Zona Romantica",
    aliases: ["Olas Altas", "Condominios Olas Altas"],
    bedroomBrackets: [1],
  },
  {
    canonical: "The Park",
    neighborhood: "Zona Romantica",
    aliases: ["The Park Unit 208", "The Park Unit 209", "Park Condos PV"],
    bedroomBrackets: [1],
  },
  {
    canonical: "Pacifica",
    neighborhood: "Zona Romantica",
    aliases: ["Pacifica 101", "Pacifica 404 Casa Astro"],
    bedroomBrackets: [1],
  },
  {
    canonical: "El Dorado",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [1, 2],
  },
  {
    canonical: "V177",
    neighborhood: "Zona Romantica",
    aliases: ["V177 Ph", "V 177", "V-177"],
    bedroomBrackets: [1, 2],
  },
  {
    canonical: "Madero",
    neighborhood: "Zona Romantica",
    aliases: ["Madero 320", "Madero 320 Unit 301"],
    bedroomBrackets: [2],
  },
  {
    canonical: "Nayri",
    neighborhood: "Zona Romantica",
    aliases: ["Nayri 302"],
    bedroomBrackets: [1],
  },
  {
    canonical: "La Palapa",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [2],
  },
  {
    canonical: "Zenith",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [1],
  },
  {
    canonical: "The Palm On The Tree",
    neighborhood: "Zona Romantica",
    aliases: ["Palm On The Tree", "Palm On Tree"],
    bedroomBrackets: [1],
  },
  {
    canonical: "Rivera Molino",
    neighborhood: "Zona Romantica",
    aliases: ["Rivera Molino 305"],
    bedroomBrackets: [3],
  },
  {
    canonical: "Vista Del Sol",
    neighborhood: "Zona Romantica",
    aliases: ["Vista Del Sol 110", "Vista Del Sol 905"],
    bedroomBrackets: [2],
  },
  {
    canonical: "Pavilion",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [1, 2],
  },
  {
    canonical: "Playa Bonita",
    neighborhood: "Zona Romantica",
    aliases: [
      "Playa Bonita Casa De Los Abuelos",
      "Playa Bonita Apartamento Para Amigos",
      "Playa Bonita Casa Amistosa",
      "Playa Bonita Casa De Risa",
    ],
    bedroomBrackets: [2, 3],
  },
  {
    canonical: "Rincon De Almas",
    neighborhood: "Zona Romantica",
    aliases: [
      "Rincon De Almas 207 Rinconcillo",
      "Rincon De Almas Casa Sammy",
      "Rincón De Almas",
    ],
    bedroomBrackets: [1],
  },
  {
    canonical: "Selva Romantica",
    neighborhood: "Zona Romantica",
    aliases: [
      "Selva Romantica Casa Cameron",
      "Selva Romantica Casa Leone",
      "Selva Romantica Villa Del Cielo",
      "Selva Romantica Paraiso",
      "Selva Romantica Amazonas",
      "Selva Romantica Safari",
    ],
    bedroomBrackets: [1, 2, 3],
  },
  {
    canonical: "Loma Del Mar",
    neighborhood: "Zona Romantica",
    aliases: [
      "Loma Del Mar C9 Sofias Casa Del Sol",
      "Loma Del Mar A14",
      "Loma Del Mar B21",
      "Loma Del Mar D22",
    ],
    bedroomBrackets: [1],
  },
  {
    canonical: "Rivera Cuale",
    neighborhood: "Zona Romantica",
    aliases: ["Rivera Cuale Casa Camartiz"],
    bedroomBrackets: [1],
  },
  {
    canonical: "Cielito Lindo",
    neighborhood: "Zona Romantica",
    aliases: [],
    bedroomBrackets: [1],
  },
  {
    canonical: "Serenity Condominium",
    neighborhood: "Zona Romantica",
    aliases: ["Serenity Condo", "Serenity"],
    bedroomBrackets: [1],
  },
  // ── Amapas ─────────────────────────────────────────────────────────────────
  {
    canonical: "Paramount Bay",
    neighborhood: "Amapas",
    aliases: ["Paramount Bay Villa Serena", "Paramount Bay Unit 807c", "Paramount Bay Unit 407c"],
    bedroomBrackets: [2, 3],
  },
  {
    canonical: "Residences By Pinnacle",
    neighborhood: "Amapas",
    aliases: ["Pinnacle Residences", "Pinnacle"],
    bedroomBrackets: [2, 3],
  },
  {
    canonical: "V177",
    neighborhood: "Amapas",
    aliases: ["V 177", "V-177"],
    bedroomBrackets: [1],
  },
  {
    canonical: "Estrellita Del Mar",
    neighborhood: "Amapas",
    aliases: [
      "Estrellita Del Mar 303 Star Light",
      "Estrellita Del Mar 202",
      "Estrellita Del Mar 102",
      "Estrellita",
    ],
    bedroomBrackets: [2],
  },
  {
    canonical: "Signature By Pinnacle",
    neighborhood: "Amapas",
    aliases: ["Signature", "Signature Pinnacle", "Signature 403", "Signature By Pinnacle 403"],
    bedroomBrackets: [2],
  },
  {
    canonical: "Sayan Tropical",
    neighborhood: "Amapas",
    aliases: ["Sayan Tropical Suite", "Sayan Tropical Penthouse 3"],
    bedroomBrackets: [2, 4],
  },
  {
    canonical: "Sayan Beach",
    neighborhood: "Amapas",
    aliases: ["Andrew Christian Sayan Beach", "Sayan Beach Casa Marriott"],
    bedroomBrackets: [3],
  },
  {
    canonical: "Orchid",
    neighborhood: "Amapas",
    aliases: ["Orchid 7e La Maravilla De Orchid", "Orchid 7e"],
    bedroomBrackets: [3],
  },
  {
    canonical: "Avalon Zen",
    neighborhood: "Amapas",
    aliases: ["Avalon Zen Treetop Retreat", "Avalon"],
    bedroomBrackets: [2],
  },
  {
    canonical: "D Terrace",
    neighborhood: "Amapas",
    aliases: ["D-Terrace", "DTerrace"],
    bedroomBrackets: [3],
  },
  {
    canonical: "Pacifica",
    neighborhood: "Amapas",
    aliases: ["Pacifica Amapas"],
    bedroomBrackets: [2],
  },
];

// ── Normalization helpers ─────────────────────────────────────────────────────

const ACCENT_MAP: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", ã: "a",
  é: "e", è: "e", ë: "e", ê: "e",
  í: "i", ì: "i", ï: "i", î: "i",
  ó: "o", ò: "o", ö: "o", ô: "o", õ: "o",
  ú: "u", ù: "u", ü: "u", û: "u",
  ñ: "n", ç: "c",
};

function removeAccents(s: string): string {
  return s.replace(/[áàäâãéèëêíìïîóòöôõúùüûñç]/gi, (c) => ACCENT_MAP[c.toLowerCase()] ?? c);
}

// Noise suffixes/words to strip before slug matching
const NOISE_WORDS = new Set([
  "pv", "pvr", "puerto", "vallarta", "unit", "units", "suite", "suites",
  "penthouse", "ph", "condo", "condominium", "condominios", "villa", "villas",
  "casa", "casas", "beach", "by", "the", "a", "de", "del", "el", "la", "los",
  "las", "y", "and", "at", "in",
]);

function toSlug(s: string): string {
  return removeAccents(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTokens(slug: string): string[] {
  return slug.split(" ").filter((t) => t.length > 0);
}

function stripNoise(tokens: string[]): string[] {
  // Remove noise words AND pure numbers (unit numbers, floor numbers)
  return tokens.filter((t) => !NOISE_WORDS.has(t) && !/^\d+$/.test(t));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

// ── Candidate index ───────────────────────────────────────────────────────────

interface CandidateIndex {
  entry: BuildingEntry;
  canonicalSlug: string;
  canonicalNoNoise: string[];
  aliasSlugs: string[];
  aliasNoNoise: string[][];
  allSlugs: Set<string>;
}

function buildIndex(): CandidateIndex[] {
  return BUILDING_CATALOG.map((entry) => {
    const canonicalSlug = toSlug(entry.canonical);
    const canonicalNoNoise = stripNoise(toTokens(canonicalSlug));

    const aliasSlugs = entry.aliases.map(toSlug);
    const aliasNoNoise = aliasSlugs.map((s) => stripNoise(toTokens(s)));

    const allSlugs = new Set([canonicalSlug, ...aliasSlugs]);

    return { entry, canonicalSlug, canonicalNoNoise, aliasSlugs, aliasNoNoise, allSlugs };
  });
}

const CANDIDATE_INDEX: CandidateIndex[] = buildIndex();

// ── Core lookup function ──────────────────────────────────────────────────────

export function lookupBuilding(
  raw: string,
  neighborhoodHint?: BuildingNeighborhood
): BuildingLookupResult {
  const trimmed = raw.trim();
  const inputSlug = toSlug(trimmed);
  const inputTokens = toTokens(inputSlug);
  const inputNoNoise = stripNoise(inputTokens);
  const inputSet = new Set(inputNoNoise);

  const scored: Array<{
    candidate: CandidateIndex;
    confidence: number;
    strategy: string;
    matchedAlias: string;
  }> = [];

  for (const candidate of CANDIDATE_INDEX) {
    // Optional neighborhood filter — still score cross-neighborhood but penalize
    const neighborhoodBonus = !neighborhoodHint || candidate.entry.neighborhood === neighborhoodHint
      ? 0 : -0.15;

    // Strategy 1: exact slug match on canonical
    if (inputSlug === candidate.canonicalSlug) {
      scored.push({ candidate, confidence: 1.0 + neighborhoodBonus, strategy: "exact_canonical", matchedAlias: candidate.entry.canonical });
      continue;
    }

    // Strategy 2: exact slug match on any alias
    const aliasExact = candidate.aliasSlugs.findIndex((s) => s === inputSlug);
    if (aliasExact !== -1) {
      scored.push({ candidate, confidence: 0.95 + neighborhoodBonus, strategy: "exact_alias", matchedAlias: candidate.entry.aliases[aliasExact] });
      continue;
    }

    // Strategy 3: noise-stripped canonical slug
    const canonNoNoiseStr = candidate.canonicalNoNoise.join(" ");
    const inputNoNoiseStr = inputNoNoise.join(" ");
    if (inputNoNoiseStr === canonNoNoiseStr && inputNoNoise.length > 0) {
      scored.push({ candidate, confidence: 0.88 + neighborhoodBonus, strategy: "normalized_canonical", matchedAlias: candidate.entry.canonical });
      continue;
    }

    // Strategy 4: noise-stripped alias match
    const aliasNNMatch = candidate.aliasNoNoise.findIndex(
      (nn) => nn.join(" ") === inputNoNoiseStr && nn.length > 0
    );
    if (aliasNNMatch !== -1) {
      scored.push({ candidate, confidence: 0.85 + neighborhoodBonus, strategy: "normalized_alias", matchedAlias: candidate.entry.aliases[aliasNNMatch] });
      continue;
    }

    // Strategy 5: Jaccard token overlap (noise-stripped)
    const canonSet = new Set(candidate.canonicalNoNoise);
    let bestJaccard = jaccardSimilarity(inputSet, canonSet);
    let bestJaccardAlias = candidate.entry.canonical;

    for (let i = 0; i < candidate.aliasNoNoise.length; i++) {
      const aSet = new Set(candidate.aliasNoNoise[i]);
      const j = jaccardSimilarity(inputSet, aSet);
      if (j > bestJaccard) {
        bestJaccard = j;
        bestJaccardAlias = candidate.entry.aliases[i];
      }
    }

    if (bestJaccard >= 0.4) {
      const conf = Math.min(0.82, 0.45 + bestJaccard * 0.5) + neighborhoodBonus;
      scored.push({ candidate, confidence: conf, strategy: "token_jaccard", matchedAlias: bestJaccardAlias });
      continue;
    }

    // Strategy 5b: lower-threshold Jaccard — suggestions only (below confident-match bar)
    if (bestJaccard >= 0.22) {
      const conf = 0.30 + bestJaccard * 0.5 + neighborhoodBonus;
      scored.push({ candidate, confidence: conf, strategy: "token_jaccard_weak", matchedAlias: bestJaccardAlias });
      continue;
    }

    // Strategy 6: prefix/containment (canonical slug is contained in input, or vice versa)
    const canonSlug = candidate.canonicalSlug;
    if (
      (inputSlug.includes(canonSlug) || canonSlug.includes(inputSlug)) &&
      canonSlug.length >= 4 && inputSlug.length >= 4
    ) {
      const overlapRatio = Math.min(canonSlug.length, inputSlug.length) /
                           Math.max(canonSlug.length, inputSlug.length);
      if (overlapRatio >= 0.5) {
        const conf = 0.60 + overlapRatio * 0.1 + neighborhoodBonus;
        scored.push({ candidate, confidence: conf, strategy: "prefix_containment", matchedAlias: candidate.entry.canonical });
        continue;
      }
    }

    // Strategy 6b: shared first token (for "rincon ..." type names)
    if (inputNoNoise.length > 0 && candidate.canonicalNoNoise.length > 0 &&
        inputNoNoise[0] === candidate.canonicalNoNoise[0] && inputNoNoise[0].length >= 4) {
      const conf = 0.35 + neighborhoodBonus;
      scored.push({ candidate, confidence: conf, strategy: "first_token_match", matchedAlias: candidate.entry.canonical });
    }
  }

  // Sort by confidence desc, pick best
  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  const suggestions = scored.slice(0, 5).map((s) => ({
    canonical: s.candidate.entry.canonical,
    neighborhood: s.candidate.entry.neighborhood,
    score: parseFloat(Math.min(1, Math.max(0, s.confidence)).toFixed(2)),
  }));

  if (!best || best.confidence < 0.55) {
    return {
      input: trimmed,
      match: null,
      suggestions,
      warning:
        suggestions.length > 0
          ? `No confident match for "${trimmed}". Did you mean: ${suggestions.map((s) => s.canonical).join(", ")}?`
          : `No match found for "${trimmed}". Check the spelling or use GET /api/rental/buildings to see available buildings.`,
    };
  }

  const confidence = Math.min(1, Math.max(0, best.confidence));
  const tier: "high" | "medium" | "low" =
    confidence >= 0.90 ? "high" : confidence >= 0.65 ? "medium" : "low";

  const matchResult: BuildingMatchResult = {
    canonical_building_name: best.candidate.entry.canonical,
    neighborhood_normalized: best.candidate.entry.neighborhood,
    matched_alias: best.matchedAlias,
    match_confidence: parseFloat(confidence.toFixed(2)),
    confidence_tier: tier,
    match_strategy: best.strategy,
  };

  const warn =
    tier === "low"
      ? `Low-confidence match for "${trimmed}" → "${best.candidate.entry.canonical}" (${Math.round(confidence * 100)}%). Verify this is correct.`
      : tier === "medium"
      ? `Partial match: "${trimmed}" → "${best.candidate.entry.canonical}" (${Math.round(confidence * 100)}% confidence). Confirm before using.`
      : null;

  return {
    input: trimmed,
    match: matchResult,
    suggestions: suggestions.slice(1, 4),
    warning: warn,
  };
}

// ── Building statistics (for GET /api/rental/buildings) ──────────────────────

export interface BuildingStats {
  canonical_building_name: string;
  neighborhood_normalized: BuildingNeighborhood;
  aliases: string[];
  listing_count: number;
  median_price: number | null;
  avg_price: number | null;
  bedroom_brackets: number[];
  thin_sample: boolean;
  note: string | null;
}

/**
 * Merges DB-sourced price stats into the catalog for API responses.
 * DB rows come from: SELECT building_name, neighborhood_normalized, COUNT(*), AVG/MEDIAN price
 * grouping by building_name (raw). We normalize each raw name and accumulate into canonical.
 */
export function mergeBuildingStats(
  dbRows: Array<{
    building_name: string;
    neighborhood_normalized: string;
    cnt: number;
    avg_price: number;
    median_price: number;
  }>
): BuildingStats[] {
  const byCanonical = new Map<string, {
    entry: BuildingEntry;
    prices: number[];
    count: number;
  }>();

  for (const row of dbRows) {
    // Skip non-target neighborhoods
    if (row.neighborhood_normalized !== "Zona Romantica" && row.neighborhood_normalized !== "Amapas") {
      continue;
    }

    // Find the catalog entry for this raw building name
    const slug = toSlug(row.building_name);
    const match = CANDIDATE_INDEX.find(
      (c) =>
        (c.canonicalSlug === slug || c.aliasSlugs.includes(slug)) &&
        c.entry.neighborhood === (row.neighborhood_normalized as BuildingNeighborhood)
    );
    const entry = match?.entry;
    if (!entry) continue; // skip buildings not in catalog

    const key = `${entry.canonical}|${entry.neighborhood}`;
    const existing = byCanonical.get(key);
    if (existing) {
      // Accumulate count; use provided avg/median directly per row
      existing.count += row.cnt;
      if (row.median_price) existing.prices.push(row.median_price);
    } else {
      byCanonical.set(key, {
        entry,
        count: row.cnt,
        prices: row.median_price ? [row.median_price] : [],
      });
    }
  }

  const results: BuildingStats[] = [];
  for (const { entry, count, prices } of byCanonical.values()) {
    const sortedPrices = [...prices].sort((a, b) => a - b);
    const median =
      sortedPrices.length > 0
        ? parseFloat(
            sortedPercentile(sortedPrices, 50).toFixed(0)
          )
        : null;
    const avg =
      prices.length > 0
        ? parseFloat(
            (prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(0)
          )
        : null;
    const thin = count < 3;

    results.push({
      canonical_building_name: entry.canonical,
      neighborhood_normalized: entry.neighborhood,
      aliases: entry.aliases,
      listing_count: count,
      median_price: median,
      avg_price: avg,
      bedroom_brackets: entry.bedroomBrackets ?? [],
      thin_sample: thin,
      note: thin
        ? `Only ${count} listing(s) — building premium is not computed for thin samples (min 2 needed).`
        : null,
    });
  }

  results.sort((a, b) => {
    if (a.neighborhood_normalized !== b.neighborhood_normalized)
      return a.neighborhood_normalized.localeCompare(b.neighborhood_normalized);
    return b.listing_count - a.listing_count;
  });

  return results;
}

function sortedPercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
