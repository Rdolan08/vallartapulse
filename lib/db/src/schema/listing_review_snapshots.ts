import {
  pgTable,
  serial,
  integer,
  real,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

/**
 * listing_review_snapshots
 * ─────────────────────────────────────────────────────────────────────────────
 * Insert-only time-series of (rating, review_count) per listing.
 * Lets us compute review velocity (proxy for booking volume) and rating drift
 * without overwriting current values.
 */
export const listingReviewSnapshotsTable = pgTable(
  "listing_review_snapshots",
  {
    id: serial("id").primaryKey(),

    listingId: integer("listing_id")
      .notNull()
      .references(() => rentalListingsTable.id, { onDelete: "cascade" }),

    collectedAt: timestamp("collected_at").notNull(),

    rating: real("rating"),
    reviewCount: integer("review_count"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_lrs_listing_collected").on(table.listingId, table.collectedAt),
    index("idx_lrs_collected_at").on(table.collectedAt),
  ]
);

export const insertListingReviewSnapshotSchema = createInsertSchema(
  listingReviewSnapshotsTable
).omit({ id: true, createdAt: true });
export const selectListingReviewSnapshotSchema = createSelectSchema(
  listingReviewSnapshotsTable
);

export type InsertListingReviewSnapshot = z.infer<
  typeof insertListingReviewSnapshotSchema
>;
export type ListingReviewSnapshot = typeof listingReviewSnapshotsTable.$inferSelect;
