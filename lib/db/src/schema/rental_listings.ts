import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  json,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rentalListingsTable = pgTable(
  "rental_listings",
  {
    // ── Identity ──────────────────────────────────────────────────────────────
    id: serial("id").primaryKey(),

    /** Opaque ID from the source platform (Airbnb listing ID, VRBO property ID, etc.) */
    sourcePlatform: text("source_platform").notNull(),
    sourceUrl: text("source_url").notNull(),
    externalId: text("external_id"),

    // ── Content ──────────────────────────────────────────────────────────────
    title: text("title").notNull(),

    // ── Location ─────────────────────────────────────────────────────────────
    /** Raw neighborhood string exactly as scraped */
    neighborhoodRaw: text("neighborhood_raw").notNull(),
    /** Canonical neighborhood from the 7-name normalization lookup */
    neighborhoodNormalized: text("neighborhood_normalized").notNull(),
    buildingName: text("building_name"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    /** Straight-line distance to the nearest beach access point, meters */
    distanceToBeachM: real("distance_to_beach_m"),

    // ── Property specs ───────────────────────────────────────────────────────
    bedrooms: integer("bedrooms").notNull(),
    bathrooms: real("bathrooms").notNull(),
    maxGuests: integer("max_guests"),
    sqft: real("sqft"),

    // ── Amenities ────────────────────────────────────────────────────────────
    /** Full amenity list exactly as returned by the source (array of strings or object) */
    amenitiesRaw: json("amenities_raw"),
    /** Normalized amenity keys referencing rental_amenities_lookup.amenity_key */
    amenitiesNormalized: json("amenities_normalized").$type<string[]>(),

    // ── Ratings & reviews ────────────────────────────────────────────────────
    ratingOverall: real("rating_overall"),
    ratingCount: integer("rating_count"),
    reviewCount: integer("review_count"),
    /** NLP sentiment score over the review corpus; −1 (very negative) → +1 (very positive) */
    reviewSentimentScore: real("review_sentiment_score"),

    // ── Pricing snapshot ─────────────────────────────────────────────────────
    /** Nightly rate at time of scrape (baseline, not calendar-specific) */
    nightlyPriceUsd: real("nightly_price_usd"),
    cleaningFeeUsd: real("cleaning_fee_usd"),
    minNights: integer("min_nights"),

    // ── Data quality ─────────────────────────────────────────────────────────
    scrapedAt: timestamp("scraped_at").notNull(),
    /** 0–1 score; see ingestion pipeline for field-weight formula */
    dataConfidenceScore: real("data_confidence_score").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),

    // ── Phase 1: durable identity & lifecycle (all nullable, additive) ───────
    /** First time this listing was observed by any seed. */
    firstSeenAt: timestamp("first_seen_at"),
    /** Most recent observation timestamp from any source-search seed. */
    lastSeenAt: timestamp("last_seen_at"),
    /** Cumulative count of search-card observations across all seeds. */
    seenCount: integer("seen_count").default(0),
    /** "active" | "stale" | "unavailable" | "removed" | "failed_enrichment" */
    lifecycleStatus: text("lifecycle_status").default("active"),
    /**
     * Stable cross-source identity key. Preferred form: "<source>:<external_listing_id>".
     * Fallback: hash of normalized canonical_url. Used by the queue to dedupe across seeds.
     */
    identityKey: text("identity_key"),
    /** "puerto_vallarta" | "riviera_nayarit" — pricing-tool top-level region. */
    parentRegionBucket: text("parent_region_bucket"),
    /**
     * Pricing-tool neighborhood bucket (see rental-normalize PRICING_TOOL_BUCKETS).
     * Distinct from the existing neighborhood_normalized field, which holds the
     * lower-level canonical name. This column is the product-facing roll-up.
     */
    normalizedNeighborhoodBucket: text("normalized_neighborhood_bucket"),
    /** "exact" | "high" | "inferred" | "unknown" */
    neighborhoodMappingConfidence: text("neighborhood_mapping_confidence"),

    // ── Phase 2c: discovery-runner gates (additive, all nullable) ───────────
    /** Raw Airbnb/VRBO property type token (e.g. "Apartment", "Villa"). */
    propertyTypeRaw: text("property_type_raw"),
    /** Lowercased, whitespace-trimmed property type used for whitelist gating. */
    propertyTypeNormalized: text("property_type_normalized"),
    /** Most recent identity-probe timestamp (HEAD/GET against canonical URL). */
    identityCheckedAt: timestamp("identity_checked_at"),
    /** "passed" | "failed" | null — set by discovery runner. */
    identityCheckStatus: text("identity_check_status"),
    /**
     * "out_of_market" | "wrong_property_type" | "thin_data" | "identity_failed"
     * | null. Populated when the discovery runner inserts a candidate that fails
     * one of the active-cohort gates. NULL means the row is in good standing.
     */
    cohortExcludedReason: text("cohort_excluded_reason"),
  },
  (table) => [
    index("idx_rl_neighborhood").on(table.neighborhoodNormalized),
    index("idx_rl_bedrooms").on(table.bedrooms),
    index("idx_rl_platform").on(table.sourcePlatform),
    index("idx_rl_price").on(table.nightlyPriceUsd),
    index("idx_rl_active").on(table.isActive),
    uniqueIndex("idx_rl_source_unique").on(table.sourcePlatform, table.sourceUrl),
    /**
     * Durable platform identity. The discovery runner uses this as its
     * ON CONFLICT target so that URL drift (mobile → desktop, query-param
     * variants, locale redirects) does NOT create duplicate rows for the
     * same logical Airbnb listing. external_id is nullable for legacy
     * rows so the index is partial.
     */
    uniqueIndex("idx_rl_platform_external_unique")
      .on(table.sourcePlatform, table.externalId)
      .where(sql`external_id IS NOT NULL`),
    index("idx_rl_lifecycle").on(table.lifecycleStatus),
    index("idx_rl_identity_key").on(table.identityKey),
    /**
     * Partial unique index on identity_key — guarantees one row per logical
     * listing even when two concurrent discovery workers see the same listing
     * via different URLs (mobile vs desktop, with vs without query params).
     * Phase 2b's upsertListing can rely on `ON CONFLICT (identity_key)` for
     * a simpler atomic upsert path.
     *
     * NULL identity_keys (legacy rows that couldn't be backfilled) are
     * intentionally excluded so the index doesn't block them.
     */
    uniqueIndex("idx_rl_identity_key_unique")
      .on(table.identityKey)
      .where(sql`identity_key IS NOT NULL`),
    index("idx_rl_parent_region").on(table.parentRegionBucket),
    index("idx_rl_pricing_bucket").on(table.normalizedNeighborhoodBucket),
    index("idx_rl_last_seen").on(table.lastSeenAt),
  ]
);

export const insertRentalListingSchema = createInsertSchema(rentalListingsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectRentalListingSchema = createSelectSchema(rentalListingsTable);

export type InsertRentalListing = z.infer<typeof insertRentalListingSchema>;
export type RentalListing = typeof rentalListingsTable.$inferSelect;
