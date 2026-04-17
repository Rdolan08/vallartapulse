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
  },
  (table) => [
    index("idx_rl_neighborhood").on(table.neighborhoodNormalized),
    index("idx_rl_bedrooms").on(table.bedrooms),
    index("idx_rl_platform").on(table.sourcePlatform),
    index("idx_rl_price").on(table.nightlyPriceUsd),
    index("idx_rl_active").on(table.isActive),
    uniqueIndex("idx_rl_source_unique").on(table.sourcePlatform, table.sourceUrl),
    index("idx_rl_lifecycle").on(table.lifecycleStatus),
    index("idx_rl_identity_key").on(table.identityKey),
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
