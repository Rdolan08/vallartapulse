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

## Data Coverage

- Tourism metrics (DATATUR): hotel occupancy, tourist arrivals, cruise visitors — 2022–2024 monthly
- Rental market (Airbnb/VRBO): avg nightly rate, occupancy %, active listings by neighborhood — 2022–2024
- Economic indicators (Data México/INEGI): GDP contribution, employment, wages — 2020–2024 yearly
- Safety/crime data (SESNSP): incident counts by category — 2021–2024 monthly
- Weather/climate (NOAA): temperature, rainfall, sea temp, humidity — 2020–2024 monthly
- Data sources registry: 10 sources with status, sync timestamps, record counts
- **Listing-level rental data** (PVRPV): 50 real scraped listings — Amapas (29) + Zona Romantica (21); tables: `rental_listings`, `rental_prices_by_date`, `rental_amenities_lookup`

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

**Current data**: 50 PVRPV listings (real, scraped), avg confidence 0.982, 100% field coverage on bedrooms/bathrooms/price/amenities/lat-lon.

## Comps Engine V2 — Rental Pricing Tool

Internal comparable-property pricing engine for Zona Romantica + Amapas listings. Used to recommend nightly rates for rental properties based on similar PVRPV listings.

**Engine file**: `artifacts/api-server/src/lib/comps-engine-v2.ts` (also mirrored at `scripts/src/comps-engine-v2.ts` for validation runs)

**Validation results** (leave-one-out, 10 cases): **MAE = 22.9%** (Tier 2 — good enough for internal MVP)

**Key design decisions**:
- Beach tier bucketing: Tier A ≤100m, B 101–500m, C >500m
- ZR Tier A commands ~90% premium vs Tier B (beachfront sub-market)
- Amapas Tier C (hillside) commands ~25% premium vs Tier B
- Building median anchor: when raw building premium >40%, use building median directly (not inflated comp median) — critical for Molino de Agua ($499 vs $175 segment)
- IQR trimming skipped for mixed-tier comp sets to avoid eliminating the most relevant same-tier comp

**API endpoint**: `POST /api/rental/comps`
- Required: `neighborhood_normalized` (Zona Romantica | Amapas), `bedrooms` (1–4), `bathrooms`, `distance_to_beach_m`, `amenities_normalized`
- Optional: `sqft`, `rating_overall`, `building_name`
- Response: `conservative_price`, `recommended_price`, `stretch_price`, `confidence_label` (high/medium/low/guidance_only), `selected_comps`, `top_drivers`, `warnings`, `explanation`
- Engine is cached in memory (5-min TTL) — loads all eligible DB rows at startup

**Scripts**:
- `pnpm --filter @workspace/scripts run validate:comps-v2` — leave-one-out validation against 10 cases
- `pnpm --filter @workspace/scripts run comps <listing-id>` — run engine on a specific listing

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
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

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
