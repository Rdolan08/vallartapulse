#!/bin/bash
set -euo pipefail

cd /Users/ryandolan/vallartapulse || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export $(grep -v '^#' .env | xargs)

if [ -z "${RAILWAY_DATABASE_URL:-}" ]; then
  echo "RAILWAY_DATABASE_URL is not set in .env" >&2
  exit 1
fi

export DATABASE_URL="$RAILWAY_DATABASE_URL"

mkdir -p /Users/ryandolan/vallartapulse-data/logs

timestamp=$(date -u +"%Y-%m-%dT%H-%M-%SZ")

echo "[run-discovery] starting Airbnb discovery directly to Railway at $timestamp" \
>> /Users/ryandolan/vallartapulse-data/logs/discovery-$timestamp.log

/opt/homebrew/bin/pnpm exec tsx scripts/src/str-discovery.ts --source=airbnb --max-seeds=10 \
>> /Users/ryandolan/vallartapulse-data/logs/discovery-$timestamp.log 2>&1