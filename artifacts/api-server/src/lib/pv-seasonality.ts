/**
 * pv-seasonality.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Puerto Vallarta seasonal pricing calendar.
 *
 * PV has one of the most pronounced STR seasonality patterns in Mexico:
 *   Peak:     Feb, Mar — Spring Break, Bear Week, golf
 *   High:     Nov, Dec, Jan, Apr — holiday travel, Easter
 *   Shoulder: May, Oct — Pride, Canadian Thanksgiving
 *   Low:      Jun–Sep  — rainy season; September is the weakest month
 *
 * The monthly multipliers represent the ratio of expected market demand
 * relative to a "neutral" baseline (November = 1.00).
 *
 * Event overlays stack on top of the monthly base. If a user selects a month
 * without specifying a day, we return the "mid-month" event if one occupies
 * the majority of the month, otherwise we return the monthly base only.
 */

export type SeasonLabel = "peak" | "high" | "shoulder" | "low";

export interface MonthFactor {
  month: number;          // 1–12
  name: string;           // "January"
  abbr: string;           // "Jan"
  multiplier: number;     // relative to baseline (Nov = 1.00)
  season: SeasonLabel;
  note: string;           // display-friendly explanation
}

export interface EventOverlay {
  name: string;           // display name, e.g. "Bear Week / Beef Dip"
  month: number;          // approx calendar month
  approxStartDay: number; // approx day start in that month
  approxEndDay: number;   // approx day end (may span to next month for NYE)
  additionalPct: number;  // stacked on top of monthly multiplier, e.g. 0.20 = +20%
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
  eventPremiumPct: number | null; // e.g. 0.15 for +15%
  displayLabel: string;           // e.g. "March 2026 (Peak — Spring Break)"
}

// ── Monthly factors ───────────────────────────────────────────────────────────

export const PV_MONTHLY_FACTORS: MonthFactor[] = [
  {
    month: 1, name: "January", abbr: "Jan",
    multiplier: 1.08, season: "high",
    note: "Peak high season — post-NYE travelers, MLK weekend surge",
  },
  {
    month: 2, name: "February", abbr: "Feb",
    multiplier: 1.18, season: "peak",
    note: "Strongest high-season month — Bear Week / Beef Dip, golf, Carnival travel",
  },
  {
    month: 3, name: "March", abbr: "Mar",
    multiplier: 1.20, season: "peak",
    note: "Peak demand — US & Canadian Spring Break, highest overall occupancy",
  },
  {
    month: 4, name: "April", abbr: "Apr",
    multiplier: 1.10, season: "high",
    note: "Strong high season — Easter / Semana Santa surge mid-month",
  },
  {
    month: 5, name: "May", abbr: "May",
    multiplier: 0.97, season: "shoulder",
    note: "Pride PV (late May), softening after Easter; still decent occupancy",
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
    multiplier: 0.88, season: "shoulder",
    note: "Recovery into high season; Canadian Thanksgiving boost",
  },
  {
    month: 11, name: "November", abbr: "Nov",
    multiplier: 1.00, season: "high",
    note: "High season established — US Thanksgiving demand spike late month",
  },
  {
    month: 12, name: "December", abbr: "Dec",
    multiplier: 1.12, season: "peak",
    note: "High season with Christmas / New Year's Eve premium late month",
  },
];

// ── Event overlays ────────────────────────────────────────────────────────────
// These stack on top of the monthly multiplier when a date falls within range.
// additionalPct is additive: a month with multiplier 1.20 + event 0.15 → 1.38 total.

export const PV_EVENT_OVERLAYS: EventOverlay[] = [
  {
    name: "Christmas Week",
    month: 12, approxStartDay: 22, approxEndDay: 31,
    additionalPct: 0.20,
    description: "Dec 22–31 — Christmas travel and NYE build-up; premium applies across PV",
  },
  {
    name: "New Year's Eve / New Year's",
    month: 12, approxStartDay: 30, approxEndDay: 31,
    additionalPct: 0.30,
    description: "Dec 30–Jan 1 — peak of peak; many properties add NYE surcharges",
  },
  {
    name: "MLK Weekend",
    month: 1, approxStartDay: 13, approxEndDay: 19,
    additionalPct: 0.08,
    description: "3rd weekend of January — US long weekend drives PV bookings",
  },
  {
    name: "Bear Week / Beef Dip",
    month: 2, approxStartDay: 5, approxEndDay: 13,
    additionalPct: 0.20,
    description: "First or second week of February — major LGBTQ+ demand event in PV",
  },
  {
    name: "Valentine's Day",
    month: 2, approxStartDay: 12, approxEndDay: 16,
    additionalPct: 0.08,
    description: "Mid-February couples travel; moderate uplift",
  },
  {
    name: "Spring Break",
    month: 3, approxStartDay: 7, approxEndDay: 25,
    additionalPct: 0.15,
    description: "US/Canada Spring Break — peak occupancy period, property-type dependent",
  },
  {
    name: "Easter / Semana Santa",
    month: 4, approxStartDay: 10, approxEndDay: 22,
    additionalPct: 0.18,
    description: "Easter week (dates shift annually) — domestic Mexican and US demand spike",
  },
  {
    name: "Pride PV",
    month: 5, approxStartDay: 20, approxEndDay: 28,
    additionalPct: 0.12,
    description: "Late May — PV Pride festival; ZR and LGBT-friendly properties see premium",
  },
  {
    name: "Canadian Thanksgiving",
    month: 10, approxStartDay: 9, approxEndDay: 14,
    additionalPct: 0.06,
    description: "Canadian long weekend in October; moderate uplift from Canadian snowbirds",
  },
  {
    name: "US Thanksgiving",
    month: 11, approxStartDay: 27, approxEndDay: 30,
    additionalPct: 0.10,
    description: "US Thanksgiving weekend — strong travel from US market",
  },
  {
    name: "Golf Tournament Season",
    month: 2, approxStartDay: 18, approxEndDay: 24,
    additionalPct: 0.08,
    description: "Mid-Feb PV golf events; premium concentrated in Marina Vallarta / Hotel Zone",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get the monthly factor for a given month number (1–12). */
export function getMonthFactor(month: number): MonthFactor {
  const factor = PV_MONTHLY_FACTORS.find((f) => f.month === month);
  if (!factor) {
    // Default to November (1.00) for invalid inputs
    return PV_MONTHLY_FACTORS[10]!;
  }
  return factor;
}

/** Find the most significant event active during a given month + day range. */
export function getActiveEvent(month: number, day?: number): EventOverlay | null {
  const inMonth = PV_EVENT_OVERLAYS.filter((e) => e.month === month);
  if (inMonth.length === 0) return null;

  if (day != null) {
    // Find the highest-premium event that contains this day
    const active = inMonth
      .filter((e) => day >= e.approxStartDay && day <= e.approxEndDay)
      .sort((a, b) => b.additionalPct - a.additionalPct);
    return active[0] ?? null;
  }

  // No specific day — return the highest-premium event in the month
  return inMonth.sort((a, b) => b.additionalPct - a.additionalPct)[0] ?? null;
}

/**
 * Get the full seasonal context for a given month (and optional day).
 * This is the primary function called by the pricing engine.
 */
export function getSeasonalContext(month: number, day?: number): SeasonalContext {
  const factor = getMonthFactor(month);
  const activeEvent = getActiveEvent(month, day);

  const eventPremiumPct = activeEvent?.additionalPct ?? null;
  const totalMultiplier = eventPremiumPct != null
    ? factor.multiplier * (1 + eventPremiumPct)
    : factor.multiplier;

  let displayLabel = `${factor.name} (${factor.season.charAt(0).toUpperCase() + factor.season.slice(1)} Season)`;
  if (activeEvent) {
    displayLabel += ` — ${activeEvent.name}`;
  }

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

/**
 * Compute a date-aware seasonal context for an explicit stay window
 * [checkIn, checkOut). Avoids the month-level event-leak bug where a stay
 * window after a holiday (e.g. 4/22–4/28, after Semana Santa 4/10–4/22)
 * inherits the highest-premium event of the month.
 *
 * Per-night multipliers are computed via getSeasonalContext(month, day) and
 * arithmetically averaged across the stay. activeEvent and eventPremiumPct
 * are derived from events that actually overlap one or more nights of the
 * stay (highest-premium event wins for display).
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
    // Defensive — fall back to month-level context for the check-in month.
    return getSeasonalContext(checkIn.getUTCMonth() + 1);
  }

  let multSum = 0;
  let monthlyMultSum = 0;
  const overlappingEvents = new Map<string, EventOverlay>();

  for (const night of nights) {
    const m = night.getUTCMonth() + 1;
    const day = night.getUTCDate();
    const ctx = getSeasonalContext(m, day);
    multSum += ctx.totalMultiplier;
    monthlyMultSum += ctx.monthlyMultiplier;
    if (ctx.activeEvent) {
      overlappingEvents.set(ctx.activeEvent.name, ctx.activeEvent);
    }
  }

  const totalMultiplier = multSum / nights.length;
  const monthlyMultiplier = monthlyMultSum / nights.length;

  const sortedEvents = [...overlappingEvents.values()].sort(
    (a, b) => b.additionalPct - a.additionalPct,
  );
  const activeEvent = sortedEvents[0] ?? null;
  const eventPremiumPct = activeEvent?.additionalPct ?? null;

  // Use the check-in month for display naming.
  const dominantMonth = checkIn.getUTCMonth() + 1;
  const dominantFactor = getMonthFactor(dominantMonth);

  let displayLabel = `${dominantFactor.name} (${
    dominantFactor.season.charAt(0).toUpperCase() + dominantFactor.season.slice(1)
  } Season)`;
  if (activeEvent) {
    displayLabel += ` — ${activeEvent.name}`;
  } else {
    displayLabel += " — stay window (date-aware)";
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
