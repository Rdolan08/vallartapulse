#!/bin/bash
set -euo pipefail

echo "[post-merge] pnpm install"
pnpm install --prefer-offline

echo "[post-merge] db push (force, non-interactive) + auto-apply views"
pnpm --filter @workspace/db run push-force

echo "[post-merge] done"
