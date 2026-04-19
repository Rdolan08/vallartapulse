import {
  pgTable,
  serial,
  integer,
  real,
  timestamp,
  json,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * airbnb_pricing_run_summaries
 * ─────────────────────────────────────────────────────────────────────────────
 * Insert-only history of every Airbnb pricing run (the daily refresh
 * driven by `runAirbnbPricingRefresh`). One row per completed run.
 *
 * Why this exists:
 *   The full-quote step parses Airbnb's GraphQL response by matching
 *   display titles ("Cleaning fee", "Service fee", "Taxes"). Airbnb
 *   periodically renames or restructures those rows, in which case the
 *   per-checkpoint quote keeps returning 200 OK but the breakdown
 *   columns silently come back null. The runner drops the half-row,
 *   the daily summary still looks "ok", and owners just stop seeing
 *   fees. Persisting per-run enrichment-rate history is what lets the
 *   freshness/alerting path notice the parser has gone dark across
 *   multiple consecutive days.
 *
 * Dry-run / canary executions are NOT persisted — they would skew the
 * enrichment-rate signal (canary skips the full-quote step entirely
 * by design).
 */
export const airbnbPricingRunSummariesTable = pgTable(
  "airbnb_pricing_run_summaries",
  {
    id: serial("id").primaryKey(),

    /** Wall-clock time the run finished. */
    ranAt: timestamp("ran_at").notNull().defaultNow(),

    // ── Run shape ────────────────────────────────────────────────────────────
    listingsAttempted: integer("listings_attempted").notNull(),
    listingsOk: integer("listings_ok").notNull(),
    listingsFailed: integer("listings_failed").notNull(),

    // ── Quote / enrichment counters ──────────────────────────────────────────
    totalQuotesWritten: integer("total_quotes_written").notNull(),
    totalQuotesEnriched: integer("total_quotes_enriched").notNull(),
    totalQuotesFailed: integer("total_quotes_failed").notNull(),
    /**
     * Denominator the alert math uses: how many checkpoints had every
     * night both covered and available, i.e. the ones we *expected* to
     * get a fee breakdown for. Excludes "min_stay_violated" /
     * "unavailable" checkpoints — those legitimately can't get a quote.
     */
    totalFullyAvailableCheckpoints: integer(
      "total_fully_available_checkpoints",
    ).notNull(),
    /**
     * Numerator for the rate: enrichments that came back on a
     * fully-available checkpoint specifically. Tracked separately from
     * `totalQuotesEnriched` (which also counts enrichments on
     * partially-available checkpoints) so the ratio stays bounded in
     * [0,1] and accurately reflects parser health.
     */
    quotesEnrichedFullyAvailable: integer(
      "quotes_enriched_fully_available",
    ).notNull(),
    /**
     * Cached `quotesEnrichedFullyAvailable / totalFullyAvailableCheckpoints`.
     * Null when the denominator is zero, so dashboards / alert code
     * can distinguish "0% enriched" (parser broken) from "no eligible
     * checkpoints this run" (canary day, all listings booked, etc).
     */
    enrichmentRate: real("enrichment_rate"),

    /** Full structured summary as JSON for ad-hoc debugging. */
    rawSummaryJson: json("raw_summary_json"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_apr_summaries_ran_at").on(table.ranAt),
  ],
);

export const insertAirbnbPricingRunSummarySchema = createInsertSchema(
  airbnbPricingRunSummariesTable,
).omit({ id: true, createdAt: true });
export const selectAirbnbPricingRunSummarySchema = createSelectSchema(
  airbnbPricingRunSummariesTable,
);

export type InsertAirbnbPricingRunSummary = z.infer<
  typeof insertAirbnbPricingRunSummarySchema
>;
export type AirbnbPricingRunSummaryRow =
  typeof airbnbPricingRunSummariesTable.$inferSelect;
