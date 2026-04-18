/**
 * rental-ingest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Placeholder ingestion pipeline for rental listing data.
 *
 * Accepts raw JSON from any scraper / manual import, maps it to the
 * normalized rental_listings schema, and writes to the database.
 *
 * NO external HTTP calls are made here. This is a pure transformation +
 * database-write pipeline. Scrapers call ingestListing() after fetching.
 */

import { sql, count } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  rentalListingsTable,
  rentalPricesByDateTable,
  rentalAmenitiesLookupTable,
  InsertRentalListing,
  InsertRentalPriceByDate,
} from "@workspace/db";
import {
  normalizeNeighborhood,
  normalizeAmenities,
  computeConfidenceScore,
  AMENITY_CATALOG,
} from "./rental-normalize";
import { logger } from "./logger";

// ── Raw input types ───────────────────────────────────────────────────────────

/**
 * Shape that a scraper or manual data entry provides.
 * All fields are optional except the three source identity fields.
 */
export interface RawListing {
  // Identity (required)
  source_platform: string;
  source_url: string;
  title: string;

  // Location (raw)
  neighborhood_raw?: string;
  building_name?: string;
  latitude?: number;
  longitude?: number;

  // Property specs
  bedrooms?: number;
  bathrooms?: number;
  max_guests?: number;
  sqft?: number;

  // Amenities — array of strings exactly as scraped
  amenities_raw?: string[];

  // Ratings
  rating_overall?: number;
  rating_count?: number;
  review_count?: number;

  // Pricing snapshot
  nightly_price_usd?: number;
  cleaning_fee_usd?: number;
  min_nights?: number;

  // Metadata
  scraped_at?: string | Date;
  external_id?: string;
}

/**
 * Per-date price/availability record from a calendar scrape.
 */
export interface RawPriceByDate {
  listing_id: number;
  date: string;
  nightly_price_usd?: number;
  availability_status?: "available" | "booked" | "blocked" | "unavailable";
  minimum_nights?: number;
  scraped_at?: string | Date;
}

// ── Normalization helpers ─────────────────────────────────────────────────────

function toDate(value: string | Date | undefined): Date {
  if (!value) return new Date();
  return value instanceof Date ? value : new Date(value);
}

function clampRating(r: number | undefined): number | null {
  if (r == null || isNaN(r)) return null;
  if (r < 0 || r > 5) {
    logger.warn({ raw_rating: r }, "Rating out of 0–5 range — clamped");
    return Math.min(5, Math.max(0, r));
  }
  return r;
}

function clampPrice(p: number | undefined, field: string): number | null {
  if (p == null || isNaN(p)) return null;
  if (p <= 0) {
    logger.warn({ raw_price: p, field }, "Non-positive price — rejected");
    return null;
  }
  if (p > 50_000) {
    logger.warn({ raw_price: p, field }, "Price above $50k/night — flagged");
  }
  return p;
}

// ── Core mapping function ─────────────────────────────────────────────────────

/**
 * Maps a RawListing to the InsertRentalListing shape used by Drizzle.
 * Returns the mapped record AND an array of validation warnings.
 */
export function mapRawToListing(raw: RawListing): {
  record: InsertRentalListing;
  warnings: string[];
} {
  const warnings: string[] = [];

  // ── Neighborhood ──
  const neighborhoodRaw = raw.neighborhood_raw?.trim() ?? "";
  const neighborhoodNormalized =
    normalizeNeighborhood(neighborhoodRaw) ?? "unclassified";

  if (neighborhoodNormalized === "unclassified") {
    warnings.push(`Neighborhood not recognized: "${neighborhoodRaw}"`);
  }

  // ── Bedrooms / bathrooms ──
  const bedrooms = raw.bedrooms != null ? Math.max(0, Math.round(raw.bedrooms)) : 0;
  const bathrooms = raw.bathrooms != null ? Math.max(0, raw.bathrooms) : 0;

  if (bedrooms === 0 && raw.bedrooms == null) {
    warnings.push("bedrooms missing — defaulted to 0 (studio)");
  }
  if (bathrooms === 0) warnings.push("bathrooms missing or zero");

  // ── Amenities ──
  const amenitiesRaw = raw.amenities_raw ?? [];
  const amenitiesNormalized = normalizeAmenities(amenitiesRaw);

  // ── Ratings ──
  const ratingOverall = clampRating(raw.rating_overall);
  if (raw.rating_overall != null && ratingOverall == null) {
    warnings.push(`rating_overall "${raw.rating_overall}" rejected`);
  }

  // ── Pricing ──
  const nightlyPriceUsd = clampPrice(raw.nightly_price_usd, "nightly_price_usd");
  const cleaningFeeUsd = clampPrice(raw.cleaning_fee_usd, "cleaning_fee_usd");

  // ── Confidence score ──
  const dataConfidenceScore = computeConfidenceScore({
    title: raw.title,
    sourceUrl: raw.source_url,
    neighborhoodNormalized,
    bedrooms,
    bathrooms,
    nightlyPriceUsd,
    ratingOverall,
    reviewCount: raw.review_count,
    latitude: raw.latitude,
    longitude: raw.longitude,
    maxGuests: raw.max_guests,
    amenitiesNormalized,
  });

  const record: InsertRentalListing = {
    sourcePlatform: raw.source_platform.trim(),
    sourceUrl: raw.source_url.trim(),
    externalId: raw.external_id?.trim() ?? null,
    title: raw.title.trim(),

    neighborhoodRaw,
    neighborhoodNormalized,
    buildingName: raw.building_name?.trim() ?? null,
    latitude: raw.latitude ?? null,
    longitude: raw.longitude ?? null,
    distanceToBeachM: null,   // computed separately when lat/lon is known

    bedrooms,
    bathrooms,
    maxGuests: raw.max_guests ?? null,
    sqft: raw.sqft ?? null,

    amenitiesRaw: amenitiesRaw.length > 0 ? amenitiesRaw : null,
    amenitiesNormalized: amenitiesNormalized.length > 0 ? amenitiesNormalized : null,

    ratingOverall,
    ratingCount: raw.rating_count ?? null,
    reviewCount: raw.review_count ?? null,
    reviewSentimentScore: null,   // populated by NLP step (not yet implemented)

    nightlyPriceUsd,
    cleaningFeeUsd,
    minNights: raw.min_nights ?? null,

    scrapedAt: toDate(raw.scraped_at),
    dataConfidenceScore,
    isActive: true,
  };

  return { record, warnings };
}

// ── Database write operations ─────────────────────────────────────────────────

/**
 * Upserts a single listing into the database.
 * On conflict (same source_platform + source_url), updates all mutable fields
 * and refreshes updated_at.
 *
 * Returns the inserted/updated row id.
 */
export async function ingestListing(raw: RawListing): Promise<{
  id: number;
  warnings: string[];
  confidence: number;
}> {
  const { record, warnings } = mapRawToListing(raw);
  const confidenceScore: number = record.dataConfidenceScore ?? 0;

  const rows_returned = await db
    .insert(rentalListingsTable)
    .values(record)
    .onConflictDoUpdate({
      target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
      set: {
        title: record.title,
        neighborhoodRaw: record.neighborhoodRaw,
        neighborhoodNormalized: record.neighborhoodNormalized,
        buildingName: record.buildingName,
        latitude: record.latitude,
        longitude: record.longitude,
        // Preserve known attribute values when re-discovering. Discovery often
        // returns 0/null for bedrooms/bathrooms (Airbnb stopped surfacing them
        // in search-card SSR), so a naive `excluded.bedrooms` overwrite would
        // erase any real value previously written by detail enrichment or an
        // earlier richer crawl. GREATEST keeps the larger known count;
        // COALESCE keeps the existing non-null value for max_guests.
        bedrooms: sql`GREATEST(${rentalListingsTable.bedrooms}, excluded.bedrooms)`,
        bathrooms: sql`GREATEST(${rentalListingsTable.bathrooms}, excluded.bathrooms)`,
        maxGuests: sql`COALESCE(${rentalListingsTable.maxGuests}, excluded.max_guests)`,
        sqft: record.sqft,
        amenitiesRaw: record.amenitiesRaw,
        amenitiesNormalized: record.amenitiesNormalized,
        ratingOverall: record.ratingOverall,
        ratingCount: record.ratingCount,
        reviewCount: record.reviewCount,
        nightlyPriceUsd: record.nightlyPriceUsd,
        cleaningFeeUsd: record.cleaningFeeUsd,
        minNights: record.minNights,
        scrapedAt: record.scrapedAt,
        dataConfidenceScore: record.dataConfidenceScore,
        isActive: record.isActive,
        updatedAt: new Date(),
      },
    })
    .returning({ id: rentalListingsTable.id });

  const insertedId = rows_returned[0]?.id;
  if (insertedId == null) throw new Error("Listing insert returned no id");

  logger.info(
    {
      id: insertedId,
      platform: record.sourcePlatform,
      confidence: confidenceScore,
      warnings: warnings.length,
    },
    "Listing ingested"
  );

  return { id: insertedId, warnings, confidence: confidenceScore };
}

/**
 * Bulk-upserts calendar price/availability records for a listing.
 * On conflict (same listing_id + date), updates price and status.
 */
export async function ingestPricesByDate(
  prices: RawPriceByDate[]
): Promise<number> {
  if (prices.length === 0) return 0;

  const rows: InsertRentalPriceByDate[] = prices.map((p) => ({
    listingId: p.listing_id,
    date: p.date,
    nightlyPriceUsd: p.nightly_price_usd ?? null,
    availabilityStatus: p.availability_status ?? "available",
    minimumNights: p.minimum_nights ?? null,
    scrapedAt: toDate(p.scraped_at),
  }));

  await db
    .insert(rentalPricesByDateTable)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        rentalPricesByDateTable.listingId,
        rentalPricesByDateTable.date,
      ],
      set: {
        nightlyPriceUsd: sql`excluded.nightly_price_usd`,
        availabilityStatus: sql`excluded.availability_status`,
        minimumNights: sql`excluded.minimum_nights`,
        scrapedAt: sql`excluded.scraped_at`,
      },
    });

  return rows.length;
}

// ── Amenity lookup seed ───────────────────────────────────────────────────────

/**
 * Seeds the rental_amenities_lookup table from the catalog defined in
 * rental-normalize.ts. Safe to re-run (upsert on primary key).
 */
export async function seedAmenitiesLookup(): Promise<void> {
  const rows = AMENITY_CATALOG.map(({ key, category, label, labelEs, description }) => ({
    amenityKey: key,
    category,
    label,
    labelEs,
    description: description ?? null,
  }));

  await db
    .insert(rentalAmenitiesLookupTable)
    .values(rows)
    .onConflictDoUpdate({
      target: [rentalAmenitiesLookupTable.amenityKey],
      set: {
        category: sql`excluded.category`,
        label: sql`excluded.label`,
        labelEs: sql`excluded.label_es`,
        description: sql`excluded.description`,
      },
    });

  logger.info({ count: rows.length }, "Amenities lookup seeded");
}

// ── PVRPV listing seed ────────────────────────────────────────────────────────

/**
 * Seeds the rental_listings table from the static PVRPV dataset scraped in
 * April 2026. Safe to re-run — upserts on (source_platform, source_url).
 * Only runs if the table is currently empty to avoid overwriting live data.
 */
export async function seedRentalListings(): Promise<void> {
  const [{ value: existing }] = await db.select({ value: count(rentalListingsTable.id) }).from(rentalListingsTable);
  if (existing > 0) {
    logger.info({ existing }, "Rental listings already seeded, skipping");
    return;
  }

  const { PVRPV_SEED_LISTINGS } = await import("./listing-seed-data.js");
  const SCRAPE_DATE = new Date("2026-04-01T00:00:00Z");

  const rows: InsertRentalListing[] = (PVRPV_SEED_LISTINGS as readonly any[]).map((r) => ({
    sourcePlatform:         r.source_platform,
    sourceUrl:              r.source_url,
    externalId:             r.external_id ?? null,
    title:                  r.title,
    neighborhoodRaw:        r.neighborhood_raw,
    neighborhoodNormalized: r.neighborhood_normalized,
    buildingName:           r.building_name ?? null,
    latitude:               r.latitude ?? null,
    longitude:              r.longitude ?? null,
    distanceToBeachM:       r.distance_to_beach_m ?? null,
    bedrooms:               r.bedrooms,
    bathrooms:              r.bathrooms,
    maxGuests:              r.max_guests ?? null,
    sqft:                   r.sqft ?? null,
    amenitiesRaw:           r.amenities_raw ?? null,
    amenitiesNormalized:    r.amenities_normalized ?? null,
    ratingOverall:          r.rating_overall ?? null,
    ratingCount:            r.rating_count ?? null,
    reviewCount:            r.review_count ?? null,
    nightlyPriceUsd:        r.nightly_price_usd ?? null,
    cleaningFeeUsd:         r.cleaning_fee_usd ?? null,
    minNights:              r.min_nights ?? null,
    scrapedAt:              SCRAPE_DATE,
    dataConfidenceScore:    r.data_confidence_score ?? 0,
    isActive:               r.is_active ?? true,
  }));

  await db
    .insert(rentalListingsTable)
    .values(rows)
    .onConflictDoUpdate({
      target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
      set: {
        externalId:             sql`excluded.external_id`,
        title:                  sql`excluded.title`,
        neighborhoodNormalized: sql`excluded.neighborhood_normalized`,
        buildingName:           sql`excluded.building_name`,
        distanceToBeachM:       sql`excluded.distance_to_beach_m`,
        // GREATEST keeps a real bedroom/bathroom count from a previous richer
        // crawl when the current bulk-seed row carries 0 (see comment on the
        // per-listing UPSERT above for the full rationale).
        bedrooms:               sql`GREATEST(${rentalListingsTable.bedrooms}, excluded.bedrooms)`,
        bathrooms:              sql`GREATEST(${rentalListingsTable.bathrooms}, excluded.bathrooms)`,
        sqft:                   sql`excluded.sqft`,
        amenitiesNormalized:    sql`excluded.amenities_normalized`,
        ratingOverall:          sql`excluded.rating_overall`,
        reviewCount:            sql`excluded.review_count`,
        nightlyPriceUsd:        sql`excluded.nightly_price_usd`,
        dataConfidenceScore:    sql`excluded.data_confidence_score`,
        isActive:               sql`excluded.is_active`,
      },
    });

  logger.info({ count: rows.length }, "PVRPV rental listings seeded");
}
