import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { safetyMetricsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { GetSafetyMetricsQueryParams, GetSafetyMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/safety", async (req, res) => {
  const parsed = GetSafetyMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year, category } = parsed.data;

  try {
    const conditions = [];
    if (year) conditions.push(eq(safetyMetricsTable.year, year));
    if (category) conditions.push(eq(safetyMetricsTable.category, category));

    const rows = await db
      .select()
      .from(safetyMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(safetyMetricsTable.year), asc(safetyMetricsTable.month), asc(safetyMetricsTable.category));

    const data = GetSafetyMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        incidentsPer100k: r.incidentsPer100k ? Number(r.incidentsPer100k) : undefined,
        changeVsPriorYear: r.changeVsPriorYear ? Number(r.changeVsPriorYear) : undefined,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch safety metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
