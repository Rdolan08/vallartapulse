import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const economicMetricsTable = pgTable("economic_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  quarter: integer("quarter"),
  indicator: text("indicator").notNull(),
  value: numeric("value", { precision: 15, scale: 4 }).notNull(),
  unit: text("unit").notNull(),
  description: text("description"),
  descriptionEs: text("description_es"),
  source: text("source").notNull().default("Data México"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertEconomicMetricSchema = createInsertSchema(economicMetricsTable).omit({ id: true, createdAt: true });
export type InsertEconomicMetric = z.infer<typeof insertEconomicMetricSchema>;
export type EconomicMetric = typeof economicMetricsTable.$inferSelect;
