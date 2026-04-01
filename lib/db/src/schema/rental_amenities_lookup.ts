import { pgTable, text, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Static lookup table — one row per canonical amenity.
 * amenity_key is the primary key and the value stored in
 * rental_listings.amenities_normalized.
 */
export const rentalAmenitiesLookupTable = pgTable(
  "rental_amenities_lookup",
  {
    /** Snake-case canonical key, e.g. "private_pool", "beachfront", "washer" */
    amenityKey: text("amenity_key").primaryKey(),

    /**
     * Grouping category — one of:
     * pool | beach | view | kitchen | laundry | climate |
     * connectivity | safety | parking | outdoor | entertainment |
     * accessibility | pet | workspace | other
     */
    category: text("category").notNull(),

    /** Human-readable label shown in the UI */
    label: text("label").notNull(),
    labelEs: text("label_es").notNull(),

    /** Optional longer description */
    description: text("description"),
  },
  (table) => [
    index("idx_ral_category").on(table.category),
  ]
);

export const insertRentalAmenityLookupSchema = createInsertSchema(rentalAmenitiesLookupTable);
export const selectRentalAmenityLookupSchema = createSelectSchema(rentalAmenitiesLookupTable);

export type InsertRentalAmenityLookup = z.infer<typeof insertRentalAmenityLookupSchema>;
export type RentalAmenityLookup = typeof rentalAmenitiesLookupTable.$inferSelect;
