/**
 * Ingest data/safety/sesnsp-incidents.csv → safety_metrics.
 */
import { db } from "@workspace/db";
import { safetyMetricsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, int, str } from "./_csv";

export const SAFETY_CSV = resolve(import.meta.dirname, "../../data/safety/sesnsp-incidents.csv");

export async function ingestSafety(): Promise<{ inserted: number }> {
  const rows = readCsv(SAFETY_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE safety_metrics RESTART IDENTITY CASCADE`);
    if (rows.length === 0) return { inserted: 0 };
    // Chunk inserts at 500 rows to stay well under any parameter-count limit.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK).map((r) => ({
        year:              int(r.year)!,
        month:             int(r.month)!,
        monthName:         str(r.month_name)!,
        category:          str(r.category)!,
        categoryEs:        str(r.category_es),
        categoryGroup:     str(r.category_group),
        categoryRaw:       str(r.category_raw),
        notes:             str(r.notes),
        incidentCount:     int(r.incident_count)!,
        incidentsPer100k:  r.incidents_per_100k,
        changeVsPriorYear: r.change_vs_prior_year,
        source:            str(r.source) ?? "SESNSP (official)",
      }));
      await tx.insert(safetyMetricsTable).values(slice);
    }
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestSafety().then((r) => { console.log("safety:", r); process.exit(0); });
}
