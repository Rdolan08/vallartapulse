/**
 * lib/db/src/schema/discovery_rejected_candidates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistent audit table for listings the discovery runner saw but did NOT
 * place into the active rental_listings cohort. Exists because:
 *
 *   1. rental_listings has NOT NULL columns (title, bedrooms, bathrooms,
 *      neighborhood_normalized, scraped_at) that thin candidates can't
 *      satisfy. Inserting placeholder values would corrupt comp queries.
 *   2. The brief required excluded rows be preserved and never deleted —
 *      relying solely on stdout JSON event streams (subject to log
 *      rotation) and run-log counters does not satisfy that requirement.
 *   3. Future re-discovery runs can decide whether to re-evaluate a
 *      previously-rejected candidate (e.g. an Airbnb host fixed their
 *      listing's address and it now passes the geo gate).
 *
 * One row per (source_platform, external_id). Reasons accumulate as the
 * latest decision; first/last_seen_at and seen_count grow over time.
 */

import {
  pgTable,
  serial,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const discoveryRejectedCandidatesTable = pgTable(
  "discovery_rejected_candidates",
  {
    id: serial("id").primaryKey(),

    /** "airbnb" | "vrbo" | etc. — same vocabulary as rental_listings.sourcePlatform. */
    sourcePlatform: text("source_platform").notNull(),
    /** Opaque platform listing ID (e.g. Airbnb /rooms/{this}). */
    externalId: text("external_id").notNull(),
    /** Canonical platform URL — informational; identity is the (platform, external_id) pair. */
    sourceUrl: text("source_url").notNull(),

    /**
     * Latest rejection reason. One of:
     *   "identity_failed"      — couldn't reach a real listing page
     *   "out_of_market"        — lat/lng outside PV market bbox
     *   "wrong_property_type"  — failed property-type whitelist
     *   "thin_data"            — passed gates that ran but missing required fields
     */
    rejectionReason: text("rejection_reason").notNull(),
    /** "passed" | "failed" | null — mirrors rental_listings.identityCheckStatus. */
    identityCheckStatus: text("identity_check_status"),

    // ── Whatever the parser was able to pull off the page ──────────────────
    parsedTitle: text("parsed_title"),
    parsedPropertyType: text("parsed_property_type"),
    parsedLatitude: real("parsed_latitude"),
    parsedLongitude: real("parsed_longitude"),
    parsedBedrooms: real("parsed_bedrooms"),
    parsedBathrooms: real("parsed_bathrooms"),
    parsedNeighborhoodHint: text("parsed_neighborhood_hint"),

    /** Bucket that surfaced this candidate (latest one wins). */
    bucketId: text("bucket_id"),

    firstSeenAt: timestamp("first_seen_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    seenCount: integer("seen_count").default(1).notNull(),

    /**
     * Last raw rejection event (the same JSON line emitted to stdout). Lets
     * future tooling see the full context without rescraping.
     */
    lastEvent: jsonb("last_event"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_drc_platform_external_unique").on(
      table.sourcePlatform,
      table.externalId
    ),
    index("idx_drc_reason").on(table.rejectionReason),
    index("idx_drc_last_seen").on(table.lastSeenAt),
  ]
);

export type DiscoveryRejectedCandidate =
  typeof discoveryRejectedCandidatesTable.$inferSelect;
export type InsertDiscoveryRejectedCandidate =
  typeof discoveryRejectedCandidatesTable.$inferInsert;
