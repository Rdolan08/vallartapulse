/**
 * ingest/vrbo-pricing-runner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Daily fee-quote refresh for VRBO listings.
 *
 * Why this exists:
 *   The comp-comparison view on /sources joins listing_price_quotes for the
 *   four fee columns. VRBO comps used to show "—" for every fee row because
 *   no runner wrote rows there for source_platform='vrbo'. This runner closes
 *   that gap so VRBO listings line up alongside Airbnb in the side-by-side view.
 *
 * Method:
 *   VRBO does not expose a calendar feed we can scrape headlessly, and its
 *   per-checkpoint quote endpoint is gated behind aggressive bot detection
 *   that the residential-proxy budget can't sustain ~30×N times per day.
 *   So we synthesize per-checkpoint quotes from the listing's already-scraped
 *   nightly_price_usd / cleaning_fee_usd plus modeled service-fee and tax
 *   percentages:
 *
 *     subtotal       = nightly * stayNights
 *     cleaning_fee   = rental_listings.cleaning_fee_usd ?? 0
 *     service_fee    = subtotal * 0.10  (VRBO guest service fee is ~8-12%)
 *     taxes          = (subtotal + cleaning) * 0.19  (IVA 16% + ISH 3%)
 *     total          = subtotal + cleaning + service + taxes
 *
 *   Listings without a published nightly_price_usd are skipped — synthesizing
 *   from nothing would just be noise. availability_status is written as
 *   "available" so the comp-comparison query picks the rows up; we have no
 *   per-night signal to override that with.
 *
 * Fee derivation is captured in raw_quote_json so a future task that scrapes
 * a real VRBO checkout quote can tell synthesized rows apart from observed ones.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  listingPriceQuotesTable,
  type InsertListingPriceQuote,
} from "@workspace/db/schema";

import { generateCheckpoints, type Checkpoint } from "./airbnb-checkpoints.js";

const SOURCE_PLATFORM = "vrbo";

/** VRBO traveler service fee — typically 8-12% of the subtotal. */
const VRBO_SERVICE_FEE_RATE = 0.10;
/** Mexico/Jalisco lodging tax: IVA 16% + ISH 3%. */
const MEXICO_LODGING_TAX_RATE = 0.19;

export interface VrboPricingRunOpts {
  maxListings?: number;
  dryRun?: boolean;
  today?: Date;
}

export interface VrboPricingPerListing {
  listingId: number;
  sourceUrl: string;
  ok: boolean;
  nightlyPriceUsd: number | null;
  cleaningFeeUsd: number | null;
  checkpointsAttempted: number;
  quotesWritten: number;
  error?: string;
}

export interface VrboPricingRunSummary {
  attempted: number;
  ok: number;
  failed: number;
  skippedNoPrice: number;
  totalQuotesWritten: number;
  alertLevel: "ok" | "warn" | "fail";
  alertReason: string;
}

export interface VrboPricingRunResult {
  summary: VrboPricingRunSummary;
  listings: VrboPricingPerListing[];
}

interface ListingRow {
  id: number;
  sourceUrl: string;
  nightlyPriceUsd: number | null;
  cleaningFeeUsd: number | null;
}

async function loadStaleFirstListings(maxListings: number): Promise<ListingRow[]> {
  const result = await db.execute(sql`
    SELECT rl.id,
           rl.source_url       AS "sourceUrl",
           rl.nightly_price_usd AS "nightlyPriceUsd",
           rl.cleaning_fee_usd  AS "cleaningFeeUsd"
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildQuoteRow(
  listingId: number,
  cp: Checkpoint,
  nightly: number,
  cleaning: number,
  collectedAt: Date,
): InsertListingPriceQuote {
  const subtotal = round2(nightly * cp.stayNights);
  const service = round2(subtotal * VRBO_SERVICE_FEE_RATE);
  const taxes = round2((subtotal + cleaning) * MEXICO_LODGING_TAX_RATE);
  const total = round2(subtotal + cleaning + service + taxes);
  return {
    listingId,
    collectedAt,
    checkinDate: cp.checkin,
    checkoutDate: cp.checkout,
    stayLengthNights: cp.stayNights,
    guestCount: cp.guestCount,
    nightlyPriceUsd: round2(nightly),
    subtotalUsd: subtotal,
    cleaningFeeUsd: round2(cleaning),
    serviceFeeUsd: service,
    taxesUsd: taxes,
    totalPriceUsd: total,
    currency: "USD",
    availabilityStatus: "available",
    rawQuoteJson: {
      source: "vrbo_listing_synth",
      checkpointKind: cp.kind,
      eventTag: cp.eventTag,
      priorityTier: cp.priorityTier,
      stayNights: cp.stayNights,
      feeDerivation: {
        nightlyPriceUsd: "rental_listings.nightly_price_usd",
        cleaningFeeUsd: "rental_listings.cleaning_fee_usd_or_zero",
        serviceFeeUsd: `subtotal_x_${VRBO_SERVICE_FEE_RATE}_vrbo_traveler_fee`,
        taxesUsd: `(subtotal+cleaning)_x_${MEXICO_LODGING_TAX_RATE}_iva_plus_ish`,
        totalPriceUsd: "sum",
      },
    },
  };
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

export async function runVrboPricingRefresh(
  opts: VrboPricingRunOpts = {},
): Promise<VrboPricingRunResult> {
  const maxListings = opts.maxListings ?? 50;
  const dryRun = opts.dryRun ?? false;
  const today = opts.today ?? new Date();

  const listings = await loadStaleFirstListings(maxListings);
  const checkpoints = generateCheckpoints({ today });
  const collectedAt = new Date();

  const perListing: VrboPricingPerListing[] = [];
  let totalQuotes = 0;
  let skippedNoPrice = 0;

  for (const l of listings) {
    const stat: VrboPricingPerListing = {
      listingId: l.id,
      sourceUrl: l.sourceUrl,
      ok: false,
      nightlyPriceUsd: l.nightlyPriceUsd,
      cleaningFeeUsd: l.cleaningFeeUsd,
      checkpointsAttempted: 0,
      quotesWritten: 0,
    };
    try {
      if (typeof l.nightlyPriceUsd !== "number" || !(l.nightlyPriceUsd > 0)) {
        skippedNoPrice++;
        stat.error = "no nightly_price_usd on rental_listings row";
        perListing.push(stat);
        continue;
      }
      const nightly = l.nightlyPriceUsd;
      const cleaning = typeof l.cleaningFeeUsd === "number" && l.cleaningFeeUsd > 0
        ? l.cleaningFeeUsd
        : 0;

      const rows: InsertListingPriceQuote[] = [];
      for (const cp of checkpoints) {
        rows.push(buildQuoteRow(l.id, cp, nightly, cleaning, collectedAt));
      }
      stat.checkpointsAttempted = rows.length;

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
  const failed = perListing.length - ok - skippedNoPrice;

  let alertLevel: "ok" | "warn" | "fail" = "ok";
  let alertReason = "";
  if (perListing.length > 0 && ok === 0 && skippedNoPrice < perListing.length) {
    alertLevel = "fail";
    alertReason = `All ${perListing.length - skippedNoPrice} eligible VRBO listings failed`;
  } else if (perListing.length > 0 && totalQuotes === 0 && !dryRun && skippedNoPrice < perListing.length) {
    alertLevel = "fail";
    alertReason = "0 VRBO quotes written despite a non-empty cohort";
  } else if (perListing.length === 0) {
    alertLevel = "warn";
    alertReason = "No VRBO listings matched the cohort filter";
  } else if (failed > 0 && failed * 2 >= (perListing.length - skippedNoPrice)) {
    alertLevel = "warn";
    alertReason = `${failed}/${perListing.length - skippedNoPrice} eligible VRBO listings failed (>=50%)`;
  } else if (skippedNoPrice > 0 && skippedNoPrice * 2 >= perListing.length) {
    alertLevel = "warn";
    alertReason = `${skippedNoPrice}/${perListing.length} VRBO listings have no nightly_price_usd to synthesize from`;
  }

  return {
    summary: {
      attempted: perListing.length,
      ok,
      failed,
      skippedNoPrice,
      totalQuotesWritten: totalQuotes,
      alertLevel,
      alertReason,
    },
    listings: perListing,
  };
}
