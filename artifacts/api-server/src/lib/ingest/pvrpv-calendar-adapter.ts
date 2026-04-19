/**
 * ingest/pvrpv-calendar-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily-grain calendar adapter for PVRPV (Puerto Vallarta Rentals Por Vida).
 *
 * Why this exists:
 *   PVRPV publishes its full calendar grid AND seasonal rate brackets directly
 *   in HTML — no proxy, no JS execution required. One listing-page fetch + one
 *   minicalendar AJAX fetch covers ~12 forward months of {date, price,
 *   availability, min-nights} per listing. This is the cheapest, most reliable
 *   per-day comp data we have access to.
 *
 * Output shape: one CalendarDay per date for the next `dayHorizon` days
 * (default 365). Empty/unknown dates are emitted with `availabilityStatus =
 * "unknown"` rather than dropped — keeps downstream UPSERT idempotent.
 *
 * Pagination:
 *   - Page 0 (embedded on the listing page) covers ~6 months.
 *   - `GET /properties/minicalendar/{property_id}/?page=N` returns the next
 *     6 months as a fragment with the same calendar markup.
 *   - We follow pages until `dayHorizon` is reached or the fragment
 *     stops yielding new months.
 *
 * Extraction:
 *   - Each month block starts with `<th colspan="7">{MonthName}&nbsp;{Year}</th>`.
 *   - Each day cell is `<td class="no-padding">…<div class="box-cal">{N}</div>…</td>`.
 *   - Unavailable days carry the class chain `occ day-off` on the inner div.
 *   - Day price (when present) lives in `<small>$ {amount}<br>…</small>`.
 *   - The legend row (col-sm-3) also matches `box-cal` and is filtered by
 *     content (the day number is the only thing inside the cell for real
 *     day cells; legend cells contain `&nbsp;`).
 *
 * Min-nights: not present in the calendar grid; pulled from the seasonal
 * rates table on the listing page and applied per-date by bracket lookup.
 */

const BASE_URL = "https://www.pvrpv.com";
const USER_AGENT = "VallartaPulse/1.0 (+https://www.vallartapulse.com)";

export interface CalendarDay {
  date: string;              // YYYY-MM-DD
  nightlyPriceUsd: number | null;
  availabilityStatus: "available" | "unavailable" | "unknown";
  minimumNights: number | null;
}

export interface PvrpvCalendarResult {
  source: "pvrpv";
  sourceUrl: string;
  propertyId: string | null;
  daysReturned: number;
  daysWithPrice: number;
  daysAvailable: number;
  daysUnavailable: number;
  errors: string[];
  days: CalendarDay[];
}

const MONTH_NAMES = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];

function monthIndex(name: string): number {
  return MONTH_NAMES.indexOf(name.toLowerCase().trim());
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

async function fetchText(url: string, timeoutMs = 20_000): Promise<{ status: number; text: string }> {
  const r = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      "accept-language": "en-US,en;q=0.9",
      "x-requested-with": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, text: await r.text() };
}

function extractPropertyId(html: string): string | null {
  const m = html.match(/\/properties\/minicalendar\/(\d+)\//);
  return m ? m[1] : null;
}

interface RateBracket {
  start: Date;
  end: Date;
  nightlyUsd: number;
  minNights: number | null;
}

function parseRatesTable(html: string): RateBracket[] {
  const tableMatch = html.match(/<table[^>]*class="[^"]*table-rounded[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const tableHtml = tableMatch[1];
  const brackets: RateBracket[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(m[1])) !== null) {
      cells.push(cm[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    }
    if (cells.length < 5) continue;
    // Cells: [date range, nightly, weekly, monthly, min stay]
    const range = cells[0];
    const nightlyMatch = cells[1].match(/\$\s*([\d,]+(?:\.\d+)?)/);
    const minMatch = cells[4].match(/(\d+)/);
    const rangeMatch = range.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})\s+to\s+(\w+)\s+(\d{1,2}),\s+(\d{4})/);
    if (!nightlyMatch || !rangeMatch) continue;
    const [, sM, sD, sY, eM, eD, eY] = rangeMatch;
    const sIdx = monthIndex(sM);
    const eIdx = monthIndex(eM);
    if (sIdx < 0 || eIdx < 0) continue;
    brackets.push({
      start: new Date(Date.UTC(parseInt(sY), sIdx, parseInt(sD))),
      end:   new Date(Date.UTC(parseInt(eY), eIdx, parseInt(eD))),
      nightlyUsd: parseFloat(nightlyMatch[1].replace(/,/g, "")),
      minNights: minMatch ? parseInt(minMatch[1]) : null,
    });
  }
  return brackets;
}

interface ParsedDay {
  year: number;
  month: number; // 0-indexed
  day: number;
  available: boolean;
  priceUsd: number | null;
}

function parseCalendarFragment(html: string): ParsedDay[] {
  const days: ParsedDay[] = [];
  // Split into month blocks. Each starts with <th colspan="7">MonthName(&nbsp;|space)YYYY</th>
  const monthRe = /<th\s+colspan="7">([A-Za-z]+)(?:&nbsp;|\s+)(\d{4})<\/th>([\s\S]*?)(?=<th\s+colspan="7">|$)/g;
  let m: RegExpExecArray | null;
  while ((m = monthRe.exec(html)) !== null) {
    const [, monthName, yearStr, body] = m;
    const monthIdx = monthIndex(monthName);
    const year = parseInt(yearStr);
    if (monthIdx < 0) continue;

    // Within the month body, find each day cell. Real day cells have a
    // box-cal whose inner text is a 1-2 digit number (legend cells contain
    // &nbsp;). Capture the surrounding TD so we can read both class chain
    // and the optional <small>$ price</small>.
    const cellRe = /<td[^>]*class="no-padding"[^>]*>([\s\S]*?)<\/td>/g;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(body)) !== null) {
      const cellHtml = c[1];
      const dayMatch = cellHtml.match(/<div class="box-cal">(\d{1,2})<\/div>/);
      if (!dayMatch) continue; // empty/legend cell
      const day = parseInt(dayMatch[1]);
      if (!Number.isFinite(day) || day < 1 || day > 31) continue;
      // Availability rule (verified against PVRPV legend):
      //   inner-div class contains `occ`     → "Not Available" (booked)
      //   inner-div class contains `dep|arr` → partial-day slot (booked)
      //   inner-div class is empty           → available
      // `occ day-off` is just `occ` + a discount tag → still unavailable.
      // Match the immediate child div's class chain only (avoid matching
      // class words inside the price `<small>`, etc.).
      const innerClassMatch = cellHtml.match(/<div class="[^"]*"><div class="([^"]*)">/);
      const innerClass = innerClassMatch ? innerClassMatch[1] : "";
      const available = !/\b(occ|dep|arr)\b/.test(innerClass);
      // Price extraction
      const priceMatch = cellHtml.match(/<small>\s*\$\s*([\d,]+(?:\.\d+)?)/);
      const priceUsd = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, "")) : null;
      days.push({ year, month: monthIdx, day, available, priceUsd });
    }
  }
  return days;
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

function lookupBracket(brackets: RateBracket[], dateUtc: Date): RateBracket | null {
  for (const b of brackets) {
    if (dateUtc >= b.start && dateUtc <= b.end) return b;
  }
  return null;
}

export interface FetchPvrpvCalendarOpts {
  /** How many forward days to emit (default 365). */
  dayHorizon?: number;
  /** Maximum minicalendar pages to follow beyond page 0 (default 3 → covers ~24 months max). */
  maxPaginationPages?: number;
  /** Per-fetch timeout in ms (default 20_000). */
  timeoutMs?: number;
}

export async function fetchPvrpvCalendar(
  sourceUrl: string,
  opts: FetchPvrpvCalendarOpts = {},
): Promise<PvrpvCalendarResult> {
  const dayHorizon = opts.dayHorizon ?? 365;
  const maxPages = opts.maxPaginationPages ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const errors: string[] = [];

  // ── 1. Fetch the listing page (page 0 + rates table) ─────────────────
  let listingHtml = "";
  try {
    const r = await fetchText(sourceUrl, timeoutMs);
    if (r.status !== 200) {
      errors.push(`listing-page http ${r.status}`);
    } else {
      listingHtml = r.text;
    }
  } catch (e) {
    errors.push(`listing-page fetch error: ${(e as Error).message.slice(0, 120)}`);
  }

  if (!listingHtml) {
    return {
      source: "pvrpv", sourceUrl, propertyId: null,
      daysReturned: 0, daysWithPrice: 0, daysAvailable: 0, daysUnavailable: 0,
      errors, days: [],
    };
  }

  const propertyId = extractPropertyId(listingHtml);
  const brackets = parseRatesTable(listingHtml);

  // ── 2. Parse embedded page-0 calendar ────────────────────────────────
  const allParsed: ParsedDay[] = [];
  // The embedded calendar lives inside #hotel-availability — extract that
  // section to avoid accidentally matching unrelated <th colspan="7">.
  const haIdx = listingHtml.indexOf('id="hotel-availability"');
  const haEnd = listingHtml.indexOf('id="reviews-pn"');
  const haSection = haIdx >= 0
    ? listingHtml.slice(haIdx, haEnd > haIdx ? haEnd : listingHtml.length)
    : listingHtml;
  allParsed.push(...parseCalendarFragment(haSection));

  // ── 3. Follow pagination until horizon reached or pages exhausted ────
  if (propertyId) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const r = await fetchText(`${BASE_URL}/properties/minicalendar/${propertyId}/?page=${page}`, timeoutMs);
        if (r.status !== 200) {
          errors.push(`minicalendar page=${page} http ${r.status}`);
          break;
        }
        const parsed = parseCalendarFragment(r.text);
        if (parsed.length === 0) break;
        allParsed.push(...parsed);
      } catch (e) {
        errors.push(`minicalendar page=${page} error: ${(e as Error).message.slice(0, 120)}`);
        break;
      }
    }
  } else {
    errors.push("no property_id found — pagination skipped");
  }

  // ── 4. Build the 365-day series ──────────────────────────────────────
  const calendarMap = new Map<string, ParsedDay>();
  for (const p of allParsed) calendarMap.set(dateKey(p.year, p.month, p.day), p);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days: CalendarDay[] = [];
  let daysWithPrice = 0;
  let daysAvailable = 0;
  let daysUnavailable = 0;

  for (let offset = 0; offset < dayHorizon; offset++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + offset);
    const key = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const parsed = calendarMap.get(key);
    const bracket = lookupBracket(brackets, d);
    let nightlyPriceUsd: number | null = null;
    let availabilityStatus: CalendarDay["availabilityStatus"] = "unknown";
    if (parsed) {
      availabilityStatus = parsed.available ? "available" : "unavailable";
      nightlyPriceUsd = parsed.priceUsd ?? bracket?.nightlyUsd ?? null;
    } else if (bracket) {
      // No calendar coverage but we have a seasonal bracket → fall back to
      // the bracket price; availability remains "unknown".
      nightlyPriceUsd = bracket.nightlyUsd;
    }
    if (nightlyPriceUsd !== null) daysWithPrice++;
    if (availabilityStatus === "available") daysAvailable++;
    if (availabilityStatus === "unavailable") daysUnavailable++;
    days.push({
      date: key,
      nightlyPriceUsd,
      availabilityStatus,
      minimumNights: bracket?.minNights ?? null,
    });
  }

  return {
    source: "pvrpv",
    sourceUrl,
    propertyId,
    daysReturned: days.length,
    daysWithPrice,
    daysAvailable,
    daysUnavailable,
    errors,
    days,
  };
}
