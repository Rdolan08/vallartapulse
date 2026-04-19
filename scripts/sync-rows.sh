#!/usr/bin/env bash
# scripts/sync-rows.sh
# ─────────────────────────────────────────────────────────────────────────────
# Generalized local→prod (or any DB→DB) row sync via psql \copy + temp staging
# + INSERT ON CONFLICT. Distilled from the proven manual procedure used to
# move 506 Airbnb rows from local dev into Railway prod on 2026-04-19.
#
# Why a script?
#   - The pattern is identical for every source: ship NEW rows from the
#     scraper-host DB to the prod DB without trampling any prod state.
#   - Doing it by hand requires ~6 psql invocations and a temp file the user
#     has to remember to clean up. This script is one command.
#
# Usage:
#   SRC_DATABASE_URL=postgres://...  \
#   DST_DATABASE_URL=postgres://...  \
#   ./scripts/sync-rows.sh \
#       --table=rental_listings \
#       --source-platform=airbnb \
#       [--conflict-cols=source_platform,external_id] \
#       [--update-on-conflict] \
#       [--limit=10000] \
#       [--dry-run]
#
# Defaults:
#   --conflict-cols  source_platform,external_id  (matches uq_rental_listings_source_external)
#   on conflict      DO NOTHING                   (--update-on-conflict flips to DO UPDATE SET ...)
#   --limit          (none — copy everything matching --source-platform)
#
# Exit codes:
#   0  success (rows copied or "no new rows")
#   1  bad args / missing env
#   2  src / dst connection failure
#   3  copy or insert failed (staging table dropped before exit)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

TABLE=""
SRC_PLATFORM=""
CONFLICT_COLS="source_platform,external_id"
UPDATE_ON_CONFLICT=0
LIMIT=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --table=*)            TABLE="${arg#*=}" ;;
    --source-platform=*)  SRC_PLATFORM="${arg#*=}" ;;
    --conflict-cols=*)    CONFLICT_COLS="${arg#*=}" ;;
    --update-on-conflict) UPDATE_ON_CONFLICT=1 ;;
    --limit=*)            LIMIT="${arg#*=}" ;;
    --dry-run)            DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *)
      echo "ERROR: unknown arg '$arg'" >&2; exit 1 ;;
  esac
done

[[ -z "$TABLE" ]]        && { echo "ERROR: --table required" >&2; exit 1; }
[[ -z "$SRC_PLATFORM" ]] && { echo "ERROR: --source-platform required" >&2; exit 1; }
[[ -z "${SRC_DATABASE_URL:-}" ]] && { echo "ERROR: SRC_DATABASE_URL not set" >&2; exit 1; }
[[ -z "${DST_DATABASE_URL:-}" ]] && { echo "ERROR: DST_DATABASE_URL not set" >&2; exit 1; }

# ── Input sanitization ─────────────────────────────────────────────────────
# Both values get shell-interpolated into psql commands further down. Restrict
# them to character sets that cannot contain quotes, semicolons, or
# whitespace, so a typo (or worse) can't smuggle SQL.
#   --table:           Postgres unquoted identifier — [a-zA-Z_][a-zA-Z0-9_]*
#   --source-platform: alphanumeric + underscore + hyphen (matches the
#                      enum values in source_platform: airbnb, vrbo, pvrpv,
#                      booking_com, vacation_vallarta, …)
if ! [[ "$TABLE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
  echo "ERROR: --table must be a Postgres identifier (got '$TABLE')" >&2; exit 1
fi
if ! [[ "$SRC_PLATFORM" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "ERROR: --source-platform must be [a-zA-Z0-9_-]+ (got '$SRC_PLATFORM')" >&2; exit 1
fi
if ! [[ "$CONFLICT_COLS" =~ ^[a-zA-Z0-9_,]+$ ]]; then
  echo "ERROR: --conflict-cols must be comma-separated identifiers (got '$CONFLICT_COLS')" >&2; exit 1
fi
if [[ -n "$LIMIT" ]] && ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit must be a positive integer (got '$LIMIT')" >&2; exit 1
fi

STAGE_TABLE="_stage_${TABLE}_$$"
TMP_CSV="$(mktemp -t sync-rows.XXXXXX.csv)"
trap 'rm -f "$TMP_CSV"; psql "$DST_DATABASE_URL" -c "DROP TABLE IF EXISTS \"$STAGE_TABLE\";" >/dev/null 2>&1 || true' EXIT

echo "[sync-rows] table=$TABLE  source_platform=$SRC_PLATFORM"
echo "[sync-rows] src → dst via staging table $STAGE_TABLE"

# ── Resolve column list from DST so the column order matches exactly ────────
COLS_LIST=$(psql "$DST_DATABASE_URL" -At -c "
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='$TABLE'
    AND column_name <> 'id'
")
if [[ -z "$COLS_LIST" ]]; then
  echo "ERROR: could not resolve columns for $TABLE on dst" >&2; exit 2
fi
echo "[sync-rows] columns: $COLS_LIST"

# ── Export src rows ─────────────────────────────────────────────────────────
LIMIT_CLAUSE=""
[[ -n "$LIMIT" ]] && LIMIT_CLAUSE="LIMIT $LIMIT"

SRC_COUNT=$(psql "$SRC_DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM $TABLE WHERE source_platform='$SRC_PLATFORM'")
echo "[sync-rows] src has $SRC_COUNT row(s) for source_platform='$SRC_PLATFORM'"
if [[ "$SRC_COUNT" == "0" ]]; then
  echo "[sync-rows] nothing to copy"; exit 0
fi

psql "$SRC_DATABASE_URL" -c "\
  \\copy (SELECT $COLS_LIST FROM $TABLE \
         WHERE source_platform='$SRC_PLATFORM' \
         ORDER BY id $LIMIT_CLAUSE) \
  TO '$TMP_CSV' CSV"

CSV_ROWS=$(wc -l < "$TMP_CSV" | tr -d ' ')
echo "[sync-rows] exported $CSV_ROWS row(s) to $TMP_CSV"

# ── Build conflict-action clause ────────────────────────────────────────────
if [[ "$UPDATE_ON_CONFLICT" == "1" ]]; then
  # Update every non-conflict, non-id column.
  UPDATE_SET=$(psql "$DST_DATABASE_URL" -At -c "
    SELECT string_agg(column_name || '=EXCLUDED.' || column_name, ', ')
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$TABLE'
      AND column_name NOT IN ('id', $(echo "$CONFLICT_COLS" | sed "s/,/','/g; s/^/'/; s/$/'/"))
  ")
  CONFLICT_ACTION="DO UPDATE SET $UPDATE_SET"
else
  CONFLICT_ACTION="DO NOTHING"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[sync-rows] DRY RUN — would now stage + INSERT INTO $TABLE ON CONFLICT ($CONFLICT_COLS) $CONFLICT_ACTION"
  exit 0
fi

# ── Stage + insert on dst ───────────────────────────────────────────────────
psql "$DST_DATABASE_URL" <<SQL
CREATE TEMP TABLE "$STAGE_TABLE" (LIKE $TABLE INCLUDING DEFAULTS);
ALTER TABLE "$STAGE_TABLE" DROP COLUMN id;
\copy "$STAGE_TABLE" ($COLS_LIST) FROM '$TMP_CSV' CSV

INSERT INTO $TABLE ($COLS_LIST)
SELECT $COLS_LIST FROM "$STAGE_TABLE"
ON CONFLICT ($CONFLICT_COLS) $CONFLICT_ACTION;

-- Bump the id sequence past the largest id so future inserts don't collide.
SELECT setval(
  pg_get_serial_sequence('$TABLE','id'),
  GREATEST((SELECT COALESCE(MAX(id),1) FROM $TABLE), 1)
);
SQL

DST_COUNT=$(psql "$DST_DATABASE_URL" -At -c \
  "SELECT COUNT(*) FROM $TABLE WHERE source_platform='$SRC_PLATFORM'")
echo "[sync-rows] dst now has $DST_COUNT row(s) for source_platform='$SRC_PLATFORM'"
echo "[sync-rows] done"
