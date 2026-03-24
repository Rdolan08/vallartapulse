import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { economicMetricsTable } from "@workspace/db/schema";
import { eq, asc } from "drizzle-orm";
import { GetEconomicMetricsQueryParams, GetEconomicMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/economic", async (req, res) => {
  const parsed = GetEconomicMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year } = parsed.data;

  try {
    const rows = await db
      .select()
      .from(economicMetricsTable)
      .where(year ? eq(economicMetricsTable.year, year) : undefined)
      .orderBy(asc(economicMetricsTable.year), asc(economicMetricsTable.indicator));

    const data = GetEconomicMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        value: Number(r.value),
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch economic metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
