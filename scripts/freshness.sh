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
\echo === rental_prices_by_date: calendar pricing freshness (overall) ===
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
\echo === rental_prices_by_date: calendar pricing freshness per source ===
SELECT
  rl.source_platform,
  COUNT(*)                                         AS rows,
  COUNT(DISTINCT rpbd.listing_id)                  AS listings_covered,
  MAX(rpbd.scraped_at)                             AS newest_scrape,
  date_trunc('minute',
    NOW() - MAX(rpbd.scraped_at))                  AS age_of_newest,
  CASE
    WHEN MAX(rpbd.scraped_at) IS NULL                       THEN 'RED   — no rows'
    WHEN MAX(rpbd.scraped_at) < NOW() - INTERVAL '2 days'   THEN 'RED   — stale (>2d)'
    WHEN MAX(rpbd.scraped_at) < NOW() - INTERVAL '36 hours' THEN 'AMBER — stale (>36h)'
    ELSE                                                         'GREEN — fresh'
  END                                              AS status
FROM rental_listings rl
LEFT JOIN rental_prices_by_date rpbd ON rpbd.listing_id = rl.id
WHERE rl.source_platform IN ('pvrpv', 'vacation_vallarta')
GROUP BY rl.source_platform
ORDER BY rl.source_platform;

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
echo "=========================================================="
echo "  Calendar pricing staleness check (rental_prices_by_date)"
echo "=========================================================="

# Threshold: 36h, since calendar scrapers run daily via GitHub Actions.
# Prints one line per stale source, then exits non-zero so this script can
# be wired into freshness alerting.
STALE_THRESHOLD="${CALENDAR_STALE_HOURS:-36}"

STALE_REPORT=$(psql "$CONN_URL" -v ON_ERROR_STOP=1 -At -F '|' \
  -v threshold="${STALE_THRESHOLD}" <<SQL
WITH per_source AS (
  SELECT
    rl.source_platform,
    MAX(rpbd.scraped_at) AS newest_scrape
  FROM rental_listings rl
  LEFT JOIN rental_prices_by_date rpbd ON rpbd.listing_id = rl.id
  WHERE rl.source_platform IN ('pvrpv', 'vacation_vallarta')
  GROUP BY rl.source_platform
)
SELECT
  source_platform,
  COALESCE(newest_scrape::text, 'never'),
  COALESCE(EXTRACT(EPOCH FROM (NOW() - newest_scrape)) / 3600, 9999)::int AS age_hours
FROM per_source
WHERE newest_scrape IS NULL
   OR newest_scrape < NOW() - (:'threshold' || ' hours')::interval
ORDER BY source_platform;
SQL
)

if [[ -n "$STALE_REPORT" ]]; then
  echo "STALE: calendar pricing has not refreshed within ${STALE_THRESHOLD}h for:"
  while IFS='|' read -r src newest age; do
    [[ -z "$src" ]] && continue
    echo "  - ${src}: newest_scrape=${newest} (age ~${age}h)"
  done <<< "$STALE_REPORT"
  echo
  echo "Done (with stale sources)."
  exit 1
fi

echo "OK: all calendar pricing sources are fresh (within ${STALE_THRESHOLD}h)."
echo
echo "Done."
