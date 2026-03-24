import { pgTable, serial, integer, numeric, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tourismMetricsTable = pgTable("tourism_metrics", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  month: integer("month").notNull(),
  monthName: text("month_name").notNull(),
  hotelOccupancyRate: numeric("hotel_occupancy_rate", { precision: 5, scale: 2 }).notNull(),
  totalHotelRooms: integer("total_hotel_rooms"),
  internationalArrivals: integer("international_arrivals"),
  domesticArrivals: integer("domestic_arrivals"),
  totalArrivals: integer("total_arrivals"),
  cruiseVisitors: integer("cruise_visitors"),
  avgHotelRateUsd: numeric("avg_hotel_rate_usd", { precision: 8, scale: 2 }),
  revenuePerAvailableRoomUsd: numeric("revenue_per_available_room_usd", { precision: 8, scale: 2 }),
  source: text("source").notNull().default("DATATUR"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertTourismMetricSchema = createInsertSchema(tourismMetricsTable).omit({ id: true, createdAt: true });
export type InsertTourismMetric = z.infer<typeof insertTourismMetricSchema>;
export type TourismMetric = typeof tourismMetricsTable.$inferSelect;
