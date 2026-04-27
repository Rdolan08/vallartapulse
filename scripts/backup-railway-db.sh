#!/bin/bash
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
# REQUIREMENTS on the Mac mini:
#   1. pg_dump v18 or newer (Railway runs PostgreSQL 18.3). Check with:
#        pg_dump --version
#      If older, install via: brew install postgresql@18
#      Then ensure /opt/homebrew/opt/postgresql@18/bin is in PATH.
#   2. RAILWAY_DATABASE_URL exported in the launchd plist environment, or
#      a ~/.vallartapulse.env file containing it (this script will source
#      that file if present).
#
# ONE-TIME INSTALL on the Mac mini (after `git pull` brings this script):
#
#   chmod +x ~/vallartapulse/scripts/backup-railway-db.sh
#   mkdir -p ~/vallartapulse-backups
#   mkdir -p ~/vallartapulse-data/logs
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
# Disk math: DB is ~233 MB; -Fc compression typically yields 30-80 MB per
# dump. 365 dumps/year ≈ 18 GB/year. No retention is enforced by this
# script — Ryan asked for "keeping a copy daily not replacing the previous
# backup". Manual cleanup or a separate retention script can be added later.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── load env ────────────────────────────────────────────────────────────────
# launchd does NOT inherit shell env, so prefer EnvironmentVariables in the
# plist OR source a known env file here. Try the env file first; fall back
# to whatever's already in the environment.
if [[ -f "$HOME/.vallartapulse.env" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.vallartapulse.env"
fi

DB_URL="${RAILWAY_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$DB_URL" ]]; then
  echo "[backup-railway-db] FATAL: RAILWAY_DATABASE_URL (or DATABASE_URL) not set." >&2
  echo "[backup-railway-db] Either export it in the launchd plist or put it in ~/.vallartapulse.env" >&2
  exit 1
fi

# ── pg_dump version sanity ──────────────────────────────────────────────────
# Railway is PG 18.3. A pg_dump older than the server's major version is
# not supported and will refuse to run. Fail loudly rather than silently
# producing a partial dump.
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup-railway-db] FATAL: pg_dump not on PATH. Install with: brew install postgresql@18" >&2
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
