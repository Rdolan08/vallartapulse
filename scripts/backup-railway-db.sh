#!/usr/bin/env bash
# scripts/backup-railway-db.sh
# ─────────────────────────────────────────────────────────────────────────────
# Daily full backup of the Railway production database to local disk on the
# Mac mini. Each run produces a NEW timestamped file — previous backups are
# never overwritten or deleted by this script.
#
# Format: pg_dump -Fc (PostgreSQL custom format, internally compressed,
# parallel-restoreable via `pg_restore -j`, supports selective restore of
# individual tables).
#
# Output:  ~/vallartapulse-backups/vallartapulse-YYYY-MM-DD-HHMMSS.dump
# Logs:    ~/vallartapulse-data/logs/db-backup.{out,err}.log (via launchd)
#
# Env access pattern matches scripts/run-discovery.sh: cd to repo root,
# `set -a; source .env; set +a` to inherit RAILWAY_DATABASE_URL from the
# Mac-local .env file. Under launchd this is the ONLY way the script sees
# the DB URL — launchd does not inherit shell env vars.
#
# REQUIREMENTS on the Mac mini:
#   1. pg_dump v18 or newer (Railway runs PostgreSQL 18.3). Check with:
#        pg_dump --version
#      If older, install via: brew install postgresql@18
#      The script adds /opt/homebrew/opt/postgresql@18/bin to PATH so
#      keg-only installs work without `brew link --force`.
#   2. .env file at the repo root containing RAILWAY_DATABASE_URL=...
#      (same .env that run-discovery.sh and run-airbnb-pricing-nightly.sh
#      already source).
#
# ONE-TIME INSTALL on the Mac mini (after `git pull` brings this script):
#
#   chmod +x ~/vallartapulse/scripts/backup-railway-db.sh
#   mkdir -p ~/vallartapulse-backups ~/vallartapulse-data/logs
#
#   cat > ~/Library/LaunchAgents/com.vallartapulse.db-backup.daily.plist <<'PLIST'
#   <?xml version="1.0" encoding="UTF-8"?>
#   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
#   <plist version="1.0">
#     <dict>
#       <key>Label</key>
#       <string>com.vallartapulse.db-backup.daily</string>
#       <key>ProgramArguments</key>
#       <array>
#         <string>/bin/bash</string>
#         <string>/Users/ryandolan/vallartapulse/scripts/backup-railway-db.sh</string>
#       </array>
#       <key>StartCalendarInterval</key>
#       <dict>
#         <key>Hour</key>
#         <integer>2</integer>
#         <key>Minute</key>
#         <integer>0</integer>
#       </dict>
#       <key>StandardOutPath</key>
#       <string>/Users/ryandolan/vallartapulse-data/logs/db-backup.out.log</string>
#       <key>StandardErrorPath</key>
#       <string>/Users/ryandolan/vallartapulse-data/logs/db-backup.err.log</string>
#       <key>RunAtLoad</key>
#       <false/>
#     </dict>
#   </plist>
#   PLIST
#
#   launchctl unload ~/Library/LaunchAgents/com.vallartapulse.db-backup.daily.plist 2>/dev/null
#   launchctl load   ~/Library/LaunchAgents/com.vallartapulse.db-backup.daily.plist
#
# Schedule: 02:00 local Mac time (75 min buffer before the 03:15 discovery
# cron mutates the DB — backup captures the prior day's terminal state).
#
# Disk math: DB is ~233 MB; -Fc compression typically yields ~10 MB per
# dump (measured 9.1 MB on first run). 365 dumps/year ≈ 3.5 GB/year. No
# retention is enforced — Ryan asked for "keeping a copy daily not
# replacing the previous backup". Manual cleanup can be added later.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── locate repo root (script-relative, not hard-coded) ──────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ── PATH for launchd (mirrors run-discovery.sh + adds postgresql@18) ────────
# launchd inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) which
# does not include homebrew binaries. postgresql@18 is keg-only on
# Apple Silicon brew so it doesn't symlink into /opt/homebrew/bin
# unless `brew link --force` was run — adding the keg's bin dir
# explicitly avoids that requirement.
export PATH="/opt/homebrew/opt/postgresql@18/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ── load env from repo .env (same pattern as run-discovery.sh) ──────────────
# `set -a; source; set +a` lets bash itself parse the file, which handles
# values with spaces, quotes, '&', '=' correctly — unlike the
# `export $(grep -v '^#' .env | xargs)` trick.
if [[ ! -f .env ]]; then
  echo "[backup-railway-db] FATAL: ${REPO_ROOT}/.env not found." >&2
  echo "[backup-railway-db] Expected RAILWAY_DATABASE_URL=... in the repo .env (same file run-discovery.sh sources)." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

DB_URL="${RAILWAY_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "[backup-railway-db] FATAL: RAILWAY_DATABASE_URL not set in ${REPO_ROOT}/.env" >&2
  exit 1
fi

# ── pg_dump version sanity ──────────────────────────────────────────────────
# Railway is PG 18.3. A pg_dump older than the server's major version is
# not supported and will refuse to run. Fail loudly rather than silently
# producing a partial dump.
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup-railway-db] FATAL: pg_dump not on PATH (looked in: $PATH)." >&2
  echo "[backup-railway-db] Install with: brew install postgresql@18" >&2
  exit 1
fi
PG_DUMP_MAJOR=$(pg_dump --version | awk '{print $3}' | cut -d. -f1)
if [[ "$PG_DUMP_MAJOR" -lt 18 ]]; then
  echo "[backup-railway-db] FATAL: pg_dump major=$PG_DUMP_MAJOR but Railway is PG 18.3. Upgrade with: brew install postgresql@18" >&2
  exit 1
fi

# ── paths ───────────────────────────────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-$HOME/vallartapulse-backups}"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date -u +"%Y-%m-%d-%H%M%S")
OUTFILE="$BACKUP_DIR/vallartapulse-${TIMESTAMP}.dump"
TMPFILE="${OUTFILE}.partial"

# ── pre-flight: capture row counts of key tables for the log ────────────────
echo "[backup-railway-db] $(date -u +%FT%TZ) start  → $OUTFILE"
echo "[backup-railway-db] pre-flight row counts:"
psql "$DB_URL" -t -c "
  SELECT
    relname AS table_name,
    n_live_tup AS rows
  FROM pg_stat_user_tables
  ORDER BY n_live_tup DESC
  LIMIT 8;
" 2>&1 | sed 's/^/[backup-railway-db]   /'

# ── dump ────────────────────────────────────────────────────────────────────
# -Fc:           custom format (compressed, parallel-restoreable)
# --no-owner:    don't restore ownership (we restore to a different role)
# --no-acl:      don't restore GRANT/REVOKE statements (same reason)
# --verbose:     log progress to stderr (captured by launchd's err log)
# Write to .partial first; rename only on success so a partial dump never
# masquerades as a complete one.
START_TS=$(date +%s)
pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --verbose \
  --file="$TMPFILE" \
  "$DB_URL"
END_TS=$(date +%s)

# ── verify the dump is parseable ────────────────────────────────────────────
# pg_restore --list reads the TOC of the dump file. If the dump is corrupt
# or empty, this fails. Counting TOC entries is a cheap sanity check —
# a healthy VallartaPulse dump has hundreds of entries (tables, indexes,
# constraints, sequences).
TOC_ENTRIES=$(pg_restore --list "$TMPFILE" 2>/dev/null | grep -c -E '^\s*[0-9]+;' || true)
if [[ "$TOC_ENTRIES" -lt 50 ]]; then
  echo "[backup-railway-db] FATAL: dump TOC has only $TOC_ENTRIES entries — looks corrupt. Keeping .partial for inspection." >&2
  exit 2
fi

# ── finalize ────────────────────────────────────────────────────────────────
mv "$TMPFILE" "$OUTFILE"
chmod 600 "$OUTFILE"  # backups contain all data; restrict to owner

SIZE=$(du -h "$OUTFILE" | cut -f1)
DURATION=$((END_TS - START_TS))
echo "[backup-railway-db] $(date -u +%FT%TZ) done   → $OUTFILE"
echo "[backup-railway-db]   size=$SIZE  toc-entries=$TOC_ENTRIES  duration=${DURATION}s"

# ── on-disk inventory (so the log shows the growing archive) ────────────────
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -maxdepth 1 -name 'vallartapulse-*.dump' | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
echo "[backup-railway-db]   archive: $TOTAL_BACKUPS dumps, $TOTAL_SIZE total in $BACKUP_DIR"
