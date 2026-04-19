# Comp Model Contract — v1

**Status:** Active. Locked 2026-04-19 alongside the T013 decision.
**Owner:** Comp engine (`artifacts/api-server/src/lib/comps-engine-v3.ts`)
plus the assembly layer
(`artifacts/api-server/src/lib/comps-pricing-source.ts`).

## Why this contract exists

Multiple data sources feed comp pricing — PVRPV (daily, full price +
availability), Airbnb (availability-only daily; per-night dollars
arriving later via the Mac mini scraper), Vacation Vallarta (seasonal
brackets), and the static `rental_listings.nightly_price_usd` snapshot
captured at discovery. Without an explicit selection rule the engine
silently mixes a 14-month-old static Airbnb price with a 24-hour-old
PVRPV daily quote — a bug that's hard to notice and very hard to undo
once owners start budgeting against the recommendations.

## Source priority (v1)

For each comp listing, the assembly layer picks **exactly one** nightly
price using the first rule that produces a value:

| Rank | Source                                 | Pulled from                    | Cadence    | v1 status |
|------|----------------------------------------|--------------------------------|------------|-----------|
| 1    | **PVRPV daily**                        | `rental_prices_by_date` (priced rows in the next 30–90 days) | daily 07:05 UTC | **PRIMARY** |
| 2    | **Static displayed price**             | `rental_listings.nightly_price_usd` | once at discovery, refreshed at enrichment | fallback |
| —    | ~~Airbnb daily (Mac scraper)~~         | `rental_prices_by_date` (Airbnb rows) | ~10-day rotation | **deferred** — comes online when the Mac scraper ships |
| —    | ~~Airbnb GraphQL replay~~              | n/a                            | n/a        | **REVERTED** (T013, 2026-04-19) |

**No source is mixed within a single listing's price.** A listing
either gets a PVRPV-daily price (rank 1) or its static fallback (rank
2). The selection is per-listing, not per-comp-set.

## Freshness weighting

Each candidate price is tagged with `observedAt` and converted to a
`freshnessWeight` in `[0, 1]` before being handed to the engine:

| Age (days) | Weight | Engine treatment |
|------------|--------|-------------------|
| ≤ 7        | 1.00   | full credit       |
| 8 – 30     | 0.50   | half credit       |
| 31 – 60    | 0.25   | quarter credit (warning logged) |
| > 60       | 0.00   | **dropped from comp pool** |

The `0.00` weight is a hard cut, not a soft penalty: stale comps don't
just get downweighted, they're removed from the pool. This is the
"never show old numbers" half of the freshness contract.

For v1 the weights are advisory metadata on each `CompsListingV2` —
the engine still computes an unweighted IQR-trimmed median over the
included pool. Weighted-median support is a follow-up (would require
changing how `CompsEngineV2` aggregates).

## Acceptance gates

A nightly price is admissible to the comp pool only if:

1. The chosen source yields a numeric value (`nightly_price_usd IS NOT NULL`).
2. The freshness weight is `> 0` (i.e. observation ≤ 60 days old).
3. The listing has the supporting fields the engine requires
   (`distance_to_beach_m`, `neighborhood_normalized`).

Listings that fail any gate are excluded from the pool **and**
counted in the `excludedReasons` map exposed in the route response so
the operator dashboard can surface "we have 508 Airbnb listings but
504 have no current pricing."

## Per-listing trace (response shape)

Each `CompsListingV2` in the engine is now augmented with:

```ts
priceSource: "pvrpv_daily" | "static_displayed";
priceObservedAt: string;   // ISO timestamp
priceFreshnessDays: number;
priceFreshnessWeight: 1.0 | 0.5 | 0.25 | 0.0;
```

These fields ride through the engine output untouched so callers
can render "PVRPV daily, observed 2 days ago" next to each comp.

## What this explicitly does NOT do (v1)

- Does **not** weight the comp engine's median by freshness — the
  pool is filtered, not weighted in the math. Weighted median is a v2
  concern.
- Does **not** read from `listing_price_quotes` — that table is
  populated by the Airbnb checkpoint generator and is currently empty
  in v1 since path 2 was reverted. Will be revisited when the Mac
  scraper writes per-quote rows.
- Does **not** consult the `airbnb_comp_signal` view yet — the view
  surfaces displayed observation drift, not comp-pool selection.
- Does **not** enforce a per-source quota (e.g. "at least 3 PVRPV
  comps"). Comp selection still runs whatever IQR + neighborhood +
  bedroom filters the engine already applies.

## When the Mac scraper lands

Add a third row above the static fallback:

```
Rank 1.5: Airbnb daily (Mac scraper) | rental_prices_by_date (airbnb rows) | ~10-day refresh
```

…and update the freshness table so 8–14 day Airbnb observations are
the expected steady-state rather than "stale." The contract here gets
revised in the same change.
