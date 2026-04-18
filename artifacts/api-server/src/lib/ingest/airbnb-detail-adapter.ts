/**
 * ingest/airbnb-detail-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure parser: rendered Airbnb /rooms/{id} HTML → normalized listing-detail
 * fields + raw fragments. NO I/O, NO DB writes. Mirrors the search-adapter
 * separation of concerns so the runner can stay thin.
 *
 * Sources used (in order of trust):
 *   1. <script type="application/ld+json"> blocks
 *      - schema.org "VacationRental" entry: name, description, image[],
 *        latitude, longitude, addressLocality, occupancy.value (capacity),
 *        aggregateRating { ratingValue, ratingCount }
 *      - schema.org "Product" entry: redundant, used as fallback
 *   2. Apollo client cache embedded inline (the GraphQL response array
 *      containing { __typename: "DemandStayListing", ... } nodes). We walk
 *      it once and merge any extra signals that JSON-LD doesn't carry —
 *      currently bedCount, pdpType, petPolicy.isAllowed, and city.
 *
 * Fields that Airbnb does NOT put in the SSR'd HTML at this render depth
 * (bedrooms, bathrooms, amenities array, host name, manager label) are
 * intentionally left null. Per the enrichment-phase brief, "null is
 * acceptable where data is unclear" — we DO NOT scrape brittle DOM text
 * to fake them. Future detail passes can target a deeper render.
 *
 * Always returned: parseStatus + parseErrors so the runner can tag rows.
 */

export interface AirbnbDetailParse {
  /** "ok" | "partial" | "parse_fail" — quick downstream filter. */
  parseStatus: "ok" | "partial" | "parse_fail";
  /** Field-level absences/issues, never thrown. */
  parseErrors: string[];

  /** Adapter+parser version stamped onto each listing_details row. */
  parseVersion: "airbnb-detail-v1";

  /** Normalized fields — every value may be null. */
  normalized: AirbnbDetailNormalized;

  /** Raw fragments preserved verbatim for future re-parsing. */
  raw: AirbnbDetailRaw;
}

export interface AirbnbDetailNormalized {
  title: string | null;
  description: string | null;
  /** schema.org @type, e.g. "VacationRental". Coarse — Airbnb does not
   *  expose its internal property_type taxonomy in the SSR HTML. */
  propertyType: string | null;

  /** Bedrooms — null in this render depth. */
  bedrooms: number | null;
  /** Bathrooms — null in this render depth. */
  bathrooms: number | null;
  /** Maximum guest capacity (containsPlace.occupancy.value). */
  maxGuests: number | null;
  /** Sleeping beds count from Apollo (NOT bedrooms). */
  bedCount: number | null;

  /** Amenities — null array in this render depth. */
  amenities: string[] | null;

  latitude: number | null;
  longitude: number | null;

  /** "Hosted by …" / SuperhostBadge — null in this render depth. */
  hostName: string | null;

  /** From aggregateRating.ratingValue. */
  ratingOverall: number | null;
  /** From aggregateRating.ratingCount. */
  reviewCount: number | null;

  /** length of JSON-LD .image[] array. */
  imageCount: number | null;

  /** address.addressLocality and Apollo location.city, if present. */
  rawLocationHints: {
    addressLocality: string | null;
    apolloCity: string | null;
  };

  /** Decoded numeric Airbnb listing ID, when present in JSON-LD identifier. */
  externalListingId: string | null;
  /** "MARKETPLACE" | "PLUS" | etc. — Apollo pdpType. */
  pdpType: string | null;
  /** Apollo bookItPetPolicy.isAllowed. */
  petsAllowed: boolean | null;
}

export interface AirbnbDetailRaw {
  /** Parsed JSON-LD blocks (each is a parsed object), preserved verbatim. */
  jsonLdBlocks: unknown[];
  /** First Apollo DemandStayListing node we found in the cache (verbatim). */
  apolloDemandStayListing: unknown | null;
}

const EMPTY_NORMALIZED: AirbnbDetailNormalized = {
  title: null,
  description: null,
  propertyType: null,
  bedrooms: null,
  bathrooms: null,
  maxGuests: null,
  bedCount: null,
  amenities: null,
  latitude: null,
  longitude: null,
  hostName: null,
  ratingOverall: null,
  reviewCount: null,
  imageCount: null,
  rawLocationHints: { addressLocality: null, apolloCity: null },
  externalListingId: null,
  pdpType: null,
  petsAllowed: null,
};

/** Decode "RGVtYW5kU3RheUxpc3Rpbmc6MzAzMTY3NzY=" → "30316776". */
function decodeStayListingId(b64: string): string | null {
  try {
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const m = decoded.match(/^DemandStayListing:(\d+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Extract every <script type="application/ld+json"> block, JSON.parse each.
 *  Skips invalid blocks silently (their loss is reflected in parseErrors). */
function extractJsonLd(html: string): { blocks: unknown[]; errors: string[] } {
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const blocks: unknown[] = [];
  const errors: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch (e) {
      errors.push(`json-ld parse fail: ${(e as Error).message.slice(0, 80)}`);
    }
  }
  return { blocks, errors };
}

/** Walk an arbitrary tree, return the first node whose __typename matches. */
function findApolloNode(root: unknown, typename: string): unknown | null {
  if (!root || typeof root !== "object") return null;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const obj = cur as Record<string, unknown>;
    if (obj.__typename === typename) return obj;
    for (const k in obj) stack.push(obj[k]);
  }
  return null;
}

/**
 * The Apollo cache is a giant inline array literal of the form
 *   [["QueryKey:{json}", {data:{node:{...}}}], ...]
 * embedded inside one of the bootstrapping scripts. Rather than try to
 * extract the entire array (regex-fragile, depth-fragile), we scan for
 * substrings that look like serialized DemandStayListing nodes and
 * JSON.parse the smallest enclosing object that's valid.
 *
 * Returns the FIRST DemandStayListing node found, or null. Conservative
 * by design — better to record null than misattribute.
 */
function extractApolloDemandStayListing(html: string): unknown | null {
  // Look for occurrences of the discriminator and walk back to the
  // enclosing `{` then forward, balancing braces, until we have parseable
  // JSON. Cap candidates at a few thousand chars to bound work.
  const needle = '"__typename":"DemandStayListing"';
  let from = 0;
  let best: unknown | null = null;
  let bestSize = 0;
  // Try up to the first 8 occurrences. We want the largest balanced object
  // because earlier hits are typically shallow id-only nodes.
  for (let attempts = 0; attempts < 8; attempts++) {
    const idx = html.indexOf(needle, from);
    if (idx < 0) break;
    from = idx + needle.length;

    // Walk backwards to find the opening `{` for THIS object. We need to
    // count balanced `}` before any `{` we cross to make sure we land on
    // the actual enclosing object.
    let depth = 0;
    let start = -1;
    for (let i = idx; i >= 0 && idx - i < 4000; i--) {
      const ch = html.charCodeAt(i);
      if (ch === 125 /* } */) depth++;
      else if (ch === 123 /* { */) {
        if (depth === 0) { start = i; break; }
        depth--;
      }
    }
    if (start < 0) continue;

    // Walk forward balancing braces (string-aware) to find matching `}`.
    let bal = 0;
    let inStr = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < html.length && i - start < 12000; i++) {
      const ch = html.charCodeAt(i);
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === 92 /* \ */) escape = true;
        else if (ch === 34 /* " */) inStr = false;
        continue;
      }
      if (ch === 34) inStr = true;
      else if (ch === 123) bal++;
      else if (ch === 125) {
        bal--;
        if (bal === 0) { end = i; break; }
      }
    }
    if (end < 0) continue;

    const slice = html.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (slice.length > bestSize) {
        best = parsed;
        bestSize = slice.length;
      }
    } catch {
      // Not a valid object slice — keep scanning.
    }
  }
  return best;
}

/** Type-narrowing helpers — JSON-LD is `unknown` after parse. */
function asObj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" ? (x as Record<string, unknown>) : null;
}
function asStr(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 ? x : null;
}
function asNum(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function asArr(x: unknown): unknown[] | null {
  return Array.isArray(x) ? x : null;
}

/**
 * Main entry point — pure function from rendered HTML to the parsed
 * structure. Always returns; never throws.
 */
export function parseAirbnbDetailHtml(html: string): AirbnbDetailParse {
  const errors: string[] = [];
  const out: AirbnbDetailNormalized = { ...EMPTY_NORMALIZED, rawLocationHints: { addressLocality: null, apolloCity: null } };

  // ── 1. JSON-LD blocks ─────────────────────────────────────────────────
  const { blocks: jsonLdBlocks, errors: ldErrors } = extractJsonLd(html);
  errors.push(...ldErrors);

  // Prefer VacationRental, fall back to Product/Accommodation.
  const vacationRental = jsonLdBlocks.find(
    (b) => asObj(b)?.["@type"] === "VacationRental"
  );
  const productBlock = jsonLdBlocks.find(
    (b) => asObj(b)?.["@type"] === "Product"
  );
  const primary = asObj(vacationRental) ?? asObj(productBlock);

  if (!primary) {
    errors.push("no JSON-LD VacationRental/Product block found");
  } else {
    out.title = asStr(primary.name);
    out.description = asStr(primary.description);
    out.propertyType = asStr(primary["@type"]);

    const ident = asStr(primary.identifier);
    if (ident) out.externalListingId = decodeStayListingId(ident);

    // Top-level lat/lng (also lives under containsPlace on some pages).
    out.latitude = asNum(primary.latitude);
    out.longitude = asNum(primary.longitude);

    const address = asObj(primary.address);
    if (address) out.rawLocationHints.addressLocality = asStr(address.addressLocality);

    const containsPlace = asObj(primary.containsPlace);
    if (containsPlace) {
      const occupancy = asObj(containsPlace.occupancy);
      if (occupancy) out.maxGuests = asNum(occupancy.value);
      // containsPlace can also restate lat/lng — only take it if missing.
      if (out.latitude === null) out.latitude = asNum(containsPlace.latitude);
      if (out.longitude === null) out.longitude = asNum(containsPlace.longitude);
    }

    const aggregate = asObj(primary.aggregateRating);
    if (aggregate) {
      out.ratingOverall = asNum(aggregate.ratingValue);
      out.reviewCount = asNum(aggregate.ratingCount);
    }

    const images = asArr(primary.image);
    if (images) out.imageCount = images.length;
  }

  // ── 2. Apollo DemandStayListing node ──────────────────────────────────
  const apolloRaw = extractApolloDemandStayListing(html);
  if (!apolloRaw) {
    errors.push("no Apollo DemandStayListing node found");
  } else {
    const node = asObj(apolloRaw);
    if (node) {
      // bedCount lives on some nodes (e.g. PdpEarlyFlushMetadataV2 follow-ups).
      // It's distinct from bedrooms — keep it labelled accordingly.
      const bedCount = asNum(node.bedCount);
      if (bedCount !== null) out.bedCount = bedCount;

      out.pdpType = asStr(node.pdpType);

      const location = asObj(node.location);
      if (location) {
        out.rawLocationHints.apolloCity = asStr(location.city);
        const coord = asObj(location.coordinate);
        if (coord) {
          if (out.latitude === null) out.latitude = asNum(coord.latitude);
          if (out.longitude === null) out.longitude = asNum(coord.longitude);
        }
      }

      const pdpPresentation = asObj(node.pdpPresentation);
      if (pdpPresentation) {
        const pet = asObj(pdpPresentation.petPolicy);
        if (pet && typeof pet.isAllowed === "boolean") out.petsAllowed = pet.isAllowed;
      }

      // Cross-check / backfill description from Apollo if JSON-LD lacked it.
      if (out.title === null || out.description === null) {
        const desc = asObj(node.description);
        if (desc) {
          if (out.title === null) {
            const name = asObj(desc.name);
            if (name) out.title = asStr(name.localizedString);
          }
          if (out.description === null) {
            const summary = asObj(desc.summary);
            if (summary) out.description = asStr(summary.localizedString);
          }
        }
      }

      // Decode external id from Apollo too if JSON-LD didn't carry it.
      if (out.externalListingId === null) {
        const id = asStr(node.id);
        if (id) out.externalListingId = decodeStayListingId(id);
      }
    }
  }

  // ── 3. Status classification ──────────────────────────────────────────
  // "parse_fail" = no usable structured data at all
  // "ok" = at least title + (lat OR maxGuests OR rating)
  // "partial" = title only, or coords-only with no metadata
  const hasAnchor = out.title !== null;
  const hasMeta = out.maxGuests !== null || out.ratingOverall !== null || out.latitude !== null;
  let parseStatus: AirbnbDetailParse["parseStatus"];
  if (!hasAnchor && !hasMeta) parseStatus = "parse_fail";
  else if (hasAnchor && hasMeta) parseStatus = "ok";
  else parseStatus = "partial";

  // Note absences explicitly so reviewers can scan parse_errors.
  if (out.bedrooms === null) errors.push("bedrooms: not in SSR HTML at this render depth");
  if (out.bathrooms === null) errors.push("bathrooms: not in SSR HTML at this render depth");
  if (out.amenities === null) errors.push("amenities: not in SSR HTML at this render depth");
  if (out.hostName === null) errors.push("hostName: not in SSR HTML at this render depth");

  return {
    parseStatus,
    parseErrors: errors,
    parseVersion: "airbnb-detail-v1",
    normalized: out,
    raw: { jsonLdBlocks, apolloDemandStayListing: apolloRaw },
  };
}
