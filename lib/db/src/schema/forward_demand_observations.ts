import {
  pgTable,
  serial,
  text,
  integer,
  real,
  date,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

/**
 * forward_demand_observations
 * ─────────────────────────────────────────────────────────────────────────────
 * Internal tracking for the forward-demand recommendation feature (v1).
 *
 * One row per (listing × night_date × event × bucket × shown calendar day).
 * Captures the five outcome fields from the locked spec plus the minimum
 * context required to interpret them. Read-only in v1 — no behavior is
 * adjusted from this data; it exists for post-event analysis after Pride
 * 2026 and Christmas/NYE 2026.
 *
 * Insert when the panel renders. Update when the user clicks Apply, and
 * later when a booking outcome becomes known.
 *
 * NOTE: listing_id is nullable because the pricing-tool operator may not
 * be a tracked listing in rental_listings. Future versions can backfill
 * via property-signature matching.
 */
export const forwardDemandObservationsTable = pgTable(
  "forward_demand_observations",
  {
    id: serial("id").primaryKey(),

    // ── Identifying context ─────────────────────────────────────────────────
    /** Optional FK — set only when the operator's input matches a tracked listing. */
    listingId: integer("listing_id").references(() => rentalListingsTable.id, {
      onDelete: "set null",
    }),

    /** The night being recommended (e.g., a single date inside Pride core). */
    nightDate: date("night_date").notNull(),

    /** Tier 1 event label, e.g., "pride_pv_2026" or "christmas_nye_2026". */
    eventLabel: text("event_label").notNull(),

    /** Time bucket at the moment of show: "early" | "mid" | "late" | "very_late". */
    bucket: text("bucket").notNull(),

    // ── What we recommended ─────────────────────────────────────────────────
    /** Single-click apply price shown to the operator (band midpoint, rounded). */
    recommendedPrice: real("recommended_price").notNull(),

    /** Comp median used as the anchor for the recommendation band. */
    compMedianAtShow: real("comp_median_at_show").notNull(),

    // ── Five outcome fields (locked spec) ───────────────────────────────────
    /** When the recommendation panel rendered for this row. */
    recommendationShown: timestamp("recommendation_shown").notNull().defaultNow(),

    /** When the operator clicked Apply. Null = not applied. */
    recommendationApplied: timestamp("recommendation_applied"),

    /** Actual nightly rate when the night booked. Null until known. */
    finalBookingPrice: real("final_booking_price"),

    /** Boolean once outcome is known: true=booked, false=passed unbooked, null=unknown. */
    booked: boolean("booked"),

    /** booking_timestamp − recommendationShown, in days. Null if unbooked or unknown. */
    daysToBooking: integer("days_to_booking"),
  },
  (table) => [
    index("idx_fdo_listing_night").on(table.listingId, table.nightDate),
    index("idx_fdo_event_bucket").on(table.eventLabel, table.bucket),
    index("idx_fdo_shown").on(table.recommendationShown),
  ],
);

export const insertForwardDemandObservationSchema = createInsertSchema(
  forwardDemandObservationsTable,
).omit({ id: true, recommendationShown: true });

export const selectForwardDemandObservationSchema = createSelectSchema(
  forwardDemandObservationsTable,
);

export type InsertForwardDemandObservation = z.infer<
  typeof insertForwardDemandObservationSchema
>;
export type ForwardDemandObservation =
  typeof forwardDemandObservationsTable.$inferSelect;
