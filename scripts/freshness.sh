#!/usr/bin/env bash
# Freshness diagnostic: prints rows per source and the age of the
# newest data, for both rental_listings and listing_details.
#
# Usage:
#   ./scripts/freshness.sh                 # against $RAILWAY_DATABASE_URL (default)
#   DATABASE_URL=... ./scripts/freshness.sh local
#
# Requires psql on PATH and either RAILWAY_DATABASE_URL (default) or
# DATABASE_URL (when arg "local" is passed) to be set in the environment.

set -euo pipefail

TARGET="${1:-prod}"

if [[ "$TARGET" == "prod" ]]; then
  CONN_URL="${RAILWAY_DATABASE_URL:-}"
  LABEL="PROD (Railway)"
elif [[ "$TARGET" == "local" ]]; then
  CONN_URL="${DATABASE_URL:-}"
  LABEL="LOCAL"
else
  echo "usage: $0 [prod|local]" >&2
  exit 2
fi

if [[ -z "$CONN_URL" ]]; then
  echo "error: connection URL not set for target=$TARGET" >&2
  exit 2
fi

echo "=========================================================="
echo "  VallartaPulse data freshness — target: $LABEL"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=========================================================="

psql "$CONN_URL" -v ON_ERROR_STOP=1 <<'SQL'
\pset border 2
\pset format aligned

\echo
\echo === rental_listings: rows per source + newest scrape ===
SELECT
  source_platform,
  COUNT(*)                                         AS rows,
  MAX(scraped_at)                                  AS newest_scrape,
  date_trunc('minute',
    NOW() - MAX(scraped_at))                       AS age_of_newest,
  COUNT(*) FILTER (
    WHERE scraped_at < NOW() - INTERVAL '2 days'
  )                                                AS rows_older_than_2d
FROM rental_listings
GROUP BY source_platform
ORDER BY source_platform;

\echo
\echo === listing_details: enrichment freshness per source ===
SELECT
  rl.source_platform,
  COUNT(DISTINCT rl.id)                            AS listings_total,
  COUNT(DISTINCT ld.listing_id)                    AS listings_enriched,
  MAX(ld.enriched_at)                              AS newest_enrichment,
  date_trunc('minute',
    NOW() - MAX(ld.enriched_at))                   AS age_of_newest,
  COUNT(DISTINCT ld.listing_id) FILTER (
    WHERE ld.enriched_at < NOW() - INTERVAL '2 days'
  )                                                AS enrichments_older_than_2d
FROM rental_listings rl
LEFT JOIN listing_details ld ON ld.listing_id = rl.id
GROUP BY rl.source_platform
ORDER BY rl.source_platform;

\echo
\echo === rental_prices_by_date: calendar pricing freshness ===
SELECT
  COUNT(*)                                         AS rows,
  COUNT(DISTINCT listing_id)                       AS listings_covered,
  MAX(scraped_at)                                  AS newest_scrape,
  date_trunc('minute',
    NOW() - MAX(scraped_at))                       AS age_of_newest,
  COUNT(*) FILTER (
    WHERE scraped_at < NOW() - INTERVAL '2 days'
  )                                                AS rows_older_than_2d
FROM rental_prices_by_date;

\echo
\echo === verdict (simple per-source freshness check) ===
WITH per_source AS (
  SELECT
    source_platform,
    COUNT(*)         AS rows,
    MAX(scraped_at)  AS newest_scrape
  FROM rental_listings
  GROUP BY source_platform
)
SELECT
  source_platform,
  rows,
  newest_scrape,
  CASE
    WHEN rows = 0                                       THEN 'RED   — no rows'
    WHEN newest_scrape < NOW() - INTERVAL '2 days'      THEN 'RED   — stale (>2d)'
    WHEN newest_scrape < NOW() - INTERVAL '36 hours'    THEN 'AMBER — stale (>36h)'
    ELSE                                                     'GREEN — fresh'
  END AS status
FROM per_source
ORDER BY source_platform;
SQL

echo
echo "Done."
