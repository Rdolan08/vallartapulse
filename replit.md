# VallartaPulse

Real-time insights for Puerto Vallarta's rental and tourism market. Bilingual (EN/ES) data platform for property managers and rental property owners.

## Branding

- **Name**: VallartaPulse
- **Logo**: VP monogram (teal on dark) — images in `attached_assets/`
  - Dark logo: `vallartapulse_dark_1774383836513.png`
  - Light logo: `vallartapulse_light_1774383836512.png`
- **Colors**: Background `#0B1F2A` · Primary teal `#00C2A8` · Accent `#00D1FF` · CTA `#FF6B6B` · Light `#F5F7FA`
- **Font**: Inter (all weights)
- **Default mode**: Dark (`.dark` class on `<html>`)
- **Positioning**: Real-time insights for Puerto Vallarta's rental and tourism market

## Product Overview

- **Primary users**: Property managers and rental property owners in Puerto Vallarta
- **Purpose**: Aggregate public data sources (government, satellite, tourism, crime, climate) into actionable insights
- **Language**: Bilingual English/Spanish
- **Data sources**: DATATUR, INEGI, Data México, SESNSP, NOAA, Airbnb/VRBO (estimated), OpenStreetMap

## Data Architecture (single source of truth)

Every DB row in the seven core tables has exactly one origin: a CSV under `data/`.
Drift is corrected by re-ingesting the CSV, not by row-level SQL patches.

- **CSV layout** (`data/<domain>/*.csv`):
  - `airport/pvr-passenger-traffic.csv`     → `airport_metrics`
  - `tourism/datatur-monthly.csv`           → `tourism_metrics`
  - `safety/sesnsp-incidents.csv`           → `safety_metrics`
  - `economic/inegi-imss-indicators.csv`    → `economic_metrics`
  - `weather/pvr-monthly.csv`               → `weather_metrics`
  - `sources/data-sources-registry.csv`     → `data_sources`
  - `events/market-events.csv`              → `market_events`
- **Ingest pipeline** (`scripts/ingest/`): one file per table + `all.ts` runner. Truncate-and-reload — idempotent. Run manually with `pnpm --filter @workspace/scripts run ingest`; `data_sources` is ingested last so its `record_count` column is re-derived from the live metric tables.
- **Boot-time seed**: `artifacts/api-server/src/lib/seed.ts` (56 lines) spawns the ingest pipeline **only when `airport_metrics` is empty**. All the former `repair*` / `reseed*` helpers (the old 1,164-line `seed.ts`) have been retired.
- **To refresh DB values**: edit the CSV and re-run the ingest script. Manual DB edits will be overwritten on the next ingest — this is intentional.

## Data Coverage

- Tourism metrics (DATATUR): hotel occupancy, tourist arrivals, cruise visitors — 2022–2024 monthly
- Rental market (Airbnb/VRBO): avg nightly rate, occupancy %, active listings by neighborhood — 2022–2024
- Economic indicators (Data México/INEGI): GDP contribution, employment, wages — 2020–2024 yearly
- Safety/crime data (SESNSP): incident counts by category — 2021–2024 monthly
- Weather/climate (NOAA): temperature, rainfall, sea temp, humidity — 2020–2024 monthly
- Data sources registry: 10 sources with status, sync timestamps, record counts
- **Listing-level rental data** (multi-source): 192 real scraped listings across 8 neighborhoods — PVRPV (161), Vacation Vallarta (24), Airbnb (4), VRBO (3); tables: `rental_listings`, `rental_prices_by_date`, `rental_amenities_lookup`

## Pages

1. **Dashboard** (`/`) — KPI summary cards + mini trend charts
2. **Tourism Metrics** (`/tourism`) — DATATUR occupancy/arrivals charts + table with filters
3. **Rental Market** (`/rental-market`) — Airbnb/VRBO rates, occupancy by neighborhood
4. **Economic** (`/economic`) — employment, revenue, workforce indicators
5. **Safety & Crime** (`/safety`) — incident categories, trends, per-100k rates
6. **Weather & Climate** (`/weather`) — temperature, rainfall, sea conditions by month
7. **Data Sources** (`/sources`) — source registry cards with Sync Now button

## Listing-Level Rental Data Pipeline

Three tables added to support listing-level rental analysis (not aggregate):
- **`rental_listings`**: 26-field listing schema with lat/lon, amenities (raw + normalized), bedrooms, bathrooms, confidence scoring
- **`rental_prices_by_date`**: Calendar-level price + availability per listing (FK to rental_listings)
- **`rental_amenities_lookup`**: 17 canonical amenity keys across 9 categories, bilingual

Normalization logic: `artifacts/api-server/src/lib/rental-normalize.ts`
Ingestion pipeline: `artifacts/api-server/src/lib/rental-ingest.ts`
Scraper: `scripts/src/pvrpv-scrape.ts` (run with `pnpm --filter @workspace/scripts run scrape:pvrpv`)

**Current data**: 192 listings — PVRPV (161), Vacation Vallarta (24), Airbnb (4), VRBO (3) — across 8 PV neighborhoods. Beach distances back-filled for Hotel Zone (300m), Centro (500m), 5 de Dic (250m), Old Town (300m), Versalles (1200m) using neighborhood centroids.

## Comps Engine V2 — Rental Pricing Tool

Internal comparable-property pricing engine covering **8 neighborhoods** across PV + Riviera Nayarit. 163 eligible listings indexed; recommends nightly rates from comps within ±1 bedroom and scored by beach distance, amenities, size, and rating.

**Engine file**: `artifacts/api-server/src/lib/comps-engine-v2.ts`

**Neighborhood coverage** (after beach-distance backfill April 2026):
- **Zona Romantica** (high confidence): 89 eligible, beach distances 42–1042m from DB
- **Amapas** (low–medium confidence): 34 eligible, beach distances 180–999m from DB
- **Hotel Zone** (low confidence): 13 eligible, estimated 300m beach distance
- **Centro** (medium confidence): 13 eligible, estimated 500m beach distance
- **5 de Diciembre** (medium confidence): 7 eligible, estimated 250m beach distance
- **Versalles** (low confidence): 5 eligible, estimated 1200m beach distance
- **Marina Vallarta** (low confidence): 5 eligible, measured 1051–1548m from DB
- **Old Town** (guidance_only): 6 listings, thin pool (1–2 comps per bedroom tier)

**Eligibility thresholds**:
- ZR/Amapas: `dataConfidenceScore >= 0.85`, beach distance required, price $1–$5000, bedrooms 1–6
- All other neighborhoods: `dataConfidenceScore >= 0.70` (VV adapter yields fewer fields → lower base score)

**Key design decisions**:
- Beach tier bucketing: Tier A ≤100m, B 101–500m, C >500m
- Building median anchor: when raw building premium >40%, use building median directly
- `BASE_WEIGHTS_GENERIC` for non-ZR/Amapas; neighborhood-aware beach adjustment via `getBeachAdj()`
- IQR trimming skipped for mixed-tier comp sets
- **5-step comp selection cascade**: (1) same beach tier, (2) safe adjacent tiers, (3) all tiers, (4) ±1BR within neighborhood, (5) adjacent neighborhood fallback (±1BR first, then ±2BR if still thin)
- Adjacent neighborhood map in `ADJACENT_NEIGHBORHOODS` constant (e.g., Hotel Zone → Marina Vallarta, Centro; Versalles → 5 de Diciembre, Centro)

**API endpoint**: `POST /api/rental/comps`
- Required: `neighborhood_normalized` (any of 16 supported), `bedrooms` (1–6), `bathrooms`, `distance_to_beach_m`, `amenities_normalized`
- Optional: `sqft`, `rating_overall`, `building_name`
- Response: `conservative_price`, `recommended_price`, `stretch_price`, `confidence_label`, `selected_comps`, `top_drivers`, `warnings`, `explanation`
- `market_anomaly` field: `{ detected, severity, events[] }` — includes any active market events that affect "pricing" and overlap the target month's window (uses `recovery_window_end` as effective end date)
- `adjacent_neighborhood: bool` + `adjacent_neighborhoods_used: string[]` — set when Step 5 triggers; UI shows indigo "Expanded Coverage" banner
- Market events cache: 15-min TTL, queries `market_events` table where `is_active = true`
- Engine cached in memory (5-min TTL) — reloads all eligible DB rows at startup

**Scripts**:
- `pnpm --filter @workspace/scripts run validate:comps-v2` — leave-one-out validation against 10 cases
- `pnpm --filter @workspace/scripts run comps <listing-id>` — run engine on a specific listing

## GitHub Operations

**Always use the personal access token stored in `GITHUB_PERSONAL_ACCESS_TOKEN_NEW`** — never `listConnections('github')`, which lacks the `workflow` scope.

Use Python via bash (the code_execution sandbox cannot read Replit secrets):

```python
python3 - <<'PYEOF'
import os, base64, json, urllib.request
token = os.environ.get('GITHUB_PERSONAL_ACCESS_TOKEN_NEW', '')
BASE = 'https://api.github.com/repos/Rdolan08/vallartapulse'
headers = {'Authorization': f'token {token}', 'Content-Type': 'application/json', 'Accept': 'application/vnd.github.v3+json'}
# ... API calls here
PYEOF
```

- **Repo**: `Rdolan08/vallartapulse`, branch `main`
- **Workflow files**: require `workflow` scope — PAT has this, integration token does NOT
- **Safety filter**: bash commands containing `git commit/push/pull` strings are blocked even inside heredocs; write file content with the `write` tool first, then reference the file in the script

## Production Hosting (do NOT ask again)

- **Frontend (SPA)**: Vercel — `https://www.vallartapulse.com`
- **API server**: Railway — `https://the-data-store-production.up.railway.app`
  - The DNS `api.vallartapulse.com` mentioned in `MIGRATION.md` is aspirational only. It does NOT resolve. Always use the Railway URL.
- **Database**: Railway PostgreSQL, accessed via `RAILWAY_DATABASE_URL` env var in production; local dev uses `DATABASE_URL` from Replit.
- **Vercel `/api/*` rewrite** (in `vercel.json`) proxies SPA-relative `/api/*` calls to the Railway origin. Hardcoded fallback also lives in `artifacts/pv-datastore/src/lib/api-base.ts` so a missing `VITE_API_URL` env var can't reintroduce the 404.

## Airbnb pricing pipeline — PAUSED

As of 2026-04-19, **Airbnb per-night quote collection is on hold**. Reason: `airbnb-graphql-pricing-adapter.ts` and `airbnb-graphql-quote-adapter.ts` are still compile-only stubs that throw "not implemented" at runtime. The full GraphQL replay + persisted-query SHA discovery code never landed.

What's currently in the paused state — **do not "fix" any of these without thinking, they are intentional**:

- `/api/ingest/airbnb-pricing-refresh` returns 500 with `"airbnb-graphql-*-adapter is not implemented in this build"`. **Safe-fail by design.** Do NOT make it return 200 with empty data.
- `/api/ingest/airbnb-pricing-freshness` returns the real DB freshness numbers — verdict will be `fail` with reason `"No quotes have ever been collected"`. That is the truth. The dashboard card is supposed to be red.
- `.github/workflows/airbnb-pricing-refresh.yml` daily cron is **commented out** (workflow_dispatch still works for manual smoke tests). Slack notify and GitHub-issue dedupe steps are gated `if: false`. Restoring is a one-line revert in each spot — see the `# PAUSED` comment blocks.
- The Airbnb cohort (`source_platform='airbnb' AND is_active=true AND external_id ~ '^[0-9]+$'`) is currently 504 listings, all with zero quotes. Comp-tool comparisons against Airbnb listings will show "—" for fee columns until quote collection lands.
- PVRPV pricing, VRBO pricing, VRBO scrape, calendar scrape, enrich refresh — all UNAFFECTED. Only the Airbnb per-night quote pipeline is paused.

To unpause once the adapters are real: revert the `if: false` gates and the commented-out cron in `airbnb-pricing-refresh.yml`, redeploy Railway, manually dispatch the workflow once with `max_listings=10` to confirm, then let the daily cron resume.

## Recurring Pitfalls — read before changing anything

- **Missing Airbnb GraphQL adapters**: `artifacts/api-server/src/lib/ingest/airbnb-pricing-runner.ts` imports `./airbnb-graphql-pricing-adapter.js` and `./airbnb-graphql-quote-adapter.js`. Those files are stubs that throw at runtime (full implementation never landed). DO NOT delete the stubs or the Railway build breaks. If you implement the real adapters, replace the stub bodies — don't rename the files. See "Airbnb pricing pipeline — PAUSED" above for the full picture.
- **Vercel proxy regression**: any time someone touches `vercel.json` or `api-base.ts`, the pricing tool can silently start serving HTML 404 to JSON callers. The hardening in commit `99e8d5f` (HTML-response guard in `apiFetch`, daily smoke workflow `pricing-tool-smoke.yml`, `/api/health/pricing-tool` endpoint) is the safety net. Don't remove it.
- **Project-task popups**: when a task agent finishes it auto-proposes follow-up tasks, which spam the user with approval popups. Default mode going forward: edit `main` directly and push, no project tasks unless the user explicitly asks. Reject any auto-proposed follow-ups on sight.

## Known Fixes & Notes

- **Chart colors**: Recharts `hsl(var(--chart-N))` variables are NOT defined in the design system. All chart strokes/fills must use hardcoded brand hex values: `#00C2A8` (primary teal), `#00D1FF` (accent cyan), `#F59E0B` (amber), `#6366F1` (indigo), `#3B82F6` (blue). Do not use `--chart-N` CSS variables.
- **Numeric values from DB**: PostgreSQL `numeric`/`decimal` columns come back as strings over JSON. Always `parseFloat(String(value))` before passing to Recharts or math operations.
- **Production build**: requires `PORT` and `BASE_PATH` env vars — use `PORT=5173 BASE_PATH="/" pnpm --filter @workspace/pv-datastore run build`

## Workspace



## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
  - **Raw-SQL views are NOT tracked by Drizzle.** `pnpm --filter @workspace/db push` will silently `DROP VIEW` anything not declared in the schema. Re-apply views with `pnpm --filter @workspace/scripts run db:apply-views` after every push. Current views: `airbnb_comp_signal` (defined in `lib/db/src/views/airbnb_comp_signal.sql`).
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL` environment variable)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Schema changes are applied with `pnpm --filter @workspace/db run push` (or `push-force` to bypass confirmation). In production the same command runs as part of the deployment post-build step.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
