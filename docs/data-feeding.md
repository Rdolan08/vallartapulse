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
| **Rental calendar — PVRPV (full 365-day window)** | B | daily 07:05 UTC *(workflow not yet wired — see follow-ups)* | `pnpm --filter @workspace/scripts run scrape:calendar` → `rental_prices_by_date` | adapter+driver shipped, **manual run only** |
| **Rental calendar — Airbnb (checkpoint set)** | A *(planned)* | daily | `airbnb-checkpoints.ts` + adapter (TBD) → `listing_price_quotes` | **blocked — see Airbnb pricing pivot below** |
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

### PVRPV: shipped (manual)

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

**Not yet wired to GitHub Actions.** Trivial follow-up — copy
`.github/workflows/pvrpv-scrape.yml`, swap the script name. Pending
operator decision on cron offset.

### Airbnb pricing — pivot required

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
