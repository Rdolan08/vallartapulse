# Pride 2026 calibration — observation series

Read-only forward-calendar measurement of host pricing in `rental_prices_by_date` for Pride 2026 (May 20-28). Each JSON file in this folder is one snapshot from `scripts/calibration/pride-2026-pre-post.ts`.

## What this is

A trend-monitoring series. The script does not change pricing behavior, multipliers, event rules, or any production logic. It only SELECTs raw `nightly_price_usd` from production and saves the result.

The query shape is **frozen at v1.0.0** so snapshots are directly comparable across checkpoints. If a different measurement is needed, write a new script — do not edit window dates, hood definitions, or filter predicates in the existing one.

## Running a checkpoint

```bash
pnpm --filter @workspace/scripts calibrate:pride
```

Requires `RAILWAY_DATABASE_URL` in the environment.

Each run writes one timestamped JSON file here and prints a console table. Commit the JSON file alongside any other repo changes from that day.

## Schedule

Today (Apr 22, 2026) is **T-28** from Pride core.

| Checkpoint | Date       | Why |
|-----------:|:-----------|:----|
| T-28       | Apr 22     | Baseline — most hosts have not yet event-priced |
| T-21       | May 1      | First signal whether host adjustments have started |
| T-14       | May 8      | Inside the dynamic-pricer adjustment window |
| T-7        | May 13     | Should show full pricing if events drive any host behavior in PV |
| T-2        | May 18     | Pride eve |
| Mid        | May 24     | Pride midpoint |
| Post       | May 30     | Immediate post-Pride |
| T+14       | Jun 11     | Retrospective — May 2026 becomes proper historical truth |

Trajectory across these eight points matters far more than any single snapshot.

## Windows (frozen)

All windows are 9 nights, Wed-Thu, with one full Fri-Sun weekend. Pre and post controls are exactly 14 days from Pride core in each direction.

- **1_pre**: 2026-05-06 → 2026-05-14
- **2_pride**: 2026-05-20 → 2026-05-28 *(Pride core)*
- **3_post**: 2026-06-03 → 2026-06-11

The post-control unavoidably spills into early June: Pride ends May 28 and only May 29-31 remain in May, too short for a matched 9-night control inside May.

## Hood diagnostics (frozen)

- **ZR + Old Town** — primary diagnostic; combines `Zona Romantica` and `Old Town` listings (Old Town is treated as a ZR alias in production)
- **Zona Romantica only** — secondary; pure ZR for comparison against the combined bucket
- **Amapas** — adjacent hood with mid-strength Pride zone seed
- **Marina Vallarta** — negative control; no Pride zone seed expected

Note: `Marina Vallarta` typically has very few listings priced this far forward (n≈3 at T-28). Treat its medians as noise until sample density grows.

## Per-row metrics

For each (hood × window):
- `listing_count`, `nightly_row_count`
- `median`, `p25`, `p75` of `nightly_price_usd`
- `exact_mapping_count`, `null_mapping_count` (neighborhood mapping confidence)

Plus per-hood:
- `pride_vs_pre_median_ratio`
- `pride_vs_post_median_ratio`

## How to read the trend

The hypothesis being tested: **does host pricing in PV develop a measurable Pride-week premium as the event approaches?**

- If `pride_vs_pre_median_ratio` for ZR+OT climbs from ≈1.00 at T-28 toward ≈1.10-1.15 by T-7, the +12% Phase A multiplier is corroborated by host behavior.
- If it stays ≈1.00 through T-7 and even T-2, the Phase A multiplier is not anchored in observed host pricing for the comp pool we measure.
- Amapas should track ZR's direction at lower magnitude. Marina should remain flat (negative control).

This is observation, not action. No pricing-engine changes will be made from this series without an explicit follow-up review of the full trajectory.
