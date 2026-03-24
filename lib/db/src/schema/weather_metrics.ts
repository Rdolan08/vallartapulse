import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const weatherMetricsTable = pgTable("weather_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  monthName: text("month_name").notNull(),
  avgTempC: numeric("avg_temp_c", { precision: 5, scale: 2 }).notNull(),
  maxTempC: numeric("max_temp_c", { precision: 5, scale: 2 }),
  minTempC: numeric("min_temp_c", { precision: 5, scale: 2 }),
  precipitationMm: numeric("precipitation_mm", { precision: 8, scale: 2 }).notNull(),
  avgHumidityPct: numeric("avg_humidity_pct", { precision: 5, scale: 2 }),
  avgSeaTempC: numeric("avg_sea_temp_c", { precision: 5, scale: 2 }),
  sunshineHours: numeric("sunshine_hours", { precision: 6, scale: 1 }),
  rainyDays: integer("rainy_days"),
  source: text("source").notNull().default("NOAA"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertWeatherMetricSchema = createInsertSchema(weatherMetricsTable).omit({ id: true, createdAt: true });
export type InsertWeatherMetric = z.infer<typeof insertWeatherMetricSchema>;
export type WeatherMetric = typeof weatherMetricsTable.$inferSelect;
