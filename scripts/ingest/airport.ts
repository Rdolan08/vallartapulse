/**
 * Ingest data/airport/pvr-passenger-traffic.csv → airport_metrics.
 * Idempotent, transactional: TRUNCATE + bulk INSERT wrapped in a single tx
 * so the table is never left empty on failure.
 */
import { db } from "@workspace/db";
import { airportMetricsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, int, str } from "./_csv";

export const AIRPORT_CSV = resolve(import.meta.dirname, "../../data/airport/pvr-passenger-traffic.csv");

export async function ingestAirport(): Promise<{ inserted: number }> {
  const rows = readCsv(AIRPORT_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE airport_metrics RESTART IDENTITY`);
    if (rows.length === 0) return { inserted: 0 };
    await tx.insert(airportMetricsTable).values(rows.map((r) => ({
      year:                    int(r.year)!,
      month:                   int(r.month)!,
      monthName:               str(r.month_name)!,
      totalPassengers:         int(r.total_passengers)!,
      domesticPassengers:      int(r.domestic_passengers),
      internationalPassengers: int(r.international_passengers),
      avgDailyPassengers:      r.avg_daily_passengers,
      daysInMonth:             int(r.days_in_month),
      sourceUrl:               str(r.source_url) ?? undefined,
      source:                  str(r.source) ?? "GAP (Grupo Aeroportuario del Pacífico)",
    })));
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestAirport().then((r) => { console.log("airport:", r); process.exit(0); });
}
