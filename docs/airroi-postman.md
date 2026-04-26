# AirROI `/listings/future/rates` — Postman / curl reference

Single-listing forward-rate calendar fetch. Ground truth for replicating
the script's behavior in Postman or any HTTP client. Captured 2026-04-26
after the morning PV burn.

## Endpoint

- **Base**: `https://api.airroi.com`
- **Path**: `/listings/future/rates`
- **Method**: **GET**
- **Proxy**: none required (direct HTTPS to AirROI's AWS API Gateway).
  The `PROXY_URL` env var in this repo is for the *other* scrapers
  (Airbnb GraphQL quote pipeline, etc.) — AirROI calls bypass it.

## Auth

Single header. Issued by AirROI on signup.

| Header | Value |
|---|---|
| `x-api-key` | `<YOUR_AIRROI_API_KEY>` |
| `accept` | `application/json` |

In our env: `AIRROI_API_KEY`.

## Query params

| Param | Type | Required | Example | Notes |
|---|---|---|---|---|
| `id` | string (numeric) | yes | `48065257` | Airbnb listing's external numeric id. Must match `^\d+$`. Both 7–8 digit legacy ids and 18–19 digit modern ids work. |
| `currency` | string | no | `usd` | Lowercase ISO-4217. Default `usd`. EUR/MXN/etc are accepted. Response echoes the resolved currency. |

## curl equivalent

```bash
curl -sS "https://api.airroi.com/listings/future/rates?id=48065257&currency=usd" \
  -H "x-api-key: $AIRROI_API_KEY" \
  -H "accept: application/json"
```

## Postman setup

1. New request → method `GET`.
2. URL: `https://api.airroi.com/listings/future/rates`
3. **Params** tab:
   - `id` = `48065257`
   - `currency` = `usd`
4. **Headers** tab:
   - `x-api-key` = `{{airroi_api_key}}` (Postman environment variable)
   - `accept` = `application/json`
5. **Settings** tab:
   - Request timeout: at least 60000 ms (AirROI cold-starts run right up
     against their own 29s backend cap; 60s gives you the 504 response
     instead of an aborted-by-client fetch).

## Response shape

```json
{
  "currency": "USD",
  "dates": [
    { "date": "2026-04-26", "available": false, "rate": 187, "min_nights": 2 },
    { "date": "2026-04-27", "available": true,  "rate": 165, "min_nights": 2 }
  ]
}
```

- Returns ~340 forward days per call (the `dates` array).
- Per day:
  - `date` — `YYYY-MM-DD`
  - `available` — boolean
  - `rate` — number (in requested currency) or `null`
  - `min_nights` — number or `null`
- Top-level `currency` field echoes the resolved currency (uppercase).

Defensive parsing in `airroi-adapter.ts` also accepts a top-level array
or any first array-of-objects with `date` + `available` keys, since the
documented shape (`dates`) has historically drifted in beta.

## Cost

- **$0.10 per successful call** — confirmed from the AirROI usage
  dashboard 2026-04-26 (avg cost on `/listings/future/rates` shown
  directly in the Usage by Endpoint card).
- Older comments in this repo referencing `$0.015/call` were stale
  pre-billing estimates and have been corrected.
- Partnership tier (https://www.airroi.com/api/pricing) advertises a
  per-call discount at higher volume — exact thresholds TBD; needs a
  conversation with their team.
- Quick budget math:
  - 1000 calls = $100 at standard rate
  - 1000 calls = $50 at partnership $0.05 rate
  - PV cohort = 640 callable listings → one full pass = $64 / $32

## Reliability profile (observed April 2026)

- Backend is AWS Lambda behind API Gateway with a hard 29s timeout.
- Cold-start invocations routinely return `504
  InternalServerErrorException` after ~29s.
- Same listing on retry typically warm-paths in 6–12s.
- Failure mode is bursty: a chunk of 20 calls usually has 0–3 retries.
- Empirical retry tax: each retry adds 30–45s of wall time.

## Retry strategy used by the script

```
maxAttempts:        3
backoffSchedule:    [5s, 15s]      # sleep before retry N+1
perAttemptTimeout:  60s            # above AirROI's 29s server cap
retryableStatuses:  408, 429, 500, 502, 503, 504
```

| Outcome | Action |
|---|---|
| `200` with non-empty `dates` | success — return |
| `200` with empty `dates` | terminal failure (listing delisted / no calendar). **Do NOT retry.** |
| 408 / 429 / 5xx | retry with backoff |
| Other 4xx | terminal failure (auth, quota, bad id) |
| Network/timeout error | retry with backoff |

## Cost-control strategy (relevant to building the pricing engine)

- Burn ≈ listings × ~$0.10 × ~1.05 retry inflation.
- Refresh policy: don't re-rate the same listing more often than its
  data decays. Use `last_rated_at` and rotate stale-first.
- Region filter is critical: `AIRROI_PARENT_REGIONS=puerto_vallarta`
  cuts the active cohort from ~thousands to ~640.
- ID-length filter (`AIRROI_ID_LENGTHS=7,8,18`) avoids the 12-digit
  dead bucket and most of the 19-digit ~60%-coverage bucket.
- Concurrency 4 is safe given the 5-minute hard timeout in
  `lib/concurrency.ts` (orphan-and-continue pattern protects against
  the original deadlock that capped us at 2).

## Alternatives to evaluate (TODO)

These are the per-Ryan options worth comparing against AirROI on cost +
data depth before committing AirROI as the long-term pricing source:

- **Bright Data** — previously evaluated for scraping. Re-check their
  current rental-data API products and PV-tier pricing.
- **Decodo** — already in use as the residential proxy for the GraphQL
  quote pipeline (`PROXY_URL`). Check whether they expose any
  rental-pricing API products directly (would cut a dependency layer).
- **AirDNA** — established short-term-rental analytics company. Likely
  has PV-market data; needs API tier pricing + data-depth comparison
  (rates, occupancy, ADR, fee breakdown).

Each of those needs the same Postman-style request capture done before
we can wire it in.

## Where this lives in the repo

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/ingest/airroi-adapter.ts` | the actual `fetch` + retry wrapper. Pure, no DB writes. |
| `scripts/src/airroi-pricing-refresh.ts` | CLI driver: select listings → call adapter → upsert into `rental_prices_by_date`. |
| `scripts/src/lib/concurrency.ts` | bounded worker pool with hard-kill timeout. |
| `lib/db/src/schema/rental_prices_by_date.ts` | target table for the per-day rows. |
| `lib/db/src/schema/rental_listings.ts` | source of `external_id` + `parent_region_bucket` for the cohort filter. |

## Script env vars (cheat sheet)

| Var | Default | Notes |
|---|---|---|
| `AIRROI_API_KEY` | — | required |
| `AIRROI_MAX_LISTINGS` | — | budget cap (e.g. `20`) |
| `AIRROI_CONCURRENCY` | `2` | parallel workers; safe up to `4` with the hard-timeout in place |
| `AIRROI_ID_LENGTHS` | (all) | comma list of acceptable `length(external_id)` values, e.g. `7,8,18` |
| `AIRROI_PARENT_REGIONS` | (all) | comma list, e.g. `puerto_vallarta` |
| `AIRROI_ORDER` | `stale` | `stale` \| `random` \| `id` |
| `DATABASE_URL` | — | required (Railway prod for this script) |
