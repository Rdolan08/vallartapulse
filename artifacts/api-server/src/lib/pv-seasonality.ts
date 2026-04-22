/**
 * pv-seasonality.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Puerto Vallarta seasonal pricing calendar.
 *
 * ARCHITECTURE
 * ────────────
 * Pricing is the product of two independent layers:
 *
 *   1. MONTHLY FACTORS  — background demand level for the calendar month,
 *      stripped of any event-driven surge. November = 1.00 baseline.
 *      e.g. April 1.00 (high-shoulder transition, no Easter bake-in),
 *      September 0.68 (deep rainy-season trough).
 *
 *   2. EVENT OVERLAYS   — date-bound premium that stacks on top of the
 *      monthly factor ONLY for nights inside an explicit ISO date window.
 *      Each event has a CORE window (full multiplier) and an optional
 *      SHOULDER window (lower multiplier, captures decay around the event).
 *      Date-shifting events (Easter, MLK, Canadian / US Thanksgiving) have
 *      explicit per-year entries so the date is never assumed.
 *
 * For multi-night stays, callers should use getStayWindowSeasonalContext()
 * which evaluates each night individually and arithmetically averages the
 * per-night multipliers, so partial-overlap windows decay naturally. That
 * call also populates an `eventAudit` array — one entry per night — for
 * full pricing explainability.
 *
 * For requests without dates (month-only), we return the monthly factor
 * with NO event premium — the caller did not commit to a date range, so
 * no event can be assumed to apply.
 *
 * SCHEMA VERSIONING
 * ─────────────────
 * EVENT_RULES_SCHEMA_VERSION is bumped whenever the EventOverlay shape or
 * audit contract changes in a non-additive way. Phase A = 1.
 */

export const EVENT_RULES_SCHEMA_VERSION = 1 as const;

export type SeasonLabel = "peak" | "high" | "shoulder" | "low";
export type EventPhase = "core" | "shoulder";
export type DateConfidence = "confirmed" | "derived" | "tentative";

export interface MonthFactor {
  month: number;          // 1–12
  name: string;           // "January"
  abbr: string;           // "Jan"
  multiplier: number;     // background demand only, relative to Nov = 1.00
  season: SeasonLabel;
  note: string;           // display-friendly explanation
}

// ── Reserved for Phase B/C (zone + property type) ────────────────────────────
// These fields can exist in EventOverlay entries today but are NOT consumed by
// any pricing math in Phase A. They are wire-format only, kept here so future
// rule authors can start populating them now.

export interface EventImpactZone {
  neighborhoodKey: string;
  multiplier: number;
  notes?: string;
}

export interface PropertyTypeAdjustment {
  propertyType: "condo" | "villa" | "luxury";
  multiplier: number;
  notes?: string;
}

export interface EventOverlay {
  // Identity
  key: string;            // stable identifier, used in audit array (e.g. "easter_2026")
  name: string;           // display name, e.g. "Easter / Semana Santa"

  // Core window — full event multiplier applies to nights inside [startDate, endDate]
  startDate: string;      // ISO YYYY-MM-DD inclusive
  endDate: string;        // ISO YYYY-MM-DD inclusive
  additionalPct: number;  // stacked on top of monthly multiplier; 0.18 = +18%

  // Shoulder window (optional) — reduced premium for decay around the core window
  shoulderStartDate?: string;
  shoulderEndDate?: string;
  shoulderPct?: number;   // when omitted, falls back to additionalPct

  // Provenance & resolution
  priority?: number;          // higher wins same-night conflicts; default 50
  dateConfidence?: DateConfidence;
  sourceRefs?: string[];

  // Display
  description: string;

  // ── Reserved for Phase B/C (NOT consumed in Phase A) ──
  eventImpactZones?: EventImpactZone[];
  propertyTypeAdjustments?: PropertyTypeAdjustment[];
}

// ── Per-night audit (Phase A) ────────────────────────────────────────────────
// Emitted by getStayWindowSeasonalContext() so the API can surface exactly
// which event matched each night and what multiplier was applied. In Phase A,
// `multiplier_applied` is the raw event multiplier (1.0 when no event matched).
// In Phase C this becomes the product of base × zone × propertyType, but the
// field name and meaning ("the event multiplier we ultimately applied") stay
// stable across phases. A nested `breakdown` sub-object will be added later.

export interface EventOverlayNightAudit {
  date: string;                          // ISO YYYY-MM-DD
  matched_event_key: string | null;
  matched_event_name: string | null;
  phase: EventPhase | null;
  multiplier_applied: number;            // 1.0 = neutral / no event
  source: "event_overlay" | "none";
}

export interface EventAudit {
  schema_version: typeof EVENT_RULES_SCHEMA_VERSION;
  nights: EventOverlayNightAudit[];
}

export interface SeasonalContext {
  month: number;
  monthName: string;
  monthAbbr: string;
  season: SeasonLabel;
  monthlyMultiplier: number;
  monthlyNote: string;
  activeEvent: EventOverlay | null;
  totalMultiplier: number;        // monthlyMultiplier × (1 + eventPremium)
  eventPremiumPct: number | null; // e.g. 0.18 for +18%
  displayLabel: string;
  /** Per-night audit array. Populated only by getStayWindowSeasonalContext. */
  eventAudit: EventAudit | null;
}

// ── Monthly factors (background demand only — NO event premium baked in) ─────

export const PV_MONTHLY_FACTORS: MonthFactor[] = [
  {
    month: 1, name: "January", abbr: "Jan",
    multiplier: 1.02, season: "high",
    note: "High season established — steady post-NYE demand (MLK weekend handled as event)",
  },
  {
    month: 2, name: "February", abbr: "Feb",
    multiplier: 1.05, season: "peak",
    note: "Peak weather, peak high season (Bear Week, Valentine's, golf handled as events)",
  },
  {
    month: 3, name: "March", abbr: "Mar",
    multiplier: 1.05, season: "peak",
    note: "Peak weather and high background demand (Spring Break handled as event)",
  },
  {
    month: 4, name: "April", abbr: "Apr",
    multiplier: 1.00, season: "high",
    note: "High-to-shoulder transition; clean baseline (Easter / Semana Santa handled as event)",
  },
  {
    month: 5, name: "May", abbr: "May",
    multiplier: 0.93, season: "shoulder",
    note: "Shoulder — heat building, post-Easter softening (Pride PV handled as event)",
  },
  {
    month: 6, name: "June", abbr: "Jun",
    multiplier: 0.82, season: "low",
    note: "Rainy season begins; meaningful drop in leisure travel",
  },
  {
    month: 7, name: "July", abbr: "Jul",
    multiplier: 0.76, season: "low",
    note: "Deep rainy season; Mexican domestic travel partially offsets",
  },
  {
    month: 8, name: "August", abbr: "Aug",
    multiplier: 0.74, season: "low",
    note: "Deep rainy season — among the weakest months",
  },
  {
    month: 9, name: "September", abbr: "Sep",
    multiplier: 0.68, season: "low",
    note: "Weakest month of the year — peak rain, minimal international travel",
  },
  {
    month: 10, name: "October", abbr: "Oct",
    multiplier: 0.84, season: "shoulder",
    note: "Recovery into high season (Canadian Thanksgiving handled as event)",
  },
  {
    month: 11, name: "November", abbr: "Nov",
    multiplier: 0.95, season: "high",
    note: "High season starting — baseline (US Thanksgiving handled as event)",
  },
  {
    month: 12, name: "December", abbr: "Dec",
    multiplier: 0.95, season: "high",
    note: "Pre-holiday lull through mid-month (Christmas / NYE handled as events)",
  },
];

// ── Event overlays ───────────────────────────────────────────────────────────
// All currently-live event windows are preserved exactly. Phase A backfill:
// every entry now carries `key`, `priority`, `dateConfidence`, `sourceRefs`.
// The single intentional behavior change is the Easter / Semana Santa split:
// the existing 3/29-4/12 window (and 2025/2027 equivalents) is decomposed into
// CORE = Holy Week (additionalPct +18%) + SHOULDER = Pascua week (+8%). The
// date coverage is identical to today's production; the magnitude on Pascua
// week becomes more conservative.
//
// Priority bands (higher wins same-night conflicts):
//   100 — sharp identity / circuit events (BeefDip, Pride PV)
//    90 — major holiday peaks (Christmas, NYE, Easter core)
//    80 — strong domestic surges (Easter shoulder, Spring Break)
//    60 — secondary national holidays (US/Canadian Thanksgiving, MLK, Bear Week)
//    50 — modest specific events (Valentine's, Golf, etc.)

export const PV_EVENT_OVERLAYS: EventOverlay[] = [
  // ── Christmas Week (fixed, recurring) ──
  {
    key: "christmas_week_2025", name: "Christmas Week",
    startDate: "2025-12-22", endDate: "2025-12-31",
    additionalPct: 0.20,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV",
  },
  {
    key: "christmas_week_2026", name: "Christmas Week",
    startDate: "2026-12-22", endDate: "2026-12-31",
    additionalPct: 0.20,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV",
  },
  {
    key: "christmas_week_2027", name: "Christmas Week",
    startDate: "2027-12-22", endDate: "2027-12-31",
    additionalPct: 0.20,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV",
  },

  // ── New Year's (fixed, spans year boundary) ──
  {
    key: "new_years_2025_2026", name: "New Year's Eve / New Year's",
    startDate: "2025-12-30", endDate: "2026-01-01",
    additionalPct: 0.30,
    priority: 95, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges",
  },
  {
    key: "new_years_2026_2027", name: "New Year's Eve / New Year's",
    startDate: "2026-12-30", endDate: "2027-01-01",
    additionalPct: 0.30,
    priority: 95, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges",
  },
  {
    key: "new_years_2027_2028", name: "New Year's Eve / New Year's",
    startDate: "2027-12-30", endDate: "2028-01-01",
    additionalPct: 0.30,
    priority: 95, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges",
  },

  // ── MLK Weekend (3rd Mon of Jan, US) ──
  {
    key: "mlk_2026", name: "MLK Weekend",
    startDate: "2026-01-16", endDate: "2026-01-19",
    additionalPct: 0.08,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["us-federal-holiday-calendar"],
    description: "Jan 16–19, 2026 — US long weekend (MLK Mon Jan 19) drives PV bookings",
  },
  {
    key: "mlk_2027", name: "MLK Weekend",
    startDate: "2027-01-15", endDate: "2027-01-18",
    additionalPct: 0.08,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["us-federal-holiday-calendar"],
    description: "Jan 15–18, 2027 — US long weekend (MLK Mon Jan 18) drives PV bookings",
  },

  // ── Bear Week / Beef Dip (early Feb, fixed-ish) ──
  {
    key: "bear_week_2026", name: "Bear Week / Beef Dip",
    startDate: "2026-02-05", endDate: "2026-02-13",
    additionalPct: 0.20,
    priority: 60, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "First/second week of February — major LGBTQ+ demand event in PV",
    // Phase B explanatory-only seed (NOT applied to price; visible in audit)
    eventImpactZones: [
      { neighborhoodKey: "zona_romantica", multiplier: 1.18, notes: "Primary zone" },
      { neighborhoodKey: "amapas",         multiplier: 1.08, notes: "Strong spillover" },
      { neighborhoodKey: "conchas_chinas", multiplier: 1.04, notes: "Luxury spillover" },
    ],
  },
  {
    key: "bear_week_2027", name: "Bear Week / Beef Dip",
    startDate: "2027-02-04", endDate: "2027-02-12",
    additionalPct: 0.20,
    priority: 60, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "First/second week of February — major LGBTQ+ demand event in PV",
    // Phase B explanatory-only seed (NOT applied to price; visible in audit)
    eventImpactZones: [
      { neighborhoodKey: "zona_romantica", multiplier: 1.18, notes: "Primary zone" },
      { neighborhoodKey: "amapas",         multiplier: 1.08, notes: "Strong spillover" },
      { neighborhoodKey: "conchas_chinas", multiplier: 1.04, notes: "Luxury spillover" },
    ],
  },

  // ── Valentine's (fixed) ──
  {
    key: "valentines_2026", name: "Valentine's Day",
    startDate: "2026-02-12", endDate: "2026-02-16",
    additionalPct: 0.08,
    priority: 50, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Mid-February couples travel; moderate uplift",
  },
  {
    key: "valentines_2027", name: "Valentine's Day",
    startDate: "2027-02-12", endDate: "2027-02-16",
    additionalPct: 0.08,
    priority: 50, dateConfidence: "confirmed",
    sourceRefs: ["fixed-calendar"],
    description: "Mid-February couples travel; moderate uplift",
  },

  // ── Golf Tournament Season (mid-Feb, fixed-ish) ──
  {
    key: "golf_2026", name: "Golf Tournament Season",
    startDate: "2026-02-18", endDate: "2026-02-24",
    additionalPct: 0.08,
    priority: 50, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Mid-Feb PV golf events; premium concentrated in Marina Vallarta / Hotel Zone",
  },
  {
    key: "golf_2027", name: "Golf Tournament Season",
    startDate: "2027-02-17", endDate: "2027-02-23",
    additionalPct: 0.08,
    priority: 50, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Mid-Feb PV golf events; premium concentrated in Marina Vallarta / Hotel Zone",
  },

  // ── Spring Break (early/mid March, fixed-ish) ──
  {
    key: "spring_break_2026", name: "Spring Break",
    startDate: "2026-03-07", endDate: "2026-03-25",
    additionalPct: 0.15,
    priority: 80, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Mar 7–25, 2026 — US/Canada Spring Break, peak occupancy period",
  },
  {
    key: "spring_break_2027", name: "Spring Break",
    startDate: "2027-03-06", endDate: "2027-03-24",
    additionalPct: 0.15,
    priority: 80, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Mar 6–24, 2027 — US/Canada Spring Break, peak occupancy period",
  },

  // ── Easter / Semana Santa (anchored to Easter Sunday per year) ──
  // Phase A split: CORE = Holy Week (Mon→Easter Sun, +18%),
  //                SHOULDER = Pascua week (Easter Mon→following Sun, +8%).
  // Date coverage identical to prior single-block 2025-04-13..2025-04-27,
  // 2026-03-29..2026-04-12, 2027-03-22..2027-04-04 — only the magnitude
  // on the Pascua half decays, which is the single intentional change.
  {
    key: "easter_2025", name: "Easter / Semana Santa",
    startDate: "2025-04-13", endDate: "2025-04-20",      // Holy Week (Easter Sun Apr 20)
    additionalPct: 0.18,
    shoulderStartDate: "2025-04-21", shoulderEndDate: "2025-04-27",
    shoulderPct: 0.08,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: ["mexican-civic-calendar-2025"],
    description: "Holy Week Apr 13–20, 2025 (core) + Pascua Apr 21–27 (shoulder); domestic Mexican + US demand spike",
  },
  {
    key: "easter_2026", name: "Easter / Semana Santa",
    startDate: "2026-03-29", endDate: "2026-04-05",      // Holy Week (Easter Sun Apr 5)
    additionalPct: 0.18,
    shoulderStartDate: "2026-04-06", shoulderEndDate: "2026-04-12",
    shoulderPct: 0.08,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: [
      "https://elpais.com/mexico/2026-03-31/semana-santa-en-mexico-2026-cuando-son-las-vacaciones-cuanto-duran-dias-clave-y-tradiciones-de-la-temporada.html",
    ],
    description: "Holy Week Mar 29–Apr 5, 2026 (core) + Pascua Apr 6–12 (shoulder); domestic Mexican + US demand spike",
  },
  {
    key: "easter_2027", name: "Easter / Semana Santa",
    startDate: "2027-03-22", endDate: "2027-03-28",      // Holy Week (Easter Sun Mar 28)
    additionalPct: 0.18,
    shoulderStartDate: "2027-03-29", shoulderEndDate: "2027-04-04",
    shoulderPct: 0.08,
    priority: 90, dateConfidence: "confirmed",
    sourceRefs: ["mexican-civic-calendar-2027"],
    description: "Holy Week Mar 22–28, 2027 (core) + Pascua Mar 29–Apr 4 (shoulder); domestic Mexican + US demand spike",
  },

  // ── Pride PV (late May, fixed-ish) ──
  {
    key: "pride_pv_2026", name: "Pride PV",
    startDate: "2026-05-20", endDate: "2026-05-28",
    additionalPct: 0.12,
    priority: 100, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Late May — PV Pride festival; ZR and LGBT-friendly properties see premium",
    // Phase B explanatory-only seed (NOT applied to price; visible in audit)
    eventImpactZones: [
      { neighborhoodKey: "zona_romantica", multiplier: 1.12, notes: "Primary zone" },
      { neighborhoodKey: "amapas",         multiplier: 1.06, notes: "Strong spillover" },
      { neighborhoodKey: "conchas_chinas", multiplier: 1.03, notes: "Luxury spillover" },
    ],
  },
  {
    key: "pride_pv_2027", name: "Pride PV",
    startDate: "2027-05-19", endDate: "2027-05-27",
    additionalPct: 0.12,
    priority: 100, dateConfidence: "tentative",
    sourceRefs: ["historical-pv-event-pattern"],
    description: "Late May — PV Pride festival; ZR and LGBT-friendly properties see premium",
    // Phase B explanatory-only seed (NOT applied to price; visible in audit)
    eventImpactZones: [
      { neighborhoodKey: "zona_romantica", multiplier: 1.12, notes: "Primary zone" },
      { neighborhoodKey: "amapas",         multiplier: 1.06, notes: "Strong spillover" },
      { neighborhoodKey: "conchas_chinas", multiplier: 1.03, notes: "Luxury spillover" },
    ],
  },

  // ── Canadian Thanksgiving (2nd Mon of Oct) ──
  {
    key: "canadian_thanksgiving_2025", name: "Canadian Thanksgiving",
    startDate: "2025-10-11", endDate: "2025-10-13",
    additionalPct: 0.06,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["canadian-federal-holiday-calendar"],
    description: "Oct 11–13, 2025 — Canadian long weekend (Mon Oct 13); modest snowbird uplift",
  },
  {
    key: "canadian_thanksgiving_2026", name: "Canadian Thanksgiving",
    startDate: "2026-10-10", endDate: "2026-10-12",
    additionalPct: 0.06,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["canadian-federal-holiday-calendar"],
    description: "Oct 10–12, 2026 — Canadian long weekend (Mon Oct 12); modest snowbird uplift",
  },
  {
    key: "canadian_thanksgiving_2027", name: "Canadian Thanksgiving",
    startDate: "2027-10-09", endDate: "2027-10-11",
    additionalPct: 0.06,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["canadian-federal-holiday-calendar"],
    description: "Oct 9–11, 2027 — Canadian long weekend (Mon Oct 11); modest snowbird uplift",
  },

  // ── US Thanksgiving (4th Thu of Nov) ──
  {
    key: "us_thanksgiving_2025", name: "US Thanksgiving",
    startDate: "2025-11-26", endDate: "2025-11-30",
    additionalPct: 0.10,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["us-federal-holiday-calendar"],
    description: "Nov 26–30, 2025 — US Thanksgiving (Thu Nov 27); strong travel from US market",
  },
  {
    key: "us_thanksgiving_2026", name: "US Thanksgiving",
    startDate: "2026-11-25", endDate: "2026-11-29",
    additionalPct: 0.10,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["us-federal-holiday-calendar"],
    description: "Nov 25–29, 2026 — US Thanksgiving (Thu Nov 26); strong travel from US market",
  },
  {
    key: "us_thanksgiving_2027", name: "US Thanksgiving",
    startDate: "2027-11-24", endDate: "2027-11-28",
    additionalPct: 0.10,
    priority: 60, dateConfidence: "confirmed",
    sourceRefs: ["us-federal-holiday-calendar"],
    description: "Nov 24–28, 2027 — US Thanksgiving (Thu Nov 25); strong travel from US market",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the monthly factor for a given month number (1–12). */
export function getMonthFactor(month: number): MonthFactor {
  const factor = PV_MONTHLY_FACTORS.find((f) => f.month === month);
  if (!factor) {
    return PV_MONTHLY_FACTORS[10]!;
  }
  return factor;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Effective premium for an event in a given phase. Shoulder falls back to
 * `additionalPct` when `shoulderPct` is omitted (defensive — current seed set
 * always specifies shoulderPct when a shoulder window exists).
 */
function effectivePremium(event: EventOverlay, phase: EventPhase): number {
  return phase === "core" ? event.additionalPct : (event.shoulderPct ?? event.additionalPct);
}

/**
 * Find the event matching a specific date, with phase. Returns null when no
 * event covers the date. When multiple events overlap on the same night,
 * resolution is:
 *
 *   1. Highest `priority` wins (default 50 when omitted).
 *   2. Tie-break on the highest effective premium for the phase that matched.
 *
 * Phase A explicitly does NOT stack overlapping events. Multi-event stacking
 * is a known limitation and is reserved for a future phase.
 */
export function getActiveEventForDate(
  date: Date,
): { event: EventOverlay; phase: EventPhase } | null {
  const iso = isoDay(date);
  const matches: Array<{ event: EventOverlay; phase: EventPhase; eff: number }> = [];

  for (const e of PV_EVENT_OVERLAYS) {
    if (iso >= e.startDate && iso <= e.endDate) {
      matches.push({ event: e, phase: "core", eff: effectivePremium(e, "core") });
    } else if (
      e.shoulderStartDate &&
      e.shoulderEndDate &&
      iso >= e.shoulderStartDate &&
      iso <= e.shoulderEndDate
    ) {
      matches.push({ event: e, phase: "shoulder", eff: effectivePremium(e, "shoulder") });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const pa = a.event.priority ?? 50;
    const pb = b.event.priority ?? 50;
    if (pb !== pa) return pb - pa;
    return b.eff - a.eff;
  });
  const best = matches[0]!;
  return { event: best.event, phase: best.phase };
}

/**
 * Get the seasonal context for a given month or specific date.
 *
 *   • Number argument → month-only, no event premium (caller did not commit
 *     to a date range, so no event can be assumed). totalMultiplier equals
 *     the monthly background factor. eventAudit is null.
 *   • Date argument   → date-aware, applies the event overlay active on that
 *     specific calendar day if any. eventAudit is null (single-date callers
 *     are not stay-window contexts).
 */
export function getSeasonalContext(monthOrDate: number | Date): SeasonalContext {
  if (monthOrDate instanceof Date) {
    const month = monthOrDate.getUTCMonth() + 1;
    const factor = getMonthFactor(month);
    const matched = getActiveEventForDate(monthOrDate);
    const eventPremiumPct = matched ? effectivePremium(matched.event, matched.phase) : null;
    const totalMultiplier = eventPremiumPct != null
      ? factor.multiplier * (1 + eventPremiumPct)
      : factor.multiplier;

    let displayLabel = `${factor.name} (${capitalize(factor.season)} Season)`;
    if (matched) {
      displayLabel += ` — ${matched.event.name}${matched.phase === "shoulder" ? " (shoulder)" : ""}`;
    }

    return {
      month,
      monthName: factor.name,
      monthAbbr: factor.abbr,
      season: factor.season,
      monthlyMultiplier: factor.multiplier,
      monthlyNote: factor.note,
      activeEvent: matched?.event ?? null,
      totalMultiplier,
      eventPremiumPct,
      displayLabel,
      eventAudit: null,
    };
  }

  const month = monthOrDate;
  const factor = getMonthFactor(month);
  return {
    month,
    monthName: factor.name,
    monthAbbr: factor.abbr,
    season: factor.season,
    monthlyMultiplier: factor.multiplier,
    monthlyNote: factor.note,
    activeEvent: null,
    totalMultiplier: factor.multiplier,
    eventPremiumPct: null,
    displayLabel: `${factor.name} (${capitalize(factor.season)} Season) — month baseline`,
    eventAudit: null,
  };
}

/**
 * Compute a date-aware seasonal context for an explicit stay window
 * [checkIn, checkOut). Each night is evaluated against the date overlay
 * independently and the per-night multipliers are arithmetically averaged.
 *
 * Phase A: also produces an `eventAudit` array — one entry per night —
 * recording which event matched, the phase (core / shoulder), and the
 * multiplier that was applied. The audit is the sole source of truth for
 * pricing explainability.
 *
 * Examples (April 2026, Easter Sun Apr 5, core 3/29–4/5, shoulder 4/6–4/12):
 *   • Stay 4/22–4/28 (no overlap)           → 1.000 (April baseline)
 *   • Stay 4/13–4/19 (no overlap)           → 1.000 (April baseline)
 *   • Stay 4/01–4/06 (5/5 nights core)      → 1.180 (full Holy Week)
 *   • Stay 4/06–4/13 (7/7 nights shoulder)  → 1.080 (Pascua shoulder)
 *   • Stay 4/01–4/15 mixed                  → ~1.104 weighted
 */
export function getStayWindowSeasonalContext(
  checkIn: Date,
  checkOut: Date,
): SeasonalContext {
  const nights: Date[] = [];
  for (
    let d = new Date(checkIn);
    d < checkOut;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    nights.push(new Date(d));
  }
  if (nights.length === 0) {
    return getSeasonalContext(checkIn.getUTCMonth() + 1);
  }

  let multSum = 0;
  let monthlyMultSum = 0;
  const overlappingEvents = new Map<string, EventOverlay>();
  const auditNights: EventOverlayNightAudit[] = [];

  for (const night of nights) {
    const factor = getMonthFactor(night.getUTCMonth() + 1);
    const matched = getActiveEventForDate(night);
    const pct = matched ? effectivePremium(matched.event, matched.phase) : 0;

    monthlyMultSum += factor.multiplier;
    multSum += factor.multiplier * (1 + pct);
    if (matched) overlappingEvents.set(matched.event.key, matched.event);

    auditNights.push({
      date: isoDay(night),
      matched_event_key: matched?.event.key ?? null,
      matched_event_name: matched?.event.name ?? null,
      phase: matched?.phase ?? null,
      multiplier_applied: parseFloat((1 + pct).toFixed(4)),
      source: matched ? "event_overlay" : "none",
    });
  }

  const totalMultiplier = multSum / nights.length;
  const monthlyMultiplier = monthlyMultSum / nights.length;

  // Highest-priority event among those that touched any night (display label only).
  const sortedEvents = [...overlappingEvents.values()].sort((a, b) => {
    const pa = a.priority ?? 50;
    const pb = b.priority ?? 50;
    if (pb !== pa) return pb - pa;
    return b.additionalPct - a.additionalPct;
  });
  const activeEvent = sortedEvents[0] ?? null;

  // eventPremiumPct reflects the *effective* premium across the whole stay
  // (i.e. how much of the event leaked into the average), not the headline
  // event rate. Keeps downstream UI honest about partial overlap.
  const effectiveEventPremium = monthlyMultiplier > 0
    ? totalMultiplier / monthlyMultiplier - 1
    : 0;
  const eventPremiumPct = activeEvent ? Math.max(0, effectiveEventPremium) : null;

  const dominantMonth = checkIn.getUTCMonth() + 1;
  const dominantFactor = getMonthFactor(dominantMonth);

  let displayLabel = `${dominantFactor.name} (${capitalize(dominantFactor.season)} Season)`;
  if (activeEvent) {
    displayLabel += ` — ${activeEvent.name} (partial-window adjusted)`;
  } else {
    displayLabel += " — clean window (no event overlap)";
  }

  return {
    month: dominantMonth,
    monthName: dominantFactor.name,
    monthAbbr: dominantFactor.abbr,
    season: dominantFactor.season,
    monthlyMultiplier,
    monthlyNote: dominantFactor.note,
    activeEvent,
    totalMultiplier,
    eventPremiumPct,
    displayLabel,
    eventAudit: {
      schema_version: EVENT_RULES_SCHEMA_VERSION,
      nights: auditNights,
    },
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Current month (1-indexed) based on server time. */
export function currentMonth(): number {
  return new Date().getMonth() + 1;
}

/** Season color for UI display. */
export function seasonColor(season: SeasonLabel): "emerald" | "blue" | "amber" | "orange" {
  switch (season) {
    case "peak":     return "blue";
    case "high":     return "emerald";
    case "shoulder": return "amber";
    case "low":      return "orange";
  }
}

// ── Neighborhood normalization (Phase B) ─────────────────────────────────────
// Maps the display strings used by /api/rental/comps requests to the
// snake_case keys used in EventOverlay.eventImpactZones[].neighborhoodKey.
// Phase B uses these only for explanatory zone audit output; no pricing math
// reads them today. Add new neighborhoods here as zone seeds expand.

export const NEIGHBORHOOD_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  "Zona Romantica":          "zona_romantica",
  "Old Town":                "zona_romantica",   // alias for ZR
  "Amapas":                  "amapas",
  "Conchas Chinas":          "conchas_chinas",
  "Centro":                  "centro",
  "5 de Diciembre":          "5_de_diciembre",
  "Hotel Zone":              "hotel_zone",
  "Versalles":               "versalles",
  "Marina Vallarta":         "marina_vallarta",
  "Nuevo Vallarta":          "nuevo_vallarta",
  "Bucerias":                "bucerias",
  "La Cruz de Huanacaxtle":  "la_cruz",
  "Punta Mita":              "punta_mita",
  "El Anclote":              "el_anclote",
  "Sayulita":                "sayulita",
  "San Pancho":              "san_pancho",
  "Mismaloya":               "mismaloya",
});

/** Normalize a display-name neighborhood to its snake_case key. Returns null
 *  for empty input. Falls back to a slugified form for unknown neighborhoods
 *  so future zone rules can match without requiring a code change to the map. */
export function normalizeNeighborhoodKey(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const direct = NEIGHBORHOOD_KEY_MAP[displayName];
  if (direct) return direct;
  return displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}
