/**
 * ingest/vrbo-discovery-wrapper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2b composition wrapper for VRBO. Reuses the existing
 * vrbo-search-adapter.ts helpers (vrboHttpGet, extractVrboListingIds) without
 * rewriting the working adapter.
 *
 * VRBO search pages only expose listing IDs (not nightly price, beds, ratings,
 * etc.) so the returned SearchCard objects carry { id } only. Downstream
 * upsertListing/insertObservation already tolerate null metadata — pricing
 * details would come from a separate detail-fetch phase, not this discovery
 * wrapper.
 */

import {
  vrboHttpGet,
  extractVrboListingIds,
} from "./vrbo-search-adapter.js";
import type { SearchCard } from "./airbnb-search-adapter.js";
import type { DiscoverySeed } from "./seed-generator.js";
import { computeStayDates } from "./airbnb-discovery-wrapper.js";
import type { FetchMode } from "./http-proxy.js";

// ─────────────────────────────────────────────────────────────────────────────
// URL construction
// ─────────────────────────────────────────────────────────────────────────────

/** Pricing-tool bucket → VRBO-friendly keyword string for the search filter. */
const BUCKET_KEYWORDS: Record<string, string> = {
  "Zona Romántica": "Zona Romantica",
  "Amapas / Conchas Chinas": "Amapas",
  "Centro / Alta Vista": "Centro",
  "Hotel Zone / Malecón": "Hotel Zone",
  "5 de Diciembre": "5 de Diciembre",
  "Old Town": "Old Town",
  "Versalles": "Versalles",
  "Marina Vallarta": "Marina Vallarta",
  "Mismaloya": "Mismaloya",
  "Nuevo Vallarta": "Nuevo Vallarta",
  "Bucerías": "Bucerias",
  "La Cruz de Huanacaxtle": "La Cruz",
  "Punta Mita": "Punta Mita",
  "El Anclote": "Punta Mita",
  "Sayulita": "Sayulita",
  "San Pancho": "San Pancho",
};

/** Pricing-tool bucket → VRBO base path (parent region falls back to PV). */
function bucketBasePath(parentRegion: string): string {
  return parentRegion === "riviera_nayarit"
    ? "/vacation-rentals/mexico/nayarit"
    : "/vacation-rentals/mexico/jalisco/puerto-vallarta";
}

export function buildVrboSearchUrl(seed: DiscoverySeed): string {
  const dates = computeStayDates(seed.checkinWindow, seed.stayLengthNights);
  const params = new URLSearchParams();
  params.set("d1", dates.checkin);
  params.set("d2", dates.checkout);
  params.set("sleeps", String(seed.guestCount));
  // Bedroom filter: VRBO uses 'minBedrooms'
  switch (seed.bedroomBucket) {
    case "1":
      params.set("minBedrooms", "1");
      break;
    case "2":
      params.set("minBedrooms", "2");
      break;
    case "3":
      params.set("minBedrooms", "3");
      break;
    case "4plus":
      params.set("minBedrooms", "4");
      break;
    // studio: no min
  }
  const keyword = BUCKET_KEYWORDS[seed.normalizedNeighborhoodBucket];
  if (keyword) params.set("keywords", keyword);
  return `https://www.vrbo.com${bucketBasePath(seed.parentRegionBucket)}?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block detection (VRBO-specific)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * VRBO-specific markers. `captcha-delivery` is the DataDome challenge host that
 * VRBO uses; we keep it because DataDome on VRBO is a confirmed real block (per
 * the prior browser-mode test). Card-count-first contract still applies: if
 * the page returned listing IDs, it's a success even if a tracker mentions
 * captcha somewhere in the HTML.
 */
const BLOCK_MARKERS = [
  "px-captcha",
  "perimeterx",
  "pardon our interruption",
  "captcha-delivery",
  "/forbidden",
  "access denied",
  "blocked - vrbo",
];

export function detectVrboBlock(html: string, idCount: number): string | null {
  // Card-count-first: real listing IDs always win over marker noise.
  if (idCount > 0) return null;
  const lower = html.toLowerCase();
  for (const m of BLOCK_MARKERS) {
    if (lower.includes(m)) return `marker:${m}`;
  }
  // No IDs AND no specific marker → not blocked. The runner records
  // cardsObserved=0 and the yield-tracker classifies as empty_results.
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface VrboBatch {
  url: string;
  cards: SearchCard[];
  raw: { htmlLength: number; httpDurationMs: number };
  blocked: string | null;
  error: string | null;
}

export async function fetchVrboSeedBatch(
  seed: DiscoverySeed,
  opts: { maxCards?: number; fetchMode?: FetchMode } = {}
): Promise<VrboBatch> {
  const url = buildVrboSearchUrl(seed);
  const t0 = Date.now();
  let html = "";
  try {
    html = await vrboHttpGet(url, { fetchMode: opts.fetchMode });
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
  const ids = extractVrboListingIds(html);
  const blocked = detectVrboBlock(html, ids.length);
  const cap = opts.maxCards ?? ids.length;
  const cards: SearchCard[] = ids.slice(0, cap).map((id) => ({ id }));
  return {
    url,
    cards,
    raw: { htmlLength: html.length, httpDurationMs },
    blocked,
    error: null,
  };
}
