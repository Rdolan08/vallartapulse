/**
 * source-sync.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared logic for syncing the data_sources table.
 * Used by:
 *   - POST /api/sources/:id/sync     (individual sync)
 *   - POST /api/sources/sync-all     (bulk sync)
 *   - daily-sync.ts cron job         (scheduled 8 AM Eastern)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@workspace/db";
import {
  dataSourcesTable,
  tourismMetricsTable,
  economicMetricsTable,
  rentalListingsTable,
  weatherMetricsTable,
} from "@workspace/db/schema";
import { eq, count } from "drizzle-orm";
import { logger } from "./logger.js";

export interface SourceSyncResult {
  id: number;
  name: string;
  records: number;
  recount: boolean;
}

export interface SyncAllResult {
  success: boolean;
  syncedAt: string;
  totalSources: number;
  results: SourceSyncResult[];
}

// ── Per-source live DB recount ────────────────────────────────────────────────
// Returns the live record count for sources backed by a real DB table.
// Returns null for external/government sources with no dedicated table.

export async function recountFromDB(sourceName: string): Promise<number | null> {
  const n = sourceName.toLowerCase();
  if (n.includes("airbnb") || n.includes("vrbo") || n.includes("rental")) {
    const [row] = await db.select({ c: count() }).from(rentalListingsTable);
    return row?.c ?? null;
  }
  if (n.includes("datatur") || n.includes("tourism")) {
    const [row] = await db.select({ c: count() }).from(tourismMetricsTable);
    return row?.c ?? null;
  }
  if (n.includes("data méxico") || n.includes("data mexico") || n.includes("economic")) {
    const [row] = await db.select({ c: count() }).from(economicMetricsTable);
    return row?.c ?? null;
  }
  if (n.includes("noaa") || n.includes("climate") || n.includes("weather")) {
    const [row] = await db.select({ c: count() }).from(weatherMetricsTable);
    return row?.c ?? null;
  }
  // External sources (SESNSP, INEGI, Transparencia, OSM, NASA, Inmuebles24):
  // no dedicated table — timestamp refresh only.
  return null;
}

// ── Sync a single source by ID ────────────────────────────────────────────────

export async function syncSourceById(id: number): Promise<{
  success: boolean;
  message: string;
  sourceId: number;
  recordsProcessed: number;
} | null> {
  const [source] = await db
    .select()
    .from(dataSourcesTable)
    .where(eq(dataSourcesTable.id, id))
    .limit(1);

  if (!source) return null;

  const liveCount = await recountFromDB(source.name);
  const newCount = liveCount !== null ? liveCount : (source.recordCount ?? 0);

  await db
    .update(dataSourcesTable)
    .set({ lastSyncedAt: new Date(), status: "active", recordCount: newCount })
    .where(eq(dataSourcesTable.id, id));

  return {
    success: true,
    message: liveCount !== null
      ? `${source.name} synced — ${newCount.toLocaleString()} records counted from live database`
      : `${source.name} synced — timestamp refreshed (external source; records unchanged)`,
    sourceId: id,
    recordsProcessed: newCount,
  };
}

// ── Sync all sources ──────────────────────────────────────────────────────────

export async function syncAllSources(): Promise<SyncAllResult> {
  const sources = await db.select().from(dataSourcesTable).orderBy(dataSourcesTable.id);
  const now = new Date();
  const results: SourceSyncResult[] = [];

  for (const source of sources) {
    const liveCount = await recountFromDB(source.name);
    const newCount = liveCount !== null ? liveCount : (source.recordCount ?? 0);

    await db
      .update(dataSourcesTable)
      .set({ lastSyncedAt: now, status: "active", recordCount: newCount })
      .where(eq(dataSourcesTable.id, source.id));

    results.push({ id: source.id, name: source.name, records: newCount, recount: liveCount !== null });
  }

  logger.info({ count: sources.length, syncedAt: now.toISOString() }, "sync-all complete");

  return {
    success: true,
    syncedAt: now.toISOString(),
    totalSources: sources.length,
    results,
  };
}
