import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  json,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

/**
 * listing_search_observations
 * ─────────────────────────────────────────────────────────────────────────────
 * One row per appearance of a listing on a search-results page.
 * Captures the lightweight card-level data the source returns BEFORE deep
 * enrichment (which lives in listing_details). Multiple observations per
 * listing accumulate over time → useful for tracking displayed-price drift,
 * search-rank movement, and which seeds surfaced which listings.
 */
export const listingSearchObservationsTable = pgTable(
  "listing_search_observations",
  {
    id: serial("id").primaryKey(),

    /** Nullable: an observation can land before the listing has a master row */
    listingId: integer("listing_id").references(() => rentalListingsTable.id, {
      onDelete: "set null",
    }),

    // ── Source identity (always populated, even when listingId is null) ──────
    source: text("source").notNull(),
    externalListingId: text("external_listing_id"),
    canonicalUrl: text("canonical_url"),

    observedAt: timestamp("observed_at").notNull(),

    /** The discovery_jobs seed params that produced this observation */
    searchSeed: json("search_seed"),

    // ── Card-level displayed values ──────────────────────────────────────────
    titleDisplayed: text("title_displayed"),
    displayedNightlyPrice: real("displayed_nightly_price"),
    displayedTotalPrice: real("displayed_total_price"),
    currency: text("currency"),
    displayedRating: real("displayed_rating"),
    displayedReviewCount: integer("displayed_review_count"),
    thumbnailUrl: text("thumbnail_url"),

    // ── Location ─────────────────────────────────────────────────────────────
    rawLocationText: text("raw_location_text"),
    normalizedNeighborhoodBucket: text("normalized_neighborhood_bucket"),
    parentRegionBucket: text("parent_region_bucket"),

    /** Optional raw card payload fragment for parser-repair / future fields */
    rawCardJson: json("raw_card_json"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_lso_listing").on(table.listingId),
    index("idx_lso_source_external").on(table.source, table.externalListingId),
    index("idx_lso_observed_at").on(table.observedAt),
    index("idx_lso_neighborhood").on(table.normalizedNeighborhoodBucket),
  ]
);

export const insertListingSearchObservationSchema = createInsertSchema(
  listingSearchObservationsTable
).omit({ id: true, createdAt: true });
export const selectListingSearchObservationSchema = createSelectSchema(
  listingSearchObservationsTable
);

export type InsertListingSearchObservation = z.infer<
  typeof insertListingSearchObservationSchema
>;
export type ListingSearchObservation = typeof listingSearchObservationsTable.$inferSelect;
