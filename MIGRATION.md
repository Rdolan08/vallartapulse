# Migration Guide — Replit → Vercel (frontend) + Railway (API + Postgres)

This document is the single source of truth for moving VallartaPulse off
Replit. Nothing in this guide deploys, migrates, or changes production. It
only stages the files and lists the exact commands you (the human) will run
when you're ready.

---

## 1. Architecture target

```
                                ┌──────────────────────────────┐
   www.vallartapulse.com  ────► │  Vercel  (static Vite build) │
                                │  artifacts/pv-datastore      │
                                └──────────────┬───────────────┘
                                               │  fetch(VITE_API_URL + /api/...)
                                               ▼
                                ┌──────────────────────────────┐
   api.vallartapulse.com  ────► │  Railway  (Node API server)  │
                                │  artifacts/api-server        │
                                └──────────────┬───────────────┘
                                               │  DATABASE_URL
                                               ▼
                                ┌──────────────────────────────┐
                                │  Railway Postgres            │
                                └──────────────────────────────┘
```

DNS:
- `vallartapulse.com`, `www.vallartapulse.com` → Vercel
- `api.vallartapulse.com` → Railway

---

## 2. Files staged for review

Code changes — frontend API base resolution
- **`artifacts/pv-datastore/src/lib/api-base.ts`** *(new)* — exports
  `apiUrl(path)` and `API_BASE_URL`. When `VITE_API_URL` is set at build
  time the helper produces absolute URLs; otherwise it returns the path
  unchanged so same-origin/local dev keeps working.
- **`artifacts/pv-datastore/src/main.tsx`** — calls
  `setBaseUrl(API_BASE_URL)` on the generated `@workspace/api-client-react`
  client whenever `VITE_API_URL` is present, so all generated hooks also
  hit the remote API.
- **`artifacts/pv-datastore/src/pages/contact.tsx`** — replaces the
  `import.meta.env.BASE_URL` concatenation with `apiUrl("/api/contact")`.
- **`artifacts/pv-datastore/src/pages/sources.tsx`** — same swap for
  `apiUrl("/api/sources/sync-all")`.
- **`artifacts/pv-datastore/src/pages/pricing-tool.tsx`** — `apiFetch()`
  now wraps incoming paths through `apiUrl(...)` before calling `fetch`.

Code changes — backend CORS
- **`artifacts/api-server/src/app.ts`** — replaces the wide-open
  `cors()` middleware with an allowlist driven by the `CORS_ORIGINS`
  environment variable (comma-separated origins). When unset, behaviour
  matches the previous default (any origin), so local dev is unaffected.

Configuration
- **`.env.example`** — documents `VITE_API_URL` and `CORS_ORIGINS`.
- **`vercel.json`** *(new)* — Vercel build config: pnpm install, build the
  `pv-datastore` filter, output from `artifacts/pv-datastore/dist/public`,
  rewrites for the 9 secondary multi-page entry points, immutable cache
  headers for hashed assets.
- **`railway.json`** *(new)* — Railway build/start config: pnpm install,
  build the `api-server` filter, start with the existing
  `node --enable-source-maps artifacts/api-server/dist/index.mjs`,
  healthcheck against `/api/healthz`.

No commits, no pushes, no production changes have been made.

---

## 3. CORS configuration the API will accept

Set on the Railway service:

```
CORS_ORIGINS=https://www.vallartapulse.com,https://vallartapulse.com,https://vallartapulse.vercel.app,http://localhost:5173,http://localhost:3000
```

Notes:
- `vallartapulse.vercel.app` covers the auto-generated production URL.
- Vercel preview URLs (`*.vercel.app`) are not included — add specific
  preview domains to the allowlist as needed, or extend the middleware to
  accept a regex if you want all `*.vercel.app` origins.
- Same-origin and tooling requests (no `Origin` header) are always allowed.
- When `CORS_ORIGINS` is unset the server is permissive — keep this for
  local dev, set the variable in production.

---

## 4. Frontend `VITE_API_URL` behaviour

| Scenario | `VITE_API_URL` | Resulting fetch |
|----------|----------------|-----------------|
| Local dev (single Express + Vite proxy) | unset | `/api/contact` (relative) |
| Vercel + Railway (split) | `https://api.vallartapulse.com` | `https://api.vallartapulse.com/api/contact` |
| Reverse-proxied prod (single domain) | unset | `/api/contact` (relative) |

Trailing slashes on `VITE_API_URL` are stripped automatically. The variable
is read at **build time** (Vite inlines it), so changing it requires a
rebuild on Vercel.

---

## 5. `vercel.json` overview

- **Install**: `corepack enable && corepack prepare pnpm@latest --activate`
  (Vercel ships pnpm via Corepack).
- **Build**: `pnpm install --frozen-lockfile && pnpm --filter
  @workspace/pv-datastore... build` — the trailing `...` builds workspace
  dependencies (`@workspace/api-client-react`, `api-zod`, etc.) too.
- **Output**: `artifacts/pv-datastore/dist/public` (matches
  `vite.config.ts → build.outDir`).
- **Rewrites**: every secondary HTML entry point (`/tourism`,
  `/rental-market`, `/pricing-tool`, `/economic`, `/safety`, `/weather`,
  `/sources`, `/about`, `/contact`) is rewritten to its built
  `index.html`. Without these rewrites Vercel only finds `/index.html`.
- **Cache headers**: `/assets/*` (Vite's hashed bundle output) gets
  `max-age=31536000, immutable`.

You'll set these env vars on the Vercel project (Settings → Environment
Variables → Production):

```
VITE_API_URL=https://api.vallartapulse.com
```

---

## 6. `railway.json` overview

- **Builder**: Nixpacks (Railway's default — auto-detects Node, runs
  `pnpm install`, etc.). Our `buildCommand` overrides it with the
  filtered build to avoid building the unused `mockup-sandbox` artifact.
- **Start**: identical to the existing root `pnpm start` script.
- **Healthcheck**: `GET /api/healthz` (already implemented in
  `routes/health.ts`).
- **Replicas**: 1. The API runs `node-cron` (daily 8 AM ET sync) and an
  in-process scheduler — running multiple replicas would cause duplicate
  cron firings and duplicate API hits to upstream sources. Keep this at 1
  unless you extract the scheduler into a separate worker.

Env vars to set on the Railway API service:

```
NODE_ENV=production
PORT=8080                          # Railway also injects PORT automatically
DATABASE_URL=<from Railway Postgres plugin, set automatically>
CORS_ORIGINS=https://www.vallartapulse.com,https://vallartapulse.com,...
GMAIL_CONTACT_FORM_PASSWORD=<from your Gmail app password>
AWIN_API_TOKEN=<your existing Awin token>
```

---

## 7. PostgreSQL dump and restore

You will run these commands locally (or in any shell with `psql` and
`pg_dump` 16+ installed). Replit's Postgres is version 16, Railway's
default is 16 — versions match.

**A. Export the current Replit database** (run in Replit shell):

```bash
# 1. Sanity check — shows version and table count.
psql "$DATABASE_URL" -c "SELECT version();"
psql "$DATABASE_URL" -c "\dt"

# 2. Take a custom-format dump (compressed, parallel-restore-capable).
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --verbose \
  --file=vallartapulse.dump

# 3. (Optional) Also take a plain SQL dump for human inspection.
pg_dump "$DATABASE_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --file=vallartapulse.sql
```

Download `vallartapulse.dump` from Replit (Files → right-click → Download).

**B. Provision Postgres on Railway**: in the Railway project, click
*New → Database → Add PostgreSQL*. Copy the `DATABASE_URL` from the
Postgres service's *Variables* tab.

**C. Import into Railway** (run locally with the Railway URL):

```bash
# Replace with the URL from the Railway Postgres service.
export RAILWAY_DATABASE_URL='postgresql://postgres:...@...railway.app:5432/railway'

# 1. Confirm the target is empty.
psql "$RAILWAY_DATABASE_URL" -c "\dt"

# 2. Restore the dump.
pg_restore \
  --dbname="$RAILWAY_DATABASE_URL" \
  --no-owner \
  --no-privileges \
  --verbose \
  vallartapulse.dump

# 3. Verify.
psql "$RAILWAY_DATABASE_URL" -c "\dt"
psql "$RAILWAY_DATABASE_URL" -c "SELECT COUNT(*) FROM data_sources;"
```

If `pg_restore` reports errors about missing extensions, run them first:

```bash
psql "$RAILWAY_DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

After restore, the API's boot-time seeders (`seedIfEmpty`,
`reseedEconomicIfOutdated`, `repairMissing2026Tourism`,
`reseedTourismIfFake`, `repairDataSourceCounts`, `seedAmenitiesLookup`,
`seedRentalListings`) all check before writing — they will be no-ops on a
populated database.

---

## 8. Environment variable migration checklist

| Variable | Frontend (Vercel) | API (Railway) | Notes |
|----------|:-----------------:|:-------------:|-------|
| `DATABASE_URL` | ✕ | ✓ | Set automatically by the Railway Postgres plugin. |
| `PORT` | ✕ | injected | Railway injects this; `index.ts` reads it. |
| `NODE_ENV` | ✕ | ✓ (`production`) | |
| `CORS_ORIGINS` | ✕ | ✓ | Comma-separated allowlist (see §3). |
| `GMAIL_CONTACT_FORM_PASSWORD` | ✕ | ✓ | Your Gmail app password. |
| `AWIN_API_TOKEN` | ✕ | ✓ | Your existing Awin affiliate token. |
| `VITE_API_URL` | ✓ | ✕ | `https://api.vallartapulse.com`. Build-time inlined. |
| `BASE_PATH` | optional | ✕ | Leave unset for root-mounted deploys. Used only by Vite. |

**Do not set on either platform**: anything Replit-specific (`REPL_*`,
`REPLIT_*`). Nothing in the code reads them.

---

## 9. Local development after these changes

Local dev is unchanged. With `VITE_API_URL` unset and `CORS_ORIGINS`
unset, behaviour matches today:

```bash
pnpm install
pnpm -r --parallel run dev    # or run the three workflows individually
```

- API listens on `PORT` (8080 in `.env.example`).
- Vite serves the frontend on its own `PORT` (5173 default).
- The frontend issues relative `/api/...` requests. If you want them to
  reach the API in dev, either:
  - Add a Vite dev proxy (not currently configured), or
  - Set `VITE_API_URL=http://localhost:8080` in a local `.env` and the
    frontend will hit the API directly. CORS will allow it because
    `CORS_ORIGINS` is unset.

The `apiUrl()` helper falls through to the previous behaviour when the
build-time variable is absent, so no existing local workflows break.

---

## 10. Replit-specific behaviour audit

Performed against `artifacts/api-server/src/**` and
`artifacts/pv-datastore/src/**`:

| Concern | Finding | Risk after split |
|--------|---------|------------------|
| Replit-specific deps | None. All `@replit/*` packages were removed earlier in this session. | None. |
| Local file storage / writable disk | No `fs.write*`, no `createWriteStream`, no uploads. Only `dist/` is written and that's at build time. | None. Railway's filesystem is ephemeral, which is fine. |
| `__dirname`-based asset reads at runtime | Build-time only (Vite alias `@assets → ../../attached_assets`). Bundled into `dist/`. | None. |
| Same-origin assumption in fetches | Three sites identified and patched: `contact.tsx`, `sources.tsx`, `pricing-tool.tsx` (`apiFetch`). All now go through `apiUrl()`. | Resolved. |
| Generated `@workspace/api-client-react` hooks | Use relative URLs by default. `main.tsx` now wires `setBaseUrl(API_BASE_URL)` so they pick up `VITE_API_URL`. | Resolved. |
| Scheduled jobs | `node-cron` (`daily-sync.ts`, daily 8 AM ET) and `startScheduler()` (`ingest/sync-scheduler.js`) both run inside the API process. Compatible with a single Railway replica. | Keep `numReplicas: 1` to avoid duplicate runs. Already set in `railway.json`. |
| Environment-variable assumptions | API requires `PORT` and `DATABASE_URL`. Both are injected by Railway. | None. |
| External APIs called from frontend | `photon.komoot.io` (geocoding) — already absolute, no change needed. | None. |
| CORS / cookies | API uses `app.use(cors())` without `credentials: true`. New config enables `credentials: true` to support future cookie auth without breaking current behaviour. No cookies are currently set or read by browser-facing routes. | None. |
| `BASE_URL` (Vite) usage | Used for in-page navigation paths (e.g. `WouterRouter` base). Independent of API URL — leaving it as `/` for Vercel root deployment is correct. | None. |

---

## 11. Risks and assumptions

- **Vite dev proxy is not configured** — if you currently rely on running
  the API and frontend on the same Replit port via the dev workflow, that
  worked because the API server itself serves the static build (or you
  proxied via Replit's reverse proxy). On Vercel, the static site can't
  proxy `/api` to Railway. The new `VITE_API_URL` flow is the supported
  path. Nothing in dev breaks because `apiUrl()` falls back to relative.
- **CORS allowlist is a strict comparison**. Vercel preview deployments
  (random `*.vercel.app` subdomains) won't be allowed unless you add them
  individually. Tell me if you want a regex/`*.vercel.app` wildcard.
- **Postgres extensions** — if the live DB uses any non-default
  extensions beyond `pgcrypto`, `pg_restore` will warn. Inspect the
  plain-text `vallartapulse.sql` for any `CREATE EXTENSION` lines and
  pre-create them on Railway.
- **Gmail app password rotation** — when you copy
  `GMAIL_CONTACT_FORM_PASSWORD` into Railway, do not commit it.
- **Cron timing** — `node-cron` uses `America/New_York`. Railway servers
  default to UTC; the timezone string handles conversion. No action
  needed, but expect logs in UTC.
- **DNS cutover order** — change DNS *after* both deployments are green
  and tested via direct URLs (`vallartapulse.vercel.app` and the Railway
  service URL). DNS TTL on `vallartapulse.com` should be lowered ahead of
  time if a fast cutover matters.

---

## 12. Commands you'll run when ready (not now)

```bash
# 1. Pull the staged changes locally and review the diff.
git pull
git status
git diff

# 2. (Optional) Run typecheck + build to confirm nothing is broken.
pnpm install
pnpm typecheck
pnpm build

# 3. When you're satisfied, commit on a feature branch.
git checkout -b chore/migration-prep
git add -A
git commit -m "chore: stage Vercel + Railway migration config"
git push -u origin chore/migration-prep

# 4. Open a PR, review on GitHub, merge to main.

# 5. On Vercel: New Project → import the repo → set VITE_API_URL → deploy.
# 6. On Railway: New Project → Deploy from GitHub → add Postgres plugin →
#    set CORS_ORIGINS, GMAIL_CONTACT_FORM_PASSWORD, AWIN_API_TOKEN.
# 7. Run the pg_dump / pg_restore commands from §7.
# 8. Test both deployments via their direct URLs.
# 9. Cut DNS over.
```

---

## 13. Summary

| Item | Status |
|------|--------|
| 1. CORS-ready API config | Staged in `app.ts`. Reads `CORS_ORIGINS` from env. |
| 2. Frontend `VITE_API_URL` with safe local fallback | Staged: `lib/api-base.ts`, `main.tsx`, three pages updated. |
| 3. `vercel.json` for the frontend | Staged at repo root. |
| 4. Railway build/start config | Staged at `railway.json`. |
| 5. Postgres dump/restore commands | Documented in §7. |
| 6. Env var migration checklist | Documented in §8. |
| 7. Local-dev compatibility | Unchanged — verified in §9. |
| 8. Replit-specific behaviour audit | Documented in §10. No blockers. |

No commits made. No production changes made. Review the diff, then run
the commands in §12 when you're ready.
