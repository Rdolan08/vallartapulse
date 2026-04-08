import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { tourismMetricsTable, rentalMarketMetricsTable, safetyMetricsTable, weatherMetricsTable } from "@workspace/db/schema";
import { desc, eq, and, sql } from "drizzle-orm";
import { GetDashboardSummaryResponse, GetDashboardSummaryQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/summary", async (req, res) => {
  try {
    const parsed = GetDashboardSummaryQueryParams.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query parameters" });
      return;
    }
    const { year: filterYear, month: filterMonth } = parsed.data;

    // Build tourism query — if year+month supplied, use them; otherwise latest
    const tourismQuery = db
      .select()
      .from(tourismMetricsTable)
      .orderBy(desc(tourismMetricsTable.year), desc(tourismMetricsTable.month))
      .limit(1);

    const [latestTourism] = filterYear && filterMonth
      ? await db
          .select()
          .from(tourismMetricsTable)
          .where(
            and(
              eq(tourismMetricsTable.year, filterYear),
              eq(tourismMetricsTable.month, filterMonth)
            )
          )
          .limit(1)
      : filterYear
      ? await db
          .select()
          .from(tourismMetricsTable)
          .where(eq(tourismMetricsTable.year, filterYear))
          .orderBy(desc(tourismMetricsTable.month))
          .limit(1)
      : await tourismQuery;

    const prevYear = (latestTourism?.year ?? new Date().getFullYear()) - 1;
    const prevMonth = latestTourism?.month ?? new Date().getMonth() + 1;

    const [prevYearTourism] = latestTourism
      ? await db
          .select()
          .from(tourismMetricsTable)
          .where(
            and(
              eq(tourismMetricsTable.year, prevYear),
              eq(tourismMetricsTable.month, prevMonth)
            )
          )
          .limit(1)
      : [null];

    // Rental query
    const rentalBase = db
      .select({
        avgNightlyRateUsd: sql<number>`avg(${rentalMarketMetricsTable.avgNightlyRateUsd})`,
        totalListings: sql<number>`sum(${rentalMarketMetricsTable.activeListings})`,
        avgOccupancy: sql<number>`avg(${rentalMarketMetricsTable.occupancyRate})`,
        year: rentalMarketMetricsTable.year,
        month: rentalMarketMetricsTable.month,
      })
      .from(rentalMarketMetricsTable)
      .groupBy(rentalMarketMetricsTable.year, rentalMarketMetricsTable.month);

    const [latestRental] = filterYear && filterMonth
      ? await db
          .select({
            avgNightlyRateUsd: sql<number>`avg(${rentalMarketMetricsTable.avgNightlyRateUsd})`,
            totalListings: sql<number>`sum(${rentalMarketMetricsTable.activeListings})`,
            avgOccupancy: sql<number>`avg(${rentalMarketMetricsTable.occupancyRate})`,
            year: rentalMarketMetricsTable.year,
            month: rentalMarketMetricsTable.month,
          })
          .from(rentalMarketMetricsTable)
          .where(
            and(
              eq(rentalMarketMetricsTable.year, filterYear),
              eq(rentalMarketMetricsTable.month, filterMonth)
            )
          )
          .groupBy(rentalMarketMetricsTable.year, rentalMarketMetricsTable.month)
          .limit(1)
      : filterYear
      ? await rentalBase
          .where(eq(rentalMarketMetricsTable.year, filterYear))
          .orderBy(desc(rentalMarketMetricsTable.month))
          .limit(1)
      : await rentalBase
          .orderBy(desc(rentalMarketMetricsTable.year), desc(rentalMarketMetricsTable.month))
          .limit(1);

    const [prevRental] = latestRental
      ? await db
          .select({
            avgNightlyRateUsd: sql<number>`avg(${rentalMarketMetricsTable.avgNightlyRateUsd})`,
            totalListings: sql<number>`sum(${rentalMarketMetricsTable.activeListings})`,
          })
          .from(rentalMarketMetricsTable)
          .where(
            and(
              eq(rentalMarketMetricsTable.year, (latestRental.year ?? 2025) - 1),
              eq(rentalMarketMetricsTable.month, latestRental.month ?? 1)
            )
          )
          .groupBy(rentalMarketMetricsTable.year, rentalMarketMetricsTable.month)
          .limit(1)
      : [null];

    // Safety query
    const safetyBase = db
      .select({
        totalIncidents: sql<number>`sum(${safetyMetricsTable.incidentCount})`,
        avgPer100k: sql<number>`avg(${safetyMetricsTable.incidentsPer100k})`,
        year: safetyMetricsTable.year,
        month: safetyMetricsTable.month,
      })
      .from(safetyMetricsTable)
      .groupBy(safetyMetricsTable.year, safetyMetricsTable.month);

    const [latestSafety] = filterYear && filterMonth
      ? await db
          .select({
            totalIncidents: sql<number>`sum(${safetyMetricsTable.incidentCount})`,
            avgPer100k: sql<number>`avg(${safetyMetricsTable.incidentsPer100k})`,
            year: safetyMetricsTable.year,
            month: safetyMetricsTable.month,
          })
          .from(safetyMetricsTable)
          .where(
            and(
              eq(safetyMetricsTable.year, filterYear),
              eq(safetyMetricsTable.month, filterMonth)
            )
          )
          .groupBy(safetyMetricsTable.year, safetyMetricsTable.month)
          .limit(1)
      : filterYear
      ? await safetyBase
          .where(eq(safetyMetricsTable.year, filterYear))
          .orderBy(desc(safetyMetricsTable.month))
          .limit(1)
      : await safetyBase
          .orderBy(desc(safetyMetricsTable.year), desc(safetyMetricsTable.month))
          .limit(1);

    // Previous year safety (for crime change calculation)
    const [prevYearSafety] = latestSafety
      ? await db
          .select({
            totalIncidents: sql<number>`sum(${safetyMetricsTable.incidentCount})`,
            avgPer100k: sql<number>`avg(${safetyMetricsTable.incidentsPer100k})`,
            year: safetyMetricsTable.year,
            month: safetyMetricsTable.month,
          })
          .from(safetyMetricsTable)
          .where(
            and(
              eq(safetyMetricsTable.year, (latestSafety.year ?? 2025) - 1),
              eq(safetyMetricsTable.month, latestSafety.month ?? 1)
            )
          )
          .groupBy(safetyMetricsTable.year, safetyMetricsTable.month)
          .limit(1)
      : [null];

    // Weather query
    const weatherBase = db
      .select()
      .from(weatherMetricsTable)
      .orderBy(desc(weatherMetricsTable.year), desc(weatherMetricsTable.month));

    const [latestWeather] = filterYear && filterMonth
      ? await db
          .select()
          .from(weatherMetricsTable)
          .where(
            and(
              eq(weatherMetricsTable.year, filterYear),
              eq(weatherMetricsTable.month, filterMonth)
            )
          )
          .limit(1)
      : filterYear
      ? await db
          .select()
          .from(weatherMetricsTable)
          .where(eq(weatherMetricsTable.year, filterYear))
          .orderBy(desc(weatherMetricsTable.month))
          .limit(1)
      : await weatherBase.limit(1);

    const round2 = (n: number) => Math.round(n * 100) / 100;

    const hotelOccupancy = latestTourism ? Number(latestTourism.hotelOccupancyRate) : 72.5;
    const prevOccupancy = prevYearTourism ? Number(prevYearTourism.hotelOccupancyRate) : 68.2;

    const avgNightlyRate = latestRental ? Number(latestRental.avgNightlyRateUsd) : 145.0;
    const prevRate = prevRental ? Number(prevRental.avgNightlyRateUsd) : 132.0;

    const activeListings = latestRental ? Number(latestRental.totalListings) : 4850;
    const prevListings = prevRental ? Number(prevRental.totalListings) : 4400;

    const touristArrivals = latestTourism ? (latestTourism.totalArrivals ?? 0) : 125000;
    const prevArrivals = prevYearTourism ? (prevYearTourism.totalArrivals ?? 0) : 110000;

    const cruiseVisitors = latestTourism ? (latestTourism.cruiseVisitors ?? 0) : 18000;

    const crimeIndex = latestSafety ? Number(latestSafety.avgPer100k) : 42.3;
    const prevCrimeIndex = prevYearSafety ? Number(prevYearSafety.avgPer100k) : null;
    const crimeIndexChange = prevCrimeIndex && prevCrimeIndex > 0
      ? round2(((crimeIndex - prevCrimeIndex) / prevCrimeIndex) * 100)
      : 0;

    const avgTemp = latestWeather ? Number(latestWeather.avgTempC) : 28.5;

    const data = GetDashboardSummaryResponse.parse({
      hotelOccupancyRate: round2(hotelOccupancy),
      hotelOccupancyChange: round2(hotelOccupancy - prevOccupancy),
      avgNightlyRate: round2(avgNightlyRate),
      avgNightlyRateChange: round2(avgNightlyRate - prevRate),
      activeListings: activeListings,
      activeListingsChange: round2(((activeListings - prevListings) / Math.max(prevListings, 1)) * 100),
      touristArrivals: touristArrivals,
      touristArrivalsChange: round2(((touristArrivals - prevArrivals) / Math.max(prevArrivals, 1)) * 100),
      cruiseVisitors: cruiseVisitors,
      crimeIndex: round2(crimeIndex),
      crimeIndexChange: crimeIndexChange,
      avgTemperatureC: round2(avgTemp),
      lastUpdated: new Date(),
    });

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch dashboard summary");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
