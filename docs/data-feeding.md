# Continuous Data Feeding

The freshness contract for VallartaPulse is simple:

> **No stale data on the site, ever.**

This applies to *every* data source — rentals, points-of-interest, OG images,
neighborhood metrics, anything we render. Every source must have an answer
to two questions:

1. **What surface refreshes it?** (one of three — see below)
2. **How often?** (default: every 24 hours)

If a source doesn't have an answer to both, it's a bug.

---

## The three refresh surfaces

| Surface | Use when | Examples | Trigger |
|---|---|---|---|
| **A. Railway in-process endpoint, GitHub Actions cron triggers it** | Source needs the residential proxy or Playwright (anti-bot) | Airbnb detail enrichment | `curl POST /api/ingest/<endpoint>` from `.github/workflows/<src>-refresh.yml` |
| **B. GitHub Actions runs the scraper directly against prod DB** | Source is a plain-HTTP scrape, no anti-bot wall | PVRPV, future OG refresh | `pnpm exec tsx src/<src>-scrape.ts` with `DATABASE_URL=$RAILWAY_DATABASE_URL` |
| **C. User's local Mac runs it, then `sync-rows.sh` ships rows to prod** | Source needs a residential IP we don't have on Railway/GHA | Airbnb discovery (current state) | `./scripts/sync-rows.sh --table=rental_listings --source-platform=airbnb` |

**Pick exactly one surface per source.** Mixing them produces ghost rows
nobody can explain a week later.

---

## Per-source assignment

| Source | Surface | Cadence | Workflow / Script | Status |
|---|---|---|---|---|
| Airbnb — discovery (find new listings) | C | daily, manual via Mac | user's local scraper → `sync-rows.sh` | working |
| Airbnb — detail enrichment (new) | A | daily 06:00 UTC | `.github/workflows/airbnb-enrich-refresh.yml` (mode=new) | shipped |
| Airbnb — detail refresh (stale >24h) | A | daily 06:00 UTC | same workflow (mode=stale) | shipped |
| PVRPV | B | daily 07:00 UTC | `.github/workflows/pvrpv-scrape.yml` | shipped |
| Vacation Vallarta | A | daily 07:30 UTC | `.github/workflows/sources-sync-refresh.yml` (vacation_vallarta step) | shipped |
| VRBO — discovery + refresh | B | daily 07:15 UTC | `.github/workflows/vrbo-scrape.yml` — script tries to discover PV listings then upserts the union of (new ∪ existing). **Discovery currently blocked by VRBO's PerimeterX bot challenge** (see vrbo-search-adapter.ts header for tried approaches). Refresh of existing rows works the moment any get seeded. | wired, discovery blocked |
| OG screenshots | B | every other day 09:00 UTC | `.github/workflows/og-refresh.yml` | shipped |
| **Rental calendar — PVRPV (full 365-day window)** | B | daily 07:05 UTC | `.github/workflows/calendar-scrape.yml` → `pnpm --filter @workspace/scripts run scrape:calendar` → `rental_prices_by_date` | shipped |
| **Rental calendar — Airbnb (availability, 365-day window)** | B | daily 07:10 UTC | `.github/workflows/airbnb-calendar-scrape.yml` → `rental_prices_by_date` (price=null, availability filled) | shipped — see "Airbnb pricing — pivot resolved" below |
| **Rental calendar — Vacation Vallarta** | B *(planned)* | daily | `vacation-vallarta-calendar-adapter.ts` → `rental_prices_by_date` | **not built** |

---

## Required GitHub repository secrets

Set these once under **Settings → Secrets and variables → Actions**:

| Secret | Used by | Value |
|---|---|---|
| `RAILWAY_API_URL` | Pattern A workflows | e.g. `https://api.vallartapulse.com` (no trailing slash) |
| `INTERNAL_TRIGGER_TOKEN` | Pattern A workflows (`/ingest/enrich-airbnb-detail`, `/ingest/sync/:source`, `/ingest/sync-all`) | same value as the Railway env var of the same name |
| `RAILWAY_DATABASE_URL` | Pattern B workflows | prod Postgres connection string |

The matching Railway env vars (`INTERNAL_TRIGGER_TOKEN`, `PROXY_URL`,
`AIRBNB_DETAIL_FETCH_MODE=raw`) are already set on the prod service.

---

## Adding a new source — five-step recipe

1. **Build the adapter** under
   `artifacts/api-server/src/lib/ingest/<source>-adapter.ts` returning
   `NormalizedRentalListing[]`. Use `persistNormalized()` to write to DB.
2. **Pick a surface** (A / B / C) using the table above.
3. **Copy the template** at `.github/workflows/_template-source-refresh.yml.example`
   and delete the pattern you didn't pick.
4. **Set the cron** to a different minute from existing workflows so we don't
   stampede the prod DB / proxy at the same instant.
5. **Add a row** to the per-source assignment table above.

That's it. End-to-end should be under an hour for a plain-HTTP source.

---

## The "stale" cohort query (rentals)

The endpoint `POST /api/ingest/enrich-airbnb-detail` accepts:

```json
{ "mode": "stale", "staleAfterDays": 1, "maxListings": 500 }
```

Internally that runs:

```sql
SELECT rl.id, rl.external_id, rl.source_url, rl.normalized_neighborhood_bucket
FROM rental_listings rl
JOIN (
  SELECT listing_id, MAX(enriched_at) AS last_enriched
  FROM listing_details
  GROUP BY listing_id
) ld ON ld.listing_id = rl.id
WHERE rl.source_platform = 'airbnb'
  AND rl.source_url IS NOT NULL
  AND rl.normalized_neighborhood_bucket IN (...)
  AND ld.last_enriched < NOW() - INTERVAL '1 day'
ORDER BY ld.last_enriched ASC
LIMIT 500;
```

Most-stale rows go first, so a backlog drains in priority order.

`mode: "new"` keeps its old behavior (rows with no `listing_details` at all)
for backward compat with existing callers.

---

## Manual operations

### Move rows from local dev DB → Railway prod

```bash
SRC_DATABASE_URL="$LOCAL_DATABASE_URL" \
DST_DATABASE_URL="$RAILWAY_DATABASE_URL" \
./scripts/sync-rows.sh \
  --table=rental_listings \
  --source-platform=airbnb
```

Defaults to `INSERT ... ON CONFLICT (source_platform, source_url) DO NOTHING`.
Pass `--update-on-conflict` to overwrite, `--limit=N` to ship a subset, or
`--dry-run` to verify the plan without touching dst.

### Force-trigger an enrichment refresh manually

```bash
curl -X POST https://<RAILWAY_API_URL>/api/ingest/enrich-airbnb-detail \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Token: $INTERNAL_TRIGGER_TOKEN" \
  -d '{"mode":"stale","staleAfterDays":1,"maxListings":500}'
```

Or trigger the GitHub Action by hand: **Actions → Airbnb Enrich + Daily
Refresh → Run workflow** (the `workflow_dispatch` button).

### Spot-check freshness on prod

**The acceptance query — max scraped_at per source.** The headline question
"is anything stale?" reduces to "what's the most recent `scraped_at` per
source, and is it within the freshness window?". Run this after every
deploy and as the first diagnostic step when something feels stale:

```sql
SELECT
  source_platform,
  COUNT(*)                                              AS rows,
  MAX(scraped_at)                                       AS last_scraped,
  NOW() - MAX(scraped_at)                               AS age,
  (NOW() - MAX(scraped_at) > INTERVAL '1 day') AS stale
FROM rental_listings
GROUP BY source_platform
ORDER BY source_platform;
```

A `stale = true` row means that source's cron has not produced a fresh
write in the last 24h — open the corresponding GitHub Actions run history
and the Railway logs.

**Per-listing freshness for Airbnb enrichment** (the slower-moving signal —
how recently each listing's PDP was re-fetched):

```sql
SELECT
  rl.source_platform,
  COUNT(*)                                                  AS total,
  COUNT(*) FILTER (WHERE ld.last_enriched IS NULL)          AS never_enriched,
  COUNT(*) FILTER (WHERE ld.last_enriched < NOW() - INTERVAL '1 day') AS stale_24h
FROM rental_listings rl
LEFT JOIN (
  SELECT listing_id, MAX(enriched_at) AS last_enriched
  FROM listing_details GROUP BY listing_id
) ld ON ld.listing_id = rl.id
GROUP BY 1 ORDER BY 1;
```

If `stale_24h > 0` for more than one daily cycle on any source, the cron for
that source is silently failing — check the GitHub Actions run history.

---

## Rental calendar / dynamic pricing (Path A) — current state

The owner-facing question this layer answers:

> "What should I charge per night for {date} given what comp listings are
> doing?"

Comp data lands in two tables, both keyed by listing × time:

- **`rental_prices_by_date`** — one row per (listing × calendar date). Used
  for the always-on, "next-365-days for every listing" coverage. UPSERT
  pattern, refreshed daily.
- **`listing_price_quotes`** — one row per (listing × check-in × check-out
  × `collected_at`). Insert-only, used for full-fee booking quotes
  (nightly + cleaning + service + tax). Time-series shape so we can study
  booking-window behavior.

### PVRPV: shipped

`scripts/src/calendar-scrape.ts` + `pvrpv-calendar-adapter.ts`. One run
covers all 125 active PVRPV listings × 365 days = ~45,625 rows. Two HTTP
fetches per listing (rates table + paginated minicalendar pages). No
proxy required.

**Validated against prod** (April 2026): 125/125 listings ✓, 45,625 rows
written, zero errors, ~80 seconds wall clock at concurrency 3. Coverage:
60% available / 40% booked across the year, with realistic seasonality
(NYE 69% booked 8 months out, Beef Dip 81% booked one year out, May
~23% booked at six-week lead — exactly the booking patterns owners
need to plan against).

**Wired to GitHub Actions** as `.github/workflows/calendar-scrape.yml`,
running daily at 07:05 UTC (5 minutes after `pvrpv-scrape.yml` so listing
rows are fresh first). `scripts/freshness.sh` reports
`MAX(scraped_at)` for `rental_prices_by_date`.

### Airbnb pricing — pivot resolved (April 2026)

**Status: shipped as availability-only feed; full quote prices deferred.**

Re-spike of path 1 (`/api/v2/calendar_months`) confirmed that exact route
is dead (404 `route_not_found`), but its surviving sibling
`/api/v2/homes_pdp_availability_calendar` still works:

- ✅ Plain HTTP, **no proxy** — Pattern B fits cleanly.
- ✅ Returns 365 days of `{available, min_nights, max_nights}` per listing
  in a single ~1s call.
- ❌ Per-day **price** is stripped — the `price` object is always `{}`,
  across every query-format permutation tried (`with_conditions`,
  `for_remarketing`, `for_web_with_date`, `for_mobile_pdp`, with
  `adults` param, etc.). Per-day prices have moved entirely to the
  client-side `PdpAvailabilityCalendar` GraphQL call (path 2).
- ⚠️ Cap: only Airbnb's pre-2022 numeric IDs (≤ 10 digits) resolve on
  this endpoint. Of our 504 active Airbnb rows, **163 fit the legacy
  shape** and get refreshed daily; the 345 long-form-ID rows wait for
  path 2.

**What shipped** (Apr 2026):

- `airbnb-calendar-adapter.ts` — pure adapter wrapping the legacy
  endpoint, returns the same `CalendarDay` shape PVRPV uses.
- `airbnb-calendar-scrape.ts` driver + `scrape:airbnb-calendar` script.
- `.github/workflows/airbnb-calendar-scrape.yml` — daily 07:10 UTC.
- Writes one row per (listing × date) into `rental_prices_by_date` with
  `nightly_price_usd = NULL` and the real `availability_status` /
  `minimum_nights`. The adapter still inspects `price.local_price`,
  `price.native_price`, etc. on every day, so if Airbnb ever restores
  per-day price data the field auto-fills with no schema or driver
  change.
- Validated against prod: 15-listing pilot run, 5,475 rows written,
  3,895 available days / 1,580 unavailable days, 0 failures, ~25s wall
  clock at concurrency 2. Full 163-listing run estimated <2 min.

**Why this is useful even without prices.** Owner-facing question
"what % of comparable Airbnb listings are booked for NYE 2026?" is
answerable from availability alone — `rental_prices_by_date` already
has `availability_status` as a first-class column. The comp model can
now see Airbnb's demand curve (booking lead-time, holiday compression,
weekend vs. mid-week occupancy) alongside PVRPV's full price+availability
data. Per-night dollars wait, but the Airbnb signal is no longer dark.

**What's still deferred:**

- `listing_price_quotes` — the full-fee quote table (nightly + cleaning
  + service + tax) — remains unpopulated for Airbnb. The
  `airbnb-checkpoints.ts` date generator stays inert until path 2
  (`PdpAvailabilityCalendar` GraphQL replay through the residential
  proxy, with a periodically-rotating persisted-query SHA hash) is
  built. That work is 1–2 days and fragile — left as a follow-up
  rather than blocking this milestone.
- The 345 long-form-ID Airbnb rows — same path-2 dependency. The
  adapter rejects them at the source-listings query (length > 10) so
  freshness signals reflect the cohort we can actually serve, not a
  67% baseline failure rate.

---

### Airbnb pricing — original pivot context (kept for history)


The original spike claimed Airbnb's SSR PDP embeds `priceBreakdown` when
fetched with `?check_in=&check_out=` — meaning we could get full quote
data via plain HTML scraping. **That conclusion was wrong.** Verified
April 2026 against three live listings on multiple date ranges:

- The PDP renders fine (~500KB) and is not delisted.
- The `data-deferred-state-0` Apollo state contains only request
  *variables* — no `priceBreakdown`, no `structuredDisplayPrice` (always
  `null`), no `chargeableAmount`, no `nightlyPrice`, no amount tokens
  anywhere in the document.
- Airbnb has shifted pricing to a client-side GraphQL fetch
  (`PdpAvailabilityCalendar` / `MerlinPriceBreakdown`) issued *after*
  page load, so the SSR HTML never contains it.

The infrastructure built and ready to plug in once a price feed exists:

- `airbnb-checkpoints.ts` — pure date generator, ~35 checkpoints per
  listing covering rolling weekends (12 weeks), holidays (Xmas/NYE),
  year-aware events (Beef Dip, Semana Santa, PV Pride, Easter computed
  via Anonymous Gregorian algorithm), and monthly mid-week anchors.
  Tier function stubbed to always return 1 — Phase 2 adds priority
  tiers without touching the driver.
- `listing_price_quotes` table schema (already in DB).

Three paths forward, in increasing effort:

1. **Use the legacy `/api/v2/calendar_months` endpoint.** Returns per-day
   availability + base nightly. No fees breakdown but enough to feed a
   comp model. May or may not still work without auth — needs a 1-hour
   spike.
2. **Replicate the GraphQL `PdpAvailabilityCalendar` call.** Capture the
   persisted-query SHA hash via Playwright once, replay through Decodo.
   Rotates periodically (~weeks). 1-2 days of work, fragile.
3. **Ship without Airbnb-specific quotes.** PVRPV's 125 listings already
   blanket the high-demand neighborhoods (Zona Romantica 89, Amapas 33,
   Marina 3) and give us $50-$2,800 nightly spread across the same
   bedroom counts Airbnb listings come in. The comp model can run on
   PVRPV alone for v1 and add Airbnb when path 1 or 2 lands.

**Recommendation:** ship v1 on PVRPV-only, spike path 1 in a 1-hour
window, reassess.

### Airbnb listing universe — partial verify-and-prune

Original spike claimed 76% of `is_active=true` Airbnb rows return the
2,671-byte delisted template. A re-run via
`scripts/src/airbnb-prune.ts` against prod checked the first 200 of 507
active rows: **0 delisted, 0 errors**. Strongly suggests the original
spike measured something else (possibly a Decodo block masquerading as
the delisted template, or a different predicate). The remaining 307
weren't checked because Decodo started intermittently hanging beyond
the 25s `AbortSignal` timeout, deadlocking workers.

**Driver hardening needed before next run:** wrap each fetch in an
outer `Promise.race` with a hard kill-switch timer that doesn't rely on
the proxy/undici respecting the abort signal.

---

## Local Mac mini scraper — Airbnb + VRBO ingestion contract

This section is the canonical brief for the local scraper running on
the user's Mac mini M4 (residential IP, Tailscale-attached). Read it
end-to-end before writing code; it exists to keep the Mac scraper from
trampling what's already running on Railway / GitHub Actions.

### Why the Mac at all

Two things only a residential IP can do reliably:

| Job | Why local | Status without it |
|---|---|---|
| **Airbnb discovery** (find new listings) | already lives here | working today |
| **VRBO discovery** | PerimeterX blocks every server-side path tried (raw HTTP, undici+proxy, headless Chromium direct, headless through Decodo) | blocked; site shows no VRBO comps |
| **Airbnb pricing** | SSR PDP no longer embeds prices; needs post-hydration GraphQL or a real browser | not collected today |
| **VRBO pricing** | same PerimeterX wall as discovery | not collected today |

Everything else stays where it is. Don't move working pipelines.

### Mac-mini deployment shape

| Concern | Decision |
|---|---|
| Host | Mac mini M4, always-on, residential IP |
| Networking | Tailscale tailnet for ops only (ssh in, tail logs, manual restart). Data flow goes Mac → Railway DB over the public internet via TLS — same as `sync-rows.sh` already does. **Do not** route DB writes over Tailscale; the Railway DB has no tailnet identity and adding one is unnecessary complexity. |
| Local DB | Postgres on the Mac, schema-only mirror of prod. Holds today's scrape output until `sync-rows.sh` ships it. |
| Browser | Playwright Chromium with persistent context at `~/.vallartapulse-chromium` so cookies survive across runs (helps with Airbnb's GraphQL session and VRBO's PerimeterX clearance token). |
| Scheduler | `launchd` (not `cron`). Single LaunchAgent runs the daily driver at 03:00 PT. Logs to `~/vallartapulse-logs/YYYY-MM-DD.log`. |
| Concurrency | 1–2 browser contexts max. The whole point of the Mac is to look like a human; concurrency 4+ defeats it. |

### Daily budget — 50 listings per vendor

The user's hard cap. Translates directly into a **stale-first rotation
strategy**: each daily run picks the 50 listings per vendor whose last
refresh is oldest, refreshes them, and exits.

\`\`\`sql
-- The "give me today's 50 Airbnb listings" query
SELECT rl.id, rl.source_url
FROM rental_listings rl
LEFT JOIN (
  SELECT listing_id, MAX(scraped_at) AS last_refresh
  FROM rental_prices_by_date GROUP BY listing_id
) p ON p.listing_id = rl.id
WHERE rl.source_platform = 'airbnb'
  AND rl.is_active = true
ORDER BY p.last_refresh ASC NULLS FIRST   -- never-scraped first, then oldest
LIMIT 50;
\`\`\`

At 50/day across ~507 active Airbnb listings, **every listing gets
refreshed every ~10 days**. That's the freshness contract for
Airbnb pricing under this budget — document it as such, don't pretend
it's daily. PVRPV (full 125 listings refreshed daily) remains the
high-frequency comp source; Airbnb is the broader, slower-rotating
comp source.

VRBO budget = same 50/day cap, applied the same way — once VRBO
discovery has populated `rental_listings` rows.

### Ownership matrix — who writes what (one writer per cell)

| Table | Cohort | Mac writes | Railway/GHA writes |
|---|---|---|---|
| `rental_listings` | NEW rows where `source_platform IN ('airbnb','vrbo')` | ✅ INSERT only, conflict = DO NOTHING | ❌ |
| `rental_listings` | NEW rows for `pvrpv`, `vacation_vallarta` | ❌ | ✅ |
| `rental_listings` | `is_active`, `lifecycle_status`, `last_seen_at` for EXISTING rows | ❌ never touch | ✅ (prune; currently paused) |
| `listing_details` | enrichment fields | ❌ never write | ✅ Pattern A endpoint |
| `rental_prices_by_date` | rows for Airbnb/VRBO listings | ✅ UPSERT on `(listing_id, date)` | ❌ |
| `rental_prices_by_date` | rows for PVRPV/VV listings | ❌ | ✅ |
| `listing_price_quotes` | Airbnb/VRBO checkpoint quotes | ✅ INSERT only (history table — never UPDATE) | ❌ |

**The single hard rule**: for any (table × cohort) cell above, exactly
one process writes. Two writers = ghost rows nobody can explain a
week later.

### Outbound shipping — Mac → Railway (the only write path)

**Always** use `scripts/sync-rows.sh`. Never connect ad-hoc psql
sessions to prod from the Mac. Three commands cover every case:

\`\`\`bash
# 1) Newly discovered listings (DO NOTHING on conflict)
SRC_DATABASE_URL=$LOCAL_DATABASE_URL DST_DATABASE_URL=$RAILWAY_DATABASE_URL \\
  ./scripts/sync-rows.sh --table=rental_listings --source-platform=airbnb

# 2) Daily price/availability rows (UPDATE on conflict — refresh today's row)
SRC_DATABASE_URL=$LOCAL_DATABASE_URL DST_DATABASE_URL=$RAILWAY_DATABASE_URL \\
  ./scripts/sync-rows.sh --table=rental_prices_by_date --source-platform=airbnb \\
    --conflict-cols=listing_id,date --update-on-conflict

# 3) Full-fee quotes (insert-only history; conflict-cols=id is a never-violated key)
SRC_DATABASE_URL=$LOCAL_DATABASE_URL DST_DATABASE_URL=$RAILWAY_DATABASE_URL \\
  ./scripts/sync-rows.sh --table=listing_price_quotes --source-platform=airbnb \\
    --conflict-cols=id
\`\`\`

If `sync-rows.sh` doesn't yet support filtering the price tables by
joined `source_platform` (it filters on the table's own column today),
that's a one-line edit — do **not** invent a parallel shipping path.

### Bootstrap once

\`\`\`bash
# Schema-only mirror of prod into local
pg_dump --schema-only "$RAILWAY_DATABASE_URL" | psql "$LOCAL_DATABASE_URL"

# Pull the listing IDs + URLs the scraper needs as input (no other prod data)
psql "$RAILWAY_DATABASE_URL" -c "\\copy (SELECT id, source_platform, source_url, is_active FROM rental_listings WHERE source_platform IN ('airbnb','vrbo')) TO '/tmp/seed.csv' CSV HEADER"
psql "$LOCAL_DATABASE_URL"   -c "\\copy rental_listings (id, source_platform, source_url, is_active) FROM '/tmp/seed.csv' CSV HEADER"
\`\`\`

Refresh the seed weekly so newly-discovered Railway-side listings show
up in the Mac's rotation.

### Per-source contracts (paste these into ChatGPT)

Each contract = (input cohort, output table, columns with types,
conflict rule, idempotency, daily budget). Hand ChatGPT **one
contract at a time**, not the whole doc.

#### Airbnb — discovery

- **Input**: PV neighborhood search URLs (copy the URL list from
  `artifacts/api-server/src/lib/ingest/airbnb-search-adapter.ts`).
- **Output table**: `rental_listings`.
- **Required columns**: `source_platform='airbnb'`, `source_url`
  (canonical PDP URL: `https://www.airbnb.com/rooms/{id}`, no query
  params, no trailing slash), `external_id` (Airbnb numeric ID),
  `title`, `bedrooms`, `bathrooms`, `max_guests`, `latitude`,
  `longitude`, `normalized_neighborhood_bucket` (use the lookup at
  `lib/normalize/neighborhoods.ts`), `is_active=true`,
  `lifecycle_status='active'`, `first_seen_at=now()`,
  `last_seen_at=now()`, `scraped_at=now()`.
- **Conflict rule**: `(source_platform, source_url) DO NOTHING` —
  never overwrite a row Railway has already enriched.
- **Idempotency**: re-run any time; only newly-found rows land.
- **Daily budget**: best-effort, no cap — discovery is cheap.

#### Airbnb — pricing (the new gold path)

- **Input cohort**: 50 stale-first listings per the rotation query
  above.
- **For each listing, do two things**:

  1. **Full 365-day calendar → `rental_prices_by_date`**, one row per
     day, UPSERT on `(listing_id, date)`. Source: Airbnb's
     `PdpAvailabilityCalendar` GraphQL operation (the call the PDP
     makes after hydration — capture its persisted-query SHA + headers
     once via Playwright, then replay through `fetch` in the same
     browser context so cookies are valid). Columns: `listing_id`,
     `date`, `nightly_price_usd` (base nightly only — calendar
     GraphQL doesn't include fees), `availability_status`
     (`available` | `booked` | `blocked` per the GraphQL response),
     `minimum_nights`, `scraped_at=now()`.

  2. **35 checkpoint quotes → `listing_price_quotes`**, INSERT only.
     Generate dates via the existing pure function:

     \`\`\`ts
     import { generateCheckpoints } from
       "../api-server/src/lib/ingest/airbnb-checkpoints.ts";
     const cps = generateCheckpoints(); // ~35 dates
     \`\`\`

     For each checkpoint hit the actual checkout/quote endpoint (not
     the calendar) so you get the full fee breakdown:
     `nightly_price_usd`, `subtotal_usd`, `cleaning_fee_usd`,
     `service_fee_usd`, `taxes_usd`, `total_price_usd`, `guest_count`
     (always 2 for comp parity), `raw_quote_json` (full payload —
     keep for parser-repair).

- **Conflict rules**: `rental_prices_by_date` UPDATE on
  `(listing_id, date)`; `listing_price_quotes` no conflict.
- **Daily budget**: 50 listings × (365 daily rows + 35 quote rows) =
  18,250 daily rows + 1,750 quote rows. Manageable single-thread, ~30
  minutes wall-clock at 1 listing every ~30s.

#### VRBO — discovery

- **Input**: VRBO PV search URLs from
  `artifacts/api-server/src/lib/ingest/vrbo-search-adapter.ts` (the
  header comment lists the four already-tried server-side approaches
  — ignore those; use a real browser locally).
- **Output table**: `rental_listings` with `source_platform='vrbo'`.
  Same column shape as Airbnb discovery.
- **Conflict rule**: same — DO NOTHING.
- **Daily budget**: best-effort. Expect 50–200 listings total in PV
  once discovery completes.

#### VRBO — pricing

- **Input cohort**: 50 stale-first VRBO listings (same rotation
  query, swap `source_platform`).
- **Output tables**: same two tables, same conflict rules.
- **Notes**: VRBO calendar/quote shape is documented at
  `https://www.vrbo.com/{listing_id}/dates`. Capture it once via
  the Playwright session that solved the discovery PerimeterX
  challenge, then replay headers in the same context.
- **Daily budget**: 50 × 365 = 18,250 daily rows + 50 × 35 = 1,750
  quote rows.

### Conflict avoidance — the "don't break what works" list

These five rules are non-negotiable. ChatGPT will want to "clean up"
or "normalize" some of them — push back.

1. **Never UPDATE `rental_listings` from the Mac.** Only INSERT new.
   Specifically: do not touch `is_active`, `lifecycle_status`,
   `last_seen_at`, `enriched_at`, or anything Railway-side
   enrichment owns. The Mac is allowed to set these fields **only
   on first insert**, never on conflict.
2. **Never write to `listing_details`.** That's Railway's table.
3. **Never run the prune (`scripts/airbnb-prune.ts`) from the Mac
   against prod.** Use it locally for a sanity signal if you want;
   do not pass `--apply` against `RAILWAY_DATABASE_URL`.
4. **Use the canonical `source_url` shape.** Airbnb:
   `https://www.airbnb.com/rooms/{id}` (no query params, no trailing
   slash). VRBO: `https://www.vrbo.com/{id}` (numeric, no slug).
   The unique index `idx_rl_source_unique` on
   `(source_platform, source_url)` is how we de-dupe — typos here
   create ghost listings.
5. **All timestamps are UTC.** `scraped_at` and `collected_at` should
   be `new Date().toISOString()` or `now() AT TIME ZONE 'UTC'` —
   never local Mac/Pacific time.

### ChatGPT prompt skeleton

When asking ChatGPT to write a piece of this, paste **one** contract
above and frame the prompt as:

> Write a TypeScript module that satisfies this contract. Use Playwright
> (Chromium) with persistent context at `~/.vallartapulse-chromium` so
> cookies survive across runs. Output rows by calling
> `db.insert(table).values(rows).onConflictDoNothing()` (or the conflict
> rule from the contract). Do not write to any table not listed. Do not
> modify any column not listed. Treat each listing independently — one
> bad listing must not abort the run. Log progress every 5 listings.
> Concurrency = 1. Exit non-zero if failure rate >= 50%.

Then paste the contract block (Input/Output/Conflict rule/Idempotency/
Budget) verbatim. Don't paste the whole doc.

### What success looks like (acceptance)

After the local scraper has been running daily for ~2 weeks (giving
the 10-day rotation time to cover the full Airbnb cohort):

\`\`\`sql
SELECT
  rl.source_platform,
  COUNT(DISTINCT rpbd.listing_id) AS listings_with_pricing,
  COUNT(*)                        AS daily_rows,
  MAX(rpbd.scraped_at)            AS last_refresh,
  AVG(NOW() - rpbd.scraped_at)    AS avg_age,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY NOW() - rpbd.scraped_at) AS p95_age
FROM rental_prices_by_date rpbd
JOIN rental_listings rl ON rl.id = rpbd.listing_id
GROUP BY rl.source_platform
ORDER BY rl.source_platform;
\`\`\`

Expectations:

| platform | listings_with_pricing | p95_age |
|---|---|---|
| `pvrpv` | ~125 | < 26 hours |
| `airbnb` | ~507 | < 11 days |
| `vrbo` | (depends on discovery) | < 11 days |

If `airbnb.p95_age > 11 days` after week 3, the rotation is falling
behind — bump the daily cap or add a second Mac.

---

## Out of scope for this task — known follow-ups

These are documented here so they don't get lost. None of them are
blocking the freshness contract for the sources we *do* feed today.

1. **VRBO discovery (PerimeterX challenge)** — see the header comment in
   `artifacts/api-server/src/lib/ingest/vrbo-search-adapter.ts` for the
   list of approaches already tried (raw HTTP, undici+proxy, headless
   Chromium direct, headless Chromium through Decodo — last one returns
   200 OK but with the challenge page, not listings). Unblocking needs
   either a challenge-solver proxy add-on, a different residential pool
   that's clean for VRBO, or an Expedia/VRBO API affiliate credential.
   Until then, the daily cron runs as a no-op when no VRBO seed rows
   exist; the moment any get seeded (manually or otherwise), the same
   cron starts refreshing them.
2. **POI / events / weather data** — these layers don't exist yet on
   the site. When they do, each gets a row in the per-source table and
   a workflow following the five-step recipe above.
