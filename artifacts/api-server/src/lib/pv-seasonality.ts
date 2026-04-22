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
 *      monthly factor ONLY for nights inside the explicit ISO start/end
 *      window. e.g. Easter / Semana Santa adds +18% on dates 2026-03-29
 *      through 2026-04-12 and is invisible on every other date.
 *
 * Date-shifting events (Easter, MLK Weekend, Canadian / US Thanksgiving)
 * have explicit per-year entries — no month-level fallback that leaks
 * the highest-premium event into the entire month.
 *
 * For multi-night stays, callers should use getStayWindowSeasonalContext()
 * which evaluates each night individually and arithmetically averages the
 * per-night multipliers, so partial-overlap windows decay naturally.
 *
 * For requests without dates (month-only), we return the monthly factor
 * with NO event premium — the caller did not commit to a date range, so
 * no event can be assumed to apply.
 */

export type SeasonLabel = "peak" | "high" | "shoulder" | "low";

export interface MonthFactor {
  month: number;          // 1–12
  name: string;           // "January"
  abbr: string;           // "Jan"
  multiplier: number;     // background demand only, relative to Nov = 1.00
  season: SeasonLabel;
  note: string;           // display-friendly explanation
}

export interface EventOverlay {
  name: string;           // display name, e.g. "Bear Week / Beef Dip"
  startDate: string;      // ISO YYYY-MM-DD inclusive
  endDate: string;        // ISO YYYY-MM-DD inclusive
  additionalPct: number;  // stacked on top of monthly multiplier, e.g. 0.18 = +18%
  description: string;
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
  displayLabel: string;           // e.g. "April (High Season) — Easter / Semana Santa"
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

// ── Event overlays (explicit ISO date ranges) ────────────────────────────────
// Date-shifting events have one entry per year. Fixed-date events repeat with
// one entry per year so the date is always explicit and never assumed.
// Coverage: 2025-2027. Add future years as needed.

export const PV_EVENT_OVERLAYS: EventOverlay[] = [
  // ── Christmas Week (fixed) ──
  { name: "Christmas Week", startDate: "2025-12-22", endDate: "2025-12-31",
    additionalPct: 0.20,
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV" },
  { name: "Christmas Week", startDate: "2026-12-22", endDate: "2026-12-31",
    additionalPct: 0.20,
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV" },
  { name: "Christmas Week", startDate: "2027-12-22", endDate: "2027-12-31",
    additionalPct: 0.20,
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV" },

  // ── New Year's (fixed; spans year boundary) ──
  { name: "New Year's Eve / New Year's", startDate: "2025-12-30", endDate: "2026-01-01",
    additionalPct: 0.30,
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges" },
  { name: "New Year's Eve / New Year's", startDate: "2026-12-30", endDate: "2027-01-01",
    additionalPct: 0.30,
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges" },
  { name: "New Year's Eve / New Year's", startDate: "2027-12-30", endDate: "2028-01-01",
    additionalPct: 0.30,
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges" },

  // ── MLK Weekend (3rd Mon of Jan, US) ──
  { name: "MLK Weekend", startDate: "2026-01-16", endDate: "2026-01-19",
    additionalPct: 0.08,
    description: "Jan 16–19, 2026 — US long weekend (MLK Mon Jan 19) drives PV bookings" },
  { name: "MLK Weekend", startDate: "2027-01-15", endDate: "2027-01-18",
    additionalPct: 0.08,
    description: "Jan 15–18, 2027 — US long weekend (MLK Mon Jan 18) drives PV bookings" },

  // ── Bear Week / Beef Dip (early Feb, fixed-ish) ──
  { name: "Bear Week / Beef Dip", startDate: "2026-02-05", endDate: "2026-02-13",
    additionalPct: 0.20,
    description: "First/second week of February — major LGBTQ+ demand event in PV" },
  { name: "Bear Week / Beef Dip", startDate: "2027-02-04", endDate: "2027-02-12",
    additionalPct: 0.20,
    description: "First/second week of February — major LGBTQ+ demand event in PV" },

  // ── Valentine's (fixed) ──
  { name: "Valentine's Day", startDate: "2026-02-12", endDate: "2026-02-16",
    additionalPct: 0.08,
    description: "Mid-February couples travel; moderate uplift" },
  { name: "Valentine's Day", startDate: "2027-02-12", endDate: "2027-02-16",
    additionalPct: 0.08,
    description: "Mid-February couples travel; moderate uplift" },

  // ── Golf Tournament Season (mid-Feb, fixed-ish) ──
  { name: "Golf Tournament Season", startDate: "2026-02-18", endDate: "2026-02-24",
    additionalPct: 0.08,
    description: "Mid-Feb PV golf events; premium concentrated in Marina Vallarta / Hotel Zone" },
  { name: "Golf Tournament Season", startDate: "2027-02-17", endDate: "2027-02-23",
    additionalPct: 0.08,
    description: "Mid-Feb PV golf events; premium concentrated in Marina Vallarta / Hotel Zone" },

  // ── Spring Break (early/mid March, fixed-ish) ──
  { name: "Spring Break", startDate: "2026-03-07", endDate: "2026-03-25",
    additionalPct: 0.15,
    description: "Mar 7–25, 2026 — US/Canada Spring Break, peak occupancy period" },
  { name: "Spring Break", startDate: "2027-03-06", endDate: "2027-03-24",
    additionalPct: 0.15,
    description: "Mar 6–24, 2027 — US/Canada Spring Break, peak occupancy period" },

  // ── Easter / Semana Santa (anchored to actual Easter Sunday per year) ──
  // Holy Week (week BEFORE Easter Sunday) + Pascua (week AFTER) is the full
  // Mexican domestic travel premium window.
  { name: "Easter / Semana Santa", startDate: "2025-04-13", endDate: "2025-04-27",
    additionalPct: 0.18,
    description: "Apr 13–27, 2025 — Holy Week (Easter Sun Apr 20) + Pascua; domestic Mexican + US demand spike" },
  { name: "Easter / Semana Santa", startDate: "2026-03-29", endDate: "2026-04-12",
    additionalPct: 0.18,
    description: "Mar 29–Apr 12, 2026 — Holy Week (Easter Sun Apr 5) + Pascua; domestic Mexican + US demand spike" },
  { name: "Easter / Semana Santa", startDate: "2027-03-22", endDate: "2027-04-04",
    additionalPct: 0.18,
    description: "Mar 22–Apr 4, 2027 — Holy Week (Easter Sun Mar 28) + Pascua; domestic Mexican + US demand spike" },

  // ── Pride PV (late May, fixed) ──
  { name: "Pride PV", startDate: "2026-05-20", endDate: "2026-05-28",
    additionalPct: 0.12,
    description: "Late May — PV Pride festival; ZR and LGBT-friendly properties see premium" },
  { name: "Pride PV", startDate: "2027-05-19", endDate: "2027-05-27",
    additionalPct: 0.12,
    description: "Late May — PV Pride festival; ZR and LGBT-friendly properties see premium" },

  // ── Canadian Thanksgiving (2nd Mon of Oct) ──
  { name: "Canadian Thanksgiving", startDate: "2025-10-11", endDate: "2025-10-13",
    additionalPct: 0.06,
    description: "Oct 11–13, 2025 — Canadian long weekend (Mon Oct 13); modest snowbird uplift" },
  { name: "Canadian Thanksgiving", startDate: "2026-10-10", endDate: "2026-10-12",
    additionalPct: 0.06,
    description: "Oct 10–12, 2026 — Canadian long weekend (Mon Oct 12); modest snowbird uplift" },
  { name: "Canadian Thanksgiving", startDate: "2027-10-09", endDate: "2027-10-11",
    additionalPct: 0.06,
    description: "Oct 9–11, 2027 — Canadian long weekend (Mon Oct 11); modest snowbird uplift" },

  // ── US Thanksgiving (4th Thu of Nov) ──
  { name: "US Thanksgiving", startDate: "2025-11-26", endDate: "2025-11-30",
    additionalPct: 0.10,
    description: "Nov 26–30, 2025 — US Thanksgiving (Thu Nov 27); strong travel from US market" },
  { name: "US Thanksgiving", startDate: "2026-11-25", endDate: "2026-11-29",
    additionalPct: 0.10,
    description: "Nov 25–29, 2026 — US Thanksgiving (Thu Nov 26); strong travel from US market" },
  { name: "US Thanksgiving", startDate: "2027-11-24", endDate: "2027-11-28",
    additionalPct: 0.10,
    description: "Nov 24–28, 2027 — US Thanksgiving (Thu Nov 25); strong travel from US market" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the monthly factor for a given month number (1–12). */
export function getMonthFactor(month: number): MonthFactor {
  const factor = PV_MONTHLY_FACTORS.find((f) => f.month === month);
  if (!factor) {
    // Default to November (baseline) for invalid inputs
    return PV_MONTHLY_FACTORS[10]!;
  }
  return factor;
}

function isoDay(date: Date): string {
  // UTC ISO YYYY-MM-DD
  return date.toISOString().slice(0, 10);
}

/**
 * Find the highest-premium event active on a specific date. Returns null if
 * no event covers that date — this is the desired behaviour. Events do NOT
 * leak across the rest of the calendar month.
 */
export function getActiveEventForDate(date: Date): EventOverlay | null {
  const iso = isoDay(date);
  const matches = PV_EVENT_OVERLAYS.filter(
    (e) => iso >= e.startDate && iso <= e.endDate,
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b.additionalPct - a.additionalPct)[0]!;
}

/**
 * Get the seasonal context for a given month or specific date.
 *
 *   • Number argument → month-only, no event premium (caller did not commit
 *     to a date range, so no event can be assumed). totalMultiplier equals
 *     the monthly background factor.
 *   • Date argument   → date-aware, applies the event overlay active on that
 *     specific calendar day if any.
 */
export function getSeasonalContext(monthOrDate: number | Date): SeasonalContext {
  if (monthOrDate instanceof Date) {
    const month = monthOrDate.getUTCMonth() + 1;
    const factor = getMonthFactor(month);
    const activeEvent = getActiveEventForDate(monthOrDate);
    const eventPremiumPct = activeEvent?.additionalPct ?? null;
    const totalMultiplier = eventPremiumPct != null
      ? factor.multiplier * (1 + eventPremiumPct)
      : factor.multiplier;

    let displayLabel = `${factor.name} (${capitalize(factor.season)} Season)`;
    if (activeEvent) displayLabel += ` — ${activeEvent.name}`;

    return {
      month,
      monthName: factor.name,
      monthAbbr: factor.abbr,
      season: factor.season,
      monthlyMultiplier: factor.multiplier,
      monthlyNote: factor.note,
      activeEvent,
      totalMultiplier,
      eventPremiumPct,
      displayLabel,
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
  };
}

/**
 * Compute a date-aware seasonal context for an explicit stay window
 * [checkIn, checkOut). Each night is evaluated against the date overlay
 * independently and the per-night multipliers are arithmetically averaged.
 *
 * Examples (April 2026, Easter Sun Apr 5, Semana Santa window 3/29–4/12):
 *   • Stay 4/13–4/19 (post-Easter, no overlap)        → ~1.00 (April baseline)
 *   • Stay 4/22–4/28 (post-Easter, no overlap)        → ~1.00 (April baseline)
 *   • Stay 4/01–4/05 (5/5 nights inside window)       → ~1.18 (full event)
 *   • Stay 4/01–4/15 (12/14 nights inside window)     → ~1.15 (partial decay)
 *
 * The activeEvent reported is the highest-premium event that overlapped at
 * least one night, used purely for display labelling.
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

  for (const night of nights) {
    const factor = getMonthFactor(night.getUTCMonth() + 1);
    const event = getActiveEventForDate(night);
    monthlyMultSum += factor.multiplier;
    multSum += factor.multiplier * (1 + (event?.additionalPct ?? 0));
    if (event) overlappingEvents.set(event.name, event);
  }

  const totalMultiplier = multSum / nights.length;
  const monthlyMultiplier = monthlyMultSum / nights.length;

  const sortedEvents = [...overlappingEvents.values()].sort(
    (a, b) => b.additionalPct - a.additionalPct,
  );
  const activeEvent = sortedEvents[0] ?? null;
  // eventPremiumPct reflects the *effective* premium across the whole stay
  // (i.e. how much of the event leaked into the average), not the headline
  // event rate. This keeps downstream UI honest about partial overlap.
  const effectiveEventPremium = monthlyMultiplier > 0
    ? totalMultiplier / monthlyMultiplier - 1
    : 0;
  const eventPremiumPct = activeEvent
    ? Math.max(0, effectiveEventPremium)
    : null;

  // Use the check-in month for display naming.
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
