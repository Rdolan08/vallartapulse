\set ON_ERROR_STOP on

-- Usage:
--   psql "$DATABASE_URL" -v csv_path='/absolute/or/relative/path/airbnb_calendar_prices.csv' \
--     -f scripts/sql/load-airbnb-calendar-prices-safe.sql
--
-- Safety semantics:
-- 1) Never erase an existing nightly_price_usd with NULL.
-- 2) Preserve historically meaningful statuses ('booked','blocked').
-- 3) Ignore unknown-status downgrades when we already had a concrete status.
-- 4) Ignore stale scraped_at values (only move forward in time).

BEGIN;

CREATE TEMP TABLE stage_airbnb_calendar_prices (
  external_id text,
  date date,
  nightly_price_usd real,
  availability_status text,
  minimum_nights integer,
  scraped_at timestamp
);

\if :{?csv_path}
  \copy stage_airbnb_calendar_prices (external_id,date,nightly_price_usd,availability_status,minimum_nights,scraped_at) FROM :'csv_path' WITH (FORMAT csv, HEADER true)
\else
  \echo 'ERROR: pass -v csv_path=/path/to/airbnb_calendar_prices.csv'
  \quit 1
\endif

INSERT INTO rental_prices_by_date (
  listing_id,
  date,
  nightly_price_usd,
  availability_status,
  minimum_nights,
  scraped_at
)
SELECT
  rl.id,
  s.date,
  s.nightly_price_usd,
  COALESCE(NULLIF(s.availability_status, ''), 'unknown') AS availability_status,
  s.minimum_nights,
  COALESCE(s.scraped_at, NOW()) AS scraped_at
FROM stage_airbnb_calendar_prices s
JOIN rental_listings rl
  ON rl.source_platform = 'airbnb'
 AND rl.external_id = s.external_id
ON CONFLICT (listing_id, date) DO UPDATE
SET
  nightly_price_usd = COALESCE(EXCLUDED.nightly_price_usd, rental_prices_by_date.nightly_price_usd),
  availability_status = CASE
    WHEN rental_prices_by_date.availability_status IN ('booked', 'blocked')
      THEN rental_prices_by_date.availability_status
    WHEN EXCLUDED.availability_status = 'unknown'
      THEN rental_prices_by_date.availability_status
    ELSE EXCLUDED.availability_status
  END,
  minimum_nights = COALESCE(EXCLUDED.minimum_nights, rental_prices_by_date.minimum_nights),
  scraped_at = GREATEST(
    COALESCE(rental_prices_by_date.scraped_at, TIMESTAMP 'epoch'),
    COALESCE(EXCLUDED.scraped_at, TIMESTAMP 'epoch')
  )
WHERE
  -- Preserve realized/blocked outcomes for behavior modeling.
  rental_prices_by_date.availability_status NOT IN ('booked', 'blocked')
  -- Do not apply older scrape snapshots over newer rows (NULL-safe).
  AND COALESCE(EXCLUDED.scraped_at, TIMESTAMP 'epoch') >= COALESCE(rental_prices_by_date.scraped_at, TIMESTAMP 'epoch');

COMMIT;
