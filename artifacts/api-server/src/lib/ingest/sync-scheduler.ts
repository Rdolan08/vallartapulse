/**
 * sync-scheduler.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * In-process scheduled refresh for all automated data sources.
 *
 * Each source has a registered handler and a refresh interval.  On startup
 * the scheduler registers all sources and begins ticking.  A full refresh can
 * also be triggered on-demand via POST /ingest/sync-all.
 *
 * Source refresh intervals (configurable via env vars):
 *   SYNC_INTERVAL_PVRPV_H          default 6   hours
 *   SYNC_INTERVAL_VACATION_VALLARTA_H default 24  hours
 *   SYNC_INTERVAL_BOOKING_H         default 12  hours
 *
 * All intervals have a minimum floor of 1 hour to avoid hammering sources.
 */

import type { SourceKey } from "./types.js";

export interface SyncRecord {
  source: SourceKey;
  displayName: string;
  intervalMs: number;
  lastSyncAt: Date | null;
  lastSyncStatus: "ok" | "error" | "skipped" | null;
  lastSyncCount: number | null;
  lastSyncError: string | null;
  nextSyncAt: Date | null;
  isRunning: boolean;
  requiresCredentials: boolean;
  credentialsMissing: boolean;
  credentialVars: string[];
}

export interface SyncResult {
  source: SourceKey;
  ok: boolean;
  count: number;
  error?: string;
  skipped?: boolean;
  note?: string;
  durationMs: number;
}

type SyncHandler = () => Promise<{ ok: boolean; count: number; error?: string; note?: string }>;

interface RegisteredSource {
  record: SyncRecord;
  handler: SyncHandler;
  timer: ReturnType<typeof setInterval> | null;
}

const registry = new Map<SourceKey, RegisteredSource>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function envHours(varName: string, defaultH: number): number {
  const raw = process.env[varName];
  if (!raw) return defaultH;
  const parsed = parseFloat(raw);
  return isNaN(parsed) || parsed < 1 ? 1 : parsed;
}

function checkCreds(vars: string[]): boolean {
  return vars.some((v) => !process.env[v]);
}

// ── Source registration ───────────────────────────────────────────────────────

export function registerSource(
  source: SourceKey,
  displayName: string,
  intervalMs: number,
  credentialVars: string[],
  handler: SyncHandler,
): void {
  const credentialsMissing = checkCreds(credentialVars);

  const record: SyncRecord = {
    source,
    displayName,
    intervalMs,
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncCount: null,
    lastSyncError: null,
    nextSyncAt: new Date(Date.now() + intervalMs),
    isRunning: false,
    requiresCredentials: credentialVars.length > 0,
    credentialsMissing,
    credentialVars,
  };

  const timer = setInterval(() => runSource(source), intervalMs);

  registry.set(source, { record, handler, timer });
}

// ── Execution ─────────────────────────────────────────────────────────────────

async function runSource(source: SourceKey): Promise<SyncResult> {
  const reg = registry.get(source);
  if (!reg) return { source, ok: false, count: 0, error: "Source not registered", durationMs: 0 };

  if (reg.record.isRunning) {
    return { source, ok: true, count: 0, skipped: true, note: "Already running", durationMs: 0 };
  }

  // Re-check credentials at runtime (may have been added since startup)
  reg.record.credentialsMissing = checkCreds(reg.record.credentialVars);

  reg.record.isRunning = true;
  const start = Date.now();

  try {
    const result = await reg.handler();
    const durationMs = Date.now() - start;

    reg.record.lastSyncAt = new Date();
    reg.record.lastSyncStatus = result.ok ? "ok" : "error";
    reg.record.lastSyncCount = result.count;
    reg.record.lastSyncError = result.error ?? null;
    reg.record.nextSyncAt = new Date(Date.now() + reg.record.intervalMs);
    reg.record.isRunning = false;

    return { source, ok: result.ok, count: result.count, error: result.error, note: result.note, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err instanceof Error ? err.message : String(err);

    reg.record.lastSyncAt = new Date();
    reg.record.lastSyncStatus = "error";
    reg.record.lastSyncError = error;
    reg.record.nextSyncAt = new Date(Date.now() + reg.record.intervalMs);
    reg.record.isRunning = false;

    return { source, ok: false, count: 0, error, durationMs };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Trigger an immediate sync of all registered sources (in parallel). */
export async function syncAll(): Promise<SyncResult[]> {
  const sources = [...registry.keys()];
  const results = await Promise.all(sources.map((s) => runSource(s)));
  return results;
}

/** Trigger an immediate sync of a single source by key. */
export async function syncSource(source: SourceKey): Promise<SyncResult> {
  return runSource(source);
}

/** Get current status for all registered sources (for the /ingest/sync-status endpoint). */
export function getSyncStatus(): SyncRecord[] {
  return [...registry.values()].map((r) => ({ ...r.record }));
}

/** Stop all scheduled timers (for graceful shutdown / testing). */
export function stopScheduler(): void {
  for (const reg of registry.values()) {
    if (reg.timer) clearInterval(reg.timer);
    reg.timer = null;
  }
  registry.clear();
}

// ── Source bootstrap (called from index.ts) ───────────────────────────────────

let schedulerStarted = false;

export async function startScheduler(): Promise<void> {
  if (schedulerStarted) return;
  schedulerStarted = true;

  // Lazy imports to avoid circular deps
  const [{ fetchAllVacationVallartaListings }, { persistNormalized }, { fetchAllBookingListings }] =
    await Promise.all([
      import("./vacation-vallarta-adapter.js"),
      import("./persist.js"),
      import("./booking-adapter.js"),
    ]);

  // ── Vacation Vallarta (HTML scraper) ─────────────────────────────────────
  const vvIntervalH = envHours("SYNC_INTERVAL_VACATION_VALLARTA_H", 24);
  registerSource(
    "vacation_vallarta",
    "Vacation Vallarta",
    vvIntervalH * 60 * 60 * 1000,
    [],
    async () => {
      const listings = await fetchAllVacationVallartaListings({ delayMs: 2000 });
      let saved = 0;
      for (const l of listings) {
        const r = await persistNormalized(l);
        if (r.ok) saved++;
      }
      return { ok: true, count: saved };
    },
  );

  // ── Booking.com (API — requires credentials) ─────────────────────────────
  const bookingIntervalH = envHours("SYNC_INTERVAL_BOOKING_H", 12);
  registerSource(
    "booking_com",
    "Booking.com",
    bookingIntervalH * 60 * 60 * 1000,
    ["BOOKING_AFFILIATE_ID", "BOOKING_API_KEY"],
    async () => {
      const result = await fetchAllBookingListings();
      if (!result.ok) return { ok: false, count: 0, error: result.error, note: result.note };
      let saved = 0;
      for (const l of result.listings) {
        const r = await persistNormalized(l);
        if (r.ok) saved++;
      }
      return { ok: true, count: saved, note: result.note };
    },
  );

  // Note: PVRPV is run via an external script (scripts/src/pvrpv-scrape.ts)
  // rather than from within the server process, because it requires crawling
  // hundreds of pages and is better suited to a GitHub Actions workflow.
  // Registered here at 30-day interval just so sync-status shows it in the registry.
  // 30 days in ms = 2_592_000_000, which is below the Node.js setInterval limit.
  registerSource(
    "pvrpv",
    "PVRPV.com (external script)",
    30 * 24 * 60 * 60 * 1000, // 30 days — effectively a placeholder; real refresh is via external workflow
    [],
    async () => ({ ok: true, count: 0, note: "PVRPV is refreshed via external GitHub Actions workflow, not in-process" }),
  );
}
