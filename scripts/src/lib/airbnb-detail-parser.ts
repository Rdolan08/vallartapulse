/**
 * scripts/src/lib/airbnb-detail-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal Airbnb listing-page parser tuned for the discovery runner.
 *
 * The discovery runner needs only enough fields to:
 *   1. Confirm the listing is a real, live Airbnb URL (identity check).
 *   2. Pass / fail the active-cohort gates: geographic, property-type,
 *      minimum field completeness.
 *   3. Insert a useful row into rental_listings (NOT NULL fields satisfied).
 *
 * It does NOT do the deep description / amenity / review / image extraction
 * that `airbnb-detail-adapter.ts` does — that's intentional. Scope creep
 * here would mean every Airbnb HTML rev breaks discovery.
 *
 * Strategy: prefer JSON-LD VacationRental / og:title meta. Fall back to
 * regex on the body for stragglers (lat/lng, beds/baths). All extraction
 * is defensive — any field can come back null and the caller decides
 * how to gate.
 */

export interface ParsedListingDetail {
  /** Long-form title (og:title or JSON-LD name). Always trimmed. */
  title: string | null;
  /** Coarse property type from og:title pattern, e.g. "Apartment", "Villa". */
  propertyTypeRaw: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Free-text neighborhood string from og:title or JSON-LD address. */
  neighborhoodHint: string | null;
}

const EMPTY: ParsedListingDetail = {
  title: null,
  propertyTypeRaw: null,
  bedrooms: null,
  bathrooms: null,
  latitude: null,
  longitude: null,
  neighborhoodHint: null,
};

/**
 * Parse a fully-loaded Airbnb listing page (HTML).
 *
 * Returns a shallow object with all fields populated where confidently
 * extractable, NULL otherwise. Never throws.
 */
export function parseListingDetail(html: string): ParsedListingDetail {
  if (!html || html.length < 1000) return { ...EMPTY };
  const out: ParsedListingDetail = { ...EMPTY };

  // ── 1. og:title ────────────────────────────────────────────────────────
  // Pattern: "<propertyType> in <city/neighborhood> · <hostFirstName> · Airbnb"
  // e.g.: "Apartment in Puerto Vallarta · ★4.92 · 2 bedrooms · 1 bath ..."
  const ogTitle = matchMeta(html, "og:title");
  if (ogTitle) {
    out.title = ogTitle;
    const inMatch = ogTitle.match(/^([^·•|]+?)\s+in\s+([^·•|]+?)(?:\s*[·•|]|$)/i);
    if (inMatch) {
      const propPart = inMatch[1].trim();
      const nbhdPart = inMatch[2].trim();
      // Strip leading article words ("Entire ", "Private ") to get the type.
      const cleaned = propPart
        .replace(/^(entire|private|shared)\s+/i, "")
        .trim();
      out.propertyTypeRaw = cleaned || propPart;
      out.neighborhoodHint = nbhdPart;
    }
    // Bedroom/bathroom counts often live in og:title after a · separator.
    const bedMatch = ogTitle.match(/(\d+(?:\.\d+)?)\s*bedrooms?/i);
    if (bedMatch) out.bedrooms = parseFloat(bedMatch[1]);
    // Bathroom variants seen in the wild on current Airbnb og:titles:
    //   "1 bath", "2 baths", "2.5 baths"          ← classic
    //   "1 private bath", "2 shared baths"        ← post-2024 PDP shape
    //   "1 bathroom", "2 bathrooms"               ← occasional long form
    // The previous regex `(\d+)\s*bath(?:room)?s?` missed the
    // "private|shared" variant entirely (no optional modifier between
    // the count and "bath"), which is what was producing the bulk of
    // the thin_data:bathrooms rejections in the smoke run.
    const bathMatch = ogTitle.match(
      /(\d+(?:\.\d+)?)\s*(?:private\s+|shared\s+)?bath(?:room)?s?\b/i,
    );
    if (bathMatch) out.bathrooms = parseFloat(bathMatch[1]);
  }

  // ── 2. JSON-LD VacationRental / Product ────────────────────────────────
  for (const blob of iterateJsonLdBlobs(html)) {
    if (!blob || typeof blob !== "object") continue;
    const blocks = Array.isArray(blob) ? blob : [blob];
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as Record<string, unknown>;
      const t = block["@type"];
      if (
        t !== "VacationRental" &&
        t !== "LodgingBusiness" &&
        t !== "Product" &&
        t !== "Accommodation"
      ) {
        continue;
      }
      if (!out.title && typeof block.name === "string") out.title = block.name;
      // Geo coordinates
      const geo = block.geo as Record<string, unknown> | undefined;
      if (geo) {
        const lat = parseNumberLoose(geo.latitude);
        const lng = parseNumberLoose(geo.longitude);
        if (lat !== null) out.latitude = lat;
        if (lng !== null) out.longitude = lng;
      }
      // numberOfBedrooms / numberOfBathroomsTotal
      const beds = parseNumberLoose(block.numberOfBedrooms ?? block.numberOfRooms);
      if (beds !== null && out.bedrooms === null) out.bedrooms = beds;
      const baths = parseNumberLoose(block.numberOfBathroomsTotal);
      if (baths !== null && out.bathrooms === null) out.bathrooms = baths;
      // Address neighborhood
      const addr = block.address as Record<string, unknown> | undefined;
      if (addr && !out.neighborhoodHint) {
        const locality = typeof addr.addressLocality === "string"
          ? addr.addressLocality
          : null;
        const region = typeof addr.addressRegion === "string"
          ? addr.addressRegion
          : null;
        out.neighborhoodHint = locality ?? region;
      }
    }
  }

  // ── 3a. Body fallback for bathrooms ────────────────────────────────────
  // Many post-2024 Airbnb listings do NOT include bath count in og:title
  // (only bedrooms), and JSON-LD numberOfBathroomsTotal is intermittently
  // present. The bath count IS still in the body — Airbnb embeds it in
  // the niobeClientData JSON as a label string ("1 bath", "2.5 baths",
  // "1 private bath") and in the SSR description. This fallback mirrors
  // the api-server's extractBathroomsFromText logic (battle-tested
  // against the same late-2025 PDP shape) without cross-importing — keeps
  // the discovery parser self-contained per the same convention as
  // airbnb-search-cards-extract.ts.
  //
  // Strategies, applied in order, first wins:
  //   1. JSON keys: "bathrooms":N or "bathroomCount":N or "bathroomLabel":"..."
  //   2. Numeric body text: "X bath", "X baths", "X.5 baths", "X bathrooms",
  //      "X private/shared baths", and Spanish "X baños"
  //   3. Word forms: "two-bath", "tres baños", etc.
  if (out.bathrooms === null) {
    out.bathrooms = extractBathroomsFromBody(html);
  }

  // ── 3b. Body regex fallbacks for lat/lng ───────────────────────────────
  if (out.latitude === null || out.longitude === null) {
    // Airbnb embeds inline JSON like: "lat":20.6123,"lng":-105.2456
    const latMatch = html.match(/"(?:lat|latitude)"\s*:\s*(-?\d+\.\d+)/);
    const lngMatch = html.match(/"(?:lng|long|longitude)"\s*:\s*(-?\d+\.\d+)/);
    if (out.latitude === null && latMatch) {
      const v = parseFloat(latMatch[1]);
      if (Number.isFinite(v)) out.latitude = v;
    }
    if (out.longitude === null && lngMatch) {
      const v = parseFloat(lngMatch[1]);
      if (Number.isFinite(v)) out.longitude = v;
    }
  }

  return out;
}

// ── Small, defensive primitives ─────────────────────────────────────────────

function matchMeta(html: string, prop: string): string | null {
  // Match either <meta property="X" content="Y"> or content first then property.
  const re1 = new RegExp(
    `<meta[^>]+property=["']${escapeRegex(prop)}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRegex(prop)}["']`,
    "i"
  );
  const m1 = html.match(re1);
  if (m1) return decodeHtml(m1[1]);
  const m2 = html.match(re2);
  if (m2) return decodeHtml(m2[1]);
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function* iterateJsonLdBlobs(html: string): Generator<unknown, void, void> {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].trim();
    if (!text) continue;
    try {
      yield JSON.parse(text);
    } catch {
      // Skip malformed blocks.
    }
  }
}

function parseNumberLoose(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const f = parseFloat(v);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

// ── Bathroom body fallback helpers ──────────────────────────────────────────
//
// Mirrors api-server/src/lib/ingest/airbnb-detail-adapter.ts's
// extractBathroomsFromText logic. Copied (not imported) to keep the
// discovery parser self-contained and free of api-server runtime deps —
// same convention as airbnb-search-cards-extract.ts.

const BATH_WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

/**
 * Extract bath count from anywhere in the HTML body. Strategies in order
 * of confidence:
 *
 *   1. Direct JSON keys ("bathrooms":N, "bathroomCount":N) — Airbnb
 *      sometimes embeds these in the niobeClientData payload.
 *   2. Label string ("bathroomLabel":"2.5 baths") — current PDP shape.
 *   3. og:description meta — typically restates beds/baths.
 *   4. Numeric body sweep with word-boundary anchoring — catches title /
 *      description text that mentions "2 baths", "1 private bath",
 *      "2 baños". We deliberately bound 0–20 to discard noise like
 *      timestamps or feature flag IDs that happen to be near a "bath"
 *      substring (e.g. "bathing" in amenity descriptions).
 *   5. Word forms ("two-bath", "tres baños") as last resort.
 *
 * Returns null if no signal found. Never throws.
 */
function extractBathroomsFromBody(html: string): number | null {
  // 1. JSON keys.
  const jsonNum = html.match(
    /"(?:bathrooms|bathroomCount|bathroomsTotal|numberOfBathrooms)"\s*:\s*(\d+(?:\.5)?)/,
  );
  if (jsonNum) {
    const n = parseFloat(jsonNum[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  }

  // 2. Label string. Airbnb wraps these as e.g.
  //    "bathroomLabel":"2.5 baths" or "subtitleLabel":"1 bath".
  const labelMatch = html.match(
    /"(?:bathroomLabel|subtitleLabel|bathroomString)"\s*:\s*"([^"]*?\b\d+(?:\.5)?\s*-?\s*(?:private\s+|shared\s+)?(?:baths?|bathrooms?|baños?|banos?)\b[^"]*?)"/i,
  );
  if (labelMatch) {
    const inner = labelMatch[1].toLowerCase();
    const m = inner.match(
      /\b(\d+(?:\.5)?)\s*-?\s*(?:private\s+|shared\s+)?(?:baths?|bathrooms?|baños?|banos?)\b/,
    );
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
    }
  }

  // 3. og:description meta.
  const ogDesc = matchMeta(html, "og:description");
  if (ogDesc) {
    const fromDesc = extractBathsFromShortText(ogDesc);
    if (fromDesc !== null) return fromDesc;
  }

  // 4. Body-wide numeric sweep. Applied LAST among numeric strategies
  //    because the haystack is large (~800KB) and false-positive risk
  //    is non-zero — but the boundary anchors keep it tight in practice.
  const bodyNum = html.toLowerCase().match(
    /\b(\d+(?:\.5)?)\s*-?\s*(?:private\s+|shared\s+)?(?:baths?|bathrooms?|baños?|banos?)\b/,
  );
  if (bodyNum) {
    const n = parseFloat(bodyNum[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  }

  // 5. Word forms.
  const wordMatch = html.toLowerCase().match(
    /\b(one|two|three|four|five|six|uno|dos|tres|cuatro|cinco|seis)[\s-]+(?:bathroom|bath|baño|bano)s?\b/,
  );
  if (wordMatch) return BATH_WORD_TO_NUM[wordMatch[1]] ?? null;

  return null;
}

/** Numeric + word bath extractor for short text snippets (og:description). */
function extractBathsFromShortText(text: string): number | null {
  const lower = text.toLowerCase();
  const numMatch = lower.match(
    /\b(\d+(?:\.5)?)\s*-?\s*(?:private\s+|shared\s+)?(?:baths?|bathrooms?|baños?|banos?)\b/,
  );
  if (numMatch) {
    const n = parseFloat(numMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  }
  const wordMatch = lower.match(
    /\b(one|two|three|four|five|six|uno|dos|tres|cuatro|cinco|seis)[\s-]+(?:bathroom|bath|baño|bano)s?\b/,
  );
  if (wordMatch) return BATH_WORD_TO_NUM[wordMatch[1]] ?? null;
  return null;
}
