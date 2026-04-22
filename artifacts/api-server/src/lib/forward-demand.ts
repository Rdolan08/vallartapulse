/**
 * forward-demand.ts — v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Forward-demand recommendation layer. Sits ALONGSIDE the comp-based pricing
 * recommendation as a separate informational signal. Does NOT modify pricing
 * math, comp-engine output, or any seasonality multiplier.
 *
 * Tier 1 events ONLY in v1: Pride PV (May) and Christmas/NYE (late Dec).
 * Two trigger conditions, both required:
 *   1. The night sits inside a Tier 1 event window
 *   2. The calibration gate signal indicates comps are still flat for the
 *      relevant hood (pride_vs_pre_median_ratio < 1.03)
 *
 * Guardrail: if the calibration signal is missing or stale (>14 days), the
 * feature is suppressed for that hood/date — no inference, no fallback.
 *
 * Pure / deterministic / no I/O except the gate reader's filesystem read.
 */

import fs from "node:fs";
import path from "node:path";

// ══════════════════════════════════════════════════════════════════════════
// TIER 1 EVENT REGISTRY — v1 hardcoded. Only these two qualify.
// ══════════════════════════════════════════════════════════════════════════

export interface Tier1Event {
  /** Stable internal label, written to forward_demand_observations.event_label. */
  label: string;
  /** Display name for the panel. */
  name: string;
  /** Inclusive start date YYYY-MM-DD. */
  startDate: string;
  /** Inclusive end date YYYY-MM-DD. */
  endDate: string;
  /** Hoods (normalized) where this event drives demand. Used for trigger gating. */
  hoods: string[];
  /** Event-specific "why" bullet. Plain language, no metrics. */
  eventBullet: string;
  /** Calibration gate config — ties this event to a calibration JSON folder. */
  calibrationFolder: string;
  /** Hood label inside the calibration JSON to read the ratio from. */
  calibrationHoodLabel: string;
}

export const TIER_1_EVENTS: Tier1Event[] = [
  {
    label: "pride_pv_2026",
    name: "Pride PV",
    startDate: "2026-05-20",
    endDate: "2026-05-28",
    hoods: ["Zona Romantica", "Old Town", "Amapas"],
    eventBullet:
      "Pride PV consistently runs at near-full occupancy in this neighborhood — historically one of the strongest weeks of the year",
    calibrationFolder: "diagnostics/calibration/pride-2026",
    calibrationHoodLabel: "ZR + Old Town",
  },
  // Christmas/NYE 2026 — placeholder; trigger will return suppressed until a
  // matching calibration folder exists. Keeps the registry shape consistent.
  {
    label: "christmas_nye_2026",
    name: "Christmas / NYE",
    startDate: "2026-12-22",
    endDate: "2027-01-02",
    hoods: ["Zona Romantica", "Old Town", "Amapas", "Marina Vallarta", "Centro"],
    eventBullet:
      "Christmas and New Year's is consistently the highest-demand stretch of the year across PV — properties book out weeks in advance",
    calibrationFolder: "diagnostics/calibration/christmas-nye-2026",
    calibrationHoodLabel: "ZR + Old Town",
  },
];

// ══════════════════════════════════════════════════════════════════════════
// HOOD NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════

/**
 * Map a free-form neighborhood label (from the pricing-tool form) to the
 * canonical hood key used by the event registry. Returns null if the hood
 * doesn't match any tracked label (feature suppressed for unmatched hoods).
 */
export function normalizeHoodForForwardDemand(input: string): string | null {
  const s = input.trim().toLowerCase();
  // Tolerate the diacritic and the non-diacritic forms.
  if (s === "zona romantica" || s === "zona romántica") return "Zona Romantica";
  if (s === "old town") return "Old Town";
  if (s === "amapas" || s === "conchas chinas / amapas") return "Amapas";
  if (s === "marina vallarta") return "Marina Vallarta";
  if (s === "centro") return "Centro";
  return null;
}

// ══════════════════════════════════════════════════════════════════════════
// BUCKET LOGIC — pure date arithmetic, no math beyond subtraction
// ══════════════════════════════════════════════════════════════════════════

export type Bucket = "early" | "mid" | "late" | "very_late";

export function bucketFor(daysToEvent: number): Bucket {
  if (daysToEvent >= 60) return "early";
  if (daysToEvent >= 30) return "mid";
  if (daysToEvent >= 15) return "late";
  return "very_late";
}

/** Days from `from` to `to` (calendar-day diff, UTC-safe, non-negative if to>=from). */
export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const b = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.round((b - a) / 86_400_000);
}

// ══════════════════════════════════════════════════════════════════════════
// RECOMMENDATION BAND — straight from the locked spec
// ══════════════════════════════════════════════════════════════════════════

export interface RecommendationBand {
  low: number;
  high: number;
  /** Single-click apply price (band midpoint, rounded to nearest dollar). */
  apply: number;
}

export function bandFor(bucket: Bucket, compMedian: number): RecommendationBand {
  let low: number;
  let high: number;
  switch (bucket) {
    case "early":
      low = compMedian + 15;
      high = compMedian + 20;
      break;
    case "mid":
      low = compMedian + 10;
      high = compMedian + 15;
      break;
    case "late":
      low = compMedian + 0;
      high = compMedian + 10;
      break;
    case "very_late":
      low = compMedian - 5;
      high = compMedian;
      break;
  }
  // Floor low at $1 in case of pathological negative comp_median (shouldn't happen).
  low = Math.max(1, Math.round(low));
  high = Math.max(low, Math.round(high));
  const apply = Math.round((low + high) / 2);
  return { low, high, apply };
}

// ══════════════════════════════════════════════════════════════════════════
// CALIBRATION GATE — reads the most recent JSON snapshot from the folder
// ══════════════════════════════════════════════════════════════════════════

export interface CalibrationGateResult {
  /** True iff a usable, fresh, flat-comps signal was found for this hood. */
  triggerOk: boolean;
  /** Human-readable suppression reason (only set when triggerOk=false). */
  reason?:
    | "no_calibration_folder"
    | "no_snapshots_in_folder"
    | "snapshot_stale"
    | "ratio_missing_for_hood"
    | "ratio_above_threshold";
  /** Exact ratio observed in the most recent snapshot, if available. */
  observedRatio?: number;
  /** Threshold below which comps are considered flat. */
  threshold: number;
  /** When the most recent snapshot was generated. */
  snapshotRunAt?: string;
  /** Age of the snapshot in days (computed at request time). */
  snapshotAgeDays?: number;
  /** Hood label used inside the calibration JSON. */
  hoodLabel?: string;
}

const STALENESS_DAYS = 14;
const FLAT_THRESHOLD = 1.03;

/** Resolve the absolute path to the calibration folder, robust across cwd. */
function resolveCalibrationFolder(relativeFolder: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), relativeFolder),
    path.resolve(process.cwd(), "../..", relativeFolder),
    path.resolve(process.cwd(), "../../..", relativeFolder),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      // not present at this candidate
    }
  }
  return null;
}

interface CalibrationSnapshot {
  metadata: { run_at: string };
  ratios: Array<{
    hood: string;
    pride_median: number | null;
    pre_median: number | null;
    post_median: number | null;
    pride_vs_pre_median_ratio: number | null;
  }>;
}

/** Read most recent JSON snapshot from a calibration folder. Returns null on any failure. */
function readMostRecentSnapshot(folder: string): CalibrationSnapshot | null {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(folder)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  const latest = entries[entries.length - 1];
  try {
    const raw = fs.readFileSync(path.join(folder, latest), "utf8");
    return JSON.parse(raw) as CalibrationSnapshot;
  } catch {
    return null;
  }
}

export function checkCalibrationGate(event: Tier1Event, now: Date): CalibrationGateResult {
  const folder = resolveCalibrationFolder(event.calibrationFolder);
  if (!folder) {
    return { triggerOk: false, reason: "no_calibration_folder", threshold: FLAT_THRESHOLD };
  }
  const snap = readMostRecentSnapshot(folder);
  if (!snap) {
    return { triggerOk: false, reason: "no_snapshots_in_folder", threshold: FLAT_THRESHOLD };
  }
  const runAt = new Date(snap.metadata.run_at);
  const ageDays = daysBetween(runAt, now);
  if (ageDays > STALENESS_DAYS) {
    return {
      triggerOk: false,
      reason: "snapshot_stale",
      threshold: FLAT_THRESHOLD,
      snapshotRunAt: snap.metadata.run_at,
      snapshotAgeDays: ageDays,
      hoodLabel: event.calibrationHoodLabel,
    };
  }
  const row = snap.ratios.find((r) => r.hood === event.calibrationHoodLabel);
  if (!row || row.pride_vs_pre_median_ratio == null) {
    return {
      triggerOk: false,
      reason: "ratio_missing_for_hood",
      threshold: FLAT_THRESHOLD,
      snapshotRunAt: snap.metadata.run_at,
      snapshotAgeDays: ageDays,
      hoodLabel: event.calibrationHoodLabel,
    };
  }
  const ratio = row.pride_vs_pre_median_ratio;
  if (ratio >= FLAT_THRESHOLD) {
    return {
      triggerOk: false,
      reason: "ratio_above_threshold",
      threshold: FLAT_THRESHOLD,
      observedRatio: ratio,
      snapshotRunAt: snap.metadata.run_at,
      snapshotAgeDays: ageDays,
      hoodLabel: event.calibrationHoodLabel,
    };
  }
  return {
    triggerOk: true,
    threshold: FLAT_THRESHOLD,
    observedRatio: ratio,
    snapshotRunAt: snap.metadata.run_at,
    snapshotAgeDays: ageDays,
    hoodLabel: event.calibrationHoodLabel,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN COMPOSER — produces the per-night recommendation panel payload
// ══════════════════════════════════════════════════════════════════════════

const HEADLINE = "The market around you hasn't adjusted for this date yet.";
const SUPPORTING_LINE =
  "This is an opportunity to capture higher-value bookings early.";

const VERY_LATE_TRANSITION =
  "This was a forward-demand opportunity — that window has passed. Now the priority is getting booked.";

const WHY_FALLBACK_BULLETS = [
  "The market around you hasn't adjusted for this date yet",
  // event-specific bullet inserted from event.eventBullet
  "Hosts typically raise prices much closer to the date — pricing earlier captures the highest-intent guests",
];

const VERY_LATE_WHY_BULLETS = [
  "Unbooked nights this close to a high-demand date rarely recover",
  "Pricing at or just below market increases visibility against late-shopping guests",
];

export interface NightRecommendation {
  date: string;
  event_label: string;
  event_name: string;
  bucket: Bucket;
  badge: "forward_demand" | "time_pressure";
  comp_median: number;
  recommended_low: number;
  recommended_high: number;
  recommended_apply_price: number;
  headline: string;
  supporting_line: string | null;
  why_bullets: string[];
  suggested_action: string[];
  transition_message: string | null;
}

export interface ForwardDemandResult {
  qualifying_nights: NightRecommendation[];
  all_nights_count: number;
  qualifying_count: number;
  /** Why the gate did or didn't fire. Always present for transparency. */
  gate: {
    event_label: string | null;
    event_name: string | null;
    calibration_signal_available: boolean;
    suppression_reason: string | null;
    observed_ratio: number | null;
    threshold: number;
    snapshot_run_at: string | null;
    snapshot_age_days: number | null;
    hood_resolved: string | null;
    hood_input: string;
  };
}

function buildSuggestedAction(bucket: Bucket, applyPrice: number): string[] {
  switch (bucket) {
    case "early":
      return [
        `Set $${applyPrice} for this night`,
        "Re-check in 3 weeks — if comps start moving, you can raise",
      ];
    case "mid":
      return [
        `Set $${applyPrice} to stay a step ahead of comps`,
        "Re-check in 2 weeks",
      ];
    case "late":
      return [
        `Hold around $${applyPrice}`,
        "Re-check in one week",
      ];
    case "very_late":
      return [
        `Set $${applyPrice} to prioritize getting booked`,
        "Re-check daily",
      ];
  }
}

/**
 * Compose the forward-demand response for a date range and a comp median.
 *
 * @param hoodInput   Free-form hood label from the request (e.g., "Zona Romántica")
 * @param checkIn     YYYY-MM-DD
 * @param checkOut    YYYY-MM-DD (exclusive — last night = checkOut - 1)
 * @param compMedian  Comp-engine median nightly price for the request
 * @param now         Reference "today" — defaults to new Date()
 */
export function composeForwardDemand(
  hoodInput: string,
  checkIn: string,
  checkOut: string,
  compMedian: number,
  now: Date = new Date(),
): ForwardDemandResult {
  // Iterate nights from checkIn (inclusive) to checkOut (exclusive).
  const start = new Date(checkIn + "T00:00:00Z");
  const end = new Date(checkOut + "T00:00:00Z");
  const allNights: string[] = [];
  for (
    let d = new Date(start);
    d.getTime() < end.getTime();
    d = new Date(d.getTime() + 86_400_000)
  ) {
    allNights.push(d.toISOString().slice(0, 10));
  }

  const hoodResolved = normalizeHoodForForwardDemand(hoodInput);

  // Find the first Tier 1 event that overlaps any of the requested nights AND
  // whose hood list contains the resolved hood. We only support one event per
  // request in v1 (event windows do not overlap among Tier 1 events).
  const matchedEvent = hoodResolved
    ? TIER_1_EVENTS.find((e) => {
        if (!e.hoods.includes(hoodResolved)) return false;
        const eStart = new Date(e.startDate + "T00:00:00Z").getTime();
        const eEnd = new Date(e.endDate + "T00:00:00Z").getTime();
        return allNights.some((n) => {
          const t = new Date(n + "T00:00:00Z").getTime();
          return t >= eStart && t <= eEnd;
        });
      })
    : null;

  const baseGate = {
    event_label: matchedEvent?.label ?? null,
    event_name: matchedEvent?.name ?? null,
    threshold: FLAT_THRESHOLD,
    hood_input: hoodInput,
    hood_resolved: hoodResolved,
  };

  if (!hoodResolved) {
    return {
      qualifying_nights: [],
      all_nights_count: allNights.length,
      qualifying_count: 0,
      gate: {
        ...baseGate,
        calibration_signal_available: false,
        suppression_reason: "hood_not_supported",
        observed_ratio: null,
        snapshot_run_at: null,
        snapshot_age_days: null,
      },
    };
  }
  if (!matchedEvent) {
    return {
      qualifying_nights: [],
      all_nights_count: allNights.length,
      qualifying_count: 0,
      gate: {
        ...baseGate,
        calibration_signal_available: false,
        suppression_reason: "no_tier1_event_in_range",
        observed_ratio: null,
        snapshot_run_at: null,
        snapshot_age_days: null,
      },
    };
  }

  const gateResult = checkCalibrationGate(matchedEvent, now);
  if (!gateResult.triggerOk) {
    return {
      qualifying_nights: [],
      all_nights_count: allNights.length,
      qualifying_count: 0,
      gate: {
        ...baseGate,
        calibration_signal_available: gateResult.reason !== "no_calibration_folder"
          && gateResult.reason !== "no_snapshots_in_folder",
        suppression_reason: gateResult.reason ?? "unknown",
        observed_ratio: gateResult.observedRatio ?? null,
        snapshot_run_at: gateResult.snapshotRunAt ?? null,
        snapshot_age_days: gateResult.snapshotAgeDays ?? null,
      },
    };
  }

  // Gate passed. Build per-night recommendations for nights inside the event.
  const eStart = new Date(matchedEvent.startDate + "T00:00:00Z").getTime();
  const eEnd = new Date(matchedEvent.endDate + "T00:00:00Z").getTime();

  const qualifying: NightRecommendation[] = [];
  for (const nightStr of allNights) {
    const nightT = new Date(nightStr + "T00:00:00Z").getTime();
    if (nightT < eStart || nightT > eEnd) continue;

    const nightDate = new Date(nightStr + "T00:00:00Z");
    const daysToEvent = daysBetween(now, nightDate);
    // Past dates: skip — forward-demand is forward-only.
    if (daysToEvent < 0) continue;

    const bucket = bucketFor(daysToEvent);
    const band = bandFor(bucket, compMedian);

    const isVeryLate = bucket === "very_late";
    const whyBullets = isVeryLate
      ? VERY_LATE_WHY_BULLETS
      : [WHY_FALLBACK_BULLETS[0], matchedEvent.eventBullet, WHY_FALLBACK_BULLETS[1]];

    qualifying.push({
      date: nightStr,
      event_label: matchedEvent.label,
      event_name: matchedEvent.name,
      bucket,
      badge: isVeryLate ? "time_pressure" : "forward_demand",
      comp_median: Math.round(compMedian),
      recommended_low: band.low,
      recommended_high: band.high,
      recommended_apply_price: band.apply,
      headline: isVeryLate
        ? "Pride is close — booking matters more than premium now."
        : HEADLINE,
      supporting_line: isVeryLate ? null : SUPPORTING_LINE,
      why_bullets: whyBullets,
      suggested_action: buildSuggestedAction(bucket, band.apply),
      transition_message: isVeryLate ? VERY_LATE_TRANSITION : null,
    });
  }

  return {
    qualifying_nights: qualifying,
    all_nights_count: allNights.length,
    qualifying_count: qualifying.length,
    gate: {
      ...baseGate,
      calibration_signal_available: true,
      suppression_reason: null,
      observed_ratio: gateResult.observedRatio ?? null,
      snapshot_run_at: gateResult.snapshotRunAt ?? null,
      snapshot_age_days: gateResult.snapshotAgeDays ?? null,
    },
  };
}
