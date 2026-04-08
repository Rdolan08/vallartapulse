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
 *   Strategy PDF – PDF from aeropuertosgap.com.mx parsed via pdftotext.
 *
 * When building the monthly map from all press releases, entries with a full
 * breakdown (dom + intl + tot) are preferred over total-only entries; when
 * both are total-only the higher value (= the real total) wins.
 *
 * Source: https://www.globenewswire.com (public press releases)
 *         https://www.aeropuertosgap.com.mx (PDF press releases)
 * ────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { db } from "@workspace/db";
import { airportMetricsTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

interface PressRelease {
  dataMonth: number;
  dataYear: number;
  url: string;
  /** One or more direct PDF URLs from aeropuertosgap.com.mx — tried in order, first success wins. */
  pdfUrls?: string[];
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
  { dataYear: 2026, dataMonth:  2, url: "https://www.globenewswire.com/news-release/2026/03/06/3251336/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-in-February-2026-of-5-5-Compared-to-2025.html",
    pdfUrls: ["https://www.aeropuertosgap.com.mx/images/files/06_03_2026_PR_TRAFICO_FEBRERO_2026_ESP_VF.pdf"] },
  { dataYear: 2026, dataMonth:  3, url: "https://www.globenewswire.com/news-release/2026/04/07/3269747/0/en/Grupo-Aeroportuario-del-Pacifico-Reports-a-Passenger-Traffic-Decrease-in-March-2026-of-8-9-Compared-to-2025.html", pdfUrls: [
    "https://www.aeropuertosgap.com.mx/images/files/07_04_2026_PR_TRAFICO_MARZO_2026_ESP_VF.pdf",
    "https://www.aeropuertosgap.com.mx/images/files/08_04_2026_PR_TRAFICO_MARZO_2026_ESP_VF.pdf",
    "https://www.aeropuertosgap.com.mx/images/files/09_04_2026_PR_TRAFICO_MARZO_2026_ESP_VF.pdf",
    "https://www.aeropuertosgap.com.mx/images/files/10_04_2026_PR_TRAFICO_MARZO_2026_ESP_VF.pdf",
    "https://www.aeropuertosgap.com.mx/images/files/11_04_2026_PR_TRAFICO_MARZO_2026_ESP_VF.pdf",
  ]},
];

interface PVRMonthData {
  year: number;
  month: number;
  domestic: number | null;
  international: number | null;
  total: number;
  sourceLabel?: string;
  sourceUrl?: string;
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

// ── PDF parsing (Strategy PDF) ────────────────────────────────────────────────

/**
 * Download a PDF from GAP's website and extract PVR passenger data using
 * pdftotext. The Spanish-language PDFs have a table like:
 *
 *   Puerto Vallarta   192.6   204.2   -5.7%   457.3   484.8   -5.7%   649.9   689.0   -5.7%
 *
 * Column order (positional): Dom_current  Dom_prior  Dom_%  Intl_current  Intl_prior  Intl_%  Tot_current  Tot_prior  Tot_%
 * Values are in thousands.  Returns null if unavailable or unparseable.
 */
async function parsePdfRelease(pr: PressRelease): Promise<PVRMonthData[] | null> {
  if (!pr.pdfUrls || pr.pdfUrls.length === 0) return null;

  // Try each candidate URL in order — first 200 response wins
  let chosenUrl: string | null = null;
  let pdfBuf: Buffer | null = null;
  for (const pdfUrl of pr.pdfUrls) {
    try {
      const res = await fetch(pdfUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; VallartaPulse/1.0)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        pdfBuf = Buffer.from(await res.arrayBuffer());
        chosenUrl = pdfUrl;
        logger.info({ pdfUrl }, "gap-scraper: PDF found");
        break;
      }
      logger.debug({ pdfUrl, status: res.status }, "gap-scraper: PDF candidate not available");
    } catch {
      logger.debug({ pdfUrl }, "gap-scraper: PDF candidate fetch error");
    }
  }

  if (!pdfBuf || !chosenUrl) {
    logger.debug({ year: pr.dataYear, month: pr.dataMonth }, "gap-scraper: no PDF candidates available");
    return null;
  }

  let tmpFile: string | null = null;
  try {
    tmpFile = path.join(os.tmpdir(), `gap-${pr.dataYear}-${pr.dataMonth}.pdf`);
    await fs.writeFile(tmpFile, pdfBuf);

    const { stdout } = await execFileAsync("pdftotext", ["-layout", tmpFile, "-"]);
    const lines = stdout.split("\n");

    // The PDF has one PVR row per metric section:
    //   Row 1 (Domestic):      Puerto Vallarta  <prior>  <current>  (pct%)  <prior_YTD>  <current_YTD>  (pct%)
    //   Row 2 (International): Puerto Vallarta  <prior>  <current>  (pct%)  <prior_YTD>  <current_YTD>  (pct%)
    //   Row 3 (Total):         Puerto Vallarta  <prior>  <current>  (pct%)  <prior_YTD>  <current_YTD>  (pct%)
    // Column order is PRIOR YEAR first, CURRENT YEAR second.
    // Filter to lines that contain a PVR airport name AND at least one number.
    // Only keep lines with a 3+-digit decimal number (e.g. 192.6, 649.9) —
    // this excludes prose lines with percentages (7.4%) or bare small numbers (52).
    const pvrLines = lines.filter(
      (l) => /puerto vallarta/i.test(l) && /\b\d{3,}\.\d/.test(l)
    );
    if (pvrLines.length === 0) {
      logger.warn({ pdfUrl: chosenUrl }, "gap-scraper: PDF parsed but no PVR data rows found");
      return null;
    }

    /** Extract the first two positive numeric values from a PVR row (prior, current). */
    function extractPair(line: string): [number, number] | null {
      const after = line.replace(/puerto vallarta/i, "");
      const nums = [...after.matchAll(/\b(\d[\d,]*\.?\d*)\b/g)]
        .map((m) => parseFloat(m[1].replace(/,/g, "")))
        .filter((n) => n > 0);
      return nums.length >= 2 ? [nums[0], nums[1]] : null;
    }

    const src = { sourceLabel: "GAP – aeropuertosgap.com.mx PDF (real)", sourceUrl: chosenUrl };

    // ── 3-row mode: Dom / Intl / Total ───────────────────────────────────────
    if (pvrLines.length >= 3) {
      const domPair  = extractPair(pvrLines[0]);
      const intlPair = extractPair(pvrLines[1]);
      const totPair  = extractPair(pvrLines[2]);
      if (domPair && intlPair && totPair) {
        const [domPrior, domCur]   = domPair;
        const [intlPrior, intlCur] = intlPair;
        const [totPrior,  totCur]  = totPair;
        // Sanity: dom + intl ≈ total (within 5%)
        if (Math.abs((domCur + intlCur) - totCur) / Math.max(totCur, 0.001) < 0.05) {
          logger.info({ year: pr.dataYear, month: pr.dataMonth, strategy: "PDF-full" }, "gap-scraper: parsed");
          return [
            { year: pr.dataYear,     month: pr.dataMonth, domestic: Math.round(domCur * 1000),   international: Math.round(intlCur * 1000),   total: Math.round(totCur * 1000),   ...src },
            { year: pr.dataYear - 1, month: pr.dataMonth, domestic: Math.round(domPrior * 1000), international: Math.round(intlPrior * 1000), total: Math.round(totPrior * 1000), ...src },
          ];
        }
      }
    }

    // ── 1-row fallback: use whichever PVR line has the largest numbers (= Total) ─
    let bestPair: [number, number] | null = null;
    for (const line of pvrLines) {
      const pair = extractPair(line);
      if (pair && (!bestPair || pair[0] + pair[1] > bestPair[0] + bestPair[1])) {
        bestPair = pair;
      }
    }
    if (bestPair) {
      const [prior, cur] = bestPair;
      logger.info({ year: pr.dataYear, month: pr.dataMonth, strategy: "PDF-total-only" }, "gap-scraper: parsed");
      return [
        { year: pr.dataYear,     month: pr.dataMonth, domestic: null, international: null, total: Math.round(cur * 1000),   ...src },
        { year: pr.dataYear - 1, month: pr.dataMonth, domestic: null, international: null, total: Math.round(prior * 1000), ...src },
      ];
    }

    logger.warn({ pdfUrl: chosenUrl }, "gap-scraper: PDF PVR rows found but no numeric pairs extracted");
    return null;
  } catch (err) {
    logger.warn({ pdfUrl: chosenUrl, err }, "gap-scraper: PDF parse error");
    return null;
  } finally {
    if (tmpFile) await fs.unlink(tmpFile).catch(() => {});
  }
}

// ── Section-label constants ───────────────────────────────────────────────────

const LABELS = {
  dom:  "Domestic Terminal Passengers",
  intl: "International Terminal Passengers",
  tot:  "Total Terminal Passengers",
} as const;

// ── Press-release parser ─────────────────────────────────────────────────────

async function parsePressRelease(pr: PressRelease): Promise<PVRMonthData[]> {
  // Try PDF source first (more reliable, direct from GAP)
  if (pr.pdfUrls && pr.pdfUrls.length > 0) {
    const pdfResult = await parsePdfRelease(pr);
    if (pdfResult && pdfResult.length > 0) return pdfResult;
    logger.debug({ year: pr.dataYear, month: pr.dataMonth }, "gap-scraper: PDF unavailable, falling back to HTML");
  }

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
  // ── Sanity check: dom + intl must ≈ total (within 10%) when breakdown is present ──
  if (data.domestic !== null && data.international !== null) {
    const computed   = data.domestic + data.international;
    const tolerance  = Math.max(data.total, 1) * 0.10;
    if (Math.abs(computed - data.total) > tolerance) {
      logger.warn(
        { year: data.year, month: data.month,
          domestic: data.domestic, international: data.international,
          total: data.total, computed },
        "gap-scraper: dom+intl sum doesn't match total — skipping write to avoid corruption"
      );
      return;
    }
  }

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
    source:                  data.sourceLabel ?? "GAP – GlobeNewswire press release (real)",
    sourceUrl:               data.sourceUrl   ?? "https://www.globenewswire.com",
  };

  if (existing.length > 0) {
    const ex = existing[0];

    // ── Regression guard ──────────────────────────────────────────────────────
    // If the existing confirmed total is significantly higher than the incoming
    // value, the scraper likely parsed the wrong number from the press release
    // (e.g. a single-terminal subtotal or a different airport's row).
    // Threshold: refuse updates where the new total is >35% below the existing
    // confirmed total — PVR traffic never halves without an airport closure.
    const existingTotal  = ex.totalPassengers ?? 0;
    const regressionPct  = existingTotal > 0
      ? ((existingTotal - data.total) / existingTotal) * 100
      : 0;

    if (existingTotal > 50_000 && regressionPct > 35) {
      logger.error(
        {
          year: data.year, month: data.month,
          existingTotal, newTotal: data.total,
          regressionPct: regressionPct.toFixed(1) + "%",
        },
        "gap-scraper: ABORTED update — regression guard triggered. New total is >35% below existing confirmed value. Likely a parse error."
      );
      return;
    }

    // Only update if the new data is higher quality (full breakdown vs total-only)
    // or if the existing row has no breakdown.
    const existingHasBreakdown = ex.domesticPassengers !== null && ex.domesticPassengers !== undefined;
    const newHasBreakdown      = data.domestic !== null;
    if (existingHasBreakdown && !newHasBreakdown) {
      logger.info(
        { year: data.year, month: data.month },
        "gap-scraper: skipping update — existing row has full breakdown, incoming is total-only"
      );
      return;
    }
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

  // ── Append-only: load months already stored in DB ─────────────────────────
  const storedRows = await db
    .select({ year: airportMetricsTable.year, month: airportMetricsTable.month })
    .from(airportMetricsTable);
  const storedKeys = new Set(storedRows.map((r) => `${r.year}-${r.month}`));

  // Always re-fetch the most recent press release (may be freshly published /
  // corrected by GAP). All older validated months are skipped entirely.
  const mostRecent = PRESS_RELEASES.reduce((a, b) =>
    a.dataYear > b.dataYear || (a.dataYear === b.dataYear && a.dataMonth > b.dataMonth) ? a : b
  );

  const toFetch = PRESS_RELEASES.filter((pr) => {
    const key = `${pr.dataYear}-${pr.dataMonth}`;
    const isMostRecent = pr === mostRecent;
    return isMostRecent || !storedKeys.has(key);
  });

  logger.info(
    { total: PRESS_RELEASES.length, toFetch: toFetch.length, storedMonths: storedKeys.size },
    "gap-scraper: skipping already-stored months"
  );

  const allMonths = new Map<string, PVRMonthData>();
  let errors = 0;

  for (const pr of toFetch) {
    try {
      const monthData = await parsePressRelease(pr);
      for (const m of monthData) {
        const key = `${m.year}-${m.month}`;
        // Only store months that are either new or the current press release's primary month
        const prKey = `${pr.dataYear}-${pr.dataMonth}`;
        const isNew = !storedKeys.has(key);
        const isPrimaryMonth = key === prKey;
        if (isNew || isPrimaryMonth) {
          const existing = allMonths.get(key);
          if (!existing || isBetter(existing, m)) {
            allMonths.set(key, m);
          }
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
