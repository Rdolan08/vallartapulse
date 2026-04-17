import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  json,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { rentalListingsTable } from "./rental_listings";

/**
 * listing_details
 * ─────────────────────────────────────────────────────────────────────────────
 * Versioned raw + normalized payloads from listing detail pages. Each
 * enrichment run inserts a new row rather than overwriting — this preserves
 * history, enables parser-repair against past raw fragments, and lets us
 * detect drift in source markup over time.
 *
 * The "current" enrichment is whichever row has the most recent enrichedAt
 * for a given listingId. Downstream consumers should read the latest by
 * (listingId, enrichedAt DESC).
 */
export const listingDetailsTable = pgTable(
  "listing_details",
  {
    id: serial("id").primaryKey(),

    listingId: integer("listing_id")
      .notNull()
      .references(() => rentalListingsTable.id, { onDelete: "cascade" }),

    enrichedAt: timestamp("enriched_at").notNull(),

    /** Adapter+parser version, e.g. "airbnb-v3", "vrbo-v2" */
    parseVersion: text("parse_version").notNull(),

    /** Full raw payload fragment(s) saved for future re-parsing */
    rawPayload: json("raw_payload"),

    /** Normalized fields in adapter-specific shape (bedrooms, amenities, host, fees, etc.) */
    normalizedFields: json("normalized_fields"),

    /** "ok" | "partial" | "parse_fail" — quick filter for re-enrichment */
    parseStatus: text("parse_status").notNull().default("ok"),
    parseErrors: json("parse_errors"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_ld_listing_enriched").on(table.listingId, table.enrichedAt),
    index("idx_ld_parse_version").on(table.parseVersion),
    index("idx_ld_parse_status").on(table.parseStatus),
  ]
);

export const insertListingDetailSchema = createInsertSchema(listingDetailsTable).omit({
  id: true,
  createdAt: true,
});
export const selectListingDetailSchema = createSelectSchema(listingDetailsTable);

export type InsertListingDetail = z.infer<typeof insertListingDetailSchema>;
export type ListingDetail = typeof listingDetailsTable.$inferSelect;
