import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { dataSourcesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { GetDataSourcesResponse, SyncDataSourceParams, SyncDataSourceResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/sources", async (req, res) => {
  try {
    const rows = await db.select().from(dataSourcesTable);

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

    await db
      .update(dataSourcesTable)
      .set({ lastSyncedAt: new Date(), status: "active" })
      .where(eq(dataSourcesTable.id, parsed.data.id));

    const data = SyncDataSourceResponse.parse({
      success: true,
      message: `Successfully synced ${source.name}`,
      sourceId: parsed.data.id,
      recordsProcessed: source.recordCount ?? 0,
    });

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to sync data source");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
