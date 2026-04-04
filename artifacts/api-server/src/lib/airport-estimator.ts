/**
 * airport-estimator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Produces a simple directional estimate of current-month PVR airport
 * passengers BEFORE the official GAP monthly press release is available.
 *
 * Philosophy: intentionally lightweight — this is a directional number, not a
 * forecast. Two simple methods are blended 50/50, then lightly adjusted for
 * seasonal patterns.
 *
 * HOW TO TUNE LATER
 * ─────────────────
 * • SEASONALITY — edit the SEASONALITY constant below. Values > 1 = busier
 *   than a neutral month, < 1 = slower. Effect is capped at ±MAX_SEASON_SWING.
 * • BLEND WEIGHTS — change WEIGHT_PRIOR_MONTH / WEIGHT_YOY (must sum to 1).
 * • CONFIDENCE THRESHOLDS — edit CONF_LOW_MAX / CONF_MED_MAX.
 * • MONTH TIMING — to shift what "current month" means, adjust
 *   getNowPuertovallarta() to use a different offset or library.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Seasonality index (month number → relative traffic factor) ────────────────
// A value of 1.00 is neutral; 1.10 means ~10% busier than a neutral month.
// Effect is capped at ±MAX_SEASON_SWING relative to 1.0 so a bad index entry
// can never swing the estimate by more than 15% in either direction.
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

const MAX_SEASON_SWING = 0.15; // ±15% max effect

// ── Blend weights (must sum to 1) ─────────────────────────────────────────────
const WEIGHT_PRIOR_MONTH = 0.5;
const WEIGHT_YOY         = 0.5;

// ── Confidence thresholds (days elapsed in current month) ─────────────────────
const CONF_LOW_MAX = 7;
const CONF_MED_MAX = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type EstimateStatus     = "estimated" | "official";
export type EstimateConfidence = "low" | "medium" | "high";

export interface AirportEstimate {
  airportCode: "PVR";
  month: number;
  year: number;
  daysElapsed: number;
  daysInMonth: number;

  /** Null for the open (current) month — filled when GAP publishes official. */
  officialPassengers: number | null;

  /** Passengers estimated so far this calendar month. */
  estimatedPassengersToDate: number;

  /** Full-month projection including seasonality adjustment. */
  projectedFullMonthPassengers: number;

  /** Average daily rate implied by the to-date estimate. */
  averageDailyPassengersToDate: number;

  /** Official GAP total for the same month in the previous year. */
  sameMonthLastYearPassengers: number | null;

  /** Projected-full-month vs same month last year, as a percentage change. */
  estimatedVsSameMonthLastYearPct: number | null;

  /**
   * Internal / debug only — projected current month vs most recent official
   * prior month. Useful for sanity-checking the estimate.
   */
  estimateGapVsLastOfficialMonthPct: number | null;

  confidence: EstimateConfidence;
  status: EstimateStatus;
  lastUpdated: string; // ISO timestamp
}

export interface MonthRow {
  year: number;
  month: number;
  totalPassengers: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Puerto Vallarta is UTC-6 year-round (Mexico abolished DST for Jalisco in 2023). */
function getNowPuertovallarta(): Date {
  const utcMs = Date.now();
  const PV_OFFSET_MS = -6 * 60 * 60 * 1000;
  return new Date(utcMs + PV_OFFSET_MS);
}

function daysInMonthFn(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month 1-indexed; Date uses 0-indexed month
}

function applySeasonality(base: number, month: number): number {
  const raw   = SEASONALITY[month] ?? 1.0;
  const low   = 1.0 - MAX_SEASON_SWING;
  const high  = 1.0 + MAX_SEASON_SWING;
  const factor = Math.min(high, Math.max(low, raw));
  return Math.round(base * factor);
}

function getConfidence(daysElapsed: number): EstimateConfidence {
  if (daysElapsed <= CONF_LOW_MAX) return "low";
  if (daysElapsed <= CONF_MED_MAX) return "medium";
  return "high";
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute a current-month airport passenger estimate from existing GAP monthly
 * totals. Returns null only if there is truly no usable prior data at all.
 *
 * @param allMonths  All rows from airport_metrics (year + month + totalPassengers).
 * @param now        Optional override — defaults to current time in PVR timezone.
 */
export function computeAirportEstimate(
  allMonths: MonthRow[],
  now?: Date,
): AirportEstimate | null {
  const pvNow       = now ?? getNowPuertovallarta();
  const currentYear = pvNow.getFullYear();
  const currentMonth = pvNow.getMonth() + 1; // 1-indexed
  const daysElapsed  = pvNow.getDate();
  const totalDays    = daysInMonthFn(currentYear, currentMonth);

  if (daysElapsed <= 0 || totalDays <= 0) return null;

  // ── If GAP has already published official data for this month, use it ──────
  const officialRow = allMonths.find(
    (r) => r.year === currentYear && r.month === currentMonth,
  );

  const sameLastYearRow = allMonths.find(
    (r) => r.year === currentYear - 1 && r.month === currentMonth,
  );

  if (officialRow) {
    const yoyPct = sameLastYearRow
      ? ((officialRow.totalPassengers - sameLastYearRow.totalPassengers) /
          sameLastYearRow.totalPassengers) * 100
      : null;

    return {
      airportCode: "PVR",
      month: currentMonth,
      year: currentYear,
      daysElapsed: totalDays, // month is complete
      daysInMonth: totalDays,
      officialPassengers: officialRow.totalPassengers,
      estimatedPassengersToDate: officialRow.totalPassengers,
      projectedFullMonthPassengers: officialRow.totalPassengers,
      averageDailyPassengersToDate: Math.round(
        officialRow.totalPassengers / totalDays,
      ),
      sameMonthLastYearPassengers: sameLastYearRow?.totalPassengers ?? null,
      estimatedVsSameMonthLastYearPct: yoyPct,
      estimateGapVsLastOfficialMonthPct: null,
      confidence: "high",
      status: "official",
      lastUpdated: new Date().toISOString(),
    };
  }

  // ── Estimation path — month is still open ─────────────────────────────────

  // Most recent official month strictly before the current month
  const sortedPrior = allMonths
    .filter(
      (r) => r.year < currentYear ||
             (r.year === currentYear && r.month < currentMonth),
    )
    .sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));

  const priorRow = sortedPrior[sortedPrior.length - 1] ?? null;

  if (!priorRow && !sameLastYearRow) {
    // No usable data at all
    return null;
  }

  // ── Method A: prior-month daily run-rate ──────────────────────────────────
  let runRateEstimate: number | null = null;
  if (priorRow) {
    const priorDays    = daysInMonthFn(priorRow.year, priorRow.month);
    const priorDailyAvg = priorRow.totalPassengers / priorDays;
    runRateEstimate     = priorDailyAvg * daysElapsed;
  }

  // ── Method B: same month last year pacing ─────────────────────────────────
  let yoyPacedEstimate: number | null = null;
  if (sameLastYearRow) {
    const lastYearDays  = daysInMonthFn(currentYear - 1, currentMonth);
    const lastYearDaily = sameLastYearRow.totalPassengers / lastYearDays;
    yoyPacedEstimate    = lastYearDaily * daysElapsed;
  }

  // ── Blend: 50/50 when both exist, 100% of whichever is available ──────────
  let elapsedEstimate: number;
  if (runRateEstimate !== null && yoyPacedEstimate !== null) {
    elapsedEstimate =
      WEIGHT_PRIOR_MONTH * runRateEstimate +
      WEIGHT_YOY         * yoyPacedEstimate;
  } else {
    // Fallback to whichever is available (spec §9)
    elapsedEstimate = (runRateEstimate ?? yoyPacedEstimate)!;
  }

  // ── Project to full-month and apply seasonality ───────────────────────────
  const paceRatio          = daysElapsed / totalDays;
  const rawProjected       = elapsedEstimate / paceRatio;
  const projectedFullMonth = applySeasonality(rawProjected, currentMonth);
  const estimatedToDate    = Math.round(elapsedEstimate);
  const avgDailyToDate     = Math.round(estimatedToDate / daysElapsed);

  // ── YoY comparison on projected total ─────────────────────────────────────
  const estimatedVsYoy = sameLastYearRow
    ? ((projectedFullMonth - sameLastYearRow.totalPassengers) /
        sameLastYearRow.totalPassengers) * 100
    : null;

  // ── Internal debug gap vs prior official month ────────────────────────────
  const estimateGapVsPrior = priorRow
    ? ((projectedFullMonth - priorRow.totalPassengers) /
        priorRow.totalPassengers) * 100
    : null;

  return {
    airportCode: "PVR",
    month: currentMonth,
    year: currentYear,
    daysElapsed,
    daysInMonth: totalDays,
    officialPassengers: null,
    estimatedPassengersToDate: estimatedToDate,
    projectedFullMonthPassengers: projectedFullMonth,
    averageDailyPassengersToDate: avgDailyToDate,
    sameMonthLastYearPassengers: sameLastYearRow?.totalPassengers ?? null,
    estimatedVsSameMonthLastYearPct: estimatedVsYoy,
    estimateGapVsLastOfficialMonthPct: estimateGapVsPrior,
    confidence: getConfidence(daysElapsed),
    status: "estimated",
    lastUpdated: new Date().toISOString(),
  };
}
