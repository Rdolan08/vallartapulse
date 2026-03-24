import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const safetyMetricsTable = pgTable("safety_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  monthName: text("month_name").notNull(),
  category: text("category").notNull(),
  categoryEs: text("category_es"),
  incidentCount: integer("incident_count").notNull(),
  incidentsPer100k: numeric("incidents_per_100k", { precision: 8, scale: 2 }),
  changeVsPriorYear: numeric("change_vs_prior_year", { precision: 8, scale: 2 }),
  source: text("source").notNull().default("SESNSP"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSafetyMetricSchema = createInsertSchema(safetyMetricsTable).omit({ id: true, createdAt: true });
export type InsertSafetyMetric = z.infer<typeof insertSafetyMetricSchema>;
export type SafetyMetric = typeof safetyMetricsTable.$inferSelect;
