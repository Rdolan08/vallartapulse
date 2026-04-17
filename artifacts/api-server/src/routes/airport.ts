import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { airportMetricsTable, marketEventsTable } from "@workspace/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { computeAirportEstimate, computePendingEstimates } from "../lib/airport-estimator.js";
import { detectAnomaly, annotateMonths, anomalyKey, type MonthDataPoint } from "../lib/anomaly-engine.js";

const router: IRouter = Router();

// ── Shared helpers ───────────────────────────────────────────────────────────

async function loadAllMonthRows() {
  return db
    .select({
      year:            airportMetricsTable.year,
      month:           airportMetricsTable.month,
      totalPassengers: airportMetricsTable.totalPassengers,
    })
    .from(airportMetricsTable)
    .orderBy(asc(airportMetricsTable.year), asc(airportMetricsTable.month));
}

async function loadActiveEvents() {
  return db
    .select()
    .from(marketEventsTable)
    .where(eq(marketEventsTable.isActive, true))
    .orderBy(asc(marketEventsTable.startDate));
}

// ── GET /api/metrics/airport ────────────────────────────────────────────────
// Returns all official GAP monthly PVR passenger records, annotated with
// anomaly metadata where relevant.
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

    const [rows, events, allRows] = await Promise.all([
      db
        .select()
        .from(airportMetricsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(airportMetricsTable.year), asc(airportMetricsTable.month)),
      loadActiveEvents(),
      loadAllMonthRows(),
    ]);

    // Build full-dataset data points for anomaly context (prior-month checks)
    const allDataPoints: MonthDataPoint[] = allRows.map((r) => {
      const priorYear = allRows.find((p) => p.year === r.year - 1 && p.month === r.month);
      const yoyPct    = priorYear
        ? ((r.totalPassengers - priorYear.totalPassengers) / priorYear.totalPassengers) * 100
        : null;
      return { year: r.year, month: r.month, yoyPct, totalPassengers: r.totalPassengers };
    });

    const anomalyMap = annotateMonths(allDataPoints, events);

    const data = rows.map((r) => {
      const anomaly = anomalyMap.get(anomalyKey(r.year, r.month)) ?? null;
      return {
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
        // Anomaly overlay — null when month is unaffected
        anomaly: anomaly?.detected ? {
          detected:            anomaly.detected,
          type:                anomaly.type,
          severity:            anomaly.severity,
          eventSlug:           anomaly.eventSlug,
          eventTitle:          anomaly.eventTitle,
          statusLabel:         anomaly.statusLabel,
          statusDetail:        anomaly.statusDetail,
          trendClassification: anomaly.trendClassification,
          cautionFlag:         anomaly.cautionFlag,
          recoveryPhase:       anomaly.recoveryPhase,
          airportDemandWeight: anomaly.airportDemandWeight,
          commentary:          anomaly.commentary,
        } : null,
      };
    });

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch airport metrics");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/metrics/airport/estimate ───────────────────────────────────────
router.get("/metrics/airport/estimate", async (req, res) => {
  try {
    const [rows, events] = await Promise.all([
      loadAllMonthRows(),
      loadActiveEvents(),
    ]);
    const estimate = computeAirportEstimate(rows, undefined, events);
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

// ── GET /api/metrics/airport/estimates ──────────────────────────────────────
// Returns all months in the current year that lack an official GAP total,
// with anomaly metadata attached where applicable.
router.get("/metrics/airport/estimates", async (req, res) => {
  try {
    const [rows, events] = await Promise.all([
      loadAllMonthRows(),
      loadActiveEvents(),
    ]);
    const estimates = computePendingEstimates(rows, undefined, events);
    res.json(estimates);
  } catch (err) {
    req.log.error({ err }, "Failed to compute pending airport estimates");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/metrics/market-events ──────────────────────────────────────────
// Returns all active market events.  Supports optional ?category= filter.
router.get("/metrics/market-events", async (req, res) => {
  try {
    const events = await loadActiveEvents();
    // Optionally filter by category
    const category = req.query.category as string | undefined;
    const filtered = category
      ? events.filter((e) => e.category === category)
      : events;
    res.json(filtered);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch market events");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
