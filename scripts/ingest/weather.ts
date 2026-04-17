/**
 * Ingest data/weather/pvr-monthly.csv → weather_metrics.
 */
import { db } from "@workspace/db";
import { weatherMetricsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, int, str } from "./_csv";

export const WEATHER_CSV = resolve(import.meta.dirname, "../../data/weather/pvr-monthly.csv");

export async function ingestWeather(): Promise<{ inserted: number }> {
  const rows = readCsv(WEATHER_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE weather_metrics RESTART IDENTITY`);
    if (rows.length === 0) return { inserted: 0 };
    await tx.insert(weatherMetricsTable).values(rows.map((r) => ({
      year:            int(r.year)!,
      month:           int(r.month)!,
      monthName:       str(r.month_name)!,
      avgTempC:        r.avg_temp_c,
      maxTempC:        r.max_temp_c,
      minTempC:        r.min_temp_c,
      precipitationMm: r.precipitation_mm,
      avgHumidityPct:  r.avg_humidity_pct,
      avgSeaTempC:     r.avg_sea_temp_c,
      sunshineHours:   r.sunshine_hours,
      rainyDays:       int(r.rainy_days),
      source:          str(r.source) ?? "NOAA / CONAGUA",
    })));
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestWeather().then((r) => { console.log("weather:", r); process.exit(0); });
}
