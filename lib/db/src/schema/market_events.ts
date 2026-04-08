/**
 * market_events.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Structured market anomaly / event records for VallartaPulse.
 *
 * Used to detect, classify, and contextualise temporary external shocks that
 * affect airport traffic, tourism metrics, and rental pricing models.
 * Examples: security disruptions, severe weather, health advisories, airport
 * closures, political unrest, one-off mega-events.
 *
 * All date fields are stored as ISO-8601 text (YYYY-MM-DD) for portability.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const marketEventsTable = pgTable("market_events", {
  id:       serial("id").primaryKey(),
  slug:     text("slug").notNull().unique(),

  title:    text("title").notNull(),
  titleEs:  text("title_es").notNull(),

  /**
   * Category: security | weather | transportation | health | event | policy | other
   */
  category: text("category").notNull(),

  /**
   * Severity: low | medium | high
   */
  severity: text("severity").notNull(),

  geography: text("geography").notNull(),

  // ── Impact windows ──────────────────────────────────────────────────────────
  /** When the disruption began (YYYY-MM-DD) */
  startDate:         text("start_date").notNull(),
  /** When the disruption ended or is expected to end (nullable = ongoing) */
  endDate:           text("end_date"),
  /** Dates of peak severity */
  peakImpactStart:   text("peak_impact_start"),
  peakImpactEnd:     text("peak_impact_end"),
  /**
   * Booking hesitation window: when booking drop-off likely started.
   * Typically 2-6 weeks before the event for security/health events.
   */
  bookingShockStart: text("booking_shock_start"),
  bookingShockEnd:   text("booking_shock_end"),
  /**
   * Date by which demand is expected to fully normalise.
   * Used to classify months as "recovery" vs "normalised".
   */
  recoveryWindowEnd: text("recovery_window_end"),

  // ── Classification ──────────────────────────────────────────────────────────
  confidence:  text("confidence").notNull(),  // low | medium | high
  sourceType:  text("source_type").notNull(), // manual | estimated | inferred

  summary:   text("summary").notNull(),
  summaryEs: text("summary_es").notNull(),

  /** Comma-separated list of expected effects */
  expectedEffects:  text("expected_effects").notNull(),
  /** rapid | gradual | uncertain */
  recoveryPattern:  text("recovery_pattern").notNull(),

  /**
   * Which data streams this event affects.
   * Comma-separated: airport, tourism, pricing
   */
  affectedMetrics:  text("affected_metrics").notNull().default("airport,tourism,pricing"),

  /**
   * JSON config override for anomaly weights.
   * e.g. { "airportDemand": 0.30, "pricingDemand": 0.35, "recoveryDemand": 0.70 }
   * When null, the anomaly engine's default config is used.
   */
  anomalyWeightConfig: text("anomaly_weight_config"),

  notes:    text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type MarketEvent   = typeof marketEventsTable.$inferSelect;
export type InsertMarketEvent = typeof marketEventsTable.$inferInsert;
