import { createWriteStream, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import { fetchAirbnbCalendar } from "../../artifacts/api-server/src/lib/ingest/airbnb-calendar-adapter.js";
import { runPool } from "./lib/concurrency.js";

interface ListingRow {
  id: number;
  externalId: string;
}

interface CsvRow {
  external_id: string;
  date: string;
  nightly_price_usd: number | null;
  availability_status: "available" | "unavailable" | "unknown";
  minimum_nights: number | null;
  scraped_at: string;
}

interface ProgressState {
  generated_at: string;
  total_listings: number;
  max_listings: number;
  start_offset: number;
  next_index: number;
  ok: number;
  failed: number;
  listings_with_calendar_signal: number;
  listings_with_priced_days: number;
  days_seen: number;
  days_kept: number;
  rows_written: number;
  out_file: string;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBoolEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Keep all days in [today, +90d]. In (90d, 365d], keep only weekday/weekend
 * anchors (Monday + Saturday) to reduce output size while retaining
 * seasonality signal.
 */
function keepDate(isoDate: string, today: Date): boolean {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;

  const d0 = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const d90 = addDays(d0, 90);
  const d365 = addDays(d0, 365);

  if (d < d0 || d > d365) return false;
  if (d <= d90) return true;

  const dow = d.getUTCDay();
  return dow === 1 || dow === 6; // Monday / Saturday
}

async function loadActiveAirbnbListings(maxListings: number): Promise<ListingRow[]> {
  const result = await db.execute(sql`
    SELECT id, external_id AS "externalId"
    FROM rental_listings
    WHERE source_platform = 'airbnb'
      AND is_active = true
      AND external_id IS NOT NULL
      AND external_id ~ '^[0-9]+$'
    ORDER BY id
    LIMIT ${maxListings}
  `);

  return (result as unknown as { rows: ListingRow[] }).rows;
}

async function main(): Promise<number> {
  const maxListings = parseIntEnv("AIRBNB_PRICING_EXPORT_MAX_LISTINGS", 2000);
  const concurrency = parseIntEnv("AIRBNB_PRICING_EXPORT_CONCURRENCY", 2);
  const startOffsetEnv = parseIntEnv("AIRBNB_PRICING_EXPORT_START_OFFSET", 0);
  const resume = parseBoolEnv("AIRBNB_PRICING_EXPORT_RESUME", false);
  const outFile = process.env.AIRBNB_PRICING_EXPORT_FILE ?? "airbnb_calendar_prices.csv";
  const progressFile =
    process.env.AIRBNB_PRICING_EXPORT_PROGRESS_FILE ?? ".airbnb-pricing-export.progress.json";
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = new Date();

  let startOffset = startOffsetEnv;
  if (resume && existsSync(progressFile)) {
    try {
      const prior = JSON.parse(readFileSync(progressFile, "utf8")) as ProgressState;
      if (prior.next_index > startOffset) startOffset = prior.next_index;
      console.log(
        `[airbnb-pricing-export] resume=1 using progress file ${progressFile} next_index=${prior.next_index}`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[airbnb-pricing-export] failed to parse progress file ${progressFile}: ${message}`,
      );
    }
  }

  const allListings = await loadActiveAirbnbListings(maxListings);
  const listings = allListings.slice(startOffset);
  console.log(
    `[airbnb-pricing-export] listings=${listings.length} offset=${startOffset} max=${maxListings} concurrency=${concurrency}`,
  );

  let rowsWritten = 0;
  const csv = createWriteStream(outFile, { encoding: "utf8", flags: "w" });
  csv.write("external_id,date,nightly_price_usd,availability_status,minimum_nights,scraped_at\n");
  const stats = {
    ok: 0,
    failed: 0,
    listingsWithCalendarSignal: 0,
    listingsWithPricedDays: 0,
    daysSeen: 0,
    daysKept: 0,
  };
  const startedAt = Date.now();
  let processedListings = 0;

  let aborted = false;
  const requestStop = (signal: string): void => {
    aborted = true;
    console.warn(
      `[airbnb-pricing-export] ${signal} received, finishing in-flight requests and saving checkpoint...`,
    );
  };
  process.on("SIGINT", () => requestStop("SIGINT"));
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGTSTP", () => requestStop("SIGTSTP"));

  const writeProgress = (nextIndex: number): void => {
    const progress: ProgressState = {
      generated_at: new Date().toISOString(),
      total_listings: listings.length,
      max_listings: maxListings,
      start_offset: startOffset,
      next_index: nextIndex,
      ok: stats.ok,
      failed: stats.failed,
      listings_with_calendar_signal: stats.listingsWithCalendarSignal,
      listings_with_priced_days: stats.listingsWithPricedDays,
      days_seen: stats.daysSeen,
      days_kept: stats.daysKept,
      rows_written: rowsWritten,
      out_file: outFile,
    };
    const payload = `${JSON.stringify(progress, null, 2)}\n`;
    // Overwrite each time to keep a single restart checkpoint.
    writeFileSync(progressFile, payload, "utf8");
  };

  await runPool(
    listings.map((listing, index) => ({ listing, index })),
    { concurrency, hardTimeoutMs: 90_000, delayBetweenMs: 300 },
    async ({ listing, index }) => {
      if (aborted) return;
      let attempted = false;
      try {
        attempted = true;
        const cal = await fetchAirbnbCalendar(listing.externalId, {
          monthsCount: 12,
          timeoutMs: 25_000,
        });

        let listingHadPrice = false;
        let listingHadCalendarSignal = false;

        for (const day of cal.days) {
          stats.daysSeen++;
          if (!keepDate(day.date, today)) continue;
          if (day.availabilityStatus === "unknown" && day.nightlyPriceUsd == null) continue;

          const row: CsvRow = {
            external_id: listing.externalId,
            date: day.date,
            nightly_price_usd: day.nightlyPriceUsd,
            availability_status: day.availabilityStatus,
            minimum_nights: day.minimumNights,
            scraped_at: nowIso,
          };
          csv.write(
            [
              row.external_id,
              row.date,
              row.nightly_price_usd == null ? "" : String(row.nightly_price_usd),
              row.availability_status,
              row.minimum_nights == null ? "" : String(row.minimum_nights),
              row.scraped_at,
            ].join(",") + "\n",
          );
          rowsWritten++;

          stats.daysKept++;
          listingHadCalendarSignal = true;
          if (day.nightlyPriceUsd != null) listingHadPrice = true;
        }

        if (listingHadCalendarSignal) stats.listingsWithCalendarSignal++;
        if (listingHadPrice) stats.listingsWithPricedDays++;
        stats.ok++;
      } catch (e) {
        stats.failed++;
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `[airbnb-pricing-export] listing=${listing.id} ext=${listing.externalId} failed: ${message.slice(0, 200)}`,
        );
      } finally {
        if (attempted) {
          processedListings++;
          writeProgress(startOffset + index + 1);

          if (processedListings % 25 === 0 || processedListings === listings.length) {
            const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
            const perMin = Math.round((processedListings / elapsedSec) * 60);
            console.log(
              `[airbnb-pricing-export] progress processed=${processedListings}/${listings.length} ok=${stats.ok} failed=${stats.failed} rows=${rowsWritten} rate=${perMin}/min`,
            );
          }
        }
      }
    },
  );

  await new Promise<void>((resolve) => {
    csv.end(() => resolve());
  });
  if (!aborted && existsSync(progressFile)) unlinkSync(progressFile);

  console.log(
    JSON.stringify(
      {
        out_file: outFile,
        resume: resume ? 1 : 0,
        start_offset: startOffset,
        scanned_listings: listings.length,
        listings_with_calendar_signal: stats.listingsWithCalendarSignal,
        listings_with_priced_days: stats.listingsWithPricedDays,
        rows_written: rowsWritten,
        days_seen: stats.daysSeen,
        days_kept: stats.daysKept,
        ok: stats.ok,
        failed: stats.failed,
        aborted: aborted ? 1 : 0,
        window_policy: `full daily [${dateOnly(today)}..+90d], then Monday+Saturday anchors through +365d`,
      },
      null,
      2,
    ),
  );

  if (aborted) return 130;
  return stats.failed > 0 && stats.ok === 0 ? 1 : 0;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
