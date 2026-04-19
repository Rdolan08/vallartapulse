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
import {
  airbnbPricingRunSummariesTable,
  rentalListingsTable,
} from "@workspace/db/schema";
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
import {
  evaluateEnrichmentAlert,
  type DailyRunRecord,
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
// On-demand trigger for the Airbnb listing-detail enrichment loop. Mirrors
// the candidate query used by scripts/src/enrich-airbnb-listings.ts: any
// rental_listings row whose source_platform='airbnb', has a source_url, and
// has no listing_details row yet, optionally restricted to a set of
// normalized neighborhood buckets. Hard-capped at maxListings=500 per call.
//
// The fetch path (browser/raw/hybrid) is dictated by the AIRBNB_DETAIL_FETCH_MODE
// env var on the server — this endpoint just iterates and reports.
//
// Auth: requires the X-Internal-Token request header to match
// process.env.INTERNAL_TRIGGER_TOKEN. If the env var is not set on the
// server, the endpoint refuses with 503 — there is no "no auth" mode.

const DEFAULT_DETAIL_BUCKETS = [
  "Zona Romántica",
  "Amapas / Conchas Chinas",
  "Centro / Alta Vista",
];

const EnrichDetailSchema = z.object({
  maxListings: z.number().int().positive().max(500).optional().default(5),
  buckets: z.array(z.string().min(1)).optional(),
  dryRun: z.boolean().optional().default(false),
  // "new"   → listings that have NEVER been enriched (LEFT JOIN ... IS NULL).
  // "stale" → listings whose latest listing_details.enriched_at is older than
  //           `staleAfterDays` days ago. Used by the daily refresh cron so the
  //           site never serves data more than ~24h old.
  mode: z.enum(["new", "stale"]).optional().default("new"),
  // Only meaningful when mode='stale'. Default 1 day = "refresh anything not
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
  const buckets = parsed.data.buckets && parsed.data.buckets.length > 0
    ? parsed.data.buckets
    : DEFAULT_DETAIL_BUCKETS;

  try {
    const bucketList = sql.join(buckets.map((b) => sql`${b}`), sql`, `);
    // Two cohorts share the endpoint:
    //   - "new":   listings with NO listing_details row yet. Drains the
    //              backlog created by discovery.
    //   - "stale": listings whose latest listing_details.enriched_at is
    //              older than `staleAfterDays`. Used by the daily refresh
    //              cron to honor the "no stale data on the site" contract.
    //              Re-fetches everything (including blocked/delisted stubs)
    //              so previously-walled or de-listed pages get a fresh
    //              chance every day.
    const candidatesRaw = mode === "stale"
      ? await db.execute(sql`
          SELECT rl.id,
                 rl.external_id,
                 rl.source_url,
                 rl.normalized_neighborhood_bucket AS bucket
          FROM rental_listings rl
          JOIN (
            SELECT listing_id, MAX(enriched_at) AS last_enriched
            FROM listing_details
            GROUP BY listing_id
          ) ld ON ld.listing_id = rl.id
          WHERE rl.source_platform = 'airbnb'
            AND rl.source_url IS NOT NULL
            AND rl.normalized_neighborhood_bucket IN (${bucketList})
            AND ld.last_enriched < NOW() - (${staleAfterDays} || ' days')::interval
          ORDER BY ld.last_enriched ASC
          LIMIT ${maxListings}
        `)
      : await db.execute(sql`
          SELECT rl.id,
                 rl.external_id,
                 rl.source_url,
                 rl.normalized_neighborhood_bucket AS bucket
          FROM rental_listings rl
          LEFT JOIN listing_details ld ON ld.listing_id = rl.id
          WHERE rl.source_platform = 'airbnb'
            AND rl.source_url IS NOT NULL
            AND ld.id IS NULL
            AND rl.normalized_neighborhood_bucket IN (${bucketList})
          ORDER BY rl.id DESC
          LIMIT ${maxListings}
        `);
    const candidates = (candidatesRaw as unknown as {
      rows: Array<{ id: number; external_id: string | null; source_url: string; bucket: string }>;
    }).rows;

    req.log.info(
      { count: candidates.length, maxListings, buckets, dryRun, mode: process.env["AIRBNB_DETAIL_FETCH_MODE"] ?? "browser" },
      "ingest/enrich-airbnb-detail: starting"
    );

    const perListing: Array<{
      listingId: number;
      externalId: string | null;
      bucket: string;
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
        outcome: r.outcome,
        parseStatus: r.outcome === "enriched" || r.outcome === "parse_fail" ? r.parseStatus : null,
        filledFieldCount: r.outcome === "enriched" || r.outcome === "parse_fail" ? r.filledFieldCount : undefined,
        errorMessage: r.outcome === "blocked" || r.outcome === "error" ? r.errorMessage : null,
        ms,
      });
    }

    const summary = {
      attempted: perListing.length,
      enriched: perListing.filter((r) => r.outcome === "enriched").length,
      parse_fail: perListing.filter((r) => r.outcome === "parse_fail").length,
      blocked: perListing.filter((r) => r.outcome === "blocked").length,
      error: perListing.filter((r) => r.outcome === "error").length,
      delisted: perListing.filter((r) => r.outcome === "delisted").length,
    };

    res.json({
      mode: process.env["AIRBNB_DETAIL_FETCH_MODE"] ?? "browser",
      dryRun,
      buckets,
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

    // Same vocabulary as the run summary so the dashboard can colour both
    // signals consistently.
    let alertLevel: "ok" | "warn" | "fail" = "ok";
    let alertReason = "";
    if (row.listings_total === 0) {
      alertLevel = "warn";
      alertReason = "No active Airbnb listings in cohort";
    } else if (ageHours === null || ageHours > 48) {
      alertLevel = "fail";
      alertReason = newestAt
        ? `Newest quote is ${Math.round(ageHours! / 24)} days old`
        : "No quotes have ever been collected";
    } else if (row.listings_stale_14d * 2 >= row.listings_total) {
      alertLevel = "fail";
      alertReason = `${row.listings_stale_14d}/${row.listings_total} listings stale >14d`;
    } else if (row.listings_stale_14d > 0) {
      alertLevel = "warn";
      alertReason = `${row.listings_stale_14d} listings stale >14d`;
    } else if (ageHours > 30) {
      alertLevel = "warn";
      alertReason = `Newest quote is ${ageHours}h old`;
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
    const recentSummaries = await db
      .select()
      .from(airbnbPricingRunSummariesTable)
      .orderBy(desc(airbnbPricingRunSummariesTable.ranAt))
      .limit(7);

    const dailyRecords: DailyRunRecord[] = recentSummaries.map((s) => ({
      ranAt: s.ranAt,
      summary: {
        attempted: s.listingsAttempted,
        ok: s.listingsOk,
        failed: s.listingsFailed,
        totalQuotesWritten: s.totalQuotesWritten,
        totalDaysWithPrice: 0,
        totalQuotesEnriched: s.totalQuotesEnriched,
        totalQuotesFailed: s.totalQuotesFailed,
        totalFullyAvailableCheckpoints: s.totalFullyAvailableCheckpoints,
        totalQuotesEnrichedFullyAvailable: s.quotesEnrichedFullyAvailable,
        enrichmentRate: s.enrichmentRate,
        shaSource: "cache",
        quoteShaSource: "cache",
        shaRediscoveriesDuringRun: 0,
        quoteShaRediscoveriesDuringRun: 0,
        alertLevel: "ok",
        alertReason: "",
      },
    }));

    const parserAlert = evaluateEnrichmentAlert(dailyRecords);
    if (parserAlert.status === "alert") {
      // Parser-keyword regression beats freshness "ok" — owners stop
      // seeing fee data even though quotes are still landing.
      alertLevel = "fail";
      alertReason = alertReason
        ? `${alertReason}; ${parserAlert.reason}`
        : parserAlert.reason;
    }

    res.json({
      source: "airbnb_pricing",
      listingsTotal: row.listings_total,
      listingsQuotedEver: row.listings_quoted_ever,
      listingsNeverQuoted: row.listings_never_quoted,
      listingsStale7d: row.listings_stale_7d,
      listingsStale14d: row.listings_stale_14d,
      newestQuoteAt: newestAt?.toISOString() ?? null,
      newestQuoteAgeHours: ageHours,
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
  maxListings: z.number().int().positive().max(500).optional().default(50),
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

export default router;
