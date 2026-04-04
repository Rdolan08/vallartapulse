import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  dataSourcesTable,
  tourismMetricsTable,
  economicMetricsTable,
  rentalListingsTable,
  weatherMetricsTable,
} from "@workspace/db/schema";
import { eq, count } from "drizzle-orm";
import { GetDataSourcesResponse, SyncDataSourceParams, SyncDataSourceResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// ── Source → live DB recount mapping ─────────────────────────────────────────
// For sources backed by real DB tables, we recount on sync.
// For external/government sources with no dedicated table, we refresh the
// timestamp only — they require manual CSV upload or scraper pipeline.

async function recountFromDB(sourceName: string): Promise<number | null> {
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
  // SESNSP, INEGI, Transparencia, OSM, NASA, Inmuebles24 — no dedicated table;
  // return null to leave current recordCount unchanged
  return null;
}

// ── GET /api/sources ──────────────────────────────────────────────────────────

router.get("/sources", async (req, res) => {
  try {
    const rows = await db.select().from(dataSourcesTable).orderBy(dataSourcesTable.id);

    const data = GetDataSourcesResponse.parse(
      rows.map((r) => ({
        ...r,
        lastSyncedAt: r.lastSyncedAt ?? undefined,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch data sources");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/sources/:id/sync ────────────────────────────────────────────────
// Syncs a single data source:
//   • Sources backed by live DB tables → recount and update recordCount
//   • External/government sources → refresh lastSyncedAt only; records unchanged
//   • Any source → set status = "active"

router.post("/sources/:id/sync", async (req, res) => {
  const parsed = SyncDataSourceParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid source ID" });
    return;
  }

  try {
    const [source] = await db
      .select()
      .from(dataSourcesTable)
      .where(eq(dataSourcesTable.id, parsed.data.id))
      .limit(1);

    if (!source) {
      res.status(404).json({ error: "Data source not found" });
      return;
    }

    const liveCount = await recountFromDB(source.name);
    const newCount = liveCount !== null ? liveCount : (source.recordCount ?? 0);

    await db
      .update(dataSourcesTable)
      .set({ lastSyncedAt: new Date(), status: "active", recordCount: newCount })
      .where(eq(dataSourcesTable.id, parsed.data.id));

    const isLiveRecount = liveCount !== null;
    const data = SyncDataSourceResponse.parse({
      success: true,
      message: isLiveRecount
        ? `${source.name} synced — ${newCount.toLocaleString()} records counted from live database`
        : `${source.name} synced — timestamp refreshed (external source; records unchanged)`,
      sourceId: parsed.data.id,
      recordsProcessed: newCount,
    });

    req.log.info({ sourceId: parsed.data.id, name: source.name, newCount, isLiveRecount }, "Source synced");
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to sync data source");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/sources/sync-all ────────────────────────────────────────────────
// Syncs all sources at once — useful for daily scheduled refresh.

router.post("/sources/sync-all", async (req, res) => {
  try {
    const sources = await db.select().from(dataSourcesTable).orderBy(dataSourcesTable.id);
    const now = new Date();
    const results: { id: number; name: string; records: number; recount: boolean }[] = [];

    for (const source of sources) {
      const liveCount = await recountFromDB(source.name);
      const newCount = liveCount !== null ? liveCount : (source.recordCount ?? 0);

      await db
        .update(dataSourcesTable)
        .set({ lastSyncedAt: now, status: "active", recordCount: newCount })
        .where(eq(dataSourcesTable.id, source.id));

      results.push({ id: source.id, name: source.name, records: newCount, recount: liveCount !== null });
    }

    req.log.info({ count: sources.length }, "All sources synced");
    res.json({
      success: true,
      syncedAt: now.toISOString(),
      totalSources: sources.length,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to sync all sources");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
