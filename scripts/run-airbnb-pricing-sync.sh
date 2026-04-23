#!/usr/bin/env bash
set -euo pipefail

# One-command runner for Airbnb pricing signal sync:
# 1) export real calendar signals to CSV
# 2) load CSV with guarded upsert semantics
#
# Required env:
#   DATABASE_URL (or RAILWAY_DATABASE_URL)
#
# Optional env:
#   AIRBNB_PRICING_EXPORT_MAX_LISTINGS (default 2000)
#   AIRBNB_PRICING_EXPORT_CONCURRENCY (default 2)
#   AIRBNB_PRICING_EXPORT_FILE (default ./airbnb_calendar_prices.csv)
#   AIRBNB_PRICING_EXPORT_RESUME (1=true, default 0)
#   AIRBNB_PRICING_EXPORT_START_OFFSET (default 0)
#   AIRBNB_PRICING_EXPORT_PROGRESS_FILE (default ./.airbnb-pricing-export.progress.json)
#   AIRBNB_PRICING_SYNC_MIN_ROWS (default 100)
#   AIRBNB_PRICING_SYNC_MIN_PRICED_ROWS (default 25)
#   AIRBNB_PRICING_SYNC_MIN_PRICED_LISTINGS (default 10)
#   AIRBNB_PRICING_SYNC_ALLOW_LOW_ROWS (1=true, default 0)

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

DB_URL="${DATABASE_URL:-${RAILWAY_DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set DATABASE_URL or RAILWAY_DATABASE_URL" >&2
  exit 1
fi

CSV_PATH="${AIRBNB_PRICING_EXPORT_FILE:-$REPO_DIR/airbnb_calendar_prices.csv}"
MIN_ROWS="${AIRBNB_PRICING_SYNC_MIN_ROWS:-100}"
MIN_PRICED_ROWS="${AIRBNB_PRICING_SYNC_MIN_PRICED_ROWS:-25}"
MIN_PRICED_LISTINGS="${AIRBNB_PRICING_SYNC_MIN_PRICED_LISTINGS:-10}"
ALLOW_LOW_ROWS="${AIRBNB_PRICING_SYNC_ALLOW_LOW_ROWS:-0}"

echo "[airbnb-pricing-sync] export start"
pnpm run scrape:airbnb-pricing-export

if [[ ! -f "$CSV_PATH" ]]; then
  echo "ERROR: export did not produce CSV at $CSV_PATH" >&2
  exit 1
fi

TOTAL_DATA_ROWS="$(tail -n +2 "$CSV_PATH" | wc -l | tr -d ' ')"
PRICED_ROWS="$(awk -F',' 'NR > 1 && $3 != "" { c++ } END { print c + 0 }' "$CSV_PATH")"
PRICED_LISTINGS="$(awk -F',' 'NR > 1 && $3 != "" && $1 != "" { seen[$1]=1 } END { for (k in seen) c++; print c + 0 }' "$CSV_PATH")"
echo "[airbnb-pricing-sync] export rows total=$TOTAL_DATA_ROWS priced_rows=$PRICED_ROWS priced_listings=$PRICED_LISTINGS"

if [[ "$ALLOW_LOW_ROWS" != "1" ]]; then
  if (( TOTAL_DATA_ROWS < MIN_ROWS )); then
    echo "ERROR: export rows below threshold: total=$TOTAL_DATA_ROWS min=$MIN_ROWS" >&2
    exit 1
  fi

  if (( PRICED_ROWS < MIN_PRICED_ROWS )); then
    echo "ERROR: priced rows below threshold: priced_rows=$PRICED_ROWS min=$MIN_PRICED_ROWS" >&2
    exit 1
  fi

  if (( PRICED_LISTINGS < MIN_PRICED_LISTINGS )); then
    echo "ERROR: priced listings below threshold: priced_listings=$PRICED_LISTINGS min=$MIN_PRICED_LISTINGS" >&2
    exit 1
  fi
fi

echo "[airbnb-pricing-sync] load start csv=$CSV_PATH"
psql "$DB_URL" \
  -v ON_ERROR_STOP=1 \
  -v csv_path="$CSV_PATH" \
  -f "$REPO_DIR/sql/load-airbnb-calendar-prices-safe.sql"

echo "[airbnb-pricing-sync] post-load metrics"
psql "$DB_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  COUNT(*) AS rows_total,
  COUNT(*) FILTER (WHERE rpbd.nightly_price_usd IS NOT NULL) AS rows_with_price,
  COUNT(DISTINCT rpbd.listing_id) AS listings_covered,
  MAX(rpbd.scraped_at) AS newest_scrape
FROM rental_prices_by_date rpbd
JOIN rental_listings rl ON rl.id = rpbd.listing_id
WHERE rl.source_platform='airbnb';
"

echo "[airbnb-pricing-sync] done"
