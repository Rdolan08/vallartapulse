import {
  pgTable,
  serial,
  text,
  integer,
  real,
  date,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";
import { listingPriceQuotesTable } from "./listing_price_quotes";

/**
 * presumed_bookings
 * ─────────────────────────────────────────────────────────────────────────────
 * Inferred booking events: when a (listing × stay-window) flips from a
 * priced/available quote → unavailable, we presume it rented at the last
 * seen rate. Source-of-truth for transaction-rate (vs. asking-rate)
 * pricing analytics.
 *
 * Insert-only and idempotent: the (listing_id, checkin_date, checkout_date,
 * last_seen_available_at) tuple is unique so the inference job can be
 * re-run safely without duplicating rows.
 *
 * Schema is provisioned via raw SQL migration:
 *   lib/db/sql/2026-04-23_presumed_bookings.sql
 * (Apply manually against Railway — never via db:push.)
 */
export const presumedBookingsTable = pgTable(
  "presumed_bookings",
  {
    id: serial("id").primaryKey(),

    listingId: integer("listing_id")
      .notNull()
      .references(() => rentalListingsTable.id, { onDelete: "cascade" }),

    // ── Stay window the booking covered ─────────────────────────────────────
    checkinDate: date("checkin_date").notNull(),
    checkoutDate: date("checkout_date").notNull(),
    stayLengthNights: integer("stay_length_nights").notNull(),
    guestCount: integer("guest_count"),

    // ── Inferred rate (from the last priced quote before unavailability) ────
    presumedNightlyUsd: real("presumed_nightly_usd").notNull(),
    presumedSubtotalUsd: real("presumed_subtotal_usd"),
    presumedTotalUsd: real("presumed_total_usd"),

    // ── Evidence timestamps ─────────────────────────────────────────────────
    lastSeenAvailableAt: timestamp("last_seen_available_at").notNull(),
    firstSeenUnavailableAt: timestamp("first_seen_unavailable_at").notNull(),
    observationGapHours: real("observation_gap_hours").notNull(),

    /**
     * "high"   — gap ≤ 48h  (daily scrape caught the flip directly)
     * "medium" — gap ≤ 168h (within a week — likely a real booking)
     * "low"    — gap > 168h (could be owner block, seasonal close, etc.)
     */
    confidence: text("confidence").notNull(),

    sourceAvailableQuoteId: integer("source_available_quote_id").references(
      () => listingPriceQuotesTable.id,
      { onDelete: "set null" },
    ),
    sourceUnavailableQuoteId: integer("source_unavailable_quote_id").references(
      () => listingPriceQuotesTable.id,
      { onDelete: "set null" },
    ),

    inferredAt: timestamp("inferred_at").defaultNow().notNull(),
  },
  (table) => [
    unique("presumed_bookings_unique_flip").on(
      table.listingId,
      table.checkinDate,
      table.checkoutDate,
      table.lastSeenAvailableAt,
    ),
    index("idx_pb_listing_checkin").on(table.listingId, table.checkinDate),
    index("idx_pb_checkin_date").on(table.checkinDate),
    index("idx_pb_inferred_at").on(table.inferredAt),
    index("idx_pb_confidence").on(table.confidence),
  ],
);

export const insertPresumedBookingSchema = createInsertSchema(
  presumedBookingsTable,
).omit({ id: true, inferredAt: true });
export const selectPresumedBookingSchema = createSelectSchema(presumedBookingsTable);

export type InsertPresumedBooking = z.infer<typeof insertPresumedBookingSchema>;
export type PresumedBooking = typeof presumedBookingsTable.$inferSelect;
