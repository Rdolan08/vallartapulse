# Airbnb Pricing Pipeline — How It Actually Works

**Purpose:** end the recurring confusion (and repeated codex regressions) about which endpoint, which adapter, and which DB table is actually responsible for Airbnb per-night pricing data. If you're about to write a new "airbnb pricing" script, **read this first**.

---

## Status (as of 2026-04-23)

**Pipeline is wired and ready for first real Mac mini run.** Both GraphQL adapters that were previously stubs are now implemented:

- `airbnb-graphql-pricing-adapter.ts` — calls `/api/v3/PdpAvailabilityCalendar/{sha}` (the priced GraphQL variant), parses `data.merlin.pdpAvailabilityCalendar.calendarMonths[].days[]`, returns 12 months of per-night prices. Bootstrap SHA is hard-coded; on `PersistedQueryNotFound` the adapter rediscovers from a public PDP page. In-process cache only — no DB schema added.
- `airbnb-graphql-quote-adapter.ts` — uses the v2 REST `pdp_listing_booking_details` endpoint internally (file name preserved to avoid touching every runner import; tactical choice documented in the file header). Parses the `price.price_items[]` breakdown into accommodation / cleaning / service / taxes / total. Returns `currency`, `shaUsed`, `available`, `errors` to satisfy the runner contract that was previously broken.

First Mac mini run instructions: see "Running the pricing refresh" below. Expected outcome on a working run: `summary.totalDaysWithPrice > 0`, `summary.enrichmentRate ≥ 0.7`, exit code 0.

If the new adapters error out, exit codes:
- **2** — fetched cleanly but zero priced days (most likely a SHA rotation Airbnb didn't surface as `PersistedQueryNotFound`, or a parser-shape regression)
- **3** — every listing failed (look at `summary.listings[].error` for the pattern: 403/429 = IP block, transport = network, anything else = parse)
- **4** — adapters reverted to "not implemented" stubs (would mean a regression)

Tracked in [issue #34](https://github.com/Rdolan08/vallartapulse/issues/34).

---

## TL;DR

| Want | Endpoint | Adapter | DB table | Script to run |
|---|---|---|---|---|
| Per-night **availability** (booked/blocked, min-nights) | `homes_pdp_availability_calendar` (v2) + `PdpAvailabilityCalendar` (v3) | `airbnb-calendar-adapter.ts` | `rental_prices_by_date` | `scrape:airbnb-calendar` |
| Per-night **prices + checkpoints** | GraphQL calendar + reservation-flow quote | `airbnb-graphql-pricing-adapter.ts` + `airbnb-graphql-quote-adapter.ts` (orchestrated by `airbnb-pricing-runner.ts`) | `listing_price_quotes` (+ `airbnb_pricing_run_summaries` for run history) | `scrape:airbnb-pricing` |

**Key fact that everyone keeps forgetting:** the v2/v3 availability calendar endpoints **do not return prices**. Airbnb stripped per-day prices from those routes some time before April 2026. The v2 `price` object is always `{}`; the v3 `localPriceFormatted` is always `null` for the anonymous public web key. This is true regardless of what IP you call from. Residential proxy / Mac mini does **not** change this.

If you query `rental_prices_by_date` for `nightly_price_usd` on Airbnb listings, **you will see ~99% nulls and that is correct**. Real Airbnb prices live in `listing_price_quotes`, populated by a different code path.

---

## Why two paths exist

The comp engine wants two things from Airbnb:

1. **Availability signal** — "is this listing booked on a given night?" — used for occupancy proxies, calendar overlap with the operator's stay window, and forward-demand heuristics. Cheap to fetch (one HTTP call per listing per refresh, no proxy required, ~1s/listing).

2. **Price signal** — "what would a guest pay to book check-in X / check-out Y?" — used for comp-pool pricing. Expensive (one GraphQL call per listing for the calendar; one quote call per stay-window checkpoint; ~30–40 checkpoints per listing). Requires SHA self-healing because Airbnb rotates the persisted-query hash periodically. Best results from residential IP (Mac mini), though it will run from anywhere.

They use different endpoints, different adapters, and different DB tables. **Do not try to unify them.** They are split deliberately because:

- The cheap availability path can run daily for every active listing (~2,000 listings) without hammering Airbnb.
- The expensive price path runs in batches of ~50 listings/day (the daily budget) and writes insert-only history to `listing_price_quotes`. Re-running it doesn't overwrite anything; it just adds new quote rows.
- The schema reflects this: `rental_prices_by_date` is keyed `(listing_id, date)` UPSERT — one row per night per listing. `listing_price_quotes` is keyed `(listing_id, checkin_date, checkout_date, quoted_at)` insert-only — many rows per listing across time.

Mixing these would force one of the tables to compromise its semantics.

---

## Comp engine reads, in order

For Airbnb listings the comp price selector reads (per the v1 contract):

1. `rental_prices_by_date` daily price feed (currently dominated by `pvrpv_daily`; Airbnb rows here are ~all-null on price by design).
2. Static fallback from `rental_listings.nightly_price_usd`.

`listing_price_quotes` is **not** wired into comp-pool selection in v1 — that is the v3.4 Phase 0 work tracked in [issue #23](https://github.com/Rdolan08/vallartapulse/issues/23). Until Phase 0 ships, the per-night Airbnb prices we're collecting feed quote analytics and the freshness dashboard, but they don't yet move the recommended-rate output.

---

## Running the pricing refresh from the Mac mini

```bash
# One-time first run, conservative cohort:
DATABASE_URL=$RAILWAY_DATABASE_URL \
  pnpm --filter @workspace/scripts run scrape:airbnb-pricing

# Once you've confirmed the first run wrote rows, dial up the cohort:
AIRBNB_PRICING_MAX_LISTINGS=200 \
  DATABASE_URL=$RAILWAY_DATABASE_URL \
  pnpm --filter @workspace/scripts run scrape:airbnb-pricing

# Smoke check without DB writes:
AIRBNB_PRICING_DRY_RUN=1 \
  DATABASE_URL=$RAILWAY_DATABASE_URL \
  pnpm --filter @workspace/scripts run scrape:airbnb-pricing
```

The script prints two JSON log lines:

- `airbnb-pricing-refresh.start` — the cohort size and dry-run flag at the top.
- `airbnb-pricing-refresh.done` — the full `AirbnbPricingRunSummary` at the end, including `totalDaysWithPrice`, `totalQuotesEnriched`, `enrichmentRate`, and any SHA rediscovery counts.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success (or dry run) |
| 1 | Missing `DATABASE_URL` or unhandled exception |
| 2 | Run completed but zero priced days returned (likely SHA rotation, IP block, or parser regression) |
| 3 | Every listing failed |

---

## Verifying it worked

After a real run, the freshness dashboard's `/api/health/pricing-tool` endpoint will surface enrichment-rate alerts via `airbnb-pricing-monitor.ts`. For a quick manual check:

```sql
SELECT
  COUNT(*)                                       AS quotes_total,
  COUNT(*) FILTER (WHERE nightly_price_usd IS NOT NULL) AS quotes_priced,
  MAX(quoted_at)                                 AS newest_quote
FROM listing_price_quotes
WHERE source_platform = 'airbnb';
```

Expect `quotes_priced / quotes_total` ≥ 0.7 on a healthy run. A drop below that is the canary for a SHA rotation or parser regression.

---

## What NOT to build (recurring codex traps)

These have all been attempted and rejected:

1. **A new "airbnb pricing export" script that calls `fetchAirbnbCalendar` and writes to `rental_prices_by_date`.** This will never produce non-null prices because the endpoint doesn't return them. Symptoms: CSV with zero rows, or 562k+ rows where `nightly_price_usd IS NULL`.
2. **A bash + psql `\copy` loader that bulk-inserts into `rental_prices_by_date`.** Even if you fix the endpoint problem, the table is the wrong target for per-night prices — it'll fight the existing UPSERT semantics that protect realized booked/blocked statuses.
3. **A duplicate "scrape:airbnb-pricing-export" / "scrape:airbnb-pricing-sync" pair in `scripts/package.json`.** The canonical entry point is `scrape:airbnb-pricing` (this script). If you find anything else there, delete it.
4. **A "let's call this from GitHub Actions" plan for the pricing path specifically.** GH runners get IP-blocked by Airbnb on the GraphQL pricing endpoints within a few requests. The availability path (`scrape:airbnb-calendar`) is fine on GH. The pricing path needs the Mac mini.

---

## Related

- v3.4 roadmap: [`docs/PRICING_ENGINE_V3.4_ROADMAP.md`](./PRICING_ENGINE_V3.4_ROADMAP.md)
- Phase 0 (wire Airbnb price into comp selection): [issue #23](https://github.com/Rdolan08/vallartapulse/issues/23)
- The actual runner: `artifacts/api-server/src/lib/ingest/airbnb-pricing-runner.ts`
- The CLI wrapper this doc describes: `scripts/src/airbnb-pricing-refresh.ts`
- Sister availability scraper (different table, different endpoint): `scripts/src/airbnb-calendar-scrape.ts`
