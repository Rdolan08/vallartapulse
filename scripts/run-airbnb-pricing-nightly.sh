#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Airbnb pricing nightly runner — Mac mini residential edition.
#
# Invoked by launchd job com.vallartapulse.airbnb-pricing at 17:00 PV
# (= 23:00 UTC). Runs the canonical per-night pricing pipeline against
# the production Railway database from the mini's residential IP — the
# only viable network position now that Decodo's residential proxy pool
# is burned. See artifacts/api-server/src/lib/ingest/airbnb-pricing-runner.ts
# and scripts/src/airbnb-pricing-refresh.ts for what the runner does.
#
# Architecture: Drizzle direct, no CSV middleman. The runner writes
# per-night quotes straight into listing_price_quotes and a run summary
# row into airbnb_pricing_run_summaries. The JSON summary the runner
# prints to stdout is the canonical "did it work" signal — it lands in
# this script's log file via the tee at the bottom.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# launchd inherits a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) which
# does not include homebrew binaries (pnpm, node, jq). Set explicitly so
# the script behaves the same under launchd as it does in an interactive
# shell. /opt/homebrew/bin is the canonical homebrew prefix on Apple Silicon.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_DIR="/Users/ryandolan/vallartapulse"
LOG_DIR="$REPO_DIR/logs/airbnb-pricing"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
LOG_FILE="$LOG_DIR/run-$TS.log"

mkdir -p "$LOG_DIR"

{
  echo "===== Airbnb pricing nightly run ($TS UTC) ====="
  echo "PATH=$PATH"
  cd "$REPO_DIR"

  echo "[1/3] Loading env"
  set -a
  source .env
  set +a
  export DATABASE_URL="${RAILWAY_DATABASE_URL:?RAILWAY_DATABASE_URL missing}"

  echo "[2/3] Running pricing refresh (Drizzle direct, target=1000 listings stale-first)"
  # AIRBNB_PRICING_MAX_LISTINGS=1000 → at ~70s/listing this is roughly a
  # 12-hour wall-clock budget, leaves ~12h margin before the next 23:00
  # UTC trigger. Adjust upward only after confirming runs finish well
  # under the next-trigger threshold.
  AIRBNB_PRICING_MAX_LISTINGS=1000 \
    pnpm --filter @workspace/scripts run scrape:airbnb-pricing
  RUN_RC=$?

  echo "[3/3] Done (exit_rc=$RUN_RC)"
  exit "$RUN_RC"
} 2>&1 | tee -a "$LOG_FILE"
