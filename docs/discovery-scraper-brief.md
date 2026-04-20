# Discovery Scraper Brief

> Hand this entire document to a coding assistant (ChatGPT, Claude, etc.) when
> you want help structuring or extending the home-residential Airbnb discovery
> scraper. It is written in the second person so it can be pasted directly into
> a chat without editing.

## Status

**Implemented.** Runner lives at `scripts/src/airbnb-discovery.ts`, helpers
at `scripts/src/lib/airbnb-discovery-{buckets,helpers}.ts` and
`scripts/src/lib/airbnb-detail-parser.ts`. Schema additions (5 nullable
columns on `rental_listings`, new `discovery_run_log` table) applied to
Railway via raw SQL `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`.
The existing scheduled scraper (Railway + GitHub Actions) is **unchanged**
and continues to run independently.

## Run command (Mac mini)

```bash
DATABASE_URL=$RAILWAY_DATABASE_URL pnpm --filter @workspace/scripts \
  exec tsx ./src/airbnb-discovery.ts
```

Optional environment knobs (defaults in parens):

| Var | Default | Purpose |
|---|---|---|
| `DISCOVERY_MAX_BUCKETS` | all 200 | Cap buckets per run |
| `DISCOVERY_MAX_PAGES`   | 5       | Search pages per bucket |
| `DISCOVERY_MIN_DELAY_MS` | 5000   | Min pacing between requests |
| `DISCOVERY_MAX_DELAY_MS` | 8000   | Max pacing between requests |
| `DISCOVERY_DRY_RUN`     | unset   | `=1` to skip all DB writes |
| `PROXY_URL`             | unset   | Decodo residential proxy URL (optional from Mac mini — direct residential IP works too) |

## Implementation notes (deviations from the original brief)

1. **Unique constraint.** `rental_listings` already enforces uniqueness on
   `(source_platform, source_url)`, not `(source_platform, external_id)`.
   The runner uses the existing constraint for `ON CONFLICT`. `external_id`
   is still populated for downstream code paths.
2. **NOT NULL columns block "thin" excluded inserts.** `rental_listings`
   requires `title`, `neighborhood_raw`, `neighborhood_normalized`,
   `bedrooms`, `bathrooms`, `scraped_at` as NOT NULL. The runner does
   **not** insert exclusion records when those fields can't be parsed
   (rather than fabricating placeholder values that would corrupt comp
   queries). Such rejections are still fully audited via:
     - The per-bucket counters in `discovery_run_log`
     - The structured stdout JSON event stream (`listing_rejected`,
       `identity_check_failed`)
3. **"Excluded but parsed" listings ARE inserted/updated.** When the
   detail parse succeeds enough to satisfy NOT NULL but the listing
   fails geo or property-type gates, the runner writes/updates the row
   with `is_active=false`, `lifecycle_status` set to the exclusion
   reason, and `cohort_excluded_reason` populated.
4. **No parallelism, runner is serial.** The brief asked for no
   parallelism; the implementation is a single async loop with
   randomized 5–8s sleeps between every HTTP request. No worker pool.
5. **Identity check reuses `rawFetchLooksUnusable`** from the existing
   `raw-fetch.ts` so the predicate stays aligned with the `airbnb-prune`
   script and the API-server detail runner.

## Project context

I run **VallartaPulse** — a Puerto Vallarta rental-comp pricing platform. I am
running a discovery-stage scraper from a residential Mac mini at
home (residential IP bypasses Airbnb's PerimeterX anti-bot wall that blocks
datacenter IPs). The scraper writes into a PostgreSQL database hosted on
Railway, into a table called `rental_listings`.

**Current discovery rate:** ~10 new listings every 2 hours = ~120/day. Cohort
is currently ~570 active Airbnb listings. Goal is to grow it cleanly, not just
quickly.

## Project context

I run **VallartaPulse** — a Puerto Vallarta rental-comp pricing platform. I am
building a discovery-stage scraper that runs from a residential Mac mini at
home (residential IP bypasses Airbnb's PerimeterX anti-bot wall that blocks
datacenter IPs). The scraper writes into a PostgreSQL database hosted on
Railway, into a table called `rental_listings`.

**Current discovery rate:** ~10 new listings every 2 hours = ~120/day. Cohort
is currently ~570 active Airbnb listings. Goal is to grow it cleanly, not just
quickly.

**My stack:**
- Postgres on Railway (URL in env var `RAILWAY_DATABASE_URL`)
- TypeScript scrapers in a Node.js workspace under `scripts/src/`
- The discovery write path is `rental_listings` table with these columns I
  care about: `external_id` (text, unique-per-platform), `source_platform`
  (`'airbnb' | 'vrbo' | 'pvrpv' | 'vacation_vallarta'`), `source_url`,
  `title`, `bedrooms`, `bathrooms`, `latitude`, `longitude`,
  `neighborhood_normalized`, `last_seen_at`, `created_at`
- Existing search adapter: fetches Airbnb search HTML, regex-parses
  `\d{7,12}` candidate IDs, walks embedded JSON (`niobeClientData`,
  `__NEXT_DATA__`) for card metadata. File:
  `artifacts/api-server/src/lib/ingest/airbnb-search-adapter.ts`

## What I'm asking for help with

Restructure the discovery scraper so that as the cohort grows from
570 → 2,000+ listings over the next few weeks, the data stays clean. I do
**not** want help making it faster — I want help making it more disciplined.

## Hard constraints

1. **Pacing:** 5–8 seconds between requests. No parallelism. Residential IPs
   get burned if you hammer them.
2. **No datacenter fallback.** If a request fails, retry on the same IP with
   backoff; do not route through a proxy.
3. **Idempotent writes.** Use
   `INSERT ... ON CONFLICT (source_platform, external_id) DO UPDATE SET last_seen_at = NOW(), title = EXCLUDED.title`.
   Never duplicate.
4. **No deletes.** Mark listings `delisted` via a column update; never
   `DELETE FROM rental_listings`.
5. **Strict TypeScript, no `any`.** Use `import type` for types.

## Quality gates a new listing must pass before being inserted

1. **Identity check:** `GET https://www.airbnb.com/rooms/{external_id}`
   returns HTTP 200 (not 301, 404, or PerimeterX challenge). 3 retries with
   exponential backoff before giving up.
2. **Geographic gate:** lat/lng inside this bounding box (generous PV
   market):
   ```
   lat:  20.50  to  20.85
   lng: -105.60 to -105.18
   ```
   Listings outside the box get inserted with
   `cohort_excluded_reason = 'out_of_market'` and excluded from active
   cohort, not deleted.
3. **Property-type whitelist:** allow `Apartment`, `Condominium`, `House`,
   `Villa`, `Townhouse`, `Loft`, `Bungalow`, `Guest suite`. Reject `Hotel`,
   `Hostel`, `Boat`, `Camper`, `Tent`, `Tipi`, `Treehouse`, `Cave`,
   `Farm stay`, `Capsule`, `Earthen home` →
   `cohort_excluded_reason = 'wrong_property_type'`.
4. **Minimum field completeness:** must have `bedrooms`, `bathrooms`, `lat`,
   `lng`. Otherwise queue for re-fetch on next pass; don't insert a thin
   record.

## Discovery strategy I want you to implement

Rather than one big "scrape Puerto Vallarta search" loop, slice the search
space into **buckets** that overlap minimally and exhaust the long tail.
Airbnb caps each search at ~280–500 results, so a single query can never
return the full PV market. Iterate over buckets:

**Bucket dimensions (cross-product):**
- **Neighborhoods** (10): Zona Romantica, Amapas, Conchas Chinas, Centro,
  5 de Diciembre, Versalles, Fluvial, Marina Vallarta, Nuevo Vallarta,
  Bucerias
- **Bedroom count** (5): 1, 2, 3, 4, 5+
- **Price band** (4): under-$100, $100–200, $200–400, $400+

That's 200 buckets. At 5 search pages × 18 cards/page × ~8s pacing per page
request, one bucket pass = ~6 min, full sweep ≈ 20 hours. Run as a single
sweep every 24h via cron.

For each bucket, dedupe candidate IDs against the existing `rental_listings`
table **before** doing the identity check / property-type gate, so you
don't re-burn requests on listings already in the cohort.

## Logging requirements

Per bucket, write a row to a `discovery_run_log` table:
- `bucket_id` (text, e.g. `"zona_romantica_2br_100-200"`)
- `started_at`, `finished_at`
- `pages_fetched` (int)
- `candidate_ids_seen` (int)
- `new_inserted` (int)
- `rejected_identity` (int)
- `rejected_geo` (int)
- `rejected_property_type` (int)
- `rejected_thin_data` (int)
- `errors` (jsonb array)

This lets me see "Centro 1BR under-$100 returned 0 new listings 6 days in a
row" = bucket is exhausted, and "Marina Vallarta 3BR is rejecting 80% on
geo gate" = bucket coordinates are wrong.

## What good looks like

- Per-day cohort growth: 50–200 new listings (under that = scraper
  degrading; over that = false positives sneaking through)
- `rejected_identity` rate: under 15% of candidates (the regex catches some
  junk IDs; this is the floor)
- Zero duplicate `(source_platform, external_id)` rows ever (constraint
  will enforce; ON CONFLICT will handle)
- `last_seen_at` updated for every existing listing seen in any bucket
  pass (so we can later sweep listings whose
  `last_seen_at < NOW() - 30d` as probably-delisted)

## Deliverable

A single TypeScript file in `scripts/src/airbnb-discovery.ts` that I can
run with `pnpm tsx scripts/src/airbnb-discovery.ts` from the Mac mini. Read
DB connection from `process.env.RAILWAY_DATABASE_URL`. Use `pg` or
`postgres` (whichever the project already uses — check `package.json`).
Log structured JSON to stdout (one line per event) so I can pipe to a
logfile and grep it.

Do not refactor the existing search adapter at
`artifacts/api-server/src/lib/ingest/airbnb-search-adapter.ts` — extract its
useful HTML-parsing logic into a shared helper, but leave the original in
place because the API server still imports it.
