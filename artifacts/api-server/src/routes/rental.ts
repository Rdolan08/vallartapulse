import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { rentalMarketMetricsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { GetRentalMarketMetricsQueryParams, GetRentalMarketMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/rental-market", async (req, res) => {
  const parsed = GetRentalMarketMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year, month, neighborhood } = parsed.data;

  try {
    const conditions = [];
    if (year) conditions.push(eq(rentalMarketMetricsTable.year, year));
    if (month) conditions.push(eq(rentalMarketMetricsTable.month, month));
    if (neighborhood) conditions.push(eq(rentalMarketMetricsTable.neighborhood, neighborhood));

    const rows = await db
      .select()
      .from(rentalMarketMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(rentalMarketMetricsTable.year), asc(rentalMarketMetricsTable.month));

    const data = GetRentalMarketMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        avgNightlyRateUsd: Number(r.avgNightlyRateUsd),
        medianNightlyRateUsd: r.medianNightlyRateUsd ? Number(r.medianNightlyRateUsd) : undefined,
        occupancyRate: Number(r.occupancyRate),
        avgReviewScore: r.avgReviewScore ? Number(r.avgReviewScore) : undefined,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch rental market metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
