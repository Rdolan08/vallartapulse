#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Discovery nightly runner — Mac mini residential edition.
#
# Invoked by three launchd jobs that each set DISCOVERY_TIER:
#   com.vallartapulse.discovery.daily    (tier 1, 03:15 UTC daily)
#   com.vallartapulse.discovery.midweek  (tier 2, 04:00 UTC Mon/Wed/Fri)
#   com.vallartapulse.discovery.weekly   (tier 3, weekly)
#
# DISCOVERY_TIER currently only drives the per-run log filename — the
# discovery scope itself is decided inside airbnb-discovery.ts. If/when
# we want different tiers to crawl different cohorts, branch on tier
# below. (See follow-up note in commit message.)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd /Users/ryandolan/vallartapulse || exit 1

# launchd inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) which
# does not include homebrew binaries (pnpm, node). Set explicitly so the
# script behaves the same under launchd as it does in an interactive
# shell. /opt/homebrew/bin is the canonical homebrew prefix on Apple Silicon.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Safer .env loading than `export $(grep -v '^#' .env | xargs)` — that
# pattern blows up on values containing spaces, quotes, '&', or '='. The
# `set -a; source; set +a` pattern lets bash itself parse the file.
set -a
source .env
set +a

if [ -z "${RAILWAY_DATABASE_URL:-}" ]; then
  echo "RAILWAY_DATABASE_URL is not set in .env" >&2
  exit 1
fi

export DATABASE_URL="$RAILWAY_DATABASE_URL"

mkdir -p /Users/ryandolan/vallartapulse-data/logs

timestamp=$(date -u +"%Y-%m-%dT%H-%M-%SZ")
tier="${DISCOVERY_TIER:-all}"
logfile="/Users/ryandolan/vallartapulse-data/logs/discovery-${tier}-${timestamp}.log"

echo "[run-discovery] starting tier=${tier} at ${timestamp}" >> "$logfile"
echo "[run-discovery] PATH=$PATH" >> "$logfile"

# Run airbnb-discovery via the @workspace/scripts subpackage, where
# tsx is actually installed (in scripts/node_modules/.bin/). The
# previous `pnpm exec tsx` from the workspace root failed with
# ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL because tsx isn't installed at
# the root — only inside the scripts subpackage.
/opt/homebrew/bin/pnpm --filter @workspace/scripts run discover:airbnb \
  >> "$logfile" 2>&1
