/**
 * routes/ingest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ingestion pipeline endpoints.
 *
 * GET  /ingest/stats            — record counts by source_platform
 * GET  /ingest/sample           — sample normalized records from the DB
 * GET  /ingest/sync-status      — scheduler status for all automated sources
 * POST /ingest/run              — run adapter on a single URL (live fetch)
 * POST /ingest/ical             — parse an iCal feed URL or raw string
 * POST /ingest/inject           — accept a pre-scraped NormalizedRentalListing
 * POST /ingest/scrape-all       — bulk-scrape a source (vacation_vallarta | vrbo_batch)
 * POST /ingest/discover         — discover & bulk-scrape Airbnb/VRBO search results for PV
 * POST /ingest/sync-all         — trigger immediate refresh of all automated sources
 * POST /ingest/sync/:source     — trigger immediate refresh of one source
 */

import { Router } from "express";
import { db } from "@workspace/db";
import { rentalListingsTable } from "@workspace/db/schema";
import { count, sql, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { fetchPvrpvListing } from "../lib/ingest/pvrpv-adapter.js";
import { fetchAirbnbListing } from "../lib/ingest/airbnb-adapter.js";
import { fetchVrboListing } from "../lib/ingest/vrbo-adapter.js";
import {
  fetchAllVacationVallartaListings,
  fetchVacationVallartaListing,
} from "../lib/ingest/vacation-vallarta-adapter.js";
import { persistNormalized } from "../lib/ingest/persist.js";
import { fetchAndParseICal, parseICalText } from "../lib/ingest/ical-parser.js";
import { syncAll, syncSource, getSyncStatus } from "../lib/ingest/sync-scheduler.js";
import { discoverVrboListings } from "../lib/ingest/vrbo-search-adapter.js";
import { fetchAirbnbSearchListings } from "../lib/ingest/airbnb-search-adapter.js";
import {
  enrichOneAirbnbListing,
  type EnrichResult,
} from "../lib/ingest/airbnb-detail-runner.js";
import { runAirbnbPricingRefresh } from "../lib/ingest/airbnb-pricing-runner.js";
import { runPvrpvPricingRefresh } from "../lib/ingest/pvrpv-pricing-runner.js";
import { runVrboPricingRefresh } from "../lib/ingest/vrbo-pricing-runner.js";
import {
  evaluateEnrichmentAlert,
  loadRecentDailyRunRecords,
} from "../lib/ingest/airbnb-pricing-monitor.js";
import type { SourceKey } from "../lib/ingest/types.js";

const router = Router();

// ── GET /ingest/stats ─────────────────────────────────────────────────────

router.get("/ingest/stats", async (req, res) => {
  try {
    const [byPlatform, totals] = await Promise.all([
      db
        .select({
          source_platform: rentalListingsTable.sourcePlatform,
          total: count(),
          active: sql<number>`SUM(CASE WHEN ${rentalListingsTable.isActive} THEN 1 ELSE 0 END)`.mapWith(Number),
        })
        .from(rentalListingsTable)
        .groupBy(rentalListingsTable.sourcePlatform)
        .orderBy(desc(count())),
      db
        .select({ total: count() })
        .from(rentalListingsTable),
    ]);

    res.json({
      total_listings: totals[0].total,
      by_source: byPlatform,
      db_table: "rental_listings",
    });
  } catch (err) {
    req.log.error({ err }, "ingest/stats failed");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── GET /ingest/sample ────────────────────────────────────────────────────

router.get("/ingest/sample", async (req, res) => {
  const source  = req.query.source as string | undefined;
  const limitRaw = parseInt(String(req.query.limit ?? "10"));
  const limit   = Math.min(Math.max(1, isNaN(limitRaw) ? 10 : limitRaw), 50);

  const COLS = {
    id: rentalListingsTable.id,
    source_platform: rentalListingsTable.sourcePlatform,
    source_url: rentalListingsTable.sourceUrl,
    external_id: rentalListingsTable.externalId,
    title: rentalListingsTable.title,
    neighborhood: rentalListingsTable.neighborhoodNormalized,
    building_name: rentalListingsTable.buildingName,
    bedrooms: rentalListingsTable.bedrooms,
    bathrooms: rentalListingsTable.bathrooms,
    max_guests: rentalListingsTable.maxGuests,
    sqft: rentalListingsTable.sqft,
    nightly_price_usd: rentalListingsTable.nightlyPriceUsd,
    rating_overall: rentalListingsTable.ratingOverall,
    review_count: rentalListingsTable.reviewCount,
    amenities_normalized: rentalListingsTable.amenitiesNormalized,
    distance_to_beach_m: rentalListingsTable.distanceToBeachM,
    is_active: rentalListingsTable.isActive,
    scraped_at: rentalListingsTable.scrapedAt,
    data_confidence_score: rentalListingsTable.dataConfidenceScore,
  } as const;

  try {
    const rows = source
      ? await db.select(COLS).from(rentalListingsTable)
          .where(eq(rentalListingsTable.sourcePlatform, source))
          .orderBy(desc(rentalListingsTable.scrapedAt))
          .limit(limit)
      : await db.select(COLS).from(rentalListingsTable)
          .orderBy(desc(rentalListingsTable.scrapedAt))
          .limit(limit);

    res.json({
      count: rows.length,
      source_filter: source ?? null,
      records: rows,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/sample failed");
    res.status(500).json({ error: "Failed to fetch sample records" });
  }
});

// ── POST /ingest/run ──────────────────────────────────────────────────────

const RunSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  persist: z.boolean().optional().default(false),
});

function detectSource(url: string): SourceKey | null {
  if (url.includes("pvrpv.com")) return "pvrpv";
  if (url.includes("airbnb.com")) return "airbnb";
  if (url.includes("vrbo.com") || url.includes("homeaway.com")) return "vrbo";
  if (url.includes("vacationvallarta.com")) return "vacation_vallarta";
  return null;
}

router.post("/ingest/run", async (req, res) => {
  const parsed = RunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const { url, persist } = parsed.data;

  const source = detectSource(url);
  if (!source) {
    return res.status(400).json({
      error: "Unsupported source",
      message: "Supported: pvrpv.com, airbnb.com, vrbo.com, homeaway.com",
    });
  }

  try {
    req.log.info({ url, source, persist }, "ingest/run: fetching listing");

    const normalized =
      source === "pvrpv"
        ? await fetchPvrpvListing(url)
        : source === "airbnb"
        ? await fetchAirbnbListing(url)
        : source === "vacation_vallarta"
        ? await fetchVacationVallartaListing(url)
        : await fetchVrboListing(url);

    let result: { listing_id?: number; warnings: string[]; persisted: boolean; error?: string } = {
      persisted: false,
      warnings: [],
    };

    if (persist) {
      const ingestResult = await persistNormalized(normalized);
      result = {
        listing_id: ingestResult.listing_id,
        warnings: ingestResult.warnings,
        persisted: ingestResult.ok,
        error: ingestResult.error,
      };
    }

    res.json({ source, url, normalized, ...result });
  } catch (err) {
    req.log.error({ err, url, source }, "ingest/run failed");
    res.status(500).json({
      error: "Adapter failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── POST /ingest/ical ─────────────────────────────────────────────────────

const ICalSchema = z.union([
  z.object({ url: z.string().url() }),
  z.object({ raw: z.string().min(10) }),
]);

router.post("/ingest/ical", async (req, res) => {
  const parsed = ICalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Provide either { url } or { raw } in the request body",
    });
  }

  try {
    const result =
      "url" in parsed.data
        ? await fetchAndParseICal(parsed.data.url)
        : parseICalText(parsed.data.raw);

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "ingest/ical failed");
    res.status(500).json({ error: "iCal parse failed", message: String(err) });
  }
});

// ── POST /ingest/inject ───────────────────────────────────────────────────
// Accepts a pre-scraped NormalizedRentalListing (e.g. from a Playwright
// scraper, residential-proxy agent, or CSV import) and persists it.
// This is the production path for sources that require JS rendering.

const VALID_SOURCES = ["airbnb", "vrbo", "pvrpv", "vacation_vallarta", "local_agency", "owner_direct", "manual", "csv"] as const;

const InjectSchema = z.object({
  source: z.enum(VALID_SOURCES),
  source_listing_id: z.string().min(1),
  source_url: z.string().url(),
  title: z.string().optional(),
  neighborhood: z.string().optional(),
  neighborhood_normalized: z.string().optional(),
  building_name: z.string().optional(),
  property_type: z.string().optional(),
  bedrooms: z.number().int().min(0).optional(),
  bathrooms: z.number().min(0).optional(),
  max_guests: z.number().int().min(1).optional(),
  sqft: z.number().optional().nullable(),
  year_built: z.number().int().optional().nullable(),
  price_nightly_usd: z.number().optional().nullable(),
  cleaning_fee_usd: z.number().optional().nullable(),
  min_nights: z.number().int().optional().nullable(),
  latitude: z.number().optional().nullable(),
  longitude: z.number().optional().nullable(),
  amenities_raw: z.array(z.string()).optional(),
  amenities_normalized: z.array(z.string()).optional(),
  rating_value: z.number().min(0).max(5).optional().nullable(),
  review_count: z.number().int().min(0).optional().nullable(),
  scraped_at: z.string().optional(),
});

router.post("/ingest/inject", async (req, res) => {
  const parsed = InjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }

  const normalized = {
    ...parsed.data,
    scraped_at: parsed.data.scraped_at ?? new Date().toISOString(),
  };

  try {
    req.log.info({ source: normalized.source, source_listing_id: normalized.source_listing_id }, "ingest/inject: persisting");
    const result = await persistNormalized(normalized);
    res.json({
      ok: result.ok,
      source: normalized.source,
      listing_id: result.listing_id,
      warnings: result.warnings,
      error: result.error,
      normalized,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/inject failed");
    res.status(500).json({ error: "Persist failed", message: String(err) });
  }
});

// ── POST /ingest/scrape-all ───────────────────────────────────────────────
// Bulk-scrapes an entire source platform and persists all discovered listings.
// Supports:  vacation_vallarta  (discovers all listings from the VV website)
//            vrbo_batch         (tries a list of VRBO listing IDs with retry)

const ScrapeAllSchema = z.object({
  source: z.enum(["vacation_vallarta", "vrbo_batch"]),
  // For vrbo_batch: provide listing IDs (numeric strings or ints)
  vrbo_ids: z.array(z.union([z.string(), z.number()])).optional(),
  delay_ms: z.number().int().min(500).max(60_000).optional().default(1_000),
  persist: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(false),
});

router.post("/ingest/scrape-all", async (req, res) => {
  const parsed = ScrapeAllSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { source, delay_ms, persist, dry_run } = parsed.data;

  req.log.info({ source, persist, dry_run }, "ingest/scrape-all: starting");

  // ── Vacation Vallarta ─────────────────────────────────────────────────────
  if (source === "vacation_vallarta") {
    try {
      const listings = await fetchAllVacationVallartaListings({ delayMs: delay_ms });
      const results = [];

      for (const listing of listings) {
        if (dry_run) {
          results.push({ ok: true, source_listing_id: listing.source_listing_id, title: listing.title, dry_run: true });
          continue;
        }
        if (persist) {
          const r = await persistNormalized(listing);
          results.push({
            ok: r.ok,
            source_listing_id: listing.source_listing_id,
            title: listing.title,
            listing_id: r.listing_id,
            warnings: r.warnings,
            error: r.error,
          });
        } else {
          results.push({ ok: true, source_listing_id: listing.source_listing_id, title: listing.title, normalized: listing });
        }
      }

      const succeeded = results.filter(r => r.ok).length;
      req.log.info({ succeeded, total: results.length }, "ingest/scrape-all: vacation_vallarta done");
      return res.json({ source, total: results.length, succeeded, results });

    } catch (err) {
      req.log.error({ err }, "ingest/scrape-all vacation_vallarta failed");
      return res.status(500).json({ error: "Scrape failed", message: String(err) });
    }
  }

  // ── VRBO Batch with exponential backoff ───────────────────────────────────
  if (source === "vrbo_batch") {
    const rawIds = parsed.data.vrbo_ids ?? [];
    if (rawIds.length === 0) {
      return res.status(400).json({ error: "Provide vrbo_ids array for vrbo_batch" });
    }

    const results = [];
    for (const idRaw of rawIds) {
      const id = String(idRaw);
      const url = `https://www.vrbo.com/${id}`;
      let normalized = null;
      let lastError = "";
      let attempts = 0;

      // Try up to 4 times with escalating delays to beat rate-limiting
      const backoffs = [0, 30_000, 60_000, 90_000];
      for (const waitMs of backoffs) {
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        attempts++;
        try {
          normalized = await fetchVrboListing(url);
          lastError = "";
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (!lastError.includes("429")) break; // Only retry on rate-limit
        }
      }

      if (normalized && !dry_run && persist) {
        const r = await persistNormalized(normalized);
        results.push({
          ok: r.ok, id, url, title: normalized.title,
          listing_id: r.listing_id, warnings: r.warnings, error: r.error, attempts,
        });
      } else if (normalized) {
        results.push({ ok: true, id, url, title: normalized.title, attempts, normalized: dry_run ? normalized : undefined });
      } else {
        results.push({ ok: false, id, url, error: lastError, attempts });
      }

      await new Promise(r => setTimeout(r, delay_ms));
    }

    const succeeded = results.filter(r => r.ok).length;
    return res.json({ source, total: results.length, succeeded, results });
  }

});

// ── POST /ingest/discover ─────────────────────────────────────────────────
// Discovers Airbnb and/or VRBO listings from Puerto Vallarta search results,
// then scrapes each discovered listing URL and persists it.
//
// Body:
//   source:      "airbnb" | "vrbo" | "both"  (default: "both")
//   max_pages:   number   — how many search pages to crawl (default: 4)
//   max_listings: number  — cap on individual listings to scrape (default: 50)
//   delay_ms:    number   — ms between individual listing requests (default: 1200)
//   persist:     boolean  — actually save to DB (default: true)
//   dry_run:     boolean  — discover only, no scraping (default: false)

const DiscoverSchema = z.object({
  source: z.enum(["airbnb", "vrbo", "both"]).optional().default("both"),
  max_pages: z.number().int().min(1).max(20).optional().default(4),
  max_listings: z.number().int().min(1).max(200).optional().default(50),
  delay_ms: z.number().int().min(500).max(10_000).optional().default(1200),
  persist: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(false),
});

router.post("/ingest/discover", async (req, res) => {
  const parsed = DiscoverSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { source, max_pages, max_listings, delay_ms, persist, dry_run } = parsed.data;

  req.log.info({ source, max_pages, max_listings, dry_run }, "ingest/discover: starting");

  const summary: Record<string, unknown> = {};

  // ── VRBO discovery ───────────────────────────────────────────────────────
  if (source === "vrbo" || source === "both") {
    try {
      const discovery = await discoverVrboListings({ maxPages: max_pages, delayMs: 1500 });
      req.log.info({ found: discovery.listingUrls.length, errors: discovery.errors.length }, "ingest/discover: vrbo discovery complete");

      if (dry_run) {
        summary["vrbo"] = { discovery_only: true, found: discovery.listingUrls.length, urls: discovery.listingUrls, errors: discovery.errors };
      } else {
        const urls = discovery.listingUrls.slice(0, max_listings);
        const results: unknown[] = [];
        for (const url of urls) {
          try {
            const normalized = await fetchVrboListing(url);
            if (persist) {
              const r = await persistNormalized(normalized);
              results.push({ ok: r.ok, url, title: normalized.title, listing_id: r.listing_id, error: r.error });
            } else {
              results.push({ ok: true, url, title: normalized.title });
            }
          } catch (err) {
            results.push({ ok: false, url, error: err instanceof Error ? err.message : String(err) });
          }
          await new Promise(r => setTimeout(r, delay_ms));
        }
        const succeeded = (results as { ok: boolean }[]).filter(r => r.ok).length;
        summary["vrbo"] = { found: discovery.listingUrls.length, scraped: urls.length, succeeded, results, discovery_errors: discovery.errors };
      }
    } catch (err) {
      summary["vrbo"] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Airbnb discovery ─────────────────────────────────────────────────────
  // Extracts full listing data directly from search result pages — no
  // individual listing page fetches needed (which are blocked from datacenter IPs).
  if (source === "airbnb" || source === "both") {
    try {
      const searchResult = await fetchAirbnbSearchListings({ maxPages: max_pages, delayMs: 2000 });
      req.log.info({ found: searchResult.listings.length, ids: searchResult.listingIds.length, errors: searchResult.errors.length }, "ingest/discover: airbnb search complete");

      const listings = searchResult.listings.slice(0, max_listings);

      if (dry_run) {
        summary["airbnb"] = {
          discovery_only: true,
          found: searchResult.listings.length,
          ids_found: searchResult.listingIds.length,
          pages_scraped: searchResult.pagesScraped,
          sample: listings.slice(0, 5).map(l => ({ id: l.source_listing_id, title: l.title, bedrooms: l.bedrooms, price: l.price_nightly_usd })),
          errors: searchResult.errors,
        };
      } else {
        const results: unknown[] = [];
        for (const normalized of listings) {
          if (persist) {
            const r = await persistNormalized(normalized);
            results.push({ ok: r.ok, id: normalized.source_listing_id, title: normalized.title, listing_id: r.listing_id, error: r.error });
          } else {
            results.push({ ok: true, id: normalized.source_listing_id, title: normalized.title });
          }
        }
        const succeeded = (results as { ok: boolean }[]).filter(r => r.ok).length;
        summary["airbnb"] = {
          ids_found: searchResult.listingIds.length,
          listings_extracted: searchResult.listings.length,
          persisted: listings.length,
          succeeded,
          pages_scraped: searchResult.pagesScraped,
          results,
          discovery_errors: searchResult.errors,
        };
      }
    } catch (err) {
      summary["airbnb"] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  req.log.info({ source, dry_run }, "ingest/discover: complete");
  res.json({ source, dry_run, persist, summary });
});

// ── GET /ingest/sync-status ───────────────────────────────────────────────
// Returns scheduler state for all registered automated sources.

router.get("/ingest/sync-status", (_req, res) => {
  const status = getSyncStatus();
  res.json({
    sources: status.map(s => ({
      source: s.source,
      display_name: s.displayName,
      interval_hours: Math.round(s.intervalMs / 3_600_000),
      last_sync_at: s.lastSyncAt?.toISOString() ?? null,
      last_sync_status: s.lastSyncStatus,
      last_sync_count: s.lastSyncCount,
      last_sync_error: s.lastSyncError,
      next_sync_at: s.nextSyncAt?.toISOString() ?? null,
      is_running: s.isRunning,
      credentials_missing: s.credentialsMissing,
      credential_vars: s.credentialVars,
    })),
  });
});

// ── POST /ingest/sync-all ─────────────────────────────────────────────────
// Triggers an immediate refresh of all automated sources in parallel.

/**
 * Token gate shared by the cron-driven ingest endpoints.
 *   - Returns null + writes the response when the request is rejected.
 *   - Returns true when the caller is authenticated.
 *   - Returns true with a logged warning when INTERNAL_TRIGGER_TOKEN is
 *     unset (preserves legacy behavior on dev / un-configured environments
 *     so local curl-based smoke tests still work; prod sets the var).
 *
 * Centralized so that adding a new triggerable endpoint can't accidentally
 * skip the auth check — every cron endpoint should call this as line 1.
 */
function requireInternalToken(req: import("express").Request, res: import("express").Response, label: string): boolean {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    req.log.warn({ label }, "ingest endpoint hit with INTERNAL_TRIGGER_TOKEN unset — allowing request (dev-mode behavior)");
    return true;
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/ingest/sync-all", async (req, res) => {
  if (!requireInternalToken(req, res, "ingest/sync-all")) return;
  req.log.info("ingest/sync-all: starting full sync");
  try {
    const results = await syncAll();
    const succeeded = results.filter(r => r.ok).length;
    res.json({
      total_sources: results.length,
      succeeded,
      results: results.map(r => ({
        source: r.source,
        ok: r.ok,
        count: r.count,
        duration_ms: r.durationMs,
        error: r.error ?? null,
        note: r.note ?? null,
        skipped: r.skipped ?? false,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "ingest/sync-all failed");
    res.status(500).json({ error: "Sync-all failed", message: String(err) });
  }
});

// ── POST /ingest/sync/:source ─────────────────────────────────────────────
// Triggers an immediate refresh of a single source.

router.post("/ingest/sync/:source", async (req, res) => {
  if (!requireInternalToken(req, res, "ingest/sync/:source")) return;
  const source = req.params["source"] as SourceKey;
  req.log.info({ source }, "ingest/sync/:source: triggered");
  try {
    const result = await syncSource(source);
    res.json({
      source: result.source,
      ok: result.ok,
      count: result.count,
      duration_ms: result.durationMs,
      error: result.error ?? null,
      note: result.note ?? null,
      skipped: result.skipped ?? false,
    });
  } catch (err) {
    req.log.error({ err, source }, "ingest/sync/:source failed");
    res.status(500).json({ error: "Sync failed", message: String(err) });
  }
});

// ── POST /ingest/enrich-airbnb-detail ─────────────────────────────────────
//
// On-demand trigger for the Airbnb listing-detail enrichment loop.
//
// Selection model (Phase-1 unified priority queue, April 2026):
//   A single ORDER-BY-priority SELECT replaces the older mode=new / mode=stale
//   dichotomy. Every candidate is bucketed into a priority_rank:
//
//     P0  brand-new listing (no listing_details row ever)
//     P1  stale (>staleAfterDays old) AND in a Tier-1 pricing-tool bucket
//     P2  stale (>staleAfterDays old) — any other bucket
//     P3  most recent enrichment was parse_status='partial' and is >6h old
//          (self-healing retry for known-broken parses)
//     P4+ everything else (recently enriched, low priority — excluded by
//          mode='priority' below; kept in the CASE so the rank scheme is
//          self-documenting and future modes can opt in)
//
//   The cron always calls mode='priority' (or no mode → server default), which
//   admits P0..P3. Backward-compat aliases mode='new' (P0 only) and
//   mode='stale' (P1..P3) remain available for ad-hoc smoke tests.
//
// Cohort exclusion: rows whose discovery has not seen them in 14 days are
// skipped entirely — discovery has lost track and re-enriching them wastes
// budget. NULL last_seen_at is tolerated by COALESCE-ing to created_at so
// legacy pre-Phase-2 rows are not penalized.
//
// The fetch path (browser/raw/hybrid) is dictated by the AIRBNB_DETAIL_FETCH_MODE
// env var on the server — this endpoint just iterates and reports.
//
// Auth: requires the X-Internal-Token request header to match
// process.env.INTERNAL_TRIGGER_TOKEN. If the env var is not set on the
// server, the endpoint refuses with 503 — there is no "no auth" mode.

/**
 * Tier-1 pricing-tool buckets used for priority_rank=1 escalation. These
 * are the comp pool the user-facing pricing tool reads from most often.
 * Mirrors TIER_1_NEIGHBORHOODS in scripts/src/lib/airbnb-discovery-buckets.ts
 * (mapped through to PRICING_TOOL_BUCKETS strings). "fluvial" rolls up into
 * Versalles/Centro via the canonical map and is therefore implicit here.
 */
const TIER_1_PRICING_BUCKETS = [
  "Zona Romántica",
  "Amapas / Conchas Chinas",
  "Centro / Alta Vista",
  "Versalles",
  "Marina Vallarta",
  "Nuevo Vallarta",
] as const;

const EnrichDetailSchema = z.object({
  maxListings: z.number().int().positive().max(10_000).optional().default(5),
  // Optional restrictor for manual smoke tests. When omitted (the cron path)
  // the unified priority queue runs across ALL active Airbnb listings.
  buckets: z.array(z.string().min(1)).optional(),
  dryRun: z.boolean().optional().default(false),
  // All modes route through the unified priority query. They differ only in
  // which priority_ranks are admitted:
  //   "priority" (default) = P0..P3 (cron path)
  //   "new"                = P0 only           (backward-compat alias)
  //   "stale"              = P1..P3 only       (backward-compat alias)
  mode: z.enum(["priority", "new", "stale"]).optional().default("priority"),
  // Only meaningful for ranks P1/P2. Default 1 day = "refresh anything not
  // touched in the last 24h". The product-level freshness contract is "no
  // stale data on the site, ever" — daily cron + this default delivers it.
  staleAfterDays: z.number().int().positive().max(365).optional().default(1),
});

router.post("/ingest/enrich-airbnb-detail", async (req, res) => {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    return res.status(503).json({
      error: "INTERNAL_TRIGGER_TOKEN not configured on server",
    });
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = EnrichDetailSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { maxListings, dryRun, mode, staleAfterDays } = parsed.data;
  // Optional manual-smoke-test bucket restrictor. Cron path leaves this null
  // so the unified priority queue runs across the entire active cohort.
  const bucketRestrictor = parsed.data.buckets && parsed.data.buckets.length > 0
    ? parsed.data.buckets
    : null;

  try {
    // ── Mode → admitted priority_ranks ──────────────────────────────────
    //   priority (default) → P0..P3 (cron path)
    //   new                → P0 only (backward-compat)
    //   stale              → P1..P3 (backward-compat)
    const admittedRanks =
      mode === "new"   ? sql`(0)`         :
      mode === "stale" ? sql`(1, 2, 3)`   :
                          sql`(0, 1, 2, 3)`;
    const tier1List = sql.join(
      TIER_1_PRICING_BUCKETS.map((b) => sql`${b}`),
      sql`, `,
    );
    const bucketRestrictorClause = bucketRestrictor
      ? sql`AND rl.normalized_neighborhood_bucket IN (${sql.join(
          bucketRestrictor.map((b) => sql`${b}`),
          sql`, `,
        )})`
      : sql``;

    // Unified priority queue (Phase-1, April 2026). Replaces the prior
    // mode=new / mode=stale split with a single ORDER BY priority_rank.
    // See header comment on this endpoint for the rank definitions.
    //
    // Cohort exclusion: COALESCE(last_seen_at, created_at) drops listings
    // discovery has not seen in 14 days, while not penalizing legacy rows
    // whose last_seen_at was never backfilled.
    const candidatesRaw = await db.execute(sql`
      WITH freshness AS (
        SELECT
          rl.id,
          rl.external_id,
          rl.source_url,
          rl.normalized_neighborhood_bucket AS bucket,
          (SELECT MAX(ld.enriched_at)
             FROM listing_details ld
            WHERE ld.listing_id = rl.id) AS last_enriched_at,
          (SELECT ld.parse_status
             FROM listing_details ld
            WHERE ld.listing_id = rl.id
            ORDER BY ld.enriched_at DESC
            LIMIT 1) AS last_parse_status
        FROM rental_listings rl
        WHERE rl.source_platform = 'airbnb'
          AND rl.source_url IS NOT NULL
          AND COALESCE(rl.last_seen_at, rl.created_at) >= NOW() - INTERVAL '14 days'
          ${bucketRestrictorClause}
      ),
      ranked AS (
        SELECT
          id, external_id, source_url, bucket,
          last_enriched_at, last_parse_status,
          CASE
            WHEN last_enriched_at IS NULL                                                THEN 0
            WHEN last_enriched_at < NOW() - (${staleAfterDays} || ' days')::interval
              AND bucket IN (${tier1List})                                               THEN 1
            WHEN last_enriched_at < NOW() - (${staleAfterDays} || ' days')::interval     THEN 2
            WHEN last_parse_status = 'partial'
              AND last_enriched_at < NOW() - INTERVAL '6 hours'                          THEN 3
            ELSE 4
          END AS priority_rank
        FROM freshness
      )
      SELECT id, external_id, source_url, bucket, priority_rank
      FROM ranked
      WHERE priority_rank IN ${admittedRanks}
      ORDER BY priority_rank ASC,
               COALESCE(last_enriched_at, '1970-01-01'::timestamp) ASC
      LIMIT ${maxListings}
    `);
    const candidates = (candidatesRaw as unknown as {
      rows: Array<{
        id: number;
        external_id: string | null;
        source_url: string;
        bucket: string | null;
        priority_rank: number;
      }>;
    }).rows;

    // Per-priority arrival counts — useful in the log line so a glance at
    // the request log tells you "today drained 12 P0 + 480 P1 + 1100 P2".
    const queuedByPriority = candidates.reduce<Record<number, number>>(
      (acc, c) => { acc[c.priority_rank] = (acc[c.priority_rank] ?? 0) + 1; return acc; },
      {},
    );

    req.log.info(
      {
        count: candidates.length,
        maxListings,
        mode,
        staleAfterDays,
        bucketRestrictor,
        queuedByPriority,
        dryRun,
        fetchMode: process.env["AIRBNB_DETAIL_FETCH_MODE"] ?? "browser",
      },
      "ingest/enrich-airbnb-detail: starting (unified priority queue)"
    );

    const perListing: Array<{
      listingId: number;
      externalId: string | null;
      bucket: string | null;
      priorityRank: number;
      outcome: EnrichResult["outcome"];
      parseStatus?: string | null;
      filledFieldCount?: number;
      errorMessage?: string | null;
      ms: number;
    }> = [];

    for (const c of candidates) {
      const t0 = Date.now();
      const r = await enrichOneAirbnbListing(c.id, c.source_url, { dryRun });
      const ms = Date.now() - t0;
      perListing.push({
        listingId: c.id,
        externalId: c.external_id,
        bucket: c.bucket,
        priorityRank: c.priority_rank,
        outcome: r.outcome,
        parseStatus: r.outcome === "enriched" || r.outcome === "parse_fail" ? r.parseStatus : null,
        filledFieldCount: r.outcome === "enriched" || r.outcome === "parse_fail" ? r.filledFieldCount : undefined,
        errorMessage: r.outcome === "blocked" || r.outcome === "error" ? r.errorMessage : null,
        ms,
      });
    }

    // ── Per-priority telemetry ────────────────────────────────────────
    // Lets `jq '.summary.byPriority'` on the workflow output confirm P0
    // and P1 drain at 100% every run. Counts include all outcomes so a
    // sudden spike in `blocked` or `error` for a specific bucket is
    // visible without spelunking through the `listings` array.
    const priorityBuckets: Array<0 | 1 | 2 | 3 | 4> = [0, 1, 2, 3, 4];
    const byPriority = Object.fromEntries(
      priorityBuckets.map((p) => {
        const rows = perListing.filter((r) => r.priorityRank === p);
        return [
          `p${p}`,
          {
            attempted: rows.length,
            enriched: rows.filter((r) => r.outcome === "enriched").length,
            parse_fail: rows.filter((r) => r.outcome === "parse_fail").length,
            blocked: rows.filter((r) => r.outcome === "blocked").length,
            error: rows.filter((r) => r.outcome === "error").length,
            delisted: rows.filter((r) => r.outcome === "delisted").length,
          },
        ];
      }),
    );

    const summary = {
      attempted: perListing.length,
      enriched: perListing.filter((r) => r.outcome === "enriched").length,
      parse_fail: perListing.filter((r) => r.outcome === "parse_fail").length,
      blocked: perListing.filter((r) => r.outcome === "blocked").length,
      error: perListing.filter((r) => r.outcome === "error").length,
      delisted: perListing.filter((r) => r.outcome === "delisted").length,
      mode,
      staleAfterDays,
      byPriority,
    };

    res.json({
      mode: process.env["AIRBNB_DETAIL_FETCH_MODE"] ?? "browser",
      dryRun,
      bucketRestrictor,
      summary,
      listings: perListing,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/enrich-airbnb-detail failed");
    res.status(500).json({
      error: "Enrichment loop failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── GET /ingest/airbnb-baseline-freshness ──────────────────────────────────
//
// Phase 1.5 — separate freshness probe for the Airbnb LISTING BASELINE
// pricing (rental_listings.nightly_price_usd, refreshed nightly by the
// detail-enrichment priority queue). This is the price source the comp
// engine actually uses for Airbnb today (priceSource='static_displayed').
//
// Distinct from /ingest/airbnb-pricing-freshness, which probes the PAUSED
// per-night quote pipeline (listing_price_quotes). That endpoint correctly
// shows zero — but it must not be read as "Airbnb pricing in comps is
// stale", which is what owners were concluding from the dashboard.
router.get("/ingest/airbnb-baseline-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT rl.id, rl.scraped_at
        FROM rental_listings rl
        WHERE rl.source_platform = 'airbnb'
          AND rl.is_active = true
          AND rl.external_id IS NOT NULL
          AND rl.external_id ~ '^[0-9]+$'
      )
      SELECT
        COUNT(*)::int                                                                    AS listings_total,
        COUNT(*) FILTER (WHERE scraped_at IS NULL)::int                                  AS listings_never_scraped,
        COUNT(*) FILTER (WHERE scraped_at < NOW() - INTERVAL '7 days' OR scraped_at IS NULL)::int   AS listings_stale_7d,
        COUNT(*) FILTER (WHERE scraped_at < NOW() - INTERVAL '14 days' OR scraped_at IS NULL)::int  AS listings_stale_14d,
        MAX(scraped_at)                                                                  AS newest_scrape_at
      FROM cohort
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_never_scraped: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_scrape_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_scrape_at ? new Date(row.newest_scrape_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active Airbnb listings in cohort";
    } else if (ageHours === null || ageHours > 72) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest baseline scrape is ${Math.round(ageHours! / 24)} days old`
        : "No baselines have ever been scraped";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} listings stale >14d`;
    } else if (row.listings_stale_7d * 3 >= row.listings_total) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_7d}/${row.listings_total} listings stale >7d`;
    }

    res.json({
      source: "airbnb_baseline",
      listingsTotal: row.listings_total,
      listingsNeverScraped: row.listings_never_scraped,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestScrapeAt: newestAt?.toISOString() ?? null,
      newestScrapeAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/airbnb-baseline-freshness failed");
    res.status(500).json({ error: "Failed to compute Airbnb baseline freshness" });
  }
});

// ── GET /ingest/airbnb-pricing-freshness ──────────────────────────────────
//
// Lightweight freshness probe over listing_price_quotes for the dashboard.
// Surfaces "Airbnb pricing — N listings stale > 14 days" so a multi-day
// silent outage (Playwright fingerprint blocked, residential proxy down,
// fallback SHA quietly returning 0 quotes for everyone) becomes visible
// within one cycle. No auth: read-only aggregate counts.
router.get("/ingest/airbnb-pricing-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT rl.id
        FROM rental_listings rl
        WHERE rl.source_platform = 'airbnb'
          AND rl.is_active = true
          AND rl.external_id IS NOT NULL
          AND rl.external_id ~ '^[0-9]+$'
      ),
      last_quote AS (
        SELECT listing_id, MAX(collected_at) AS last_quoted
        FROM listing_price_quotes
        GROUP BY listing_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                     AS listings_total,
        (SELECT COUNT(*) FROM cohort c JOIN last_quote q ON q.listing_id = c.id)::int
                                                                               AS listings_quoted_ever,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL)::int                                     AS listings_never_quoted,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '7 days')::int
                                                                               AS listings_stale_7d,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '14 days')::int
                                                                               AS listings_stale_14d,
        (SELECT MAX(last_quoted) FROM last_quote q
         WHERE q.listing_id IN (SELECT id FROM cohort))                        AS newest_quote_at,
        -- 24h activity counters: distinguish priced vs. unavailable rows so
        -- the dashboard tooltip can show "N priced · M unavailable" instead
        -- of misreading the new fast-path's unavailable rows as failures.
        (SELECT COUNT(*) FROM listing_price_quotes lpq
         WHERE lpq.collected_at >= NOW() - INTERVAL '24 hours')::int           AS quotes_last_24h,
        (SELECT COUNT(*) FROM listing_price_quotes lpq
         WHERE lpq.collected_at >= NOW() - INTERVAL '24 hours'
           AND lpq.total_price_usd IS NOT NULL)::int                           AS quotes_priced_last_24h,
        (SELECT COUNT(*) FROM listing_price_quotes lpq
         WHERE lpq.collected_at >= NOW() - INTERVAL '24 hours'
           AND lpq.availability_status = 'unavailable')::int                   AS quotes_unavailable_last_24h,
        -- Booked-rate inference signal — count rows the post-scrape
        -- inference step wrote in the last 24h.
        (SELECT COUNT(*) FROM presumed_bookings pb
         WHERE pb.inferred_at >= NOW() - INTERVAL '24 hours')::int             AS presumed_bookings_last_24h
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_quoted_ever: number;
        listings_never_quoted: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_quote_at: string | null;
        quotes_last_24h: number;
        quotes_priced_last_24h: number;
        quotes_unavailable_last_24h: number;
        presumed_bookings_last_24h: number;
      }>;
    }).rows[0];

    const newestAt = row.newest_quote_at ? new Date(row.newest_quote_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    // Alert tiering philosophy (per ops):
    //   RED    = no data         — pipeline is genuinely dead, nothing landing
    //   YELLOW = partial issues  — quotes are landing but something's off
    //                              (missing fees, cohort partially stale,
    //                              newest quote getting old)
    //   GREEN  = "we have gold"  — quotes landing freshly with full fee
    //                              breakdowns and good cohort coverage
    //
    // The key inversion vs. the old logic: cohort staleness and parser-health
    // overlay alerts no longer escalate to RED. A pipeline that's producing
    // 2,900 healthy quotes a day is NOT "failing" just because the cohort
    // hasn't fully cycled yet, or because an enrichment-rate threshold tripped
    // on a small historical sample. RED is reserved for genuine outages.
    let alertLevel: "ok" | "warn" | "fail" = "ok";
    const reasons: string[] = [];

    if (row.listings_total === 0) {
      // Edge case: nothing to quote. Yellow, not red — not a pipeline failure.
      alertLevel = "warn";
      reasons.push("No active Airbnb listings in cohort");
    } else if (
      row.quotes_priced_last_24h === 0 &&
      (ageHours === null || ageHours > 48)
    ) {
      // RED: no priced quotes in 24h AND newest historical quote is stale
      // (or never existed). Pipeline is genuinely producing nothing usable.
      alertLevel = "fail";
      reasons.push(
        ageHours === null
          ? "No quotes have ever been collected"
          : `No priced quotes in 24h; newest is ${Math.round(ageHours / 24)} days old`,
      );
    } else {
      // We have SOME data — cap at YELLOW for any remaining issues.
      if (ageHours !== null && ageHours > 48) {
        alertLevel = "warn";
        reasons.push(`Newest quote is ${Math.round(ageHours / 24)} days old`);
      } else if (ageHours !== null && ageHours > 30) {
        alertLevel = "warn";
        reasons.push(`Newest quote is ${ageHours}h old`);
      }
      if (row.listings_stale_14d > 0) {
        alertLevel = "warn";
        reasons.push(
          `${row.listings_stale_14d}/${row.listings_total} listings stale >14d`,
        );
      }
    }

    // ── Parser-health overlay ────────────────────────────────────────────
    // The age/stale checks above catch a TOTAL pipeline outage (no quotes
    // landing at all). They miss the failure mode this endpoint cares about
    // most: Airbnb renames a fee line title, the per-checkpoint quote
    // returns 200 OK, the runner silently drops the row, and quotes keep
    // landing — they just have no fee numbers. We pull the last few
    // persisted run summaries and ask the monitor whether the
    // fully-available enrichment rate has been below the threshold for
    // multiple consecutive runs. When it has, we escalate to "fail" so
    // ops sees a single combined signal.
    // The parser-health overlay is an OPTIONAL enrichment. If the
    // run-summaries table isn't present (e.g. migration hasn't run on
    // this environment), or the loader fails for any other reason, we
    // degrade to "insufficient_data" instead of 500-ing the whole
    // freshness response — losing the Airbnb card entirely is much
    // worse than losing the parser-health badge on it.
    let parserAlert: ReturnType<typeof evaluateEnrichmentAlert>;
    try {
      const dailyRecords = await loadRecentDailyRunRecords(7);
      parserAlert = evaluateEnrichmentAlert(dailyRecords);
      if (parserAlert.status === "alert") {
        // Parser-keyword regression → YELLOW, not RED. Quotes are still
        // landing; the fees just aren't enriching at the expected rate.
        // Per ops tiering: missing fees is "we are missing fees and shit",
        // not "no data". Don't downgrade an already-RED state (no-data),
        // just escalate from green → yellow.
        if (alertLevel === "ok") alertLevel = "warn";
        reasons.push(parserAlert.reason);
      }
    } catch (overlayErr) {
      req.log.warn(
        { err: overlayErr },
        "ingest/airbnb-pricing-freshness: parser-health overlay unavailable, returning freshness without it",
      );
      parserAlert = {
        status: "insufficient_data",
        reason: "Parser-health overlay unavailable in this environment",
        evaluatedRuns: [],
        thresholds: { minRate: 0.5, consecutiveDays: 2, minDenominator: 5 },
      };
    }

    const alertReason = reasons.join("; ");

    res.json({
      source: "airbnb_pricing",
      listingsTotal: row.listings_total,
      listingsQuotedEver: row.listings_quoted_ever,
      listingsNeverQuoted: row.listings_never_quoted,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestQuoteAt: newestAt?.toISOString() ?? null,
      newestQuoteAgeHours: ageHours,
      quotesLast24h: row.quotes_last_24h,
      quotesPricedLast24h: row.quotes_priced_last_24h,
      quotesUnavailableLast24h: row.quotes_unavailable_last_24h,
      presumedBookingsLast24h: row.presumed_bookings_last_24h,
      alertLevel,
      alertReason,
      parserHealth: {
        status: parserAlert.status,
        reason: parserAlert.reason,
        thresholds: parserAlert.thresholds,
        evaluatedRuns: parserAlert.evaluatedRuns.map((r) => ({
          ranAt: r.ranAt.toISOString(),
          enrichmentRate: r.enrichmentRate,
          fullyAvailableCheckpoints: r.fullyAvailableCheckpoints,
          quotesEnriched: r.quotesEnriched,
          belowThreshold: r.belowThreshold,
        })),
      },
    });
  } catch (err) {
    req.log.error({ err }, "ingest/airbnb-pricing-freshness failed");
    res.status(500).json({ error: "Failed to compute Airbnb pricing freshness" });
  }
});

// ── GET /ingest/pvrpv-pricing-freshness ───────────────────────────────────
//
// Pipeline-health probe for the daily PVRPV per-night pricing refresh
// (lib/ingest/pvrpv-pricing-runner.ts → listing_price_quotes rows for
// source_platform='pvrpv'). Same shape as airbnb-pricing-freshness so the
// /sources dashboard can render a consistent banner.
router.get("/ingest/pvrpv-pricing-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT rl.id
        FROM rental_listings rl
        WHERE rl.source_platform = 'pvrpv'
          AND rl.is_active = true
      ),
      last_quote AS (
        SELECT listing_id, MAX(collected_at) AS last_quoted
        FROM listing_price_quotes
        GROUP BY listing_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                     AS listings_total,
        (SELECT COUNT(*) FROM cohort c JOIN last_quote q ON q.listing_id = c.id)::int
                                                                               AS listings_quoted_ever,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL)::int                                     AS listings_never_quoted,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '7 days')::int
                                                                               AS listings_stale_7d,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '14 days')::int
                                                                               AS listings_stale_14d,
        (SELECT MAX(last_quoted) FROM last_quote q
         WHERE q.listing_id IN (SELECT id FROM cohort))                        AS newest_quote_at
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_quoted_ever: number;
        listings_never_quoted: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_quote_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_quote_at ? new Date(row.newest_quote_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active PVRPV listings in cohort";
    } else if (ageHours === null || ageHours > 48) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest PVRPV quote is ${Math.round(ageHours! / 24)} days old`
        : "No PVRPV quotes have ever been collected";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} PVRPV listings stale >14d`;
    } else if (row.listings_stale_14d > 0) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_14d} PVRPV listings stale >14d`;
    } else if (ageHours > 36) {
      alertLevel = "warn";
      alertReason = `Newest PVRPV quote is ${ageHours}h old`;
    }

    res.json({
      source: "pvrpv_pricing",
      listingsTotal: row.listings_total,
      listingsQuotedEver: row.listings_quoted_ever,
      listingsNeverQuoted: row.listings_never_quoted,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestQuoteAt: newestAt?.toISOString() ?? null,
      newestQuoteAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/pvrpv-pricing-freshness failed");
    res.status(500).json({ error: "Failed to compute PVRPV pricing freshness" });
  }
});

// ── GET /ingest/vrbo-pricing-freshness ────────────────────────────────────
//
// Pipeline-health probe for the daily VRBO per-night pricing refresh
// (lib/ingest/vrbo-pricing-runner.ts → listing_price_quotes rows for
// source_platform='vrbo'). Distinct from /ingest/vrbo-scrape-freshness,
// which monitors the underlying listing scrape rather than the quote
// pipeline that feeds the comp-comparison view.
router.get("/ingest/vrbo-pricing-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT rl.id
        FROM rental_listings rl
        WHERE rl.source_platform = 'vrbo'
          AND rl.is_active = true
      ),
      last_quote AS (
        SELECT listing_id, MAX(collected_at) AS last_quoted
        FROM listing_price_quotes
        GROUP BY listing_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                     AS listings_total,
        (SELECT COUNT(*) FROM cohort c JOIN last_quote q ON q.listing_id = c.id)::int
                                                                               AS listings_quoted_ever,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL)::int                                     AS listings_never_quoted,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '7 days')::int
                                                                               AS listings_stale_7d,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_quote q ON q.listing_id = c.id
         WHERE q.last_quoted IS NULL OR q.last_quoted < NOW() - INTERVAL '14 days')::int
                                                                               AS listings_stale_14d,
        (SELECT MAX(last_quoted) FROM last_quote q
         WHERE q.listing_id IN (SELECT id FROM cohort))                        AS newest_quote_at
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_quoted_ever: number;
        listings_never_quoted: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_quote_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_quote_at ? new Date(row.newest_quote_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active VRBO listings in cohort";
    } else if (ageHours === null || ageHours > 48) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest VRBO quote is ${Math.round(ageHours! / 24)} days old`
        : "No VRBO quotes have ever been collected";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} VRBO listings stale >14d`;
    } else if (row.listings_stale_14d > 0) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_14d} VRBO listings stale >14d`;
    } else if (ageHours > 36) {
      alertLevel = "warn";
      alertReason = `Newest VRBO quote is ${ageHours}h old`;
    }

    res.json({
      source: "vrbo_pricing",
      listingsTotal: row.listings_total,
      listingsQuotedEver: row.listings_quoted_ever,
      listingsNeverQuoted: row.listings_never_quoted,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestQuoteAt: newestAt?.toISOString() ?? null,
      newestQuoteAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/vrbo-pricing-freshness failed");
    res.status(500).json({ error: "Failed to compute VRBO pricing freshness" });
  }
});

// ── GET /ingest/vrbo-scrape-freshness ─────────────────────────────────────
//
// Pipeline-health probe for the daily VRBO listings refresh
// (scripts/src/vrbo-scrape.ts → rental_listings rows where
// source_platform='vrbo'). Same shape as airbnb-pricing-freshness so the
// /sources dashboard can render a consistent banner per pipeline.
router.get("/ingest/vrbo-scrape-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT id, scraped_at
        FROM rental_listings
        WHERE source_platform = 'vrbo'
          AND is_active = true
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                     AS listings_total,
        (SELECT COUNT(*) FROM cohort
         WHERE scraped_at IS NULL OR scraped_at < NOW() - INTERVAL '7 days')::int
                                                                               AS listings_stale_7d,
        (SELECT COUNT(*) FROM cohort
         WHERE scraped_at IS NULL OR scraped_at < NOW() - INTERVAL '14 days')::int
                                                                               AS listings_stale_14d,
        (SELECT MAX(scraped_at) FROM cohort)                                   AS newest_scrape_at
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_scrape_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_scrape_at ? new Date(row.newest_scrape_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active VRBO listings in cohort";
    } else if (ageHours === null || ageHours > 48) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest VRBO scrape is ${Math.round(ageHours! / 24)} days old`
        : "No VRBO listings have ever been scraped";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} VRBO listings stale >14d`;
    } else if (row.listings_stale_14d > 0) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_14d} VRBO listings stale >14d`;
    } else if (ageHours > 36) {
      alertLevel = "warn";
      alertReason = `Newest VRBO scrape is ${ageHours}h old`;
    }

    res.json({
      source: "vrbo_scrape",
      listingsTotal: row.listings_total,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestScrapeAt: newestAt?.toISOString() ?? null,
      newestScrapeAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/vrbo-scrape-freshness failed");
    res.status(500).json({ error: "Failed to compute VRBO scrape freshness" });
  }
});

// ── GET /ingest/vacation-vallarta-pricing-freshness ───────────────────────
//
// Pipeline-health probe for the daily Vacation Vallarta calendar pricing
// refresh (scripts/src/calendar-scrape.ts → rental_prices_by_date rows
// joined to rental_listings where source_platform='vacation_vallarta').
router.get("/ingest/vacation-vallarta-pricing-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT id
        FROM rental_listings
        WHERE source_platform = 'vacation_vallarta'
          AND is_active = true
      ),
      last_price AS (
        SELECT listing_id, MAX(scraped_at) AS last_scraped
        FROM rental_prices_by_date
        GROUP BY listing_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                     AS listings_total,
        (SELECT COUNT(*) FROM cohort c JOIN last_price q ON q.listing_id = c.id)::int
                                                                               AS listings_covered,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_price q ON q.listing_id = c.id
         WHERE q.last_scraped IS NULL OR q.last_scraped < NOW() - INTERVAL '7 days')::int
                                                                               AS listings_stale_7d,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_price q ON q.listing_id = c.id
         WHERE q.last_scraped IS NULL OR q.last_scraped < NOW() - INTERVAL '14 days')::int
                                                                               AS listings_stale_14d,
        (SELECT MAX(last_scraped) FROM last_price q
         WHERE q.listing_id IN (SELECT id FROM cohort))                        AS newest_scrape_at
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_covered: number;
        listings_stale_7d: number;
        listings_stale_14d: number;
        newest_scrape_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_scrape_at ? new Date(row.newest_scrape_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active Vacation Vallarta listings in cohort";
    } else if (ageHours === null || ageHours > 48) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest VV calendar refresh is ${Math.round(ageHours! / 24)} days old`
        : "No Vacation Vallarta calendar pricing has ever been collected";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} VV listings stale >14d`;
    } else if (row.listings_stale_14d > 0) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_14d} VV listings stale >14d`;
    } else if (ageHours > 36) {
      alertLevel = "warn";
      alertReason = `Newest VV calendar refresh is ${ageHours}h old`;
    }

    res.json({
      source: "vacation_vallarta_pricing",
      listingsTotal: row.listings_total,
      listingsCovered: row.listings_covered,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestScrapeAt: newestAt?.toISOString() ?? null,
      newestScrapeAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/vacation-vallarta-pricing-freshness failed");
    res.status(500).json({ error: "Failed to compute VV pricing freshness" });
  }
});

// ── GET /ingest/airbnb-calendar-freshness ─────────────────────────────────
//
// Pipeline-health probe for the daily Airbnb CALENDAR scrape (separate
// from per-night quote collection — this one is operational and writes
// to rental_prices_by_date via the Mac mini scraper). Wired to the
// "Airbnb calendar" tile on /sources.
//
// Cohort: active Airbnb listings.
// Coverage: how many of those listings have any rental_prices_by_date row.
// Freshness: MAX(scraped_at) across the cohort's rows.
//
// Verdict logic (data freshness, not coverage — coverage is reported as
// detail only because Airbnb's anti-bot rate-limiting caps the daily
// reachable cohort somewhere around 30-40%, which is intentional, not
// a bug. A pipeline writing fresh data is healthy even with partial
// coverage; the tooltip carries the coverage fraction so it's visible):
//   - fail  : never written / newest > 7 days old
//   - warn  : newest > 36h (cron skipped a day)
//   - ok    : newest ≤ 36h
router.get("/ingest/airbnb-calendar-freshness", async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH cohort AS (
        SELECT rl.id
        FROM rental_listings rl
        WHERE rl.source_platform = 'airbnb'
          AND rl.is_active = true
      ),
      last_row AS (
        SELECT listing_id, MAX(scraped_at) AS last_scraped
        FROM rental_prices_by_date
        GROUP BY listing_id
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::int                                           AS listings_total,
        (SELECT COUNT(*) FROM cohort c JOIN last_row r ON r.listing_id = c.id)::int  AS listings_with_rows,
        (SELECT COUNT(*) FROM cohort c LEFT JOIN last_row r ON r.listing_id = c.id
         WHERE r.last_scraped IS NULL OR r.last_scraped < NOW() - INTERVAL '14 days')::int
                                                                                     AS listings_stale_14d,
        (SELECT COUNT(*) FROM rental_prices_by_date rpbd
         JOIN cohort c ON c.id = rpbd.listing_id)::int                               AS price_rows_total,
        (SELECT MAX(r.last_scraped) FROM last_row r
         WHERE r.listing_id IN (SELECT id FROM cohort))                              AS newest_scrape_at
    `);
    const row = (result as unknown as {
      rows: Array<{
        listings_total: number;
        listings_with_rows: number;
        listings_stale_14d: number;
        price_rows_total: number;
        newest_scrape_at: string | null;
      }>;
    }).rows[0];

    const newestAt = row.newest_scrape_at ? new Date(row.newest_scrape_at) : null;
    const ageHours = newestAt
      ? Math.floor((Date.now() - newestAt.getTime()) / 3_600_000)
      : null;
    const coveragePct =
      row.listings_total > 0
        ? Math.round((row.listings_with_rows / row.listings_total) * 100)
        : 0;

    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active Airbnb listings in cohort";
    } else if (ageHours === null) {
      alertLevel = "fail";
      alertReason = "No Airbnb calendar rows have ever been written";
    } else if (ageHours > 168) {
      alertLevel = "fail";
      alertReason = `Newest Airbnb calendar scrape is ${Math.round(ageHours / 24)} days old`;
    } else if (ageHours > 36) {
      alertLevel = "warn";
      alertReason = `Newest Airbnb calendar scrape is ${ageHours}h old (cron likely skipped)`;
    } else {
      alertReason = `${row.price_rows_total.toLocaleString()} rows · ${row.listings_with_rows}/${row.listings_total} listings (${coveragePct}% coverage)`;
    }

    res.json({
      source: "airbnb_calendar",
      listingsTotal: row.listings_total,
      listingsCovered: row.listings_with_rows,
      listingsStale14d: row.listings_stale_14d,
      priceRowsTotal: row.price_rows_total,
      coveragePct,
      newestScrapeAt: newestAt?.toISOString() ?? null,
      newestScrapeAgeHours: ageHours,
      alertLevel,
      alertReason,
    });
  } catch (err) {
    req.log.error({ err }, "ingest/airbnb-calendar-freshness failed");
    res.status(500).json({ error: "Failed to compute Airbnb calendar freshness" });
  }
});

// ── GET /ingest/rental-prices-quality ─────────────────────────────────────
//
// Wholesomeness probe for `rental_prices_by_date`. Surfaces what `psql`
// would tell you about the table's contents — broken out by source
// platform, plus an ALL row — so trash data is visible on the dashboard
// instead of buried in the DB.
//
// Per platform we report:
//   - total rows
//   - null-price rows (Airbnb's calendar feed legitimately omits price
//     for many days; PVRPV always has price; so this isn't necessarily
//     a bug — but a *spike* would be)
//   - zero-price rows                  (always a bug — flagged red)
//   - suspiciously-low rows ($0–$20)   (almost always a bug)
//   - plausible rows ($20–$5,000)      (the healthy bucket)
//   - suspiciously-high rows (>$5,000) (almost always a bug)
//   - past-dated rows (date < CURRENT_DATE)  — dead weight, no forward
//     pricing value; the retention sweep below removes these on a 7-day
//     buffer.
//   - oldest scraped_at, plus scrape-age buckets at 30/60/90 days, so
//     we can see if a platform is quietly aging out.
//
// Read-only and unauthenticated — same posture as the *-freshness probes,
// since the page that consumes it is public.
router.get("/ingest/rental-prices-quality", async (req, res) => {
  try {
    // INNER JOIN against rental_listings WHERE is_active = true scopes the
    // table to the *active cohort* — the listings we actually care about for
    // pricing decisions. Rows belonging to delisted/paused listings, and
    // orphan rows whose listing_id no longer exists in rental_listings, are
    // excluded so the row counts mean something.
    //
    // We deliberately KEEP null-price rows in the count: Airbnb's calendar
    // legitimately omits price for booked / blocked / minimum-stay-restricted
    // nights, and those null-price rows are the input signal for the
    // presumed-bookings inference (rented-night detection). Filtering them
    // out would silently destroy that signal.
    //
    // distinct_listings is a far more interpretable number than raw row
    // counts ("1,979 listings covered" vs "542,500 rows"), surfaced as a
    // separate column.
    const result = await db.execute(sql`
      WITH joined AS (
        SELECT
          rl.source_platform,
          rpbd.listing_id,
          rpbd.nightly_price_usd,
          rpbd.date,
          rpbd.scraped_at
        FROM rental_prices_by_date rpbd
        INNER JOIN rental_listings rl
          ON rl.id = rpbd.listing_id
         AND rl.is_active = true
      ),
      grouped AS (
        SELECT
          source_platform,
          COUNT(*)::int                                                              AS total_rows,
          COUNT(DISTINCT listing_id)::int                                            AS distinct_listings,
          COUNT(*) FILTER (WHERE nightly_price_usd IS NULL)::int                    AS null_price,
          COUNT(*) FILTER (WHERE nightly_price_usd = 0)::int                        AS zero_price,
          COUNT(*) FILTER (WHERE nightly_price_usd > 0 AND nightly_price_usd < 20)::int
                                                                                     AS low_price,
          COUNT(*) FILTER (WHERE nightly_price_usd >= 20 AND nightly_price_usd <= 5000)::int
                                                                                     AS plausible_price,
          COUNT(*) FILTER (WHERE nightly_price_usd > 5000)::int                     AS high_price,
          COUNT(*) FILTER (WHERE date < CURRENT_DATE)::int                          AS past_dated,
          COUNT(*) FILTER (WHERE scraped_at < NOW() - INTERVAL '30 days')::int      AS scraped_30d_plus,
          COUNT(*) FILTER (WHERE scraped_at < NOW() - INTERVAL '60 days')::int      AS scraped_60d_plus,
          COUNT(*) FILTER (WHERE scraped_at < NOW() - INTERVAL '90 days')::int      AS scraped_90d_plus,
          MIN(scraped_at)                                                            AS oldest_scrape_at,
          MAX(scraped_at)                                                            AS newest_scrape_at
        FROM joined
        GROUP BY source_platform
      ),
      all_row AS (
        SELECT
          'ALL'                                          AS source_platform,
          SUM(total_rows)::int                           AS total_rows,
          (SELECT COUNT(DISTINCT listing_id)::int FROM joined) AS distinct_listings,
          SUM(null_price)::int                           AS null_price,
          SUM(zero_price)::int                           AS zero_price,
          SUM(low_price)::int                            AS low_price,
          SUM(plausible_price)::int                      AS plausible_price,
          SUM(high_price)::int                           AS high_price,
          SUM(past_dated)::int                           AS past_dated,
          SUM(scraped_30d_plus)::int                     AS scraped_30d_plus,
          SUM(scraped_60d_plus)::int                     AS scraped_60d_plus,
          SUM(scraped_90d_plus)::int                     AS scraped_90d_plus,
          MIN(oldest_scrape_at)                          AS oldest_scrape_at,
          MAX(newest_scrape_at)                          AS newest_scrape_at
        FROM grouped
      )
      SELECT * FROM grouped
      UNION ALL
      SELECT * FROM all_row
      ORDER BY source_platform
    `);

    const rows = (result as unknown as {
      rows: Array<{
        source_platform: string;
        total_rows: number;
        null_price: number;
        zero_price: number;
        low_price: number;
        plausible_price: number;
        high_price: number;
        past_dated: number;
        scraped_30d_plus: number;
        scraped_60d_plus: number;
        scraped_90d_plus: number;
        oldest_scrape_at: string | null;
        newest_scrape_at: string | null;
      }>;
    }).rows;

    const platforms = rows.map((r) => {
      const suspicious = r.zero_price + r.low_price + r.high_price;
      let alertLevel: "ok" | "warn" | "fail" = "ok";
      if (suspicious > 0) alertLevel = "fail";
      else if (r.scraped_90d_plus > 0) alertLevel = "warn";
      return {
        sourcePlatform: r.source_platform,
        totalRows: r.total_rows,
        nullPrice: r.null_price,
        zeroPrice: r.zero_price,
        lowPrice: r.low_price,
        plausiblePrice: r.plausible_price,
        highPrice: r.high_price,
        suspiciousTotal: suspicious,
        pastDated: r.past_dated,
        scraped30dPlus: r.scraped_30d_plus,
        scraped60dPlus: r.scraped_60d_plus,
        scraped90dPlus: r.scraped_90d_plus,
        oldestScrapeAt: r.oldest_scrape_at,
        newestScrapeAt: r.newest_scrape_at,
        alertLevel,
      };
    });

    res.json({ table: "rental_prices_by_date", platforms });
  } catch (err) {
    req.log.error({ err }, "ingest/rental-prices-quality failed");
    res.status(500).json({ error: "Failed to compute rental-prices quality" });
  }
});

// ── POST /ingest/rental-prices-retention-sweep ────────────────────────────
//
// Daily age-based purge of `rental_prices_by_date`. Two independent rules:
//
//   Rule A — past-date:  DELETE rows WHERE date < CURRENT_DATE - 7 days
//   Rule B — stale-row:  DELETE rows WHERE scraped_at < NOW() - 90 days
//
// Both rules look ONLY at row age. Neither triggers on scrape failure,
// neither triggers on "today's run produced no replacement". A failed
// Monday scrape leaves last week's data intact — the next age check
// won't sweep those rows for another 7 / 90 days.
//
// Per-platform delete counts are returned (and logged) for both rules so
// later we can spot a quiet die-off ("PVRPV stale-row deletes jumped
// from 0 to 4,000 overnight = scraper has been silently failing for 90
// days") instead of just watching aggregate row counts shrink mysteriously.
//
// Auth: gated by INTERNAL_TRIGGER_TOKEN like the refresh endpoints.
// Body: { dryRun?: boolean }  — when true, returns the counts that
//       WOULD be deleted without running the DELETE.
const RetentionSweepSchema = z.object({
  dryRun: z.boolean().optional().default(false),
});

router.post("/ingest/rental-prices-retention-sweep", async (req, res) => {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    return res.status(503).json({
      error: "INTERNAL_TRIGGER_TOKEN not configured on server",
    });
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Invalid internal token" });
  }

  const parsed = RetentionSweepSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }
  const { dryRun } = parsed.data;

  try {
    // ── COUNT phase ─────────────────────────────────────────────────────
    // Counts are taken before any DELETE so dryRun and live runs return
    // identical numbers when the table is otherwise quiescent.
    const pastDateCounts = await db.execute(sql`
      SELECT COALESCE(rl.source_platform, 'unknown') AS source_platform,
             COUNT(*)::int                            AS rows
      FROM rental_prices_by_date rpbd
      LEFT JOIN rental_listings rl ON rl.id = rpbd.listing_id
      WHERE rpbd.date < CURRENT_DATE - INTERVAL '7 days'
      GROUP BY source_platform
      ORDER BY source_platform
    `);
    const staleScrapeCounts = await db.execute(sql`
      SELECT COALESCE(rl.source_platform, 'unknown') AS source_platform,
             COUNT(*)::int                            AS rows
      FROM rental_prices_by_date rpbd
      LEFT JOIN rental_listings rl ON rl.id = rpbd.listing_id
      WHERE rpbd.scraped_at < NOW() - INTERVAL '90 days'
      GROUP BY source_platform
      ORDER BY source_platform
    `);

    type CountRow = { source_platform: string; rows: number };
    const pastDateRows = (pastDateCounts as unknown as { rows: CountRow[] }).rows;
    const staleScrapeRows = (staleScrapeCounts as unknown as { rows: CountRow[] }).rows;

    let pastDateDeleted = 0;
    let staleScrapeDeleted = 0;

    if (!dryRun) {
      // Independent DELETEs — order matters only for accounting (a row
      // matching both rules is counted under past-date and not double-
      // deleted, since after the first DELETE the row no longer exists
      // for the second to touch).
      const pdResult = await db.execute(sql`
        DELETE FROM rental_prices_by_date
        WHERE date < CURRENT_DATE - INTERVAL '7 days'
      `);
      pastDateDeleted =
        (pdResult as unknown as { rowCount?: number }).rowCount ?? 0;

      const ssResult = await db.execute(sql`
        DELETE FROM rental_prices_by_date
        WHERE scraped_at < NOW() - INTERVAL '90 days'
      `);
      staleScrapeDeleted =
        (ssResult as unknown as { rowCount?: number }).rowCount ?? 0;
    } else {
      pastDateDeleted = pastDateRows.reduce((s, r) => s + r.rows, 0);
      staleScrapeDeleted = staleScrapeRows.reduce((s, r) => s + r.rows, 0);
    }

    const summary = {
      table: "rental_prices_by_date",
      dryRun,
      ranAt: new Date().toISOString(),
      pastDateRule: {
        threshold: "date < CURRENT_DATE - 7 days",
        deleted: pastDateDeleted,
        byPlatform: pastDateRows.map((r) => ({
          sourcePlatform: r.source_platform,
          rows: r.rows,
        })),
      },
      staleScrapeRule: {
        threshold: "scraped_at < NOW() - 90 days",
        deleted: staleScrapeDeleted,
        byPlatform: staleScrapeRows.map((r) => ({
          sourcePlatform: r.source_platform,
          rows: r.rows,
        })),
      },
    };

    // Loud structured log so spikes are spottable in Railway logs even
    // without checking the dashboard. Especially useful for the per-
    // platform stale-row breakdown (a sudden non-zero number on a
    // platform that's been quiet = scraper has been dark for ~90 days).
    req.log.info(
      { summary },
      `rental-prices retention sweep: pastDate=${pastDateDeleted} stale=${staleScrapeDeleted}${dryRun ? " (dry-run)" : ""}`,
    );

    res.json(summary);
  } catch (err) {
    req.log.error({ err }, "ingest/rental-prices-retention-sweep failed");
    res.status(500).json({ error: "Retention sweep failed" });
  }
});

// ── POST /ingest/airbnb-pricing-refresh ───────────────────────────────────
//
// Daily Airbnb per-night pricing refresh. Drives the "path 2" pipeline
// (PdpAvailabilityCalendar GraphQL persisted-query replay through the
// residential proxy). Picks the stale-first cohort of active Airbnb
// listings — both legacy 9-digit and post-2022 long-form IDs are eligible
// here — fetches one calendar per listing, and inserts one quote row per
// generated checkpoint into listing_price_quotes.
//
// Auth: same X-Internal-Token gate as enrich-airbnb-detail.
const PricingRefreshSchema = z.object({
  maxListings: z.number().int().positive().max(10_000).optional().default(50),
  dryRun: z.boolean().optional().default(false),
});

router.post("/ingest/airbnb-pricing-refresh", async (req, res) => {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    return res.status(503).json({
      error: "INTERNAL_TRIGGER_TOKEN not configured on server",
    });
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = PricingRefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { maxListings, dryRun } = parsed.data;

  try {
    req.log.info({ maxListings, dryRun }, "ingest/airbnb-pricing-refresh: starting");
    const result = await runAirbnbPricingRefresh({ maxListings, dryRun });
    res.json({ dryRun, ...result });
  } catch (err) {
    req.log.error({ err }, "ingest/airbnb-pricing-refresh failed");
    res.status(500).json({
      error: "Airbnb pricing refresh failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── POST /ingest/pvrpv-pricing-refresh ────────────────────────────────────
//
// Daily PVRPV per-night pricing refresh. Pulls the public calendar for each
// stale-first PVRPV listing, generates the same checkpoint set as the
// Airbnb pricing runner, and writes one quote row per fully-available
// checkpoint into listing_price_quotes — populating the cleaning / service
// / taxes / total columns the comp-comparison view requires. Cleaning and
// platform-service fees default to $0 (PVRPV folds both into the nightly
// rate); taxes are synthesized at the standard Mexico/Jalisco lodging rate
// (IVA 16% + ISH 3%). Auth: same X-Internal-Token gate.
const PvrpvPricingRefreshSchema = z.object({
  maxListings: z.number().int().positive().max(10_000).optional().default(50),
  dryRun: z.boolean().optional().default(false),
});

router.post("/ingest/pvrpv-pricing-refresh", async (req, res) => {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    return res.status(503).json({
      error: "INTERNAL_TRIGGER_TOKEN not configured on server",
    });
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = PvrpvPricingRefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { maxListings, dryRun } = parsed.data;

  try {
    req.log.info({ maxListings, dryRun }, "ingest/pvrpv-pricing-refresh: starting");
    const result = await runPvrpvPricingRefresh({ maxListings, dryRun });
    res.json({ dryRun, ...result });
  } catch (err) {
    req.log.error({ err }, "ingest/pvrpv-pricing-refresh failed");
    res.status(500).json({
      error: "PVRPV pricing refresh failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── POST /ingest/vrbo-pricing-refresh ─────────────────────────────────────
//
// Daily VRBO fee-quote refresh. VRBO doesn't expose a calendar feed we can
// scrape headlessly, so each quote is synthesized from the listing's
// already-scraped nightly_price_usd / cleaning_fee_usd plus the standard
// VRBO traveler service fee (~10%) and Mexico lodging tax (IVA 16% + ISH 3%).
// Listings without a published nightly_price_usd are skipped. Same X-
// Internal-Token gate as the other pricing endpoints.
const VrboPricingRefreshSchema = z.object({
  maxListings: z.number().int().positive().max(10_000).optional().default(50),
  dryRun: z.boolean().optional().default(false),
});

router.post("/ingest/vrbo-pricing-refresh", async (req, res) => {
  const expected = process.env["INTERNAL_TRIGGER_TOKEN"];
  if (!expected || expected.length === 0) {
    return res.status(503).json({
      error: "INTERNAL_TRIGGER_TOKEN not configured on server",
    });
  }
  const provided = req.header("x-internal-token");
  if (provided !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const parsed = VrboPricingRefreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
  }
  const { maxListings, dryRun } = parsed.data;

  try {
    req.log.info({ maxListings, dryRun }, "ingest/vrbo-pricing-refresh: starting");
    const result = await runVrboPricingRefresh({ maxListings, dryRun });
    res.json({ dryRun, ...result });
  } catch (err) {
    req.log.error({ err }, "ingest/vrbo-pricing-refresh failed");
    res.status(500).json({
      error: "VRBO pricing refresh failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
