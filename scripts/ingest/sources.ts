/**
 * Ingest data/sources/data-sources-registry.csv → data_sources.
 * record_count is re-derived from the underlying metric tables so the
 * registry never goes stale.
 */
import { db } from "@workspace/db";
import { dataSourcesTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, str, bool } from "./_csv";

export const SOURCES_CSV = resolve(import.meta.dirname, "../../data/sources/data-sources-registry.csv");

/** Maps data_sources.name → SQL returning the live row count for its table. */
const RECORD_COUNT_QUERIES: Record<string, ReturnType<typeof sql>> = {
  "GAP – Airport Traffic (PVR)":       sql`SELECT COUNT(*)::int AS n FROM airport_metrics`,
  "DATATUR – Tourism Statistics":      sql`SELECT COUNT(*)::int AS n FROM tourism_metrics`,
  "SESNSP – Crime Data":               sql`SELECT COUNT(*)::int AS n FROM safety_metrics`,
  "INEGI – Census & Demographics":     sql`SELECT COUNT(*)::int AS n FROM economic_metrics WHERE indicator IN ('population','imss_formal_workers')`,
  "Data México – Economic Indicators": sql`SELECT COUNT(*)::int AS n FROM economic_metrics WHERE indicator NOT IN ('population','imss_formal_workers')`,
  "NOAA – Climate & Ocean Data":       sql`SELECT COUNT(*)::int AS n FROM weather_metrics`,
};

export async function ingestSources(): Promise<{ inserted: number }> {
  const rows = readCsv(SOURCES_CSV);
  if (rows.length === 0) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`TRUNCATE TABLE data_sources RESTART IDENTITY`);
    });
    return { inserted: 0 };
  }

  // Compute record counts OUTSIDE the truncate tx so we read committed data
  // from the metric tables (which the previous ingestors already populated).
  const now = new Date();
  const enriched = await Promise.all(rows.map(async (r) => {
    const name = str(r.name)!;
    let recordCount: number | null = null;
    const q = RECORD_COUNT_QUERIES[name];
    if (q) {
      const result = await db.execute(q) as unknown as
        { rows?: { n: number }[] } & { n?: number }[];
      recordCount = Number(result.rows?.[0]?.n ?? (result as unknown as { n: number }[])[0]?.n ?? 0);
    }
    return {
      name,
      nameEs:        str(r.name_es),
      category:      str(r.category)!,
      description:   str(r.description),
      descriptionEs: str(r.description_es),
      url:           str(r.url),
      status:        str(r.status) ?? "active",
      lastSyncedAt:  now,
      recordCount,
      frequency:     str(r.frequency) ?? "monthly",
      isPublic:      bool(r.is_public),
    };
  }));

  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE data_sources RESTART IDENTITY`);
    await tx.insert(dataSourcesTable).values(enriched);
    return { inserted: enriched.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestSources().then((r) => { console.log("sources:", r); process.exit(0); });
}
