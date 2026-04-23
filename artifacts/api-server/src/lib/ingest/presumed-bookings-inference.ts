/**
 * presumed-bookings-inference.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Post-scrape SQL step that derives transaction-rate signals from the
 * listing_price_quotes time-series. NO Airbnb traffic — pure DB derivation.
 *
 * Logic per (listing × stay-window):
 *   1. Find pairs of consecutive quotes where the EARLIER quote is priced
 *      and AVAILABLE (total_price_usd IS NOT NULL) and the LATER quote is
 *      UNAVAILABLE (availability_status='unavailable').
 *   2. The transition implies the listing was booked at the earlier rate.
 *   3. Compute confidence band based on the observation gap (tighter gap =
 *      higher confidence the flip is a real booking, not a missed window).
 *   4. INSERT … ON CONFLICT DO NOTHING — re-running is a no-op thanks to
 *      the (listing_id, checkin, checkout, last_seen_available_at) unique
 *      constraint on presumed_bookings.
 *
 * Designed to run as the final step of the nightly Airbnb pricing scrape.
 * Cheap: a single bounded SQL statement, indexed lookups only.
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface InferPresumedBookingsResult {
  /** Number of new presumed-booking rows inserted this run. */
  inserted: number;
  /** Number of candidate flips evaluated (incl. duplicates already present). */
  candidatesEvaluated: number;
}

/**
 * Look back this far when scanning for available→unavailable transitions.
 * Bounds the work per run; longer history doesn't change inferences we
 * already wrote (the unique constraint absorbs duplicates).
 */
const LOOKBACK_DAYS = 14;

export async function inferPresumedBookings(
  db: NodePgDatabase<Record<string, unknown>>,
): Promise<InferPresumedBookingsResult> {
  // Single SQL statement: build (available, next-unavailable) pairs per
  // (listing × stay-window) using LAG over collected_at, then INSERT the
  // transitions into presumed_bookings.
  //
  // We use LAG (not LEAD) so each unavailable row "looks back" to find the
  // most recent prior priced quote for the same window. This makes the
  // query naturally idempotent: each unavailable observation contributes
  // at most one inferred booking, keyed by its prior available row's
  // collected_at.
  const result = await db.execute(sql`
    WITH ordered AS (
      SELECT
        lpq.id,
        lpq.listing_id,
        lpq.checkin_date,
        lpq.checkout_date,
        lpq.stay_length_nights,
        lpq.guest_count,
        lpq.collected_at,
        lpq.availability_status,
        lpq.nightly_price_usd,
        lpq.subtotal_usd,
        lpq.total_price_usd,
        LAG(lpq.id) OVER w                  AS prev_id,
        LAG(lpq.collected_at) OVER w        AS prev_collected_at,
        LAG(lpq.availability_status) OVER w AS prev_status,
        LAG(lpq.nightly_price_usd) OVER w   AS prev_nightly_usd,
        LAG(lpq.subtotal_usd) OVER w        AS prev_subtotal_usd,
        LAG(lpq.total_price_usd) OVER w     AS prev_total_usd
      FROM listing_price_quotes lpq
      WHERE lpq.collected_at >= NOW() - INTERVAL '${sql.raw(String(LOOKBACK_DAYS))} days'
      WINDOW w AS (
        PARTITION BY lpq.listing_id, lpq.checkin_date, lpq.checkout_date
        ORDER BY lpq.collected_at
      )
    ),
    flips AS (
      SELECT
        listing_id,
        checkin_date,
        checkout_date,
        stay_length_nights,
        guest_count,
        prev_collected_at AS last_seen_available_at,
        collected_at      AS first_seen_unavailable_at,
        prev_nightly_usd  AS presumed_nightly_usd,
        prev_subtotal_usd AS presumed_subtotal_usd,
        prev_total_usd    AS presumed_total_usd,
        prev_id           AS source_available_quote_id,
        id                AS source_unavailable_quote_id,
        EXTRACT(EPOCH FROM (collected_at - prev_collected_at)) / 3600.0
                          AS observation_gap_hours
      FROM ordered
      WHERE availability_status = 'unavailable'
        AND prev_status        IS NOT NULL
        AND prev_status        <> 'unavailable'
        AND prev_total_usd     IS NOT NULL
        AND prev_nightly_usd   IS NOT NULL
        AND prev_nightly_usd   > 0
    ),
    inserted AS (
      INSERT INTO presumed_bookings (
        listing_id, checkin_date, checkout_date, stay_length_nights, guest_count,
        presumed_nightly_usd, presumed_subtotal_usd, presumed_total_usd,
        last_seen_available_at, first_seen_unavailable_at, observation_gap_hours,
        confidence,
        source_available_quote_id, source_unavailable_quote_id
      )
      SELECT
        listing_id, checkin_date, checkout_date, stay_length_nights, guest_count,
        presumed_nightly_usd, presumed_subtotal_usd, presumed_total_usd,
        last_seen_available_at, first_seen_unavailable_at, observation_gap_hours,
        CASE
          WHEN observation_gap_hours <=  48 THEN 'high'
          WHEN observation_gap_hours <= 168 THEN 'medium'
          ELSE 'low'
        END AS confidence,
        source_available_quote_id, source_unavailable_quote_id
      FROM flips
      ON CONFLICT (listing_id, checkin_date, checkout_date, last_seen_available_at)
        DO NOTHING
      RETURNING 1
    ),
    candidate_count AS (
      SELECT COUNT(*)::int AS n FROM flips
    )
    SELECT
      (SELECT COUNT(*)::int FROM inserted) AS inserted,
      (SELECT n               FROM candidate_count) AS candidates_evaluated
  `);

  const row = (result.rows[0] ?? { inserted: 0, candidates_evaluated: 0 }) as {
    inserted: number;
    candidates_evaluated: number;
  };
  return {
    inserted: Number(row.inserted ?? 0),
    candidatesEvaluated: Number(row.candidates_evaluated ?? 0),
  };
}
