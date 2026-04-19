/**
 * ingest/vacation-vallarta-calendar-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily-grain calendar adapter for Vacation Vallarta (Squarespace).
 *
 * Why this exists:
 *   VV publishes nightly rates as 3–5 hand-typed seasonal brackets per listing
 *   inside the listing-page rich-text blocks (no calendar grid, no JSON, no
 *   AJAX — just `<strong>SeasonName</strong><br>$N/night<br>Month to Month |
 *   N night min` patterns). Parsing those brackets gives us a forward-looking
 *   nightly comp price for ~24 PV listings concentrated in the Old Town /
 *   Conchas Chinas corridor where PVRPV's coverage is thinner.
 *
 * What we emit:
 *   One CalendarDay per date for the next `dayHorizon` days (default 365).
 *   `availabilityStatus` is always "unknown" — VV does not expose a public
 *   calendar grid, only seasonal rates. Days outside any bracket window get
 *   `nightlyPriceUsd = null`.
 *
 * Bracket types we recognise:
 *   - "Peak"          → high season  (typical: Nov → Apr/May/Jun)
 *   - "Non-Peak"      → low  season  (typical: May/Jul → Oct)
 *   - "Shoulder"      → shoulder      (when present)
 *   - "Holiday" / "Christmas" / "Xmas / New Years" → tight ~Dec 20 → Jan 5 window
 *
 * Multi-bedroom variants:
 *   Some villas list one bracket per bedroom-count variant (e.g. "Peak - Four
 *   Bedroom" + "Peak - Five Bedroom"). Caller passes `bedrooms` so we can pick
 *   the variant whose bedroom count matches (closest match wins, ties prefer
 *   the smaller — conservative for comp pricing).
 *
 * Robustness notes:
 *   - Some listings (e.g. villa-savana) typeset their pricing in a table whose
 *     prices land in cells without a "/night" suffix. We accept `$N/night`,
 *     `$N per night`, or a bare `$N` immediately under the bracket header.
 *   - Holiday brackets often omit month-to-month text — we infer Dec 20 → Jan 5.
 *   - Year wrap: bracket month ranges are applied to BOTH the current and next
 *     calendar year so the lookup covers a full forward 365-day horizon.
 */

const SOURCE = "vacation_vallarta" as const;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface VvCalendarDay {
  date: string; // YYYY-MM-DD
  nightlyPriceUsd: number | null;
  availabilityStatus: "unknown";
  minimumNights: number | null;
}

export interface VvCalendarResult {
  source: typeof SOURCE;
  sourceUrl: string;
  bracketsFound: number;
  daysReturned: number;
  daysWithPrice: number;
  errors: string[];
  days: VvCalendarDay[];
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(name: string): number {
  return MONTH_NAMES.indexOf(name.toLowerCase().trim());
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15,
};

function parseBedroomTag(label: string): number | null {
  // "Peak - Four Bedroom", "Peak - Five Bedroom", "Peak - 6 bedrooms", "14 bedrooms"
  const num = label.match(/(\d+)\s*bedroom/i);
  if (num) return parseInt(num[1], 10);
  const word = label.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen)\s*bedroom/i);
  if (word) return NUMBER_WORDS[word[1].toLowerCase()] ?? null;
  return null;
}

type SeasonKind = "peak" | "non_peak" | "shoulder" | "holiday";

function classifyLabel(label: string): SeasonKind | null {
  const l = label.toLowerCase();
  if (/\b(holiday|holidays|christmas|xmas|new\s*years?)\b/.test(l)) return "holiday";
  if (/\b(non[- ]?peak|low season|low-season|off[- ]?peak|summer)\b/.test(l)) return "non_peak";
  if (/\bshoulder\b/.test(l)) return "shoulder";
  if (/\b(peak|high season|high-season|winter)\b/.test(l)) return "peak";
  return null;
}

interface RawBracket {
  label: string;
  kind: SeasonKind;
  bedroomTag: number | null;
  nightlyUsd: number;
  minNights: number | null;
  monthRange: { startMonth: number; startDay: number; endMonth: number; endDay: number } | null;
  isHolidayWindow: boolean;
}

function parseMonthRange(text: string): RawBracket["monthRange"] {
  // "November to June", "December to March", "May to October"
  // Optionally with day numbers: "December 15 to January 5"
  const m = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?\s*(?:to|through|-|–)\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{1,2})?/i,
  );
  if (!m) return null;
  const sIdx = monthIndex(m[1]);
  const eIdx = monthIndex(m[3]);
  if (sIdx < 0 || eIdx < 0) return null;
  const sDay = m[2] ? parseInt(m[2], 10) : 1;
  // End day defaults to last day of end month (handled at apply time via 0-day-of-next-month).
  const eDay = m[4] ? parseInt(m[4], 10) : -1;
  return { startMonth: sIdx, startDay: sDay, endMonth: eIdx, endDay: eDay };
}

function lastDayOfMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

function parseBracketBody(label: string, body: string): RawBracket | null {
  const kind = classifyLabel(label);
  if (!kind) return null;
  const bedroomTag = parseBedroomTag(label);

  // Strip tags but keep textual structure
  const text = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();

  // Price extraction — prefer $N/night, then $N per night, then bare $N on
  // the first non-empty line (Squarespace tables sometimes drop the suffix).
  let nightlyUsd: number | null = null;
  let priceMatch =
    text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*night|per\s*night|nightly|a\s*night)/i);
  if (!priceMatch) {
    // Fallback: first dollar amount above $50 (avoid $750 deposits etc by
    // taking the first amount on the first line).
    const firstLine = text.split("\n").map((s) => s.trim()).find((s) => s.length > 0) ?? "";
    priceMatch = firstLine.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  }
  if (priceMatch) {
    const n = parseFloat(priceMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 50 && n <= 50_000) nightlyUsd = n;
  }
  if (nightlyUsd === null) return null;

  const minMatch = text.match(/(\d+)\s*[-]?\s*night\s*min(?:imum)?/i);
  const minNights = minMatch ? parseInt(minMatch[1], 10) : null;

  const monthRange = parseMonthRange(text);
  const isHolidayWindow =
    kind === "holiday" || /\b(xmas|christmas|new\s*years?)\b/i.test(text);

  return { label, kind, bedroomTag, nightlyUsd, minNights, monthRange, isHolidayWindow };
}

function extractBrackets(html: string): RawBracket[] {
  // Find every <strong>LABEL</strong> ... up to the next <strong> or a clear
  // section break (</section>, <h1/2/3>, end of html).
  const out: RawBracket[] = [];
  const re = /<strong>([^<]{2,80})<\/strong>([\s\S]*?)(?=<strong>|<h[1-3][\s>]|<\/section>|<\/article>|<footer|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = m[1].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (classifyLabel(label) === null) continue;
    // Cap body to ~600 chars so we don't cross into unrelated text if the
    // negative lookahead missed a section boundary.
    const body = m[2].slice(0, 600);
    const parsed = parseBracketBody(label, body);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Pick the bedroom-variant of each season-kind that best matches `bedrooms`.
 * If no variants are tagged, every bracket of that kind is kept.
 *
 * Closest match wins. Ties prefer the smaller bedroom count (conservative
 * comp pricing) and, secondarily, the lower nightly rate.
 */
function selectByBedrooms(brackets: RawBracket[], bedrooms: number | undefined): RawBracket[] {
  const groups = new Map<SeasonKind, RawBracket[]>();
  for (const b of brackets) {
    const arr = groups.get(b.kind) ?? [];
    arr.push(b);
    groups.set(b.kind, arr);
  }
  const out: RawBracket[] = [];
  for (const [, arr] of groups) {
    const tagged = arr.filter((b) => b.bedroomTag !== null);
    const untagged = arr.filter((b) => b.bedroomTag === null);
    if (tagged.length === 0 || bedrooms === undefined) {
      out.push(...arr);
      continue;
    }
    let best = tagged[0];
    let bestScore = Math.abs((best.bedroomTag ?? 0) - bedrooms);
    for (const b of tagged.slice(1)) {
      const score = Math.abs((b.bedroomTag ?? 0) - bedrooms);
      if (
        score < bestScore ||
        (score === bestScore && (b.bedroomTag ?? 0) < (best.bedroomTag ?? 0)) ||
        (score === bestScore && b.bedroomTag === best.bedroomTag && b.nightlyUsd < best.nightlyUsd)
      ) {
        best = b;
        bestScore = score;
      }
    }
    out.push(best);
    out.push(...untagged); // keep any non-variant brackets (rare, but harmless — holiday wins anyway)
  }
  return out;
}

interface DateBracket {
  start: Date;
  end: Date;
  nightlyUsd: number;
  minNights: number | null;
  kind: SeasonKind;
}

/**
 * Materialise each bracket into one or more concrete UTC date windows
 * covering the next ~13 months. Holiday brackets without a month-range get
 * a Dec 20 → Jan 5 window applied for both the current and the next year.
 */
function expandToDateWindows(brackets: RawBracket[], todayUtc: Date, dayHorizon: number): DateBracket[] {
  const out: DateBracket[] = [];
  const startYear = todayUtc.getUTCFullYear();
  const endDate = new Date(todayUtc);
  endDate.setUTCDate(endDate.getUTCDate() + dayHorizon);
  const endYear = endDate.getUTCFullYear();
  // Include startYear-1 so wrap-around brackets (e.g. "November to June")
  // that began last calendar year still cover today's date.
  const years: number[] = [];
  for (let y = startYear - 1; y <= endYear + 1; y++) years.push(y);

  for (const b of brackets) {
    // Holiday with no explicit month range → Dec 20 → Jan 5.
    if (b.isHolidayWindow && !b.monthRange) {
      for (const y of years) {
        out.push({
          start: new Date(Date.UTC(y, 11, 20)),
          end: new Date(Date.UTC(y + 1, 0, 5)),
          nightlyUsd: b.nightlyUsd,
          minNights: b.minNights,
          kind: b.kind,
        });
      }
      continue;
    }
    if (!b.monthRange) continue;
    const { startMonth, startDay, endMonth, endDay } = b.monthRange;
    for (const y of years) {
      const sy = y;
      // If end month wraps before start month, end falls in next year.
      const ey = endMonth < startMonth ? y + 1 : y;
      const sDay = startDay > 0 ? startDay : 1;
      const eDay = endDay > 0 ? endDay : lastDayOfMonth(ey, endMonth);
      out.push({
        start: new Date(Date.UTC(sy, startMonth, sDay)),
        end: new Date(Date.UTC(ey, endMonth, eDay)),
        nightlyUsd: b.nightlyUsd,
        minNights: b.minNights,
        kind: b.kind,
      });
    }
  }
  return out;
}

/**
 * Pick the best bracket for a given date. Holiday > shoulder > peak/non-peak.
 * Ties resolved by latest start date (more specific window wins).
 */
function lookupForDate(windows: DateBracket[], dateUtc: Date): DateBracket | null {
  const matches = windows.filter((w) => dateUtc >= w.start && dateUtc <= w.end);
  if (matches.length === 0) return null;
  const priority: Record<SeasonKind, number> = { holiday: 4, shoulder: 3, peak: 2, non_peak: 1 };
  matches.sort((a, b) => {
    const dp = priority[b.kind] - priority[a.kind];
    if (dp !== 0) return dp;
    return b.start.getTime() - a.start.getTime();
  });
  return matches[0];
}

async function fetchListingHtml(url: string, timeoutMs: number): Promise<string> {
  const r = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

export interface FetchVvCalendarOpts {
  /** How many forward days to emit (default 365). */
  dayHorizon?: number;
  /** Listing bedroom count — drives multi-variant bracket selection. */
  bedrooms?: number;
  /** Per-fetch timeout in ms (default 20_000). */
  timeoutMs?: number;
  /** Inject pre-fetched HTML (used by tests / probes). */
  html?: string;
}

export async function fetchVacationVallartaCalendar(
  sourceUrl: string,
  opts: FetchVvCalendarOpts = {},
): Promise<VvCalendarResult> {
  const dayHorizon = opts.dayHorizon ?? 365;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const errors: string[] = [];

  let html = opts.html ?? "";
  if (!html) {
    try {
      html = await fetchListingHtml(sourceUrl, timeoutMs);
    } catch (e) {
      errors.push(`listing-page fetch error: ${(e as Error).message.slice(0, 160)}`);
      return {
        source: SOURCE, sourceUrl,
        bracketsFound: 0, daysReturned: 0, daysWithPrice: 0,
        errors, days: [],
      };
    }
  }

  const allBrackets = extractBrackets(html);
  const selected = selectByBedrooms(allBrackets, opts.bedrooms);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const windows = expandToDateWindows(selected, today, dayHorizon);

  const days: VvCalendarDay[] = [];
  let daysWithPrice = 0;
  for (let offset = 0; offset < dayHorizon; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + offset);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const w = lookupForDate(windows, d);
    const nightlyPriceUsd = w?.nightlyUsd ?? null;
    if (nightlyPriceUsd !== null) daysWithPrice++;
    days.push({
      date: key,
      nightlyPriceUsd,
      availabilityStatus: "unknown",
      minimumNights: w?.minNights ?? null,
    });
  }

  if (allBrackets.length === 0) {
    errors.push("no seasonal brackets parsed from listing page");
  }

  return {
    source: SOURCE,
    sourceUrl,
    bracketsFound: allBrackets.length,
    daysReturned: days.length,
    daysWithPrice,
    errors,
    days,
  };
}
