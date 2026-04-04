import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dataSourcesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { GetDataSourcesResponse, SyncDataSourceParams, SyncDataSourceResponse } from "@workspace/api-zod";
import { syncSourceById, syncAllSources } from "../lib/source-sync.js";
import { syncGAPData } from "../lib/gap-scraper.js";

const router: IRouter = Router();

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

// ── POST /api/sources/sync-all ────────────────────────────────────────────────
// Must be registered BEFORE /:id/sync so Express doesn't treat "sync-all" as an id.

router.post("/sources/sync-all", async (req, res) => {
  try {
    const result = await syncAllSources();
    req.log.info({ totalSources: result.totalSources }, "Manual sync-all triggered");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to sync all sources");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/sources/:id/sync ────────────────────────────────────────────────

router.post("/sources/:id/sync", async (req, res) => {
  const parsed = SyncDataSourceParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid source ID" });
    return;
  }

  try {
    const result = await syncSourceById(parsed.data.id);

    if (!result) {
      res.status(404).json({ error: "Data source not found" });
      return;
    }

    const data = SyncDataSourceResponse.parse(result);
    req.log.info({ sourceId: parsed.data.id, records: result.recordsProcessed }, "Source synced");
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to sync data source");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/sources/sync-gap ────────────────────────────────────────────────
// Manually trigger the GAP GlobeNewswire scraper to refresh airport_metrics.

router.post("/sources/sync-gap", async (req, res) => {
  try {
    req.log.info("Manual GAP sync triggered");
    const result = await syncGAPData();
    res.json({ success: true, ...result });
  } catch (err) {
    req.log.error({ err }, "GAP sync failed");
    res.status(500).json({ error: "GAP sync failed", detail: String(err) });
  }
});

// ── GET /api/sources/schedule ─────────────────────────────────────────────────
// Returns metadata about the daily automatic sync schedule.

router.get("/sources/schedule", (_req, res) => {
  const timezone = "America/New_York";
  const now = new Date();
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false }).format(now),
    10
  );
  const daysAhead = etHour >= 8 ? 1 : 0;
  const nextRun = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const nextRunEastern = nextRun.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  }) + " at 8:00 AM Eastern";

  res.json({
    schedule: "0 8 * * *",
    timezone,
    description: "All data sources sync automatically every day at 8:00 AM Eastern (EST/EDT).",
    nextRunEastern,
    manualTrigger: "POST /api/sources/sync-all",
  });
});

export default router;
