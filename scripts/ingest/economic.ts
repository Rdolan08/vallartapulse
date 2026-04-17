/**
 * Ingest data/economic/inegi-imss-indicators.csv → economic_metrics.
 */
import { db } from "@workspace/db";
import { economicMetricsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, int, str } from "./_csv";

export const ECONOMIC_CSV = resolve(import.meta.dirname, "../../data/economic/inegi-imss-indicators.csv");

export async function ingestEconomic(): Promise<{ inserted: number }> {
  const rows = readCsv(ECONOMIC_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE economic_metrics RESTART IDENTITY`);
    if (rows.length === 0) return { inserted: 0 };
    await tx.insert(economicMetricsTable).values(rows.map((r) => ({
      year:          int(r.year)!,
      quarter:       int(r.quarter),
      indicator:     str(r.indicator)!,
      value:         r.value,
      unit:          str(r.unit)!,
      description:   str(r.description),
      descriptionEs: str(r.description_es),
      source:        str(r.source)!,
    })));
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestEconomic().then((r) => { console.log("economic:", r); process.exit(0); });
}
