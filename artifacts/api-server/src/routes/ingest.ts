/**
 * routes/ingest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ingestion pipeline endpoints.
 *
 * GET  /ingest/stats            — record counts by source_platform
 * GET  /ingest/sample           — sample normalized records from the DB
 * POST /ingest/run              — run adapter on a single URL (live fetch)
 * POST /ingest/ical             — parse an iCal feed URL or raw string
 * POST /ingest/inject           — accept a pre-scraped NormalizedRentalListing
 * POST /ingest/scrape-all       — bulk-scrape a supported source (vacation_vallarta | vrbo_batch)
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

export default router;
