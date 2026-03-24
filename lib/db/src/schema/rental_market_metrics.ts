import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rentalMarketMetricsTable = pgTable("rental_market_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  monthName: text("month_name").notNull(),
  neighborhood: text("neighborhood").notNull(),
  platform: text("platform").notNull().default("all"),
  activeListings: integer("active_listings").notNull(),
  avgNightlyRateUsd: numeric("avg_nightly_rate_usd", { precision: 8, scale: 2 }).notNull(),
  medianNightlyRateUsd: numeric("median_nightly_rate_usd", { precision: 8, scale: 2 }),
  occupancyRate: numeric("occupancy_rate", { precision: 5, scale: 2 }).notNull(),
  avgReviewScore: numeric("avg_review_score", { precision: 3, scale: 2 }),
  totalReviews: integer("total_reviews"),
  source: text("source").notNull().default("Airbnb/VRBO"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertRentalMarketMetricSchema = createInsertSchema(rentalMarketMetricsTable).omit({ id: true, createdAt: true });
export type InsertRentalMarketMetric = z.infer<typeof insertRentalMarketMetricSchema>;
export type RentalMarketMetric = typeof rentalMarketMetricsTable.$inferSelect;
