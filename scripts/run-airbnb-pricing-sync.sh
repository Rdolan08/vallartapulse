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

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

DB_URL="${DATABASE_URL:-${RAILWAY_DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: set DATABASE_URL or RAILWAY_DATABASE_URL" >&2
  exit 1
fi

CSV_PATH="${AIRBNB_PRICING_EXPORT_FILE:-$REPO_DIR/airbnb_calendar_prices.csv}"

echo "[airbnb-pricing-sync] export start"
pnpm run scrape:airbnb-pricing-export

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
