/**
 * Investigation-only: compare raw HTTP (via proxy) vs browser fetch for
 * Airbnb detail enrichment. No DB writes. No production effect.
 *
 * For each listing we:
 *   1. Fetch via raw HTTP through the residential proxy
 *   2. Apply rawFetchLooksUnusable() — if unusable, fall back to browser
 *   3. Fetch via browser independently (for the side-by-side comparison)
 *   4. Run parseAirbnbDetailHtml() on both bodies
 *   5. Apply the runner's delisted/blocked classification logic
 *   6. Compare normalized fields between modes
 */

import { performance } from "node:perf_hooks";
import {
  fetchAirbnbRaw,
  rawFetchLooksUnusable,
} from "../../artifacts/api-server/src/lib/ingest/raw-fetch.js";
import { fetchWithBrowser, closeBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";
import { parseAirbnbDetailHtml } from "../../artifacts/api-server/src/lib/ingest/airbnb-detail-adapter.js";

interface TestCase { id: string; expectedAlive: boolean; ageBucket: "old" | "mid" | "new"; }

const CASES: TestCase[] = [
  // 5 LIVE — mix of older + newer IDs
  { id: "26717558",     expectedAlive: true,  ageBucket: "old" },  // newly added
  { id: "29764486",     expectedAlive: true,  ageBucket: "old" },
  { id: "13935677",     expectedAlive: true,  ageBucket: "old" },
  { id: "51332052",     expectedAlive: true,  ageBucket: "mid" },
  { id: "53860136",     expectedAlive: true,  ageBucket: "mid" },
  // 3 DELISTED
  { id: "986576320529", expectedAlive: false, ageBucket: "new" },
  { id: "142188006292", expectedAlive: false, ageBucket: "new" },
  { id: "150230730061", expectedAlive: false, ageBucket: "new" },
];

const URL_OF = (id: string) => `https://www.airbnb.com/rooms/${id}`;

type Outcome = "ok" | "partial" | "parse_fail" | "blocked" | "delisted" | "error";

interface ModeResult {
  outcome: Outcome;
  status?: number;
  bytes?: number;
  ms?: number;
  parseStatus?: "ok" | "partial" | "parse_fail";
  fields?: ReturnType<typeof parseAirbnbDetailHtml>["normalized"];
  error?: string;
  /** For raw mode only: did rawFetchLooksUnusable trip + we'd fall back? */
  wouldFallBackToBrowser?: boolean;
  fallbackReason?: string;
}

function looksDelisted(html: string): boolean {
  if (html.length > 6_000) return false;
  return html.includes("helpful_404.html.erb") ||
         html.includes("404 Page Not Found - Airbnb") ||
         /<title>\s*404\b/i.test(html);
}

function looksBlocked(html: string): { blocked: boolean; reason?: string } {
  if (html.length < 40_000) return { blocked: true, reason: `short body ${html.length}b` };
  const lower = html.toLowerCase();
  if (lower.includes("px-captcha") || lower.includes("perimeterx") ||
      lower.includes("/distil_r_") || lower.includes("access denied") ||
      lower.includes("are you a human") || lower.includes("blocked by the airbnb") ||
      lower.includes("pardon our interruption") || lower.includes("/forbidden")) {
    return { blocked: true, reason: "captcha/bot-wall markers" };
  }
  return { blocked: false };
}

/** Mirror what enrichOneAirbnbListing would conclude given an html body. */
function classify(html: string): { outcome: Outcome; parseStatus?: ModeResult["parseStatus"]; fields?: ModeResult["fields"] } {
  if (looksDelisted(html)) return { outcome: "delisted" };
  const block = looksBlocked(html);
  if (block.blocked) return { outcome: "blocked" };
  const parsed = parseAirbnbDetailHtml(html);
  return { outcome: parsed.parseStatus, parseStatus: parsed.parseStatus, fields: parsed.normalized };
}

async function runRaw(url: string): Promise<ModeResult> {
  try {
    const r = await fetchAirbnbRaw(url, { timeoutMs: 25_000 });
    const fallback = rawFetchLooksUnusable(r.html, r.status);
    const cls = classify(r.html);
    return {
      ...cls,
      status: r.status,
      bytes: r.bytes,
      ms: r.ms,
      wouldFallBackToBrowser: fallback.unusable,
      fallbackReason: fallback.reason,
    };
  } catch (e) {
    return { outcome: "error", error: (e as Error).message?.slice(0, 200), wouldFallBackToBrowser: true, fallbackReason: "raw transport error" };
  }
}

async function runBrowser(url: string): Promise<ModeResult> {
  const t0 = performance.now();
  try {
    const html = await fetchWithBrowser(url, {
      timeoutMs: 25_000,
      waitForSelector: 'script[type="application/ld+json"], script[id^="data-deferred-state"]',
      fallbackOnTimeout: true,
    });
    const ms = Math.round(performance.now() - t0);
    const cls = classify(html);
    return { ...cls, ms, bytes: html.length };
  } catch (e) {
    return { outcome: "error", ms: Math.round(performance.now() - t0), error: (e as Error).message?.slice(0, 200) };
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function fieldDelta(a?: ModeResult["fields"], b?: ModeResult["fields"]): string[] {
  if (!a && !b) return [];
  if (!a || !b) return ["one side has no fields"];
  const diffs: string[] = [];
  const keys: (keyof NonNullable<ModeResult["fields"]>)[] = [
    "title", "propertyType", "bedrooms", "bathrooms", "maxGuests", "bedCount",
    "latitude", "longitude", "ratingOverall", "reviewCount", "imageCount",
  ];
  for (const k of keys) {
    const av = a[k], bv = b[k];
    // Nulls vs values are interesting; small numeric differences (rounding) are not.
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number" && Math.abs(av - bv) < 0.001) continue;
    if (typeof av === "string" && typeof bv === "string" && av.trim() === bv.trim()) continue;
    diffs.push(`${k}: raw=${JSON.stringify(av)} browser=${JSON.stringify(bv)}`);
  }
  return diffs;
}

async function main() {
  console.log("════════════════ FETCH MODE COMPARISON ════════════════");
  console.log(`Test set: ${CASES.filter(c => c.expectedAlive).length} live + ${CASES.filter(c => !c.expectedAlive).length} delisted\n`);

  const rows: { c: TestCase; raw: ModeResult; browser: ModeResult }[] = [];

  for (const c of CASES) {
    const url = URL_OF(c.id);
    process.stdout.write(`[${c.id.padStart(13)}] raw...`);
    const raw = await runRaw(url);
    process.stdout.write(` ${raw.outcome}(${raw.ms ?? "?"}ms) | browser...`);
    const browser = await runBrowser(url);
    process.stdout.write(` ${browser.outcome}(${browser.ms ?? "?"}ms)\n`);
    rows.push({ c, raw, browser });
  }

  // ── Per-listing detail ───────────────────────────────────────────────
  console.log("\n════════════════ PER-LISTING DETAIL ════════════════");
  for (const { c, raw, browser } of rows) {
    console.log(`\n[${c.id}] (${c.ageBucket}, expected=${c.expectedAlive ? "live" : "delisted"})`);
    console.log(`  raw     : outcome=${raw.outcome.padEnd(10)} ms=${String(raw.ms ?? "?").padStart(5)}  bytes=${String(raw.bytes ?? "?").padStart(7)}  status=${raw.status ?? "—"}` +
                (raw.wouldFallBackToBrowser ? `  →fallback (${raw.fallbackReason})` : "") +
                (raw.error ? `  err=${raw.error.slice(0, 80)}` : ""));
    console.log(`  browser : outcome=${browser.outcome.padEnd(10)} ms=${String(browser.ms ?? "?").padStart(5)}  bytes=${String(browser.bytes ?? "?").padStart(7)}` +
                (browser.error ? `  err=${browser.error.slice(0, 80)}` : ""));
    if (raw.fields || browser.fields) {
      const summary = (f?: ModeResult["fields"]) => f
        ? `br=${f.bedrooms ?? "—"} ba=${f.bathrooms ?? "—"} g=${f.maxGuests ?? "—"} bc=${f.bedCount ?? "—"} r=${f.ratingOverall ?? "—"} t=${f.title ? "Y" : "N"} lat=${f.latitude ? "Y" : "N"}`
        : "(none)";
      console.log(`  fields  : raw[${summary(raw.fields)}]`);
      console.log(`            br [${summary(browser.fields)}]`);
      const diffs = fieldDelta(raw.fields, browser.fields);
      if (diffs.length) console.log(`  DELTA   : ${diffs.join(" ; ")}`);
    }
  }

  // ── Aggregate metrics ────────────────────────────────────────────────
  console.log("\n════════════════ AGGREGATE METRICS ════════════════");
  function bucket(mode: "raw" | "browser", liveOnly = false) {
    const subset = liveOnly ? rows.filter(r => r.c.expectedAlive) : rows;
    const all = subset.map(r => r[mode]);
    const counts: Record<Outcome, number> = { ok: 0, partial: 0, parse_fail: 0, blocked: 0, delisted: 0, error: 0 };
    for (const r of all) counts[r.outcome]++;
    const successCount = counts.ok + counts.partial;
    const times = all.filter(r => typeof r.ms === "number").map(r => r.ms!);
    return { counts, successCount, medianMs: median(times), n: all.length };
  }

  const tableRow = (label: string, b: ReturnType<typeof bucket>) =>
    `${label.padEnd(28)} success=${b.successCount}/${b.n}  ok=${b.counts.ok}  partial=${b.counts.partial}  parse_fail=${b.counts.parse_fail}  blocked=${b.counts.blocked}  delisted=${b.counts.delisted}  error=${b.counts.error}  median=${b.medianMs}ms`;

  console.log(tableRow("RAW (all 8)",                bucket("raw")));
  console.log(tableRow("BROWSER (all 8)",            bucket("browser")));
  console.log(tableRow("RAW (5 live only)",          bucket("raw", true)));
  console.log(tableRow("BROWSER (5 live only)",      bucket("browser", true)));

  // ── Hybrid simulation: raw-first, browser fallback when unusable ────
  console.log("\n════════════════ HYBRID SIMULATION (raw-first + browser fallback) ════════════════");
  const hybridCounts: Record<Outcome, number> = { ok: 0, partial: 0, parse_fail: 0, blocked: 0, delisted: 0, error: 0 };
  let fallbackCount = 0;
  let totalHybridMs = 0;
  for (const { raw, browser } of rows) {
    if (raw.wouldFallBackToBrowser) {
      fallbackCount++;
      hybridCounts[browser.outcome]++;
      totalHybridMs += (raw.ms ?? 0) + (browser.ms ?? 0);
    } else {
      hybridCounts[raw.outcome]++;
      totalHybridMs += (raw.ms ?? 0);
    }
  }
  console.log(`hybrid result: ok=${hybridCounts.ok} partial=${hybridCounts.partial} parse_fail=${hybridCounts.parse_fail} blocked=${hybridCounts.blocked} delisted=${hybridCounts.delisted} error=${hybridCounts.error}`);
  console.log(`browser-fallback used: ${fallbackCount}/${rows.length}`);
  console.log(`total wall time hybrid: ${totalHybridMs}ms (vs browser-only ~${rows.reduce((s, r) => s + (r.browser.ms ?? 0), 0)}ms)`);

  // ── Field-equivalence summary ───────────────────────────────────────
  console.log("\n════════════════ FIELD EQUIVALENCE (raw vs browser, live listings) ════════════════");
  let identical = 0, differing = 0, oneOnly = 0;
  for (const { c, raw, browser } of rows) {
    if (!c.expectedAlive) continue;
    if (!raw.fields && !browser.fields) continue;
    if (!raw.fields || !browser.fields) { oneOnly++; continue; }
    const diffs = fieldDelta(raw.fields, browser.fields);
    if (diffs.length === 0) identical++; else differing++;
  }
  console.log(`identical:     ${identical}/5`);
  console.log(`differing:     ${differing}/5`);
  console.log(`one-side-only: ${oneOnly}/5`);

  await closeBrowser();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FATAL:", e?.message || e);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
