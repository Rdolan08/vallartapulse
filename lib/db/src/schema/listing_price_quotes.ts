import {
  pgTable,
  serial,
  text,
  integer,
  real,
  date,
  timestamp,
  json,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

/**
 * listing_price_quotes
 * ─────────────────────────────────────────────────────────────────────────────
 * Time-series of full priced quotes (nightly × stay-length × fees × taxes)
 * collected from listing checkout/quote endpoints. Distinct from
 * rental_prices_by_date, which stores one row per stay-date. This table stores
 * one row per (listing × checkin × checkout × collected_at) and includes the
 * full fee breakdown — required for booking-window price modelling, lead-time
 * analysis, and seasonality.
 *
 * Insert-only. Never UPDATE; always INSERT new rows so history is preserved.
 */
export const listingPriceQuotesTable = pgTable(
  "listing_price_quotes",
  {
    id: serial("id").primaryKey(),

    listingId: integer("listing_id")
      .notNull()
      .references(() => rentalListingsTable.id, { onDelete: "cascade" }),

    /** When the quote was collected (the "as-of" timestamp) */
    collectedAt: timestamp("collected_at").notNull(),

    // ── Stay window being priced ─────────────────────────────────────────────
    checkinDate: date("checkin_date").notNull(),
    checkoutDate: date("checkout_date").notNull(),
    stayLengthNights: integer("stay_length_nights").notNull(),
    /**
     * Number of guests used to generate this quote. Critical for time-series
     * comparability — Airbnb/VRBO pricing varies by guest count via
     * extra-person fees, so a 2-guest $200 quote is not comparable to a
     * 4-guest $250 quote for the same listing/dates.
     */
    guestCount: integer("guest_count"),

    // ── Price breakdown (USD unless currency specifies otherwise) ────────────
    nightlyPriceUsd: real("nightly_price_usd"),
    subtotalUsd: real("subtotal_usd"),
    cleaningFeeUsd: real("cleaning_fee_usd"),
    serviceFeeUsd: real("service_fee_usd"),
    taxesUsd: real("taxes_usd"),
    totalPriceUsd: real("total_price_usd"),

    currency: text("currency").notNull().default("USD"),

    /** "available" | "unavailable" | "min_stay_violated" | "blocked" | "unknown" */
    availabilityStatus: text("availability_status").notNull().default("unknown"),

    /** Raw quote payload for parser-repair */
    rawQuoteJson: json("raw_quote_json"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_lpq_listing_collected").on(table.listingId, table.collectedAt),
    index("idx_lpq_listing_checkin").on(table.listingId, table.checkinDate),
    index("idx_lpq_checkin_date").on(table.checkinDate),
    index("idx_lpq_collected_at").on(table.collectedAt),
    index("idx_lpq_availability").on(table.availabilityStatus),
  ]
);

export const insertListingPriceQuoteSchema = createInsertSchema(
  listingPriceQuotesTable
).omit({ id: true, createdAt: true });
export const selectListingPriceQuoteSchema = createSelectSchema(listingPriceQuotesTable);

export type InsertListingPriceQuote = z.infer<typeof insertListingPriceQuoteSchema>;
export type ListingPriceQuote = typeof listingPriceQuotesTable.$inferSelect;
