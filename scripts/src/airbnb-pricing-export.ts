import { writeFileSync } from "node:fs";
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
  nightly_price_usd: number;
  availability_status: "available" | "unavailable" | "unknown";
  minimum_nights: number | null;
  scraped_at: string;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
  const outFile = process.env.AIRBNB_PRICING_EXPORT_FILE ?? "airbnb_calendar_prices.csv";
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = new Date();

  const listings = await loadActiveAirbnbListings(maxListings);
  console.log(
    `[airbnb-pricing-export] listings=${listings.length} max=${maxListings} concurrency=${concurrency}`,
  );

  const rows: CsvRow[] = [];
  const stats = {
    ok: 0,
    failed: 0,
    listingsWithPricedDays: 0,
    daysSeen: 0,
    daysKept: 0,
  };

  await runPool(
    listings,
    { concurrency, hardTimeoutMs: 90_000, delayBetweenMs: 300 },
    async (listing) => {
      try {
        const cal = await fetchAirbnbCalendar(listing.externalId, {
          monthsCount: 12,
          timeoutMs: 25_000,
        });

        let listingHadPrice = false;
        for (const day of cal.days) {
          stats.daysSeen++;
          if (day.nightlyPriceUsd == null) continue; // real-only
          if (!keepDate(day.date, today)) continue;

          rows.push({
            external_id: listing.externalId,
            date: day.date,
            nightly_price_usd: day.nightlyPriceUsd,
            availability_status: day.availabilityStatus,
            minimum_nights: day.minimumNights,
            scraped_at: nowIso,
          });
          stats.daysKept++;
          listingHadPrice = true;
        }

        if (listingHadPrice) stats.listingsWithPricedDays++;
        stats.ok++;
      } catch (e) {
        stats.failed++;
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `[airbnb-pricing-export] listing=${listing.id} ext=${listing.externalId} failed: ${message.slice(0, 200)}`,
        );
      }
    },
  );

  const header =
    "external_id,date,nightly_price_usd,availability_status,minimum_nights,scraped_at";
  const body = rows.map((r) =>
    [
      r.external_id,
      r.date,
      String(r.nightly_price_usd),
      r.availability_status,
      r.minimum_nights == null ? "" : String(r.minimum_nights),
      r.scraped_at,
    ].join(","),
  );

  writeFileSync(outFile, `${header}\n${body.join("\n")}${body.length > 0 ? "\n" : ""}`, "utf8");

  console.log(
    JSON.stringify(
      {
        out_file: outFile,
        scanned_listings: listings.length,
        listings_with_priced_days: stats.listingsWithPricedDays,
        rows_written: rows.length,
        days_seen: stats.daysSeen,
        days_kept: stats.daysKept,
        ok: stats.ok,
        failed: stats.failed,
        window_policy: `full daily [${dateOnly(today)}..+90d], then Monday+Saturday anchors through +365d`,
      },
      null,
      2,
    ),
  );

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
