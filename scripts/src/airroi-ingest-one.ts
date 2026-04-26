/**
 * airroi-ingest-one.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * POC: pull forward-rate calendar from AirROI for a SINGLE Airbnb listing
 * and UPSERT it into rental_prices_by_date. Validates schema mapping +
 * Drizzle integration end-to-end before we commit to the full-cohort adapter.
 *
 * Replaces, for the AirROI cohort, the work currently done by:
 *   - scripts/src/airbnb-calendar-scrape.ts (availability)
 *   - scripts/src/airbnb-pricing-refresh.ts (per-night rates) — partially;
 *     this POC writes only rental_prices_by_date.nightlyPriceUsd, NOT
 *     listing_price_quotes (AirROI lacks fee breakdowns).
 *
 * Idempotent. Re-running upserts on the same (listing_id, date) unique index
 * (idx_rpbd_unique) — same target & ON CONFLICT semantics as the existing
 * scripts/src/airbnb-calendar-scrape.ts.
 *
 * Usage:
 *   AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:ingest:one -- 53116610
 *
 *   # Dry-run (fetch + map + count, but DO NOT write):
 *   AIRROI_DRY_RUN=1 AIRROI_API_KEY=... DATABASE_URL=$RAILWAY_DATABASE_URL \
 *     pnpm --filter @workspace/scripts run airroi:ingest:one -- 53116610
 *
 * Env:
 *   AIRROI_API_KEY        required
 *   DATABASE_URL          required (use $RAILWAY_DATABASE_URL for prod)
 *   AIRROI_DRY_RUN        optional; "1" skips the UPSERT
 *   AIRROI_CURRENCY       optional; default "usd"
 *
 * Availability mapping (see schema rental_prices_by_date.availabilityStatus):
 *   AirROI {available: true}  → "available"
 *   AirROI {available: false} → "booked"
 *     (AirROI doesn't distinguish booked-by-guest vs blocked-by-host; the
 *     conservative read for PV market intelligence is "booked" since hosts
 *     don't typically blackout 80%+ of their calendar. Revisit if downstream
 *     analytics need the distinction — would require a separate booked/
 *     blocked signal AirROI doesn't currently expose.)
 */

import { sql, eq, and, count } from "drizzle-orm";
import {
  db,
  pool,
  rentalListingsTable,
  rentalPricesByDateTable,
  type InsertRentalPriceByDate,
} from "@workspace/db";

const SOURCE_PLATFORM = "airbnb";
const AIRROI_BASE = "https://api.airroi.com";

interface AirroiDay {
  date: string;
  available: boolean;
  rate: number | null;
  min_nights: number | null;
}

interface AirroiResponse {
  currency?: string;
  dates?: AirroiDay[];
  // AirROI returns the array under one of: "dates" (current docs) or top-level array
  // depending on endpoint version. Probe both shapes defensively.
  [k: string]: unknown;
}

function logJson(event: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...payload }));
}

async function fetchAirroi(externalId: string, apiKey: string, currency: string): Promise<{
  status: number;
  headers: Record<string, string>;
  body: AirroiResponse;
  url: string;
  elapsedMs: number;
}> {
  const url = `${AIRROI_BASE}/listings/future/rates?id=${encodeURIComponent(externalId)}&currency=${encodeURIComponent(currency)}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "GET",
    headers: { "x-api-key": apiKey, accept: "application/json" },
  });
  const elapsedMs = Date.now() - t0;
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = (await res.json()) as AirroiResponse;
  return { status: res.status, headers, body, url, elapsedMs };
}

function extractDays(body: AirroiResponse): AirroiDay[] {
  // Defensive: try the documented "dates" key first, then a top-level array,
  // then any value that looks like an array of {date, available, rate, ...}.
  if (Array.isArray((body as { dates?: unknown }).dates)) {
    return (body as { dates: AirroiDay[] }).dates;
  }
  if (Array.isArray(body)) {
    return body as unknown as AirroiDay[];
  }
  for (const v of Object.values(body)) {
    if (
      Array.isArray(v) &&
      v.length > 0 &&
      typeof v[0] === "object" &&
      v[0] !== null &&
      "date" in (v[0] as object) &&
      "available" in (v[0] as object)
    ) {
      return v as AirroiDay[];
    }
  }
  return [];
}

function mapAvailability(available: boolean): "available" | "booked" {
  return available ? "available" : "booked";
}

function toInsertRows(
  listingId: number,
  days: AirroiDay[],
  scrapedAt: Date,
): InsertRentalPriceByDate[] {
  return days.map((d) => ({
    listingId,
    date: d.date, // YYYY-MM-DD; drizzle `date` accepts string
    nightlyPriceUsd: d.rate,
    availabilityStatus: mapAvailability(d.available),
    minimumNights: d.min_nights,
    scrapedAt,
  }));
}

async function upsertDays(rows: InsertRentalPriceByDate[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 1000;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db
      .insert(rentalPricesByDateTable)
      .values(slice)
      .onConflictDoUpdate({
        target: [rentalPricesByDateTable.listingId, rentalPricesByDateTable.date],
        set: {
          nightlyPriceUsd: sql`EXCLUDED.nightly_price_usd`,
          availabilityStatus: sql`EXCLUDED.availability_status`,
          minimumNights: sql`EXCLUDED.minimum_nights`,
          scrapedAt: sql`EXCLUDED.scraped_at`,
        },
      });
    total += slice.length;
  }
  return total;
}

async function main() {
  const externalId = process.argv[2];
  if (!externalId || !/^\d+$/.test(externalId)) {
    console.error("Usage: airroi:ingest:one -- <numeric-external-id>");
    process.exit(2);
  }

  const apiKey = process.env.AIRROI_API_KEY;
  if (!apiKey) {
    console.error("ERROR: AIRROI_API_KEY env var not set.");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL env var not set (use $RAILWAY_DATABASE_URL for prod).");
    process.exit(2);
  }

  const currency = process.env.AIRROI_CURRENCY ?? "usd";
  const dryRun = process.env.AIRROI_DRY_RUN === "1";

  logJson("airroi-ingest.start", { externalId, currency, dryRun });

  // 1. Look up internal listing id
  const listingRow = await db
    .select({ id: rentalListingsTable.id, title: rentalListingsTable.title })
    .from(rentalListingsTable)
    .where(
      and(
        eq(rentalListingsTable.sourcePlatform, SOURCE_PLATFORM),
        eq(rentalListingsTable.externalId, externalId),
      ),
    )
    .limit(1);

  if (listingRow.length === 0) {
    logJson("airroi-ingest.error", {
      reason: "listing-not-found",
      externalId,
    });
    await pool.end();
    process.exit(3);
  }
  const listingId = listingRow[0].id;
  const listingTitle = listingRow[0].title;
  logJson("airroi-ingest.listing-resolved", { externalId, listingId, listingTitle });

  // 2. Fetch from AirROI
  const fetchResult = await fetchAirroi(externalId, apiKey, currency);
  if (fetchResult.status !== 200) {
    logJson("airroi-ingest.error", {
      reason: "non-200-from-airroi",
      status: fetchResult.status,
      headers: fetchResult.headers,
      body: fetchResult.body,
    });
    await pool.end();
    process.exit(4);
  }

  const days = extractDays(fetchResult.body);
  if (days.length === 0) {
    logJson("airroi-ingest.error", {
      reason: "no-days-in-response",
      bodyKeys: Object.keys(fetchResult.body),
    });
    await pool.end();
    process.exit(5);
  }

  // 3. Pre-write count (scoped to this listing)
  const beforeRow = await db
    .select({ c: count() })
    .from(rentalPricesByDateTable)
    .where(eq(rentalPricesByDateTable.listingId, listingId));
  const beforeCount = beforeRow[0]?.c ?? 0;

  // 4. Map + write
  const scrapedAt = new Date();
  const insertRows = toInsertRows(listingId, days, scrapedAt);

  let written = 0;
  if (dryRun) {
    logJson("airroi-ingest.dry-run", {
      wouldWrite: insertRows.length,
      sample: insertRows.slice(0, 3),
    });
  } else {
    written = await upsertDays(insertRows);
  }

  // 5. Post-write count
  const afterRow = await db
    .select({ c: count() })
    .from(rentalPricesByDateTable)
    .where(eq(rentalPricesByDateTable.listingId, listingId));
  const afterCount = afterRow[0]?.c ?? 0;

  // 6. Summary
  const availableDays = days.filter((d) => d.available).length;
  const daysWithRate = days.filter((d) => d.rate != null).length;
  const rates = days.map((d) => d.rate).filter((r): r is number => r != null);
  const sortedRates = [...rates].sort((a, b) => a - b);
  const median =
    sortedRates.length === 0
      ? null
      : sortedRates.length % 2 === 0
        ? (sortedRates[sortedRates.length / 2 - 1] + sortedRates[sortedRates.length / 2]) / 2
        : sortedRates[Math.floor(sortedRates.length / 2)];

  logJson("airroi-ingest.done", {
    externalId,
    listingId,
    listingTitle,
    fetch: {
      status: fetchResult.status,
      elapsedMs: fetchResult.elapsedMs,
      url: fetchResult.url,
    },
    response: {
      totalDays: days.length,
      availableDays,
      daysWithRate,
      dateRange: { first: days[0]?.date, last: days[days.length - 1]?.date },
      rateStats:
        rates.length === 0
          ? null
          : { min: Math.min(...rates), max: Math.max(...rates), median },
    },
    db: {
      dryRun,
      rowsBefore: Number(beforeCount),
      rowsAfter: Number(afterCount),
      rowsDelta: Number(afterCount) - Number(beforeCount),
      rowsWritten: written,
    },
  });

  await pool.end();
}

main().catch(async (err) => {
  console.error("airroi-ingest.fatal", err);
  try {
    await pool.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
