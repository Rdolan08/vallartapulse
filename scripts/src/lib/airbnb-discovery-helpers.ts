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

// ── Property-type whitelist ─────────────────────────────────────────────────

/**
 * Allowed property types for vacation-rental comp pool. Tokens are matched
 * lowercase, substring-aware so "Apartment" matches "Entire apartment", etc.
 */
const ALLOWED_PROPERTY_TOKENS = [
  "apartment",
  "condominium",
  "condo",
  "house",
  "villa",
  "townhouse",
  "loft",
  "bungalow",
  "guest suite",
  "guesthouse",
  "guest house",
  "cottage",
  "cabin", // Airbnb sometimes labels small detached units this way
  // "Rental unit" is Airbnb's default category for whole-unit rentals
  // that aren't sub-classified as apartment/condo/etc. Empirically it's
  // the dominant property type on listings created in the last ~year
  // (78%+ of new admits in the zona_romantica smoke runs were getting
  // rejected on this token). Allowed because the og:title parser
  // already strips the "Entire/Private/Shared" prefix before this
  // gate runs, so a "Rental unit" label here is implicitly a whole-unit.
  "rental unit",
  // "Serviced apartment" — DECISION: allow. Airbnb uses this label for
  // furnished, hotel-adjacent, owner/management-operated whole units that
  // behave like vacation rentals for pricing purposes (per-night rates,
  // furnished, instant-bookable, often building-level concierge). They
  // are legitimate comp pool members for nightly-rate modeling. The
  // existing "apartment" token already substring-matches this label
  // (lower.includes("apartment") is true for "serviced apartment"), so
  // this token is technically redundant — but listing it explicitly
  // documents the policy decision and prevents an accidental future
  // narrowing of "apartment" → "/^apartment$/" from silently dropping
  // them.
  "serviced apartment",
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
  "private room", // we only want whole-unit rentals
] as const;

/**
 * Check whether a raw property-type label belongs to the whitelist.
 *
 * Returns `true` iff the label contains at least one allowed token AND
 * does not contain any rejected token. NULL/empty labels default to
 * `false` (treat as wrong-type) so the runner doesn't insert thin records
 * into the active cohort.
 */
export function isAllowedPropertyType(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  for (const tok of REJECTED_PROPERTY_TOKENS) {
    if (lower.includes(tok)) return false;
  }
  for (const tok of ALLOWED_PROPERTY_TOKENS) {
    if (lower.includes(tok)) return true;
  }
  return false;
}

/** Lowercase + collapse whitespace; NULL stays NULL. */
export function normalizePropertyType(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
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
  | "run_started"
  | "run_finished"
  | "bucket_started"
  | "bucket_finished"
  | "search_page_fetched"
  | "search_page_failed"
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
