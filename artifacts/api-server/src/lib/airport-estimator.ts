import {
  detectAnomaly,
  DEFAULT_ANOMALY_CONFIG,
  type AnomalyResult,
  type MonthDataPoint,
} from "./anomaly-engine.js";
import type { MarketEvent } from "@workspace/db/schema";

/**
 * airport-estimator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces directional estimates of PVR airport passengers for any month that
 * lacks an official GAP press release.  Returns all pending months at once so
 * the frontend can show one card per unconfirmed month.
 *
 * Philosophy: intentionally lightweight — directional numbers, not forecasts.
 * Two simple methods are blended 50/50, then lightly adjusted for seasonality.
 *
 * HOW TO TUNE LATER
 * ─────────────────
 * • SEASONALITY — edit the SEASONALITY constant below. Values > 1 = busier
 *   than a neutral month, < 1 = slower. Effect is capped at ±MAX_SEASON_SWING.
 * • BLEND WEIGHTS — change WEIGHT_PRIOR_MONTH / WEIGHT_YOY (must sum to 1).
 * • CONFIDENCE THRESHOLDS — edit CONF_LOW_MAX / CONF_MED_MAX (days elapsed).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Seasonality index (month number → relative traffic factor) ────────────────
const SEASONALITY: Record<number, number> = {
  1:  1.08,  // January  – peak winter season
  2:  1.05,  // February – still high
  3:  1.10,  // March    – spring break / Easter
  4:  1.02,  // April    – shoulder (post-Easter)
  5:  0.96,  // May      – low shoulder
  6:  0.90,  // June     – summer slow
  7:  0.88,  // July     – slow summer
  8:  0.89,  // August   – slow summer
  9:  0.87,  // September – lowest month
  10: 0.95,  // October  – shoulder recovery
  11: 1.00,  // November – neutral
  12: 1.15,  // December – holiday peak
};

const MAX_SEASON_SWING  = 0.15; // ±15% max seasonality effect
const WEIGHT_PRIOR_MONTH = 0.5;
const WEIGHT_YOY         = 0.5;
const CONF_LOW_MAX       = 7;   // days ≤ 7  → low confidence
const CONF_MED_MAX       = 20;  // days ≤ 20 → medium confidence

// ── Types ─────────────────────────────────────────────────────────────────────

export type EstimateStatus     = "estimated" | "official";
export type EstimateConfidence = "low" | "medium" | "high";

export interface AirportEstimate {
  airportCode: "PVR";
  month: number;
  year: number;
  daysElapsed: number;
  daysInMonth: number;

  /** Null while the month is open / unconfirmed. */
  officialPassengers: number | null;

  estimatedPassengersToDate: number;
  projectedFullMonthPassengers: number;
  averageDailyPassengersToDate: number;
  sameMonthLastYearPassengers: number | null;
  estimatedVsSameMonthLastYearPct: number | null;
  estimateGapVsLastOfficialMonthPct: number | null;

  confidence: EstimateConfidence;
  status: EstimateStatus;

  /** True when the calendar month is fully elapsed but official data not yet published. */
  monthComplete: boolean;

  lastUpdated: string; // ISO timestamp

  /** Anomaly detection result — null when no events loaded or not anomalous. */
  anomaly: AnomalyResult | null;
}

export interface MonthRow {
  year: number;
  month: number;
  totalPassengers: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Puerto Vallarta is UTC-6 year-round (Mexico abolished DST for Jalisco in 2023). */
function getNowPuertovallarta(): Date {
  return new Date(Date.now() + -6 * 60 * 60 * 1000);
}

function daysInMonthFn(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function applySeasonality(base: number, month: number): number {
  const raw    = SEASONALITY[month] ?? 1.0;
  const factor = Math.min(1.0 + MAX_SEASON_SWING, Math.max(1.0 - MAX_SEASON_SWING, raw));
  return Math.round(base * factor);
}

function getConfidence(daysElapsed: number, daysInMonth: number): EstimateConfidence {
  // A completed month always gets "high" — the method A+B blend is fully baked.
  if (daysElapsed >= daysInMonth) return "high";
  if (daysElapsed <= CONF_LOW_MAX)  return "low";
  if (daysElapsed <= CONF_MED_MAX)  return "medium";
  return "high";
}

// ── Core estimator for a single target month ──────────────────────────────────

function estimateMonth(
  allMonths: MonthRow[],
  targetYear: number,
  targetMonth: number,
  daysElapsed: number,    // how many days of the month have elapsed (use daysInMonth for complete months)
): AirportEstimate | null {
  const totalDays = daysInMonthFn(targetYear, targetMonth);

  // Official data already published?
  const officialRow = allMonths.find(
    (r) => r.year === targetYear && r.month === targetMonth,
  );

  const sameLastYearRow = allMonths.find(
    (r) => r.year === targetYear - 1 && r.month === targetMonth,
  );

  if (officialRow) {
    const yoyPct = sameLastYearRow
      ? ((officialRow.totalPassengers - sameLastYearRow.totalPassengers) /
          sameLastYearRow.totalPassengers) * 100
      : null;
    return {
      airportCode: "PVR",
      month: targetMonth,
      year: targetYear,
      daysElapsed: totalDays,
      daysInMonth: totalDays,
      officialPassengers: officialRow.totalPassengers,
      estimatedPassengersToDate: officialRow.totalPassengers,
      projectedFullMonthPassengers: officialRow.totalPassengers,
      averageDailyPassengersToDate: Math.round(officialRow.totalPassengers / totalDays),
      sameMonthLastYearPassengers: sameLastYearRow?.totalPassengers ?? null,
      estimatedVsSameMonthLastYearPct: yoyPct,
      estimateGapVsLastOfficialMonthPct: null,
      confidence: "high",
      status: "official",
      monthComplete: true,
      lastUpdated: new Date().toISOString(),
      anomaly: null, // attached by caller after anomaly detection
    };
  }

  // ── Estimation path ────────────────────────────────────────────────────────

  // All months strictly before the target
  const sortedPrior = allMonths
    .filter((r) =>
      r.year < targetYear ||
      (r.year === targetYear && r.month < targetMonth),
    )
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

  const priorRow = sortedPrior[sortedPrior.length - 1] ?? null;

  if (!priorRow && !sameLastYearRow) return null; // no usable data

  // Method A: prior-month daily run-rate scaled to daysElapsed
  let runRateEstimate: number | null = null;
  if (priorRow) {
    const priorDays = daysInMonthFn(priorRow.year, priorRow.month);
    runRateEstimate  = (priorRow.totalPassengers / priorDays) * daysElapsed;
  }

  // Method B: same month last year, scaled to daysElapsed
  let yoyPacedEstimate: number | null = null;
  if (sameLastYearRow) {
    const lastYearDays = daysInMonthFn(targetYear - 1, targetMonth);
    yoyPacedEstimate   = (sameLastYearRow.totalPassengers / lastYearDays) * daysElapsed;
  }

  // Blend
  let elapsedEstimate: number;
  if (runRateEstimate !== null && yoyPacedEstimate !== null) {
    elapsedEstimate = WEIGHT_PRIOR_MONTH * runRateEstimate + WEIGHT_YOY * yoyPacedEstimate;
  } else {
    elapsedEstimate = (runRateEstimate ?? yoyPacedEstimate)!;
  }

  // Project to full month and apply seasonality
  const paceRatio          = daysElapsed / totalDays;
  const rawProjected       = elapsedEstimate / paceRatio;
  const projectedFullMonth = applySeasonality(rawProjected, targetMonth);
  const estimatedToDate    = Math.round(elapsedEstimate);
  const avgDailyToDate     = Math.round(estimatedToDate / Math.max(1, daysElapsed));

  const estimatedVsYoy = sameLastYearRow
    ? ((projectedFullMonth - sameLastYearRow.totalPassengers) /
        sameLastYearRow.totalPassengers) * 100
    : null;

  const estimateGapVsPrior = priorRow
    ? ((projectedFullMonth - priorRow.totalPassengers) /
        priorRow.totalPassengers) * 100
    : null;

  const monthComplete = daysElapsed >= totalDays;

  return {
    airportCode: "PVR",
    month: targetMonth,
    year: targetYear,
    daysElapsed,
    daysInMonth: totalDays,
    officialPassengers: null,
    estimatedPassengersToDate: estimatedToDate,
    projectedFullMonthPassengers: projectedFullMonth,
    averageDailyPassengersToDate: avgDailyToDate,
    sameMonthLastYearPassengers: sameLastYearRow?.totalPassengers ?? null,
    estimatedVsSameMonthLastYearPct: estimatedVsYoy,
    estimateGapVsLastOfficialMonthPct: estimateGapVsPrior,
    confidence: getConfidence(daysElapsed, totalDays),
    status: "estimated",
    monthComplete,
    lastUpdated: new Date().toISOString(),
    anomaly: null, // attached by caller after anomaly detection
  };
}

// ── Helper: build MonthDataPoints for anomaly detection ───────────────────────

/**
 * Converts MonthRow[] into MonthDataPoint[] (with YoY % computed for each row).
 * Used to give the anomaly engine historical context for prior-month checks.
 */
function buildDataPoints(allMonths: MonthRow[]): MonthDataPoint[] {
  return allMonths.map((row) => {
    const priorYear = allMonths.find(
      (r) => r.year === row.year - 1 && r.month === row.month,
    );
    const yoyPct = priorYear
      ? ((row.totalPassengers - priorYear.totalPassengers) / priorYear.totalPassengers) * 100
      : null;
    return { year: row.year, month: row.month, yoyPct, totalPassengers: row.totalPassengers };
  });
}

// ── Main export: current month ─────────────────────────────────────────────────

/**
 * Estimate for the current calendar month.
 * Returns null only if there is no usable prior data at all.
 *
 * @param events Optional market events for anomaly detection.
 */
export function computeAirportEstimate(
  allMonths: MonthRow[],
  now?: Date,
  events?: MarketEvent[],
): AirportEstimate | null {
  const pvNow        = now ?? getNowPuertovallarta();
  const currentYear  = pvNow.getFullYear();
  const currentMonth = pvNow.getMonth() + 1;
  const daysElapsed  = pvNow.getDate();
  const est = estimateMonth(allMonths, currentYear, currentMonth, daysElapsed);
  if (!est) return null;

  if (events && events.length > 0) {
    const dataPoints = buildDataPoints(allMonths);
    const currentPoint: MonthDataPoint = {
      year:  currentYear,
      month: currentMonth,
      yoyPct: est.estimatedVsSameMonthLastYearPct,
    };
    est.anomaly = detectAnomaly(currentPoint, dataPoints, events, DEFAULT_ANOMALY_CONFIG);
  }

  return est;
}

// ── Secondary export: all unconfirmed months ───────────────────────────────────

/**
 * Returns estimates for every recent month that lacks an official GAP total,
 * ordered chronologically (oldest first).
 *
 * "Recent" = from January of the current year through the current month.
 *
 * @param events Optional market events for anomaly detection.
 */
export function computePendingEstimates(
  allMonths: MonthRow[],
  now?: Date,
  events?: MarketEvent[],
): AirportEstimate[] {
  const pvNow        = now ?? getNowPuertovallarta();
  const currentYear  = pvNow.getFullYear();
  const currentMonth = pvNow.getMonth() + 1;
  const todayDay     = pvNow.getDate();

  const results: AirportEstimate[] = [];

  for (let m = 1; m <= currentMonth; m++) {
    const isCurrentMonth = m === currentMonth;
    const daysElapsed    = isCurrentMonth
      ? todayDay
      : daysInMonthFn(currentYear, m); // completed month = all days elapsed

    const est = estimateMonth(allMonths, currentYear, m, daysElapsed);
    if (est && est.status === "estimated") {
      results.push(est);
    }
  }

  // ── Attach anomaly metadata ────────────────────────────────────────────────
  if (events && events.length > 0) {
    const dataPoints = buildDataPoints(allMonths);

    for (const est of results) {
      const point: MonthDataPoint = {
        year:   est.year,
        month:  est.month,
        yoyPct: est.estimatedVsSameMonthLastYearPct,
      };
      est.anomaly = detectAnomaly(point, dataPoints, events, DEFAULT_ANOMALY_CONFIG);
    }
  }

  return results;
}
