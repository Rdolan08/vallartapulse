import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * discovery_run_log
 * ──────────────────────────────────────────────────────────────────────────
 * One row per bucket pass executed by the residential discovery runner
 * (`scripts/src/airbnb-discovery.ts`). Buckets are the cross-product of
 * neighborhood × bedroom-band × price-band.
 *
 * The runner writes a row at the end of each bucket. Counters are the
 * canonical observability surface — the JSON-line stdout stream is for
 * tailing live, this table is for "what did the scraper actually do
 * yesterday?" queries.
 */
export const discoveryRunLogTable = pgTable(
  "discovery_run_log",
  {
    id: serial("id").primaryKey(),

    /** "<neighborhoodKey>__<bedroomBand>__<priceBand>", stable across runs. */
    bucketId: text("bucket_id").notNull(),
    sourcePlatform: text("source_platform").notNull(),

    /** Encoded search URL of the bucket (page=1). Useful for manual replay. */
    bucketQueryUrl: text("bucket_query_url").notNull(),

    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull(),

    pagesFetched: integer("pages_fetched").notNull().default(0),
    candidateIdsSeen: integer("candidate_ids_seen").notNull().default(0),
    /** Already-known IDs whose last_seen_at we bumped. */
    existingTouched: integer("existing_touched").notNull().default(0),
    newInserted: integer("new_inserted").notNull().default(0),

    rejectedIdentity: integer("rejected_identity").notNull().default(0),
    rejectedGeo: integer("rejected_geo").notNull().default(0),
    rejectedPropertyType: integer("rejected_property_type").notNull().default(0),
    rejectedThinData: integer("rejected_thin_data").notNull().default(0),

    retryCount: integer("retry_count").notNull().default(0),

    /** Array of {externalId, stage, message} objects. JSONB for cheap querying. */
    errors: jsonb("errors").$type<Array<Record<string, unknown>>>(),
  },
  (table) => [
    index("idx_drl_bucket").on(table.bucketId),
    index("idx_drl_platform").on(table.sourcePlatform),
    index("idx_drl_started_at").on(table.startedAt),
  ]
);

export const insertDiscoveryRunLogSchema = createInsertSchema(
  discoveryRunLogTable
).omit({ id: true });
export const selectDiscoveryRunLogSchema = createSelectSchema(
  discoveryRunLogTable
);

export type InsertDiscoveryRunLog = z.infer<typeof insertDiscoveryRunLogSchema>;
export type DiscoveryRunLog = typeof discoveryRunLogTable.$inferSelect;
