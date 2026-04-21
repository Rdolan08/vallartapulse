/**
 * scripts/src/lib/airbnb-discovery-helpers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure utility helpers for the Airbnb discovery runner: pacing/jitter,
 * bounding-box gating, property-type whitelist, and structured stdout
 * event emission.
 *
 * No I/O beyond stdout.
 */

// ── Pacing ──────────────────────────────────────────────────────────────────

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Random integer in [minMs, maxMs] inclusive. Used to jitter request pacing
 * so the residential IP doesn't generate a perfectly periodic pattern.
 */
export function randomDelayMs(minMs: number, maxMs: number): number {
  if (maxMs < minMs) return minMs;
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
}

/**
 * Exponential backoff delay for retry `attempt` (0-indexed). Caps at 60s.
 * 0 → ~5s, 1 → ~10s, 2 → ~20s, 3 → ~40s, 4+ → 60s. Adds ±20% jitter.
 */
export function backoffMs(attempt: number): number {
  const base = Math.min(60_000, 5_000 * Math.pow(2, attempt));
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(1_000, Math.round(base + jitter));
}

// ── Geographic gate ─────────────────────────────────────────────────────────

/**
 * Generous Puerto Vallarta + Riviera Nayarit market bounding box. Anything
 * outside is junk discovery — usually a result of Airbnb's "near Puerto
 * Vallarta" fuzziness returning Guadalajara or Mexico City listings.
 */
const PV_MARKET_BBOX = {
  minLat: 20.5,
  maxLat: 20.85,
  minLng: -105.6,
  maxLng: -105.18,
} as const;

export function inMarket(lat: number, lng: number): boolean {
  return (
    lat >= PV_MARKET_BBOX.minLat &&
    lat <= PV_MARKET_BBOX.maxLat &&
    lng >= PV_MARKET_BBOX.minLng &&
    lng <= PV_MARKET_BBOX.maxLng
  );
}

// ── Property-type policy ────────────────────────────────────────────────────
//
// Two-stage policy:
//
//   1. ALLOWED / REJECTED token sets decide whether a listing enters the
//      main comp cohort. REJECTED is checked FIRST so multi-word labels
//      like "Vacation home" can be excluded even though they contain the
//      "home" substring used by the allow check.
//
//   2. normalizePropertyType() collapses Airbnb's many overlapping labels
//      into a small canonical set used for cohort/comp queries. The raw
//      label is preserved separately in property_type_raw so we can
//      always go back to source. The canonical set:
//
//        apartment   ← Apartment, Serviced apartment, Rental unit,
//                       Condominium, Condo (these all price the same
//                       in PV — multi-unit building, shared services,
//                       per-unit rentals)
//        house       ← House, Home, Single-family home (whole-unit
//                       detached or quasi-detached residences)
//        villa       ← Villa
//        townhouse   ← Townhouse
//        loft        ← Loft
//        bungalow    ← Bungalow
//        guest_suite ← Guest suite, Guesthouse, Guest house
//        cottage     ← Cottage
//        cabin       ← Cabin
//        studio      ← Studio
//
// Anything else falls through to allow=false → rejected.

const ALLOWED_PROPERTY_TOKENS = [
  "apartment",        // covers Apartment + Serviced apartment via substring
  "rental unit",      // Airbnb's default whole-unit category
  "condominium",
  "condo",
  "house",            // covers House + Townhouse via substring
  "home",             // covers Home (Entire prefix stripped by parser)
  "villa",
  "townhouse",
  "loft",
  "bungalow",
  "guest suite",
  "guesthouse",
  "guest house",
  "cottage",
  "cabin",
  "studio",
] as const;

const REJECTED_PROPERTY_TOKENS = [
  "hotel",
  "hostel",
  "boat",
  "yacht",
  "camper",
  "rv",
  "tent",
  "tipi",
  "treehouse",
  "cave",
  "farm stay",
  "capsule",
  "earthen",
  "barn",
  "shipping container",
  "shared room",
  "private room",
  // The next three were briefly allowed during admission tuning but the
  // production policy (consolidated 2026-04) is to exclude them from the
  // main cohort: they price differently from the standard whole-unit
  // vacation rental and would distort comp medians.
  //
  //   - "vacation home" — would otherwise pass via the "home" substring,
  //     hence the explicit reject; pricing tends to follow a luxury /
  //     long-stay pattern that's not comparable to nightly vacation
  //     rental comps.
  //   - "casa particular" — Cuban-style category Airbnb keeps untranslated;
  //     not covered by any English allow token, so this entry is
  //     belt-and-suspenders for clarity / greppability.
  //   - "tower" / "castle" — novelty categories; explicitly listed so
  //     anyone reading the rejection log knows it's intentional.
  "vacation home",
  "casa particular",
  "tower",
  "castle",
] as const;

/**
 * Pre-compile each token as a word-boundary regex.
 *
 * Why not plain `String.includes`: a previous version of this code used
 * substring matching, which had a subtle bug — the "rv" reject token
 * (for Camper/RV) substring-matches "se**rv**iced apartment" and would
 * silently kick out every Serviced apartment listing. Short tokens like
 * "rv", "tent", "barn" all need word-boundary protection. Compiling the
 * patterns once at module load avoids per-listing regex construction.
 *
 * `\b` treats hyphens, slashes, spaces, punctuation, and string edges as
 * boundaries — so all of these still match correctly:
 *
 *   "Entire apartment"       → \bapartment\b ✓
 *   "Single-family home"     → \bhome\b      ✓
 *   "Camper/RV"              → \brv\b        ✓
 *   "Serviced apartment"     → \bapartment\b ✓ (no false \brv\b)
 *   "Vacation home"          → \bvacation home\b ✓
 */
function compileTokenPattern(tok: string): RegExp {
  // Escape regex metacharacters in the token before wrapping in \b…\b.
  const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

const ALLOWED_PATTERNS: readonly RegExp[] = ALLOWED_PROPERTY_TOKENS.map(compileTokenPattern);
const REJECTED_PATTERNS: readonly RegExp[] = REJECTED_PROPERTY_TOKENS.map(compileTokenPattern);

/**
 * Check whether a raw property-type label belongs in the active cohort.
 *
 * Returns `true` iff the label matches at least one allowed token AND
 * matches no rejected token. NULL/empty labels default to `false`
 * (treat as wrong-type) so the runner doesn't insert thin records into
 * the active cohort.
 *
 * REJECTED is checked first so multi-word excludes like "vacation home"
 * win over the "home" allow pattern.
 */
export function isAllowedPropertyType(raw: string | null | undefined): boolean {
  if (!raw) return false;
  for (const re of REJECTED_PATTERNS) {
    if (re.test(raw)) return false;
  }
  for (const re of ALLOWED_PATTERNS) {
    if (re.test(raw)) return true;
  }
  return false;
}

/**
 * Canonical normalization map. Applied AFTER isAllowedPropertyType has
 * passed the listing into the cohort, so we can assume the raw label
 * contains at least one allowed token and no rejected token.
 *
 * Order matters: more specific patterns must precede their substring
 * matches (e.g. "serviced apartment" is checked before bare "apartment"
 * — though both map to "apartment" today, the explicit ordering
 * documents intent and survives future divergence).
 *
 * Returns NULL only if the input is null/empty. Otherwise always returns
 * one of the canonical values:
 *
 *   "apartment" | "house" | "villa" | "townhouse" | "loft" |
 *   "bungalow" | "guest_suite" | "cottage" | "cabin" | "studio" |
 *   "<lowercased raw>"   ← only for unknown labels that somehow passed
 *                          isAllowedPropertyType; defensive fallback.
 */
export function normalizePropertyType(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!lower) return null;

  // Order matters — most specific first.
  if (lower.includes("serviced apartment")) return "apartment";
  if (lower.includes("rental unit")) return "apartment";
  if (lower.includes("condominium") || lower.includes("condo")) return "apartment";
  if (lower.includes("apartment")) return "apartment";

  if (lower.includes("townhouse")) return "townhouse";
  if (lower.includes("guest suite") ||
      lower.includes("guesthouse") ||
      lower.includes("guest house")) return "guest_suite";

  // House / home / single-family — all fold to "house". Done after townhouse
  // and guest house so those don't get swallowed by the "house" substring.
  if (lower.includes("single-family") ||
      lower.includes("single family") ||
      lower.includes("house") ||
      lower.includes("home")) return "house";

  if (lower.includes("villa")) return "villa";
  if (lower.includes("loft")) return "loft";
  if (lower.includes("bungalow")) return "bungalow";
  if (lower.includes("cottage")) return "cottage";
  if (lower.includes("cabin")) return "cabin";
  if (lower.includes("studio")) return "studio";

  // Defensive fallback: passed allow check but didn't match a canonical
  // bucket. Preserves the raw label (lowercased) so comp queries don't
  // crash on null while flagging the gap for future allowlist tuning.
  return lower;
}

// ── External-ID parsing ─────────────────────────────────────────────────────

/**
 * Strips the "ABB-" prefix used by older code paths. Idempotent: a bare
 * numeric string is returned as-is.
 */
export function parseExternalId(sourceListingId: string): string {
  if (sourceListingId.startsWith("ABB-")) return sourceListingId.slice(4);
  return sourceListingId;
}

// ── Structured stdout logging ───────────────────────────────────────────────

export type EventType =
  | "run_planned"
  | "run_started"
  | "run_finished"
  | "bucket_started"
  | "bucket_finished"
  | "search_page_fetched"
  | "search_page_failed"
  | "search_page_debug"
  | "candidate_deduped"
  | "identity_check_started"
  | "identity_check_passed"
  | "identity_check_failed"
  | "identity_retry"
  | "listing_inserted"
  | "listing_updated"
  | "listing_rejected"
  | "existing_touched";

export interface LogEventInput {
  event: EventType;
  bucketId?: string;
  externalId?: string;
  reason?: string;
  attempt?: number;
  [key: string]: unknown;
}

/** Emit one JSON object per line. Grep-friendly. */
export function logEvent(input: LogEventInput): void {
  const line = {
    timestamp: new Date().toISOString(),
    ...input,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
