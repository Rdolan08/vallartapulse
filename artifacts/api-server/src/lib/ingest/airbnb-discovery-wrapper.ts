/**
 * ingest/airbnb-discovery-wrapper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2b composition wrapper. Takes a single DiscoverySeed + a YieldTracker
 * and produces card-level observations using the EXISTING airbnb-search-adapter
 * helpers (extractSearchCards, normalizeCard, airbnbHttpGet). The existing
 * adapter is not rewritten — only its building blocks are reused.
 *
 * Block-detection contract (revised — card-count-first):
 *   1. cardCount > 0  → ALWAYS treat as success, regardless of marker hits.
 *      Airbnb routinely bundles reCAPTCHA Enterprise scripts on real search
 *      pages, so a literal "captcha" substring on a page that *also* contains
 *      real listings is not evidence of a block.
 *   2. cardCount = 0 AND a *specific*, Airbnb-interstitial marker present →
 *      mark blocked.
 *   3. cardCount = 0 AND no specific marker → return null. The runner / yield
 *      tracker will classify as empty_results (parser succeeded, zero cards)
 *      or parse_fail (parser failed). We do NOT auto-fail on tiny pages or on
 *      "zero cards + no pagination" heuristics — those produced false blocks.
 *   - One HTTP fetch per call to fetchAirbnbSeedBatch()
 */

import {
  airbnbHttpGet,
  extractSearchCards,
  type SearchCard,
} from "./airbnb-search-adapter.js";
import type { DiscoverySeed } from "./seed-generator.js";
import type { FetchMode } from "./http-proxy.js";

// ─────────────────────────────────────────────────────────────────────────────
// URL construction
// ─────────────────────────────────────────────────────────────────────────────

/** Pricing-tool bucket → Airbnb search slug. */
const BUCKET_SLUG: Record<string, string> = {
  "Zona Romántica": "Zona-Romantica--Puerto-Vallarta--Mexico",
  "Amapas / Conchas Chinas": "Amapas--Puerto-Vallarta--Mexico",
  "Centro / Alta Vista": "Centro--Puerto-Vallarta--Mexico",
  "Hotel Zone / Malecón": "Hotel-Zone--Puerto-Vallarta--Mexico",
  "5 de Diciembre": "5-de-Diciembre--Puerto-Vallarta--Mexico",
  "Old Town": "Puerto-Vallarta--Jalisco--Mexico",
  "Versalles": "Versalles--Puerto-Vallarta--Mexico",
  "Marina Vallarta": "Marina-Vallarta--Puerto-Vallarta--Mexico",
  "Mismaloya": "Mismaloya--Puerto-Vallarta--Mexico",
  "Nuevo Vallarta": "Nuevo-Vallarta--Nayarit--Mexico",
  "Bucerías": "Bucerias--Nayarit--Mexico",
  "La Cruz de Huanacaxtle": "La-Cruz-de-Huanacaxtle--Nayarit--Mexico",
  "Punta Mita": "Punta-de-Mita--Nayarit--Mexico",
  "El Anclote": "Punta-de-Mita--Nayarit--Mexico",
  "Sayulita": "Sayulita--Nayarit--Mexico",
  "San Pancho": "San-Francisco--Nayarit--Mexico",
};

/** Bedroom bucket → Airbnb min_bedrooms query value (null = no filter). */
function bedroomMin(bucket: string): number | null {
  switch (bucket) {
    case "studio":
      return null;
    case "1":
      return 1;
    case "2":
      return 2;
    case "3":
      return 3;
    case "4plus":
      return 4;
    default:
      return null;
  }
}

/** Compute checkin/checkout dates for a given window + stay length. */
export function computeStayDates(
  window: string,
  stayLengthNights: number,
  today: Date = new Date()
): { checkin: string; checkout: string } {
  const base = new Date(today);
  base.setUTCHours(12, 0, 0, 0);

  let checkin: Date;
  if (window === "next_weekend") {
    // First Friday strictly after today
    const dow = base.getUTCDay(); // 0=Sun..6=Sat
    const daysUntilFri = ((5 - dow + 7) % 7) || 7;
    checkin = addDays(base, daysUntilFri);
  } else if (window === "+14") {
    checkin = addDays(base, 14);
  } else if (window === "+30") {
    checkin = addDays(base, 30);
  } else if (window === "+60") {
    checkin = addDays(base, 60);
  } else if (window === "+90") {
    checkin = addDays(base, 90);
  } else if (window === "+180") {
    checkin = addDays(base, 180);
  } else {
    checkin = addDays(base, 14);
  }
  const checkout = addDays(checkin, stayLengthNights);
  return {
    checkin: toYmd(checkin),
    checkout: toYmd(checkout),
  };
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildAirbnbSearchUrl(seed: DiscoverySeed): string {
  const slug =
    BUCKET_SLUG[seed.normalizedNeighborhoodBucket] ??
    "Puerto-Vallarta--Jalisco--Mexico";
  const dates = computeStayDates(seed.checkinWindow, seed.stayLengthNights);
  const params = new URLSearchParams();
  params.set("adults", String(seed.guestCount));
  params.set("checkin", dates.checkin);
  params.set("checkout", dates.checkout);
  const minBeds = bedroomMin(seed.bedroomBucket);
  if (minBeds !== null) params.set("min_bedrooms", String(minBeds));
  return `https://www.airbnb.com/s/${slug}/homes?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Specific interstitial / WAF markers. The bare token "captcha" is intentionally
 * NOT in this list — Airbnb preloads reCAPTCHA Enterprise on every search page
 * for the booking flow, so it appears in benign script tags. The generic
 * "are you a human" / "are you human" strings were also too noisy and were
 * removed; add them back only if confirmed inside an actual Airbnb block page.
 */
const BLOCK_MARKERS = [
  "px-captcha",
  "perimeterx",
  "pardon our interruption",
  "/forbidden",
  "access denied",
];

export function detectBlock(html: string, cardCount: number): string | null {
  // Card-count-first contract: real cards always win over marker noise.
  if (cardCount > 0) return null;
  const lower = html.toLowerCase();
  for (const m of BLOCK_MARKERS) {
    if (lower.includes(m)) return `marker:${m}`;
  }
  // No cards AND no specific block marker → not blocked. Caller will
  // classify as empty_results / parse_fail.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface AirbnbBatch {
  url: string;
  cards: SearchCard[];
  raw: { htmlLength: number; httpDurationMs: number };
  blocked: string | null;
  error: string | null;
}

/**
 * Fetch one batch of cards for a seed. Phase 2b uses one batch per seed
 * (Airbnb's first search page). The runner decides whether to keep going.
 */
export async function fetchAirbnbSeedBatch(
  seed: DiscoverySeed,
  opts: { maxCards?: number; fetchMode?: FetchMode } = {}
): Promise<AirbnbBatch> {
  const url = buildAirbnbSearchUrl(seed);
  const t0 = Date.now();
  let html = "";
  try {
    html = await airbnbHttpGet(url, { fetchMode: opts.fetchMode });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const blocked = /403|429|rate-limited/i.test(msg) ? `http:${msg}` : null;
    return {
      url,
      cards: [],
      raw: { htmlLength: 0, httpDurationMs: Date.now() - t0 },
      blocked,
      error: blocked ? null : msg,
    };
  }
  const httpDurationMs = Date.now() - t0;
  const allCards = extractSearchCards(html);
  const blocked = detectBlock(html, allCards.length);
  const cap = opts.maxCards ?? allCards.length;
  return {
    url,
    cards: allCards.slice(0, cap),
    raw: { htmlLength: html.length, httpDurationMs },
    blocked,
    error: null,
  };
}
