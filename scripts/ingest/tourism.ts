/**
 * Ingest data/tourism/datatur-monthly.csv → tourism_metrics.
 */
import { db } from "@workspace/db";
import { tourismMetricsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, int, str } from "./_csv";

export const TOURISM_CSV = resolve(import.meta.dirname, "../../data/tourism/datatur-monthly.csv");

export async function ingestTourism(): Promise<{ inserted: number }> {
  const rows = readCsv(TOURISM_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE tourism_metrics RESTART IDENTITY`);
    if (rows.length === 0) return { inserted: 0 };
    await tx.insert(tourismMetricsTable).values(rows.map((r) => ({
      year:                       int(r.year)!,
      month:                      int(r.month)!,
      monthName:                  str(r.month_name)!,
      hotelOccupancyRate:         r.hotel_occupancy_rate,
      totalHotelRooms:            int(r.total_hotel_rooms),
      internationalArrivals:      int(r.international_arrivals),
      domesticArrivals:           int(r.domestic_arrivals),
      totalArrivals:              int(r.total_arrivals),
      cruiseVisitors:             int(r.cruise_visitors),
      avgHotelRateUsd:            r.avg_hotel_rate_usd,
      revenuePerAvailableRoomUsd: r.revenue_per_available_room_usd,
      source:                     str(r.source) ?? "DATATUR / SECTUR",
    })));
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestTourism().then((r) => { console.log("tourism:", r); process.exit(0); });
}
