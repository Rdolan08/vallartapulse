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
  /** Raw <meta property="og:title"> content — present even on partially
   *  hydrated pages, used as a tertiary fallback. Optional for backward
   *  compatibility with rows persisted before this field was added. */
  ogTitle?: string | null;
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

// ─────────────────────────────────────────────────────────────────────────
// Bedroom / bathroom fallback extractors.
//
// As of late 2025 Airbnb's PDP no longer renders bedrooms/bathrooms inside
// the SSR HTML — they bind after Apollo hydration. Titles + descriptions
// almost always restate these counts (e.g. "3BR Ocean View Villa",
// "three-bedroom, three-bath retreat", "Casa con 4 recámaras y 2 baños").
// We regex over `${title}\n${description}` as a backstop so the comp engine
// has the most pricing-relevant attribute populated for every listing where
// the host bothered to mention it (which is essentially all of them).
// ─────────────────────────────────────────────────────────────────────────

const WORD_TO_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

export function extractBedroomsFromText(text: string): number | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Studio / efficiency / monoambiente → 0 bedrooms.
  // Match only when these words refer to the property type, not as
  // adjacent vocabulary (e.g. "studio apartment", "efficiency unit",
  // "estudio con cocina"). The regex requires a word boundary on both
  // sides and is paired with a negative lookahead for the words that
  // would imply a multi-bedroom property mentioning a "studio" amenity.
  if (/\b(?:studio|estudio|monoambiente|efficiency)\b/.test(lower) &&
      !/\b\d+\s*(?:br|bd|bed(?:room)?s?|recámaras?|recamaras?|habitaciones?|dormitorios?)\b/.test(lower)) {
    return 0;
  }

  // Numeric forms in EN/ES:
  //   "3BR", "3 br", "3-bedroom", "3 bedrooms", "3 bd", "3 bed"
  //   "3 recámaras", "4 habitaciones", "2 dormitorios"
  const numMatch = lower.match(
    /\b(\d+)\s*-?\s*(?:br|bd|bed(?:room)?s?|recámaras?|recamaras?|habitaciones?|dormitorios?)\b/
  );
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  }

  // Word forms: "two-bedroom", "three bedrooms", "tres recámaras"
  const wordMatch = lower.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)[\s-]+(?:bedroom|bed|recámara|recamara|habitación|habitacion|dormitorio)s?\b/
  );
  if (wordMatch) return WORD_TO_NUM[wordMatch[1]] ?? null;

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// og:title tertiary fallback.
//
// Airbnb embeds a richly structured Open Graph title on every PDP, and it
// renders into the SSR HTML even on responses where Apollo deferred-state
// or JSON-LD fail to hydrate fully. Format examples observed in the wild:
//   "Condo in Puerto Vallarta · ★4.96 · 2 bedrooms · 2 beds · 2 private baths"
//   "Rental unit in Sayulita · ★4.89 · 1 bedroom · 1 bed · 1 private bath"
//   "Studio in Romantic Zone · ★4.7 · 1 bed · 1 bath"
//
// The parsed parts (propertyType, neighborhood, ratingOverall, bedrooms,
// bedCount, bathrooms) are applied ONLY where prior signals left a null,
// so this fallback can never overwrite higher-trust data.
// ─────────────────────────────────────────────────────────────────────────

export interface OgTitleParts {
  propertyType: string | null;
  neighborhood: string | null;
  ratingOverall: number | null;
  bedrooms: number | null;
  bedCount: number | null;
  bathrooms: number | null;
}

/** Pulls the raw og:title content (or null). */
export function extractOgTitle(html: string): string | null {
  const m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

/** Best-effort parse of the structured "X in Y · ★R · Z bedrooms · ..." og:title. */
export function parseOgTitle(og: string): OgTitleParts {
  const out: OgTitleParts = {
    propertyType: null, neighborhood: null, ratingOverall: null,
    bedrooms: null, bedCount: null, bathrooms: null,
  };
  if (!og) return out;

  // "<propertyType> in <neighborhood> · ..." — captured up to the first " · "
  // boundary so we don't pull rating/bedrooms into the locality slot.
  const inMatch = og.match(/^([^·]+?)\s+in\s+([^·]+?)\s*(?:·|$)/i);
  if (inMatch) {
    out.propertyType = inMatch[1].trim() || null;
    out.neighborhood = inMatch[2].trim() || null;
  }

  const rating = og.match(/★\s*(\d+(?:\.\d+)?)/);
  if (rating) {
    const r = parseFloat(rating[1]);
    if (Number.isFinite(r) && r >= 0 && r <= 5) out.ratingOverall = r;
  }

  // Studio = 0 bedrooms, but only when no explicit bedroom count appears.
  if (/\bstudio\b/i.test(og) && !/\d+\s*bedroom/i.test(og)) {
    out.bedrooms = 0;
  }
  const br = og.match(/(\d+)\s*bedroom/i);
  if (br) {
    const n = parseInt(br[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 30) out.bedrooms = n;
  }
  // bedCount — match "X bed" / "X beds" but NOT "X bedroom" (negative lookahead).
  const bd = og.match(/(\d+)\s*beds?\b(?!\s*room)/i);
  if (bd) {
    const n = parseInt(bd[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 50) out.bedCount = n;
  }
  // bathrooms — handle "X bath", "X baths", "X private baths", "X.5 baths"
  const ba = og.match(/(\d+(?:\.5)?)\s*(?:private\s+|shared\s+)?baths?\b/i);
  if (ba) {
    const n = parseFloat(ba[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 30) out.bathrooms = n;
  }

  return out;
}

export function extractBathroomsFromText(text: string): number | null {
  if (!text) return null;
  const lower = text.toLowerCase();

  // Numeric forms (allow .5 for half baths):
  //   "3-bath", "3 baths", "3 bathrooms", "2.5 baths", "3 baños", "2 banos"
  //   We deliberately exclude bare "ba" because it collides too often with
  //   product-noise like "BAJA", "ba.", room codes etc.
  const numMatch = lower.match(
    /\b(\d+(?:\.5)?)\s*-?\s*(?:baths?|bathrooms?|baños?|banos?)\b/
  );
  if (numMatch) {
    const n = parseFloat(numMatch[1]);
    if (Number.isFinite(n) && n >= 0 && n <= 20) return n;
  }

  // Word forms: "two-bath", "three bathrooms", "dos baños"
  const wordMatch = lower.match(
    /\b(one|two|three|four|five|six|uno|dos|tres|cuatro|cinco|seis)[\s-]+(?:bathroom|bath|baño|bano)s?\b/
  );
  if (wordMatch) return WORD_TO_NUM[wordMatch[1]] ?? null;

  return null;
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

  // ── 2.5. Fallback extraction from title + description ────────────────
  // Airbnb removed bedrooms/bathrooms from the initial SSR HTML in late 2025
  // — they only appear after Apollo hydration. As a backstop we regex the
  // title + description, which reliably state these counts (e.g. "Las Brisas
  // 3BR Ocean View", "three-bedroom, three-bath retreat", "Casa con 4
  // recámaras"). Studio detection maps to bedrooms = 0.
  if (out.bedrooms === null) {
    out.bedrooms = extractBedroomsFromText(`${out.title ?? ""}\n${out.description ?? ""}`);
  }
  if (out.bathrooms === null) {
    out.bathrooms = extractBathroomsFromText(`${out.title ?? ""}\n${out.description ?? ""}`);
  }

  // ── 2.7. og:title tertiary fallback ──────────────────────────────────
  // The Open Graph title is structured ("X in Y · ★R · N bedrooms · N beds
  // · N baths") and ships in the SSR HTML even when Apollo deferred-state
  // or JSON-LD fail to hydrate. We apply each parsed part ONLY where the
  // corresponding field is still null, so this fallback can never overwrite
  // higher-trust data from JSON-LD or Apollo.
  const ogTitle = extractOgTitle(html);
  if (ogTitle) {
    const og = parseOgTitle(ogTitle);
    if (out.title === null) out.title = ogTitle;
    if (out.propertyType === null && og.propertyType !== null) out.propertyType = og.propertyType;
    if (out.bedrooms === null && og.bedrooms !== null) out.bedrooms = og.bedrooms;
    if (out.bedCount === null && og.bedCount !== null) out.bedCount = og.bedCount;
    if (out.bathrooms === null && og.bathrooms !== null) out.bathrooms = og.bathrooms;
    if (out.ratingOverall === null && og.ratingOverall !== null) out.ratingOverall = og.ratingOverall;
    if (out.rawLocationHints.addressLocality === null && og.neighborhood !== null) {
      out.rawLocationHints.addressLocality = og.neighborhood;
    }
  } else {
    errors.push("og:title meta tag not present");
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
  if (out.bedrooms === null) errors.push("bedrooms: not in SSR HTML AND no fallback signal in title/description");
  if (out.bathrooms === null) errors.push("bathrooms: not in SSR HTML AND no fallback signal in title/description");
  if (out.amenities === null) errors.push("amenities: not in SSR HTML at this render depth");
  if (out.hostName === null) errors.push("hostName: not in SSR HTML at this render depth");

  return {
    parseStatus,
    parseErrors: errors,
    parseVersion: "airbnb-detail-v1",
    normalized: out,
    raw: { jsonLdBlocks, apolloDemandStayListing: apolloRaw, ogTitle },
  };
}
