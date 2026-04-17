/**
 * anomaly-engine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable market anomaly detection and classification framework.
 *
 * Purpose
 * ───────
 * Detects when a data point (airport month, tourism metric) should be treated
 * as a temporary external shock rather than a structural demand trend.  Drives
 * downstream analytics: narrative commentary, chart annotations, pricing weight
 * adjustments, and UI status labels.
 *
 * Architecture
 * ────────────
 * Pure functions only — no DB calls.  Callers load MarketEvent[] from the
 * database and pass them in.  This keeps the engine testable and fast.
 *
 * Detection logic
 * ───────────────
 * A month is flagged as anomalous when ALL of the following are true:
 *   1. Its YoY change falls below ANOMALY_THRESHOLD_PCT (default −15 %)
 *   2. One or more known MarketEvents overlap the month's booking window
 *   3. Prior months did not exhibit a sustained deterioration of similar
 *      magnitude (i.e. the drop looks like a shock, not a trend)
 *
 * Recovery detection
 * ──────────────────
 * A month is classified as "recovery" when a prior month was anomalous and
 * the current month falls within the event's recovery window.
 *
 * Adding future events
 * ────────────────────
 * Insert rows into the market_events table — no code changes required.
 * The anomalyWeightConfig JSON column overrides per-event weight defaults.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { MarketEvent } from "@workspace/db/schema";

// ── Configuration ─────────────────────────────────────────────────────────────

export interface AnomalyConfig {
  /**
   * YoY % change below which a month is considered potentially anomalous.
   * Default: −15 %.  Must be negative.
   */
  yoyAnomalyThresholdPct: number;

  /**
   * How many prior months to inspect for pre-existing deterioration.
   * If ≥ this many prior months also declined beyond priorMonthsMaxDeclinePct,
   * the drop is classified as structural rather than a shock.
   */
  priorMonthsToCheck: number;

  /**
   * Prior-month YoY decline up to this amount is considered "normal noise".
   * Deeper declines suggest the market was already weakening (structural).
   */
  priorMonthsMaxDeclinePct: number;

  /**
   * Default demand weight for an anomaly-affected month.
   * Range 0–1.  Lower = less influence on trend / pricing.
   */
  defaultAnomalyWeight: number;

  /**
   * Default demand weight for a recovery-phase month.
   */
  defaultRecoveryWeight: number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyConfig = {
  yoyAnomalyThresholdPct: -15,
  priorMonthsToCheck:     2,
  priorMonthsMaxDeclinePct: -8,
  defaultAnomalyWeight:   0.30,
  defaultRecoveryWeight:  0.70,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnomalyType      = "external_event" | "weather" | "health" | "structural_decline" | "outlier" | null;
export type RecoveryPhase    = "booking_shock" | "direct_impact" | "recovery" | "normalised" | null;
export type AnomalyInterpretation = "temporary_demand_shock" | "structural_decline" | "normal_variation" | null;

export interface MonthDataPoint {
  year:  number;
  month: number;
  /** YoY % change for this month (null when prior-year data unavailable) */
  yoyPct: number | null;
  /** Raw passenger count (optional, for context) */
  totalPassengers?: number;
}

export interface AnomalyResult {
  detected:      boolean;
  type:          AnomalyType;
  severity:      "low" | "medium" | "high" | null;
  eventSlug:     string | null;
  eventTitle:    string | null;
  eventTitleEs:  string | null;
  interpretation: AnomalyInterpretation;
  trendOverride: boolean;

  /**
   * Demand weight for use in airport analytics (0.25 – 1.0).
   * 1.0 = normal month; 0.30 = anomaly (80 % discount applied to scoring).
   */
  airportDemandWeight: number;

  /**
   * Demand weight for use in pricing engine (0.35 – 1.0).
   */
  pricingDemandWeight: number;

  /** UI labels */
  statusLabel:      string;
  statusDetail:     string | null;
  statusDetailEs:   string | null;
  trendClassification:   string | null;
  trendClassificationEs: string | null;
  cautionFlag:      boolean;

  /** Where in the event lifecycle this month falls */
  recoveryPhase:    RecoveryPhase;

  /** Plain-language commentary for display */
  commentary: {
    en: string;
    es: string;
  };

  /** All events whose windows touch this month */
  activeEvents: MarketEvent[];
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDate(s: string): Date {
  // Treats YYYY-MM-DD as midnight UTC to avoid timezone drift
  return new Date(s + "T00:00:00Z");
}

function monthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

function monthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
}

function dateIsInMonth(date: Date, year: number, month: number): boolean {
  return date >= monthStart(year, month) && date <= monthEnd(year, month);
}

function rangeOverlapsMonth(
  rangeStart: Date,
  rangeEnd:   Date,
  year:       number,
  month:      number,
): boolean {
  const mStart = monthStart(year, month);
  const mEnd   = monthEnd(year, month);
  return rangeStart <= mEnd && rangeEnd >= mStart;
}

// ── Event–month matching ──────────────────────────────────────────────────────

interface EventWindowMatch {
  event:              MarketEvent;
  isDirectImpact:     boolean; // event dates fall in this month
  isBookingShock:     boolean; // booking hesitation window falls in this month
  isRecovery:         boolean; // recovery window falls in this month
  phase:              RecoveryPhase;
}

function matchEventsToMonth(
  year:   number,
  month:  number,
  events: MarketEvent[],
): EventWindowMatch[] {
  const results: EventWindowMatch[] = [];

  for (const event of events) {
    if (!event.isActive) continue;

    const eventStart = parseDate(event.startDate);
    const eventEnd   = event.endDate ? parseDate(event.endDate) : eventStart;

    // 1. Direct impact: event dates overlap the month
    const isDirectImpact = rangeOverlapsMonth(eventStart, eventEnd, year, month);

    // 2. Booking shock: booking window overlaps the month
    let isBookingShock = false;
    if (event.bookingShockStart && event.bookingShockEnd) {
      const bStart = parseDate(event.bookingShockStart);
      const bEnd   = parseDate(event.bookingShockEnd);
      isBookingShock = rangeOverlapsMonth(bStart, bEnd, year, month);
    }

    // 3. Recovery: recovery window overlaps the month
    let isRecovery = false;
    if (event.recoveryWindowEnd) {
      const rEnd = parseDate(event.recoveryWindowEnd);
      // Recovery window = eventEnd → recoveryWindowEnd
      isRecovery = !isDirectImpact && !isBookingShock && rangeOverlapsMonth(eventEnd, rEnd, year, month);
    }

    if (!isDirectImpact && !isBookingShock && !isRecovery) continue;

    let phase: RecoveryPhase = null;
    if (isDirectImpact)  phase = "direct_impact";
    else if (isBookingShock) phase = "booking_shock";
    else if (isRecovery)     phase = "recovery";

    results.push({ event, isDirectImpact, isBookingShock, isRecovery, phase });
  }

  return results;
}

// ── Anomaly weight from event config ─────────────────────────────────────────

interface EventWeights {
  airportDemand:  number;
  pricingDemand:  number;
  recoveryDemand: number;
}

function getEventWeights(event: MarketEvent, config: AnomalyConfig): EventWeights {
  if (event.anomalyWeightConfig) {
    try {
      const parsed = JSON.parse(event.anomalyWeightConfig) as Partial<EventWeights>;
      return {
        airportDemand:  parsed.airportDemand  ?? config.defaultAnomalyWeight,
        pricingDemand:  parsed.pricingDemand  ?? config.defaultAnomalyWeight,
        recoveryDemand: parsed.recoveryDemand ?? config.defaultRecoveryWeight,
      };
    } catch {
      // fall through to defaults
    }
  }
  return {
    airportDemand:  config.defaultAnomalyWeight,
    pricingDemand:  config.defaultAnomalyWeight,
    recoveryDemand: config.defaultRecoveryWeight,
  };
}

// ── Commentary generation ─────────────────────────────────────────────────────

function buildCommentary(
  year:       number,
  month:      number,
  monthName:  string,
  yoyPct:     number | null,
  result: {
    detected:      boolean;
    type:          AnomalyType;
    recoveryPhase: RecoveryPhase;
    eventTitle:    string | null;
    eventTitleEs:  string | null;
  },
): { en: string; es: string } {
  const yoyStr    = yoyPct !== null ? `${yoyPct >= 0 ? "+" : ""}${yoyPct.toFixed(1)}%` : null;
  const yoyEsStr  = yoyStr;

  if (!result.detected) {
    if (yoyStr) {
      return {
        en: `${monthName} ${year} passenger traffic was ${yoyStr} year-over-year — consistent with normal seasonal variation.`,
        es: `El tráfico de pasajeros en ${monthName} ${year} fue de ${yoyEsStr} interanual — acorde con la variación estacional normal.`,
      };
    }
    return {
      en: `${monthName} ${year} passenger data reflects normal market conditions.`,
      es: `Los datos de pasajeros de ${monthName} ${year} reflejan condiciones de mercado normales.`,
    };
  }

  if (result.recoveryPhase === "direct_impact" || result.recoveryPhase === "booking_shock") {
    const eventRef = result.eventTitle ?? "an external disruption";
    const eventRefEs = result.eventTitleEs ?? "una disrupción externa";
    const yoyNote = yoyStr ? ` Traffic was ${yoyStr} versus the prior year,` : "";
    const yoyNoteEs = yoyEsStr ? ` El tráfico fue de ${yoyEsStr} respecto al año anterior,` : "";
    return {
      en: `${monthName} ${year} passenger traffic was materially impacted by ${eventRef}.${yoyNote} but this should be treated as a temporary anomaly rather than a structural tourism decline. VallartaPulse treats this month as an external shock — normal demand patterns are expected to resume as the disruption resolves.`,
      es: `El tráfico de pasajeros en ${monthName} ${year} fue materialmente afectado por ${eventRefEs}.${yoyNoteEs} pero esto debe tratarse como una anomalía temporal, no como un declive estructural del turismo. VallartaPulse clasifica este mes como un choque externo — se espera que los patrones de demanda normales se reanuden a medida que se resuelva la disrupción.`,
    };
  }

  if (result.recoveryPhase === "recovery") {
    return {
      en: `${monthName} ${year} estimates point toward normalization following the prior disruption. Current projections suggest demand recovery rather than continued deterioration — consistent with the event's expected rapid recovery pattern.`,
      es: `Las estimaciones de ${monthName} ${year} apuntan hacia una normalización tras la disrupción anterior. Las proyecciones actuales sugieren una recuperación de la demanda, no un deterioro continuo — acorde con el patrón de recuperación rápida esperado del evento.`,
    };
  }

  return {
    en: `${monthName} ${year} reflects residual effects of a recent market disruption. Conditions are expected to normalise through the coming weeks.`,
    es: `${monthName} ${year} refleja efectos residuales de una reciente disrupción de mercado. Se espera que las condiciones se normalicen en las próximas semanas.`,
  };
}

// ── Main detection function ───────────────────────────────────────────────────

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Detect whether a given month/year data point represents an anomaly.
 *
 * @param target       The month being evaluated.
 * @param allPoints    All available monthly data points (for prior-month context).
 * @param events       Active market events loaded from the database.
 * @param config       Optional config overrides.
 */
export function detectAnomaly(
  target:    MonthDataPoint,
  allPoints: MonthDataPoint[],
  events:    MarketEvent[],
  config:    AnomalyConfig = DEFAULT_ANOMALY_CONFIG,
): AnomalyResult {
  const { year, month, yoyPct } = target;
  const monthName = MONTH_NAMES[month] ?? "Unknown";

  // ── Step 1: match events to this month ──────────────────────────────────────
  const matches = matchEventsToMonth(year, month, events);
  const impactMatches   = matches.filter((m) => m.isDirectImpact || m.isBookingShock);
  const recoveryMatches = matches.filter((m) => m.isRecovery);
  const hasKnownEvent   = impactMatches.length > 0;
  const isRecoveryMonth = recoveryMatches.length > 0 && !hasKnownEvent;

  // ── Step 2: early exit — recovery month ─────────────────────────────────────
  if (isRecoveryMonth && !hasKnownEvent) {
    const bestRecovery = recoveryMatches[0]!;
    const eventWeights = getEventWeights(bestRecovery.event, config);
    const commentary = buildCommentary(year, month, monthName, yoyPct, {
      detected: true,
      type: "external_event",
      recoveryPhase: "recovery",
      eventTitle: bestRecovery.event.title,
      eventTitleEs: bestRecovery.event.titleEs,
    });

    return {
      detected:            true,
      type:                "external_event",
      severity:            bestRecovery.event.severity as "low" | "medium" | "high",
      eventSlug:           bestRecovery.event.slug,
      eventTitle:          bestRecovery.event.title,
      eventTitleEs:        bestRecovery.event.titleEs,
      interpretation:      "temporary_demand_shock",
      trendOverride:       false,
      airportDemandWeight: eventWeights.recoveryDemand,
      pricingDemandWeight: eventWeights.recoveryDemand,
      statusLabel:         "Recovery",
      statusDetail:        "Projected rebound after temporary disruption",
      statusDetailEs:      "Rebote proyectado tras disrupción temporal",
      trendClassification:     "Normalisation — event impact fading",
      trendClassificationEs:   "Normalización — impacto del evento se desvanece",
      cautionFlag:         false,
      recoveryPhase:       "recovery",
      commentary,
      activeEvents:        recoveryMatches.map((m) => m.event),
    };
  }

  // ── Step 3: check YoY threshold ─────────────────────────────────────────────
  if (yoyPct === null || yoyPct >= config.yoyAnomalyThresholdPct) {
    // Not anomalous by YoY metric
    const commentary = buildCommentary(year, month, monthName, yoyPct, {
      detected: false, type: null, recoveryPhase: null,
      eventTitle: null, eventTitleEs: null,
    });
    return _normalResult(commentary);
  }

  // YoY below threshold — check if known event overlaps
  if (!hasKnownEvent) {
    // Large drop but no known event — could be structural or unexplained outlier
    const priorDeclines = getPriorMonthYoyDeclines(year, month, allPoints, config.priorMonthsToCheck);
    const isStructural  = priorDeclines.filter((d) => d < config.priorMonthsMaxDeclinePct).length >= 2;
    const commentary = buildCommentary(year, month, monthName, yoyPct, {
      detected: isStructural,
      type: isStructural ? "structural_decline" : "outlier",
      recoveryPhase: "direct_impact",
      eventTitle: null, eventTitleEs: null,
    });
    if (isStructural) {
      return {
        detected:            true,
        type:                "structural_decline",
        severity:            yoyPct < -25 ? "high" : "medium",
        eventSlug:           null,
        eventTitle:          null,
        eventTitleEs:        null,
        interpretation:      "structural_decline",
        trendOverride:       false,
        airportDemandWeight: 0.80, // reduce but don't ignore structural signals
        pricingDemandWeight: 0.85,
        statusLabel:         "Decline",
        statusDetail:        "Sustained multi-month decline in passenger traffic",
        statusDetailEs:      "Caída sostenida de varios meses en el tráfico de pasajeros",
        trendClassification:     "Structural — multiple prior months declining",
        trendClassificationEs:   "Estructural — varios meses previos en declive",
        cautionFlag:         true,
        recoveryPhase:       null,
        commentary,
        activeEvents:        [],
      };
    }
    return _normalResult(commentary);
  }

  // ── Step 4: known event + YoY below threshold — likely anomaly ──────────────
  const priorDeclines = getPriorMonthYoyDeclines(year, month, allPoints, config.priorMonthsToCheck);
  const isStructural  = priorDeclines.filter((d) => d < config.priorMonthsMaxDeclinePct).length >= 2;

  if (isStructural) {
    // The market was already weakening before the event — weigh both
    const commentary = buildCommentary(year, month, monthName, yoyPct, {
      detected: true, type: "structural_decline",
      recoveryPhase: "direct_impact",
      eventTitle: impactMatches[0]!.event.title,
      eventTitleEs: impactMatches[0]!.event.titleEs,
    });
    return {
      detected:            true,
      type:                "structural_decline",
      severity:            "medium",
      eventSlug:           impactMatches[0]!.event.slug,
      eventTitle:          impactMatches[0]!.event.title,
      eventTitleEs:        impactMatches[0]!.event.titleEs,
      interpretation:      "structural_decline",
      trendOverride:       false,
      airportDemandWeight: 0.70,
      pricingDemandWeight: 0.75,
      statusLabel:         "Anomaly + Structural",
      statusDetail:        "External event compounded existing softness",
      statusDetailEs:      "Evento externo agravó una debilidad preexistente",
      trendClassification:     "Mixed — event + prior softness",
      trendClassificationEs:   "Mixto — evento + debilidad previa",
      cautionFlag:         true,
      recoveryPhase:       "direct_impact",
      commentary,
      activeEvents:        impactMatches.map((m) => m.event),
    };
  }

  // Clean external shock — prior months were normal, known event overlaps
  const bestMatch    = impactMatches[0]!;
  const eventWeights = getEventWeights(bestMatch.event, config);

  const commentary = buildCommentary(year, month, monthName, yoyPct, {
    detected: true, type: "external_event",
    recoveryPhase: bestMatch.phase,
    eventTitle: bestMatch.event.title,
    eventTitleEs: bestMatch.event.titleEs,
  });

  return {
    detected:            true,
    type:                "external_event",
    severity:            bestMatch.event.severity as "low" | "medium" | "high",
    eventSlug:           bestMatch.event.slug,
    eventTitle:          bestMatch.event.title,
    eventTitleEs:        bestMatch.event.titleEs,
    interpretation:      "temporary_demand_shock",
    trendOverride:       true,
    airportDemandWeight: eventWeights.airportDemand,
    pricingDemandWeight: eventWeights.pricingDemand,
    statusLabel:         "Anomaly",
    statusDetail:        "Temporary disruption — not a structural tourism decline",
    statusDetailEs:      "Disrupción temporal — no es un declive estructural del turismo",
    trendClassification:     "External shock, not structural decline",
    trendClassificationEs:   "Choque externo, no declive estructural",
    cautionFlag:         true,
    recoveryPhase:       bestMatch.phase,
    commentary,
    activeEvents:        impactMatches.map((m) => m.event),
  };
}

// ── Helper: get prior-month YoY declines for structural check ─────────────────

function getPriorMonthYoyDeclines(
  year:         number,
  month:        number,
  allPoints:    MonthDataPoint[],
  priorToCheck: number,
): number[] {
  const results: number[] = [];
  for (let i = 1; i <= priorToCheck; i++) {
    let targetMonth = month - i;
    let targetYear  = year;
    if (targetMonth < 1) { targetMonth += 12; targetYear -= 1; }
    const pt = allPoints.find((p) => p.year === targetYear && p.month === targetMonth);
    if (pt?.yoyPct !== null && pt?.yoyPct !== undefined) {
      results.push(pt.yoyPct);
    }
  }
  return results;
}

function _normalResult(commentary: { en: string; es: string }): AnomalyResult {
  return {
    detected:            false,
    type:                null,
    severity:            null,
    eventSlug:           null,
    eventTitle:          null,
    eventTitleEs:        null,
    interpretation:      "normal_variation",
    trendOverride:       false,
    airportDemandWeight: 1.0,
    pricingDemandWeight: 1.0,
    statusLabel:         "Official",
    statusDetail:        null,
    statusDetailEs:      null,
    trendClassification:     null,
    trendClassificationEs:   null,
    cautionFlag:         false,
    recoveryPhase:       null,
    commentary,
    activeEvents:        [],
  };
}

// ── Annotate a list of months ─────────────────────────────────────────────────

/**
 * Batch-detect anomalies across a list of month data points.
 * allPoints must include all months needed for prior-context lookups.
 */
export function annotateMonths(
  points:    MonthDataPoint[],
  events:    MarketEvent[],
  config?:   AnomalyConfig,
): Map<string, AnomalyResult> {
  const results = new Map<string, AnomalyResult>();
  for (const pt of points) {
    const key = `${pt.year}-${String(pt.month).padStart(2, "0")}`;
    results.set(key, detectAnomaly(pt, points, events, config));
  }
  return results;
}

/**
 * Convenience key builder for the annotateMonths map.
 */
export function anomalyKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}
