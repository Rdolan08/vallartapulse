/**
 * gap-scraper.ts
 * ────────────────────────────────────────────────────────────────────────────
 * Scrapes GAP (Grupo Aeroportuario del Pacífico) monthly passenger traffic
 * press releases from GlobeNewswire and stores real PVR (Puerto Vallarta)
 * figures in the airport_metrics table.
 *
 * Parser uses a dual-strategy approach:
 *   Strategy A – Tables contain "Domestic/International/Total Terminal Passengers"
 *                as explicit labels (older press release format).
 *   Strategy B – First 3 tables with PVR rows are positionally assumed to be
 *                Dom/Intl/Total (newer format where labels appear in paragraphs
 *                outside the tables).
 *   Strategy C – Only one PVR table found; use it as total-only fallback.
 *
 * When building the monthly map from all press releases, entries with a full
 * breakdown (dom + intl + tot) are preferred over total-only entries; when
 * both are total-only the higher value (= the real total) wins.
 *
 * Source: https://www.globenewswire.com (public press releases)
 * ────────────────────────────────────────────────────────────────────────────
 */

import { db } from "@workspace/db";
import { airportMetricsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";

interface PressRelease {
  dataMonth: number;
  dataYear: number;
  url: string;
}

const PRESS_RELEASES: PressRelease[] = [
  // ── 2025 reports (covers 2024 prior-year comparisons + 2025 current) ────────
  { dataYear: 2025, dataMonth:  1, url: "https://www.globenewswire.com/news-release/2025/02/05/3021624/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-in-January-2025-a-Passenger-Traffic-Increase-of-5-4-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  2, url: "https://www.globenewswire.com/news-release/2025/03/05/3037068/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-in-February-2025-a-Passenger-Traffic-Increase-of-1-6-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  3, url: "https://www.globenewswire.com/news-release/2025/04/04/3056228/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-in-March-2025-a-Passenger-Traffic-Increase-of-5-6-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  4, url: "https://www.globenewswire.com/news-release/2025/05/06/3075666/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-in-April-2025-a-Passenger-Traffic-Increase-of-9-1-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  5, url: "https://www.globenewswire.com/news-release/2025/06/05/3094840/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-May-2025-of-2-6-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  6, url: "https://www.globenewswire.com/news-release/2025/07/04/3110180/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-June-2025-of-0-6-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  7, url: "https://www.globenewswire.com/news-release/2025/08/06/3127998/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-July-2025-of-3-1-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  8, url: "https://www.globenewswire.com/news-release/2025/09/03/3144124/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-August-2025-of-3-4-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth:  9, url: "https://www.globenewswire.com/news-release/2025/10/03/3161211/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-September-2025-of-0-9-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth: 10, url: "https://www.globenewswire.com/news-release/2025/11/07/3184016/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-In-October-2025-of-0-8-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth: 11, url: "https://www.globenewswire.com/news-release/2025/12/04/3200407/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-in-November-2025-of-2-0-Compared-to-2024.html" },
  { dataYear: 2025, dataMonth: 12, url: "https://www.globenewswire.com/news-release/2026/01/06/3214165/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Increase-in-December-2025-of-0-1-Compared-to-2024.html" },
  // ── 2026 reports (covers 2025 prior-year comparisons + 2026 current) ────────
  { dataYear: 2026, dataMonth:  1, url: "https://www.globenewswire.com/news-release/2026/02/05/3233515/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-in-January-2026-of-2-2-Compared-to-2025.html" },
  { dataYear: 2026, dataMonth:  2, url: "https://www.globenewswire.com/news-release/2026/03/06/3251336/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-in-February-2026-of-5-5-Compared-to-2025.html" },
];

interface PVRMonthData {
  year: number;
  month: number;
  domestic: number | null;
  international: number | null;
  total: number;
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

/** Strip HTML tags and non-breaking spaces from a string. */
function cleanHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\u00a0/g, "").trim();
}

/** Parse "1,234.5" or "(73.4%)" → number | null */
function parseNum(s: string): number | null {
  const cleaned = s.replace(/[()%,\s]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** Extract all <table>…</table> blocks from HTML. */
function extractTables(html: string): string[] {
  const tables: string[] = [];
  const re = /<table[^>]*>[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) tables.push(m[0]);
  return tables;
}

/** Find the Puerto Vallarta row in a table and return (prior, current) numeric pair. */
function pvrFromTable(tableHtml: string): [number, number] | null {
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(tableHtml)) !== null) {
    const rowHtml = m[1];
    if (!/puerto vallarta/i.test(rowHtml)) continue;

    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(rowHtml)) !== null) {
      cells.push(cleanHtml(td[1]));
    }

    // Collect first 2 numeric values after the airport-name cell
    const pvrIdx = cells.findIndex((c) => /puerto vallarta/i.test(c));
    if (pvrIdx === -1) continue;

    const nums: number[] = [];
    for (let i = pvrIdx + 1; i < cells.length; i++) {
      const n = parseNum(cells[i]);
      if (n !== null) {
        nums.push(n);
        if (nums.length === 2) break;
      }
    }

    if (nums.length === 2) return [nums[0], nums[1]]; // [prior_year, current_year]
  }
  return null;
}

// ── Section-label constants ───────────────────────────────────────────────────

const LABELS = {
  dom:  "Domestic Terminal Passengers",
  intl: "International Terminal Passengers",
  tot:  "Total Terminal Passengers",
} as const;

// ── Press-release parser ─────────────────────────────────────────────────────

async function parsePressRelease(pr: PressRelease): Promise<PVRMonthData[]> {
  let html: string;
  try {
    const res = await fetch(pr.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; VallartaPulse/1.0)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    logger.warn({ url: pr.url, err }, "gap-scraper: fetch failed");
    return [];
  }

  const allTables = extractTables(html);
  const pvrTables = allTables.filter((t) => /puerto vallarta/i.test(t));

  if (pvrTables.length === 0) return [];

  // ── Strategy A: labeled tables ────────────────────────────────────────────
  if (pvrTables.length >= 3) {
    type Key = "dom" | "intl" | "tot";
    const matched: Partial<Record<Key, { vals: [number, number]; tableIdx: number }>> = {};

    for (const key of ["dom", "intl", "tot"] as Key[]) {
      const label = LABELS[key];
      for (let i = 0; i < pvrTables.length; i++) {
        if (!pvrTables[i].includes(label)) continue;
        const vals = pvrFromTable(pvrTables[i]);
        if (vals && !matched[key]) {
          matched[key] = { vals, tableIdx: i };
          break;
        }
      }
    }

    const allDistinct =
      matched.dom && matched.intl && matched.tot &&
      new Set([matched.dom.tableIdx, matched.intl.tableIdx, matched.tot.tableIdx]).size === 3;

    if (allDistinct) {
      const { dom, intl, tot } = matched as Required<typeof matched>;
      const sumCur = dom.vals[1] + intl.vals[1];
      if (Math.abs(sumCur - tot.vals[1]) / Math.max(tot.vals[1], 0.001) < 0.25) {
        logger.debug({ year: pr.dataYear, month: pr.dataMonth, strategy: "A" }, "gap-scraper: parsed");
        return makeResult(pr, dom.vals, intl.vals, tot.vals);
      }
    }

    // ── Strategy B: positional ────────────────────────────────────────────
    const dom  = pvrFromTable(pvrTables[0]);
    const intl = pvrFromTable(pvrTables[1]);
    const tot  = pvrFromTable(pvrTables[2]);
    if (dom && intl && tot) {
      const sumCur = dom[1] + intl[1];
      if (Math.abs(sumCur - tot[1]) / Math.max(tot[1], 0.001) < 0.25) {
        logger.debug({ year: pr.dataYear, month: pr.dataMonth, strategy: "B" }, "gap-scraper: parsed");
        return makeResult(pr, dom, intl, tot);
      }
    }
  }

  // ── Strategy C: total-only from last PVR table ────────────────────────────
  const lastR = pvrFromTable(pvrTables[pvrTables.length - 1]);
  if (lastR) {
    logger.debug({ year: pr.dataYear, month: pr.dataMonth, strategy: "C-total-only" }, "gap-scraper: parsed");
    // lastR values are in thousands — multiply to get actual passenger count
    return [
      { year: pr.dataYear,     month: pr.dataMonth, domestic: null, international: null, total: Math.round(lastR[1] * 1000) },
      { year: pr.dataYear - 1, month: pr.dataMonth, domestic: null, international: null, total: Math.round(lastR[0] * 1000) },
    ];
  }

  logger.warn({ year: pr.dataYear, month: pr.dataMonth }, "gap-scraper: could not extract PVR data");
  return [];
}

function makeResult(
  pr: PressRelease,
  dom: [number, number],
  intl: [number, number],
  tot: [number, number],
): PVRMonthData[] {
  return [
    {
      year: pr.dataYear,     month: pr.dataMonth,
      domestic: dom[1] * 1000, international: intl[1] * 1000, total: tot[1] * 1000,
    },
    {
      year: pr.dataYear - 1, month: pr.dataMonth,
      domestic: dom[0] * 1000, international: intl[0] * 1000, total: tot[0] * 1000,
    },
  ].map((r) => ({
    ...r,
    domestic:      r.domestic      !== null ? Math.round(r.domestic)      : null,
    international: r.international !== null ? Math.round(r.international) : null,
    total:         Math.round(r.total),
  }));
}

// ── Upsert helpers ────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** Prefer entry with breakdown over total-only; prefer higher total when both total-only. */
function isBetter(existing: PVRMonthData, candidate: PVRMonthData): boolean {
  if (existing.domestic === null && candidate.domestic !== null) return true;
  if (existing.domestic === null && candidate.domestic === null) return candidate.total > existing.total;
  return false;
}

async function upsertAirportMonth(data: PVRMonthData): Promise<void> {
  const days      = daysInMonth(data.year, data.month);
  const avgDaily  = parseFloat((data.total / days).toFixed(2));
  const monthName = MONTH_NAMES[data.month - 1];

  const existing = await db
    .select()
    .from(airportMetricsTable)
    .where(and(eq(airportMetricsTable.year, data.year), eq(airportMetricsTable.month, data.month)))
    .limit(1);

  const row = {
    totalPassengers:         data.total,
    domesticPassengers:      data.domestic ?? undefined,
    internationalPassengers: data.international ?? undefined,
    avgDailyPassengers:      String(avgDaily),
    daysInMonth:             days,
    source:                  "GAP – GlobeNewswire press release (real)",
    sourceUrl:               "https://www.globenewswire.com",
  };

  if (existing.length > 0) {
    await db.update(airportMetricsTable).set(row)
      .where(and(eq(airportMetricsTable.year, data.year), eq(airportMetricsTable.month, data.month)));
  } else {
    await db.insert(airportMetricsTable).values({
      year: data.year, month: data.month, monthName, ...row,
    });
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface GAPSyncResult {
  monthsProcessed: number;
  errors: number;
}

export async function syncGAPData(): Promise<GAPSyncResult> {
  logger.info("gap-scraper: starting sync");

  const allMonths = new Map<string, PVRMonthData>();
  let errors = 0;

  for (const pr of PRESS_RELEASES) {
    try {
      const monthData = await parsePressRelease(pr);
      for (const m of monthData) {
        const key = `${m.year}-${m.month}`;
        const existing = allMonths.get(key);
        if (!existing || isBetter(existing, m)) {
          allMonths.set(key, m);
        }
      }
      await new Promise((r) => setTimeout(r, 600));
    } catch (err) {
      logger.error({ pr, err }, "gap-scraper: press release processing error");
      errors++;
    }
  }

  for (const [, data] of allMonths) {
    try {
      await upsertAirportMonth(data);
    } catch (err) {
      logger.error({ data, err }, "gap-scraper: upsert failed");
      errors++;
    }
  }

  logger.info({ monthsProcessed: allMonths.size, errors }, "gap-scraper: sync complete");
  return { monthsProcessed: allMonths.size, errors };
}
