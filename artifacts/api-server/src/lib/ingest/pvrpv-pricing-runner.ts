/**
 * ingest/pvrpv-pricing-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily fee-quote refresh for PVRPV listings.
 *
 * Why this exists:
 *   The comp-comparison view on /sources joins listing_price_quotes for the
 *   four fee columns (cleaning / service / taxes / total). Until now only the
 *   Airbnb pricing runner wrote to this table, so PVRPV comps rendered "—"
 *   for every fee row. This runner closes that gap.
 *
 * Method:
 *   1. Stale-first cohort across active PVRPV listings.
 *   2. For each listing, fetch the public calendar via fetchPvrpvCalendar()
 *      (per-night prices + availability for ~12 forward months).
 *   3. Generate the same Airbnb checkpoint set so comps line up date-for-date.
 *   4. For each checkpoint, sum the per-night calendar prices into a
 *      subtotal. PVRPV does not surface a separate cleaning or platform
 *      service fee on its public pages — both are folded into the nightly
 *      rate per the agency's own terms. We synthesize Mexico hotel tax
 *      (IVA 16% + ISH 3% = 19%) on top of the subtotal so the "total" row
 *      is comparable to Airbnb / VRBO totals; cleaning_fee_usd and
 *      service_fee_usd are written as 0 to preserve the non-null contract
 *      the comp-comparison query relies on.
 *   5. Skip checkpoints that aren't fully available — the comp-comparison
 *      query filters on availability_status='available', and writing
 *      partial-availability rows would just bloat the time-series.
 *
 * Fee derivation is recorded in raw_quote_json.feeDerivation so a future
 * task that scrapes a real PVRPV checkout quote can tell synthesized rows
 * apart from observed ones.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  listingPriceQuotesTable,
  type InsertListingPriceQuote,
} from "@workspace/db/schema";

import { fetchPvrpvCalendar, type CalendarDay } from "./pvrpv-calendar-adapter.js";
import { generateCheckpoints, type Checkpoint } from "./airbnb-checkpoints.js";

const SOURCE_PLATFORM = "pvrpv";

/** Mexico/Jalisco lodging tax: IVA 16% + ISH 3%. */
const MEXICO_LODGING_TAX_RATE = 0.19;

export interface PvrpvPricingRunOpts {
  maxListings?: number;
  dryRun?: boolean;
  today?: Date;
}

export interface PvrpvPricingPerListing {
  listingId: number;
  sourceUrl: string;
  ok: boolean;
  daysReturned: number;
  daysWithPrice: number;
  checkpointsAttempted: number;
  checkpointsAvailable: number;
  quotesWritten: number;
  error?: string;
}

export interface PvrpvPricingRunSummary {
  attempted: number;
  ok: number;
  failed: number;
  totalQuotesWritten: number;
  alertLevel: "ok" | "warn" | "fail";
  alertReason: string;
}

export interface PvrpvPricingRunResult {
  summary: PvrpvPricingRunSummary;
  listings: PvrpvPricingPerListing[];
}

interface ListingRow {
  id: number;
  sourceUrl: string;
}

async function loadStaleFirstListings(maxListings: number): Promise<ListingRow[]> {
  const result = await db.execute(sql`
    SELECT rl.id,
           rl.source_url AS "sourceUrl"
    FROM rental_listings rl
    LEFT JOIN (
      SELECT listing_id, MAX(collected_at) AS last_quoted
      FROM listing_price_quotes
      GROUP BY listing_id
    ) q ON q.listing_id = rl.id
    WHERE rl.source_platform = ${SOURCE_PLATFORM}
      AND rl.is_active = true
    ORDER BY q.last_quoted ASC NULLS FIRST, rl.id ASC
    LIMIT ${maxListings}
  `);
  return (result as unknown as { rows: ListingRow[] }).rows;
}

function buildDayIndex(days: CalendarDay[]): Map<string, CalendarDay> {
  const m = new Map<string, CalendarDay>();
  for (const d of days) m.set(d.date, d);
  return m;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface StayPrice {
  perNight: number[];
  nightsCovered: number;
  allAvailable: boolean;
}

function pricesForStay(cp: Checkpoint, index: Map<string, CalendarDay>): StayPrice {
  const start = new Date(`${cp.checkin}T00:00:00Z`);
  const perNight: number[] = [];
  let nightsCovered = 0;
  let allAvailable = true;
  for (let i = 0; i < cp.stayNights; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const day = index.get(key);
    if (!day) {
      allAvailable = false;
      continue;
    }
    nightsCovered++;
    if (day.availabilityStatus !== "available") allAvailable = false;
    if (typeof day.nightlyPriceUsd === "number") perNight.push(day.nightlyPriceUsd);
  }
  return { perNight, nightsCovered, allAvailable };
}

function buildQuoteRows(
  listingId: number,
  days: CalendarDay[],
  collectedAt: Date,
  today: Date,
): { rows: InsertListingPriceQuote[]; checkpointsAttempted: number; checkpointsAvailable: number } {
  const checkpoints = generateCheckpoints({ today });
  const index = buildDayIndex(days);
  const rows: InsertListingPriceQuote[] = [];
  let checkpointsAvailable = 0;

  for (const cp of checkpoints) {
    const { perNight, nightsCovered, allAvailable } = pricesForStay(cp, index);

    // Need full coverage AND full availability AND a price for every night —
    // anything less means we can't build an apples-to-apples total.
    if (
      nightsCovered !== cp.stayNights ||
      !allAvailable ||
      perNight.length !== cp.stayNights
    ) {
      continue;
    }

    checkpointsAvailable++;
    const subtotal = round2(perNight.reduce((a, b) => a + b, 0));
    const avgNightly = round2(subtotal / cp.stayNights);
    const cleaning = 0;
    const service = 0;
    const taxes = round2(subtotal * MEXICO_LODGING_TAX_RATE);
    const total = round2(subtotal + cleaning + service + taxes);

    rows.push({
      listingId,
      collectedAt,
      checkinDate: cp.checkin,
      checkoutDate: cp.checkout,
      stayLengthNights: cp.stayNights,
      guestCount: cp.guestCount,
      nightlyPriceUsd: avgNightly,
      subtotalUsd: subtotal,
      cleaningFeeUsd: cleaning,
      serviceFeeUsd: service,
      taxesUsd: taxes,
      totalPriceUsd: total,
      currency: "USD",
      availabilityStatus: "available",
      rawQuoteJson: {
        source: "pvrpv_calendar_synth",
        checkpointKind: cp.kind,
        eventTag: cp.eventTag,
        priorityTier: cp.priorityTier,
        nightsCovered,
        stayNights: cp.stayNights,
        perNightPricesUsd: perNight,
        feeDerivation: {
          cleaningFeeUsd: "constant_zero_pvrpv_includes_in_nightly",
          serviceFeeUsd: "constant_zero_no_platform_fee",
          taxesUsd: "subtotal_x_0.19_iva_plus_ish",
          totalPriceUsd: "subtotal_plus_taxes",
        },
      },
    });
  }
  return { rows, checkpointsAttempted: checkpoints.length, checkpointsAvailable };
}

async function insertQuotes(rows: InsertListingPriceQuote[]): Promise<number> {
  if (rows.length === 0) return 0;
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db.insert(listingPriceQuotesTable).values(slice);
    total += slice.length;
  }
  return total;
}

export async function runPvrpvPricingRefresh(
  opts: PvrpvPricingRunOpts = {},
): Promise<PvrpvPricingRunResult> {
  const maxListings = opts.maxListings ?? 50;
  const dryRun = opts.dryRun ?? false;
  const today = opts.today ?? new Date();

  const listings = await loadStaleFirstListings(maxListings);
  const perListing: PvrpvPricingPerListing[] = [];
  let totalQuotes = 0;

  for (const l of listings) {
    const stat: PvrpvPricingPerListing = {
      listingId: l.id,
      sourceUrl: l.sourceUrl,
      ok: false,
      daysReturned: 0,
      daysWithPrice: 0,
      checkpointsAttempted: 0,
      checkpointsAvailable: 0,
      quotesWritten: 0,
    };
    try {
      const cal = await fetchPvrpvCalendar(l.sourceUrl);
      stat.daysReturned = cal.daysReturned;
      stat.daysWithPrice = cal.daysWithPrice;
      if (cal.errors.length > 0 && cal.daysReturned === 0) {
        stat.error = cal.errors.join("; ").slice(0, 200);
        perListing.push(stat);
        continue;
      }

      const { rows, checkpointsAttempted, checkpointsAvailable } = buildQuoteRows(
        l.id,
        cal.days,
        new Date(),
        today,
      );
      stat.checkpointsAttempted = checkpointsAttempted;
      stat.checkpointsAvailable = checkpointsAvailable;

      if (!dryRun) {
        stat.quotesWritten = await insertQuotes(rows);
      } else {
        stat.quotesWritten = rows.length;
      }
      stat.ok = true;
      totalQuotes += stat.quotesWritten;
    } catch (e) {
      stat.error = (e as Error).message.slice(0, 200);
    }
    perListing.push(stat);
  }

  const ok = perListing.filter((p) => p.ok).length;
  const failed = perListing.length - ok;

  let alertLevel: "ok" | "warn" | "fail" = "ok";
  let alertReason = "";
  if (perListing.length > 0 && ok === 0) {
    alertLevel = "fail";
    alertReason = `All ${perListing.length} PVRPV listings failed`;
  } else if (perListing.length > 0 && totalQuotes === 0 && !dryRun) {
    alertLevel = "fail";
    alertReason = "0 PVRPV quotes written despite a non-empty cohort";
  } else if (perListing.length === 0) {
    alertLevel = "warn";
    alertReason = "No PVRPV listings matched the cohort filter";
  } else if (failed > 0 && failed * 2 >= perListing.length) {
    alertLevel = "warn";
    alertReason = `${failed}/${perListing.length} PVRPV listings failed (>=50%)`;
  }

  return {
    summary: {
      attempted: perListing.length,
      ok,
      failed,
      totalQuotesWritten: totalQuotes,
      alertLevel,
      alertReason,
    },
    listings: perListing,
  };
}
