import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const airportMetricsTable = pgTable("airport_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  monthName: text("month_name").notNull(),
  totalPassengers: integer("total_passengers").notNull(),
  domesticPassengers: integer("domestic_passengers"),
  internationalPassengers: integer("international_passengers"),
  avgDailyPassengers: numeric("avg_daily_passengers", { precision: 10, scale: 2 }),
  daysInMonth: integer("days_in_month"),
  sourceUrl: text("source_url").default("https://www.aeropuertosgap.com.mx/en/puerto-vallarta-3/statistics.html"),
  source: text("source").notNull().default("GAP (Grupo Aeroportuario del Pacífico)"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAirportMetricSchema = createInsertSchema(airportMetricsTable).omit({ id: true, createdAt: true });
export type InsertAirportMetric = z.infer<typeof insertAirportMetricSchema>;
export type AirportMetric = typeof airportMetricsTable.$inferSelect;
