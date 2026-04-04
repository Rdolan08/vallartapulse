import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { airportMetricsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { computeAirportEstimate } from "../lib/airport-estimator.js";

const router: IRouter = Router();

// ── GET /api/metrics/airport ────────────────────────────────────────────────
// Returns all official GAP monthly PVR passenger records.
// Supports optional ?year= and ?month= filters.
router.get("/metrics/airport", async (req, res) => {
  const year  = req.query.year  ? Number(req.query.year)  : undefined;
  const month = req.query.month ? Number(req.query.month) : undefined;

  if (year !== undefined && (isNaN(year) || year < 2000 || year > 2100)) {
    res.status(400).json({ error: "Invalid year" });
    return;
  }

  try {
    const conditions = [];
    if (year)  conditions.push(eq(airportMetricsTable.year,  year));
    if (month) conditions.push(eq(airportMetricsTable.month, month));

    const rows = await db
      .select()
      .from(airportMetricsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(airportMetricsTable.year), asc(airportMetricsTable.month));

    const data = rows.map((r) => ({
      id:                      r.id,
      year:                    r.year,
      month:                   r.month,
      monthName:               r.monthName,
      totalPassengers:         r.totalPassengers,
      domesticPassengers:      r.domesticPassengers      ?? null,
      internationalPassengers: r.internationalPassengers ?? null,
      avgDailyPassengers:      r.avgDailyPassengers ? Number(r.avgDailyPassengers) : null,
      daysInMonth:             r.daysInMonth             ?? null,
      source:                  r.source,
      sourceUrl:               r.sourceUrl               ?? null,
    }));

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch airport metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/metrics/airport/estimate ───────────────────────────────────────
// Returns a lightweight current-month passenger estimate derived from the
// official GAP monthly totals already stored in airport_metrics.
//
// No new data sources, no paid APIs — purely computed from what GAP has published.
// See lib/airport-estimator.ts for tuning instructions (seasonality, weights,
// confidence thresholds).
router.get("/metrics/airport/estimate", async (req, res) => {
  try {
    // Load all official monthly rows — the estimator needs the full history
    const rows = await db
      .select({
        year:            airportMetricsTable.year,
        month:           airportMetricsTable.month,
        totalPassengers: airportMetricsTable.totalPassengers,
      })
      .from(airportMetricsTable)
      .orderBy(asc(airportMetricsTable.year), asc(airportMetricsTable.month));

    const estimate = computeAirportEstimate(rows);

    if (!estimate) {
      res.status(503).json({ error: "Insufficient historical data to compute estimate" });
      return;
    }

    res.json(estimate);
  } catch (err) {
    req.log.error({ err }, "Failed to compute airport estimate");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
