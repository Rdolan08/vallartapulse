import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  json,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * discovery_jobs
 * ─────────────────────────────────────────────────────────────────────────────
 * Durable queue of work items for the source-agnostic STR ingestion pipeline.
 * One row per (source × neighborhood × guest × stay × bedroom × window × job_type)
 * permutation. Phase 1 only creates the table — the queue runner ships in Phase 2.
 */
export const discoveryJobsTable = pgTable(
  "discovery_jobs",
  {
    id: serial("id").primaryKey(),

    // ── Identity / seed ──────────────────────────────────────────────────────
    /** "airbnb" | "vrbo" | future sources */
    source: text("source").notNull(),
    /** "discovery" | "enrichment" | "pricing_snapshot" | "refresh" */
    jobType: text("job_type").notNull(),
    /** "puerto_vallarta" | "riviera_nayarit" */
    parentRegionBucket: text("parent_region_bucket"),
    /** Pricing-tool neighborhood bucket (see rental-normalize PRICING_TOOL_BUCKETS) */
    normalizedNeighborhoodBucket: text("normalized_neighborhood_bucket"),
    /** 1 / 2 / 4 / 6 — null for non-search jobs */
    guestCount: integer("guest_count"),
    /** 3 / 5 / 7 nights — null for non-search jobs */
    stayLengthNights: integer("stay_length_nights"),
    /** "studio" | "1" | "2" | "3" | "4plus" — null when not bucketed */
    bedroomBucket: text("bedroom_bucket"),
    /** "next_weekend" | "+14" | "+30" | "+60" — null for non-search jobs */
    checkinWindow: text("checkin_window"),

    // ── State ────────────────────────────────────────────────────────────────
    /** "pending" | "in_progress" | "complete" | "failed" */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    discoveredCount: integer("discovered_count").notNull().default(0),
    newCount: integer("new_count").notNull().default(0),

    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    lastRunAt: timestamp("last_run_at"),

    errorMessage: text("error_message"),
    /** "exhausted" | "timeout" | "blocked" | "parse_fail" | "duplicate_only" | "manual_cap" */
    terminationReason: text("termination_reason"),

    /** Adapter-specific resume cursor (page, scroll offset, next pagination token, etc.) */
    cursorState: json("cursor_state"),

    /** Priority weight — higher runs first. PV neighborhoods should get higher weights. */
    priority: integer("priority").notNull().default(0),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_dj_status").on(table.status),
    index("idx_dj_source_status").on(table.source, table.status),
    index("idx_dj_priority").on(table.priority),
    index("idx_dj_neighborhood").on(table.normalizedNeighborhoodBucket),
    index("idx_dj_job_type").on(table.jobType),
    /**
     * Partial unique index — at most one pending/in-progress job per
     * (source × job_type × neighborhood × guest × stay × bedroom × window).
     * Completed and failed rows are NOT covered, so retries / historical
     * runs of the same seed can coexist.
     */
    uniqueIndex("idx_dj_active_seed_unique")
      .on(
        table.source,
        table.jobType,
        table.normalizedNeighborhoodBucket,
        table.guestCount,
        table.stayLengthNights,
        table.bedroomBucket,
        table.checkinWindow
      )
      .where(sql`status IN ('pending', 'in_progress')`),
  ]
);

export const insertDiscoveryJobSchema = createInsertSchema(discoveryJobsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectDiscoveryJobSchema = createSelectSchema(discoveryJobsTable);

export type InsertDiscoveryJob = z.infer<typeof insertDiscoveryJobSchema>;
export type DiscoveryJob = typeof discoveryJobsTable.$inferSelect;
