-- presumed_bookings
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply on Mac mini against Railway prod:
--   psql "$RAILWAY_DATABASE_URL" -f lib/db/sql/2026-04-23_presumed_bookings.sql
--
-- One row per inferred booking: the moment a (listing × stay-window) flips
-- from a priced/available quote → unavailable, we presume it rented at the
-- last seen rate. Source-of-truth for transaction-rate (vs. asking-rate)
-- pricing analytics.
--
-- Insert-only by design: the (listing_id, checkin_date, checkout_date,
-- last_seen_available_at) tuple is unique so the inference job can be
-- re-run idempotently without duplicating rows.

CREATE TABLE IF NOT EXISTS presumed_bookings (
  id                          SERIAL PRIMARY KEY,
  listing_id                  INTEGER NOT NULL
                                REFERENCES rental_listings(id) ON DELETE CASCADE,

  -- Stay window the booking covered
  checkin_date                DATE NOT NULL,
  checkout_date               DATE NOT NULL,
  stay_length_nights          INTEGER NOT NULL,
  guest_count                 INTEGER,

  -- Inferred rate (from the last priced quote before unavailability)
  presumed_nightly_usd        REAL NOT NULL,
  presumed_subtotal_usd       REAL,
  presumed_total_usd          REAL,

  -- Evidence timestamps
  last_seen_available_at      TIMESTAMP NOT NULL,   -- collected_at of the last priced quote
  first_seen_unavailable_at   TIMESTAMP NOT NULL,   -- collected_at of the first unavailable quote
  observation_gap_hours       REAL NOT NULL,        -- hours between the two above

  -- Confidence band based on the gap (tighter gap = higher confidence the
  -- transition really represents a booking and not a long observation gap):
  --   high   : gap <= 48h   (daily scrape caught the flip directly)
  --   medium : gap <= 168h  (within a week — likely a real booking)
  --   low    : gap >  168h  (could be owner block, seasonal close, etc.)
  confidence                  TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),

  -- IDs of the source quote rows for full auditability
  source_available_quote_id   INTEGER REFERENCES listing_price_quotes(id) ON DELETE SET NULL,
  source_unavailable_quote_id INTEGER REFERENCES listing_price_quotes(id) ON DELETE SET NULL,

  inferred_at                 TIMESTAMP NOT NULL DEFAULT NOW(),

  -- Idempotency key: re-running inference for the same flip is a no-op
  CONSTRAINT presumed_bookings_unique_flip UNIQUE (
    listing_id, checkin_date, checkout_date, last_seen_available_at
  )
);

CREATE INDEX IF NOT EXISTS idx_pb_listing_checkin
  ON presumed_bookings(listing_id, checkin_date);

CREATE INDEX IF NOT EXISTS idx_pb_checkin_date
  ON presumed_bookings(checkin_date);

CREATE INDEX IF NOT EXISTS idx_pb_inferred_at
  ON presumed_bookings(inferred_at);

CREATE INDEX IF NOT EXISTS idx_pb_confidence
  ON presumed_bookings(confidence);
