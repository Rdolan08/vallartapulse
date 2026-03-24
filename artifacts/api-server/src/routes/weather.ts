import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { weatherMetricsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { GetWeatherMetricsQueryParams, GetWeatherMetricsResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/metrics/weather", async (req, res) => {
  const parsed = GetWeatherMetricsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query parameters" });
    return;
  }

  const { year, month } = parsed.data;

  try {
    const conditions = [];
    if (year) conditions.push(eq(weatherMetricsTable.year, year));
    if (month) conditions.push(eq(weatherMetricsTable.month, month));

    const rows = await db
      .select()
      .from(weatherMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(weatherMetricsTable.year), asc(weatherMetricsTable.month));

    const data = GetWeatherMetricsResponse.parse(
      rows.map((r) => ({
        ...r,
        avgTempC: Number(r.avgTempC),
        maxTempC: r.maxTempC ? Number(r.maxTempC) : undefined,
        minTempC: r.minTempC ? Number(r.minTempC) : undefined,
        precipitationMm: Number(r.precipitationMm),
        avgHumidityPct: r.avgHumidityPct ? Number(r.avgHumidityPct) : undefined,
        avgSeaTempC: r.avgSeaTempC ? Number(r.avgSeaTempC) : undefined,
        sunshineHours: r.sunshineHours ? Number(r.sunshineHours) : undefined,
        createdAt: r.createdAt,
      }))
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch weather metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
