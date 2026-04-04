import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tourismMetricsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { GetTourismMetricsQueryParams, GetTourismMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/tourism", async (req, res) => {
  const parsed = GetTourismMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year, month } = parsed.data;

  try {
    const conditions = [];
    if (year) conditions.push(eq(tourismMetricsTable.year, year));
    if (month) conditions.push(eq(tourismMetricsTable.month, month));

    const rows = await db
      .select()
      .from(tourismMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(tourismMetricsTable.year), asc(tourismMetricsTable.month));

    const data = GetTourismMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        hotelOccupancyRate: Number(r.hotelOccupancyRate),
        avgHotelRateUsd: r.avgHotelRateUsd != null ? Number(r.avgHotelRateUsd) : null,
        revenuePerAvailableRoomUsd: r.revenuePerAvailableRoomUsd != null ? Number(r.revenuePerAvailableRoomUsd) : null,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch tourism metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
