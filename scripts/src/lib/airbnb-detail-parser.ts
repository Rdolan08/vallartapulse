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
    const bathMatch = ogTitle.match(/(\d+(?:\.\d+)?)\s*bath(?:room)?s?/i);
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

  // ── 3. Body regex fallbacks for lat/lng ────────────────────────────────
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
