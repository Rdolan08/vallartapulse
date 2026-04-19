/**
 * airbnb-checkpoints.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure checkpoint-date generator for Airbnb price-quote fetching.
 *
 * Owner-facing scenarios this set must answer:
 *   • "What are comp listings charging for next month's weekend?"     → rolling weekends
 *   • "What are comps doing 6 weeks out?"                             → rolling weekends span 12wk
 *   • "How does Christmas / NYE 2026 look?"                            → fixed-date holidays
 *   • "Beef Dip 2027 / Semana Santa / PV Pride"                        → year-aware events
 *   • "Mid-week baseline for the year"                                 → monthly mid-week anchors
 *
 * Output: ~30–40 checkpoints. Pure function, no I/O, no DB. The driver
 * decides which to actually fetch (cache check, tier filter, hard cap).
 *
 * Stay-length policy (chosen to avoid Airbnb min-stay rejections):
 *   • Weekend  : Fri-night check-in, Sun check-out (2 nights)
 *   • Weekend  : Sat-night check-in, Mon check-out (2 nights)
 *   • Event    : Sat-of-event-week check-in, +7 nights
 *   • Mid-week : Mon check-in, Thu check-out (3 nights)
 *
 * Tier function is intentionally a stub returning `1` for everything in
 * Phase 1. Phase 2 swaps in the real tier calc; nothing else changes.
 */

export type CheckpointKind = "weekend" | "event" | "midweek_anchor" | "holiday";
export type Season = "high" | "shoulder" | "low";

export interface Checkpoint {
  /** YYYY-MM-DD */
  checkin: string;
  /** YYYY-MM-DD */
  checkout: string;
  stayNights: number;
  guestCount: number;
  kind: CheckpointKind;
  /** e.g. "beef_dip_2027", "xmas_2026", null for non-event */
  eventTag: string | null;
  isWeekend: boolean;
  isEvent: boolean;
  season: Season;
  daysOut: number;
  /** Phase 1: always 1. Phase 2: real tier per-date. */
  priorityTier: 1 | 2 | 3 | 4;
}

export interface GenerateCheckpointsOpts {
  /** Override "today" (test hook). */
  today?: Date;
  /** How many weeks of rolling Fri/Sat to emit (default 12). */
  rollingWeekendWeeks?: number;
  /** How many monthly mid-week anchors to emit beyond the rolling window (default 6). */
  monthlyAnchorMonths?: number;
  /** Default guests per quote (default 2 — matches owner pricing scenarios). */
  guestCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date helpers (UTC throughout — checkpoint dates are calendar dates, not
// instants, so we anchor everything to UTC midnight to dodge tz drift).
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function utcDate(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d));
}

function fmt(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

/** Find next occurrence of `dow` (0=Sun..6=Sat), starting today (inclusive). */
function nextDow(from: Date, dow: number): Date {
  const cur = from.getUTCDay();
  const delta = (dow - cur + 7) % 7;
  return addDays(from, delta);
}

/**
 * Easter Sunday (Gregorian) — Anonymous algorithm (Meeus/Jones/Butcher).
 * Returns UTC date.
 */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);   // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month - 1, day);
}

/** Puerto Vallarta seasonality. */
function seasonOf(d: Date): Season {
  const m = d.getUTCMonth(); // 0..11
  // High: Nov(10)-Apr(3); Shoulder: May(4), Oct(9); Low: Jun(5)-Sep(8)
  if (m === 10 || m === 11 || m <= 3) return "high";
  if (m === 4 || m === 9) return "shoulder";
  return "low";
}

// ─────────────────────────────────────────────────────────────────────────────
// Event windows (year-aware)
// ─────────────────────────────────────────────────────────────────────────────

interface EventWindow {
  tag: string;       // e.g. "beef_dip_2027"
  /** Most useful single check-in date for this event. */
  checkin: Date;
  /** Stay length to price for this event (matches typical booking pattern). */
  stayNights: number;
}

/** Saturday on or before `d` (Beef Dip / Pride bookings typically run Sat→Sat). */
function priorSaturday(d: Date): Date {
  const back = (d.getUTCDay() - 6 + 7) % 7; // 6 = Sat
  return addDays(d, -back);
}

function eventsForYear(year: number): EventWindow[] {
  const out: EventWindow[] = [];

  // Christmas: Dec 24 check-in, 3-night stay through Dec 27
  out.push({
    tag: `xmas_${year}`,
    checkin: utcDate(year, 11, 24),
    stayNights: 3,
  });
  // NYE: Dec 30 check-in, 3-night stay (covers Dec 31 + Jan 1)
  out.push({
    tag: `nye_${year}`,
    checkin: utcDate(year, 11, 30),
    stayNights: 3,
  });

  // Beef Dip: typically the week of MLK Day (3rd Monday of January) of the
  // following calendar year, but the event's own naming convention attaches
  // the year of the event itself. PV Beef Dip is anchored to "the third
  // Saturday of January" → check-in that Sat, 7-night stay.
  const jan1 = utcDate(year + 1, 0, 1);
  const firstSatJan = nextDow(jan1, 6);
  const thirdSatJan = addDays(firstSatJan, 14);
  out.push({
    tag: `beef_dip_${year + 1}`,
    checkin: thirdSatJan,
    stayNights: 7,
  });

  // Semana Santa: Easter Sunday's prior Saturday → 7-night stay covering
  // the Mexican holy week peak.
  const easter = easterSunday(year + 1);
  const semanaCheckin = addDays(priorSaturday(easter), -7); // Saturday a week before Easter
  out.push({
    tag: `semana_santa_${year + 1}`,
    checkin: semanaCheckin,
    stayNights: 7,
  });

  // PV Pride: typically the last week of May. Anchor on the last Saturday
  // of May, 4-night stay.
  const may31Next = utcDate(year + 1, 4, 31);
  let lastSatMay = may31Next;
  while (lastSatMay.getUTCDay() !== 6) lastSatMay = addDays(lastSatMay, -1);
  out.push({
    tag: `pride_${year + 1}`,
    checkin: lastSatMay,
    stayNights: 4,
  });

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier function — Phase 1 stub. Phase 2 swaps in the real logic.
// ─────────────────────────────────────────────────────────────────────────────

export function priorityTierFor(_cp: Omit<Checkpoint, "priorityTier">): 1 | 2 | 3 | 4 {
  // Phase 1: refresh everything daily. Tier function exists so Phase 2 is
  // a one-function change with zero schema/driver churn.
  return 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: generate checkpoints
// ─────────────────────────────────────────────────────────────────────────────

export function generateCheckpoints(opts: GenerateCheckpointsOpts = {}): Checkpoint[] {
  const todayLocal = opts.today ?? new Date();
  // Anchor to UTC date-only.
  const today = utcDate(
    todayLocal.getUTCFullYear(),
    todayLocal.getUTCMonth(),
    todayLocal.getUTCDate(),
  );
  const rollingWeeks = opts.rollingWeekendWeeks ?? 12;
  const anchorMonths = opts.monthlyAnchorMonths ?? 6;
  const guests = opts.guestCount ?? 2;

  const seen = new Set<string>(); // dedup on `${checkin}|${checkout}`
  const out: Checkpoint[] = [];

  function push(
    checkin: Date,
    stayNights: number,
    kind: CheckpointKind,
    eventTag: string | null,
  ): void {
    const checkout = addDays(checkin, stayNights);
    const key = `${fmt(checkin)}|${fmt(checkout)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const dow = checkin.getUTCDay();
    const isWeekend = dow === 5 || dow === 6; // Fri/Sat check-in
    const partial: Omit<Checkpoint, "priorityTier"> = {
      checkin: fmt(checkin),
      checkout: fmt(checkout),
      stayNights,
      guestCount: guests,
      kind,
      eventTag,
      isWeekend,
      isEvent: kind === "event" || kind === "holiday",
      season: seasonOf(checkin),
      daysOut: Math.max(0, diffDays(checkin, today)),
    };
    out.push({ ...partial, priorityTier: priorityTierFor(partial) });
  }

  // 1) Rolling weekends — next N Fri/Sat check-ins.
  //    Friday check-in is the canonical weekend pricing question.
  let cursor = nextDow(today, 5); // next Friday
  for (let i = 0; i < rollingWeeks; i++) {
    push(cursor, 2, "weekend", null);   // Fri → Sun
    push(addDays(cursor, 1), 2, "weekend", null); // Sat → Mon (2-night, dodges weekend min-stay)
    cursor = addDays(cursor, 7);
  }

  // 2) Year-aware events. Cover this year + next year so we always have
  //    forward visibility on the next occurrence of each event.
  const horizonEnd = addDays(today, 540); // ~18 months
  const years = new Set<number>();
  years.add(today.getUTCFullYear());
  years.add(today.getUTCFullYear() + 1);
  for (const y of years) {
    for (const ev of eventsForYear(y)) {
      // Skip events whose check-in is in the past or beyond horizon.
      if (ev.checkin.getTime() < today.getTime()) continue;
      if (ev.checkin.getTime() > horizonEnd.getTime()) continue;
      const kind: CheckpointKind = ev.tag.startsWith("xmas_") || ev.tag.startsWith("nye_")
        ? "holiday"
        : "event";
      push(ev.checkin, ev.stayNights, kind, ev.tag);
    }
  }

  // 3) Monthly mid-week anchors — 1 per month (Mon → Thu, 3 nights), starting
  //    from the month after the rolling-weekend window ends.
  const rollingEnd = addDays(today, rollingWeeks * 7);
  let anchorCursor = utcDate(
    rollingEnd.getUTCFullYear(),
    rollingEnd.getUTCMonth() + 1, // first day of the month AFTER rollingEnd
    1,
  );
  for (let i = 0; i < anchorMonths; i++) {
    // Second Monday of that month — avoids odd month-start edge cases and
    // gives a representative non-event mid-week comp.
    const firstOfMonth = utcDate(anchorCursor.getUTCFullYear(), anchorCursor.getUTCMonth(), 1);
    const firstMon = nextDow(firstOfMonth, 1);
    const secondMon = addDays(firstMon, 7);
    push(secondMon, 3, "midweek_anchor", null);
    anchorCursor = utcDate(anchorCursor.getUTCFullYear(), anchorCursor.getUTCMonth() + 1, 1);
  }

  // Sort by check-in date for predictable scheduler iteration.
  out.sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));
  return out;
}
