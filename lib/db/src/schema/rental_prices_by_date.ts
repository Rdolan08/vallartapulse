import {
  pgTable,
  serial,
  integer,
  real,
  text,
  date,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

export const rentalPricesByDateTable = pgTable(
  "rental_prices_by_date",
  {
    id: serial("id").primaryKey(),

    /** References rental_listings.id */
    listingId: integer("listing_id")
      .notNull()
      .references(() => rentalListingsTable.id, { onDelete: "cascade" }),

    /** Calendar date this price/availability record applies to (YYYY-MM-DD) */
    date: date("date").notNull(),

    nightlyPriceUsd: real("nightly_price_usd"),

    /**
     * One of: "available" | "booked" | "blocked" | "unavailable"
     * "blocked" = owner-blocked (no revenue), "unavailable" = platform-removed
     */
    availabilityStatus: text("availability_status").notNull().default("available"),

    /** Minimum-night requirement active on this specific date */
    minimumNights: integer("minimum_nights"),

    scrapedAt: timestamp("scraped_at").notNull(),
  },
  (table) => [
    index("idx_rpbd_listing_date").on(table.listingId, table.date),
    index("idx_rpbd_date").on(table.date),
    index("idx_rpbd_status").on(table.availabilityStatus),
    uniqueIndex("idx_rpbd_unique").on(table.listingId, table.date),
  ]
);

export const insertRentalPriceByDateSchema = createInsertSchema(rentalPricesByDateTable).omit({
  id: true,
});
export const selectRentalPriceByDateSchema = createSelectSchema(rentalPricesByDateTable);

export type InsertRentalPriceByDate = z.infer<typeof insertRentalPriceByDateSchema>;
export type RentalPriceByDate = typeof rentalPricesByDateTable.$inferSelect;
