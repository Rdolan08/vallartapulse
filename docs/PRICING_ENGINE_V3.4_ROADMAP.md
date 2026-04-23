# Pricing Engine v3.4 — Roadmap

**Owner:** Ricardo · **Status:** Drafted Apr 22, 2026 · **Target:** Phase 0 by Apr 28, 2026; Phase 3 by ~Jun 3, 2026

---

## Why v3.4

The engine is layered, explainable, and ships explicit diagnostics — that's the differentiator. v3.4 turns those diagnostics into **calibration leverage** without breaking the live endpoint. The work is sequenced so each phase is independently shippable and provably better than the previous baseline.

The Apr 28 Airbnb-pricing unlock is the single highest-leverage milestone on the roadmap because it changes both **coverage** (more priced comps per query) and **freshness** (less reliance on static fallback) the moment those rows land.

---

## Current Baseline (as of Apr 22, 2026)

- Comp price selector — **v1**: rank 1 = `rental_prices_by_date` (pvrpv_daily), rank 2 = static fallback from `rental_listings.nightly_price_usd`. `listing_price_quotes` is **not** used in comp-pool selection in v1.
- Aggregation — **unweighted median** with a freshness penalty applied as a multiplier on the result, not as a per-comp weight.
- Premiums (view, finish, rooftop, plunge, terrace, beachfront) — **hardcoded constants** in code, applied multiplicatively in a known order.
- Confidence — labeled and returned in the response; **not yet used to dampen** non-core premiums.
- Outcomes — recommendations are **not logged** in a backtest-ready table.
- Forward-demand recommendation (shipped, manual-only) — independent of the comp engine; v3.4 does not modify it.

---

## Phase 0 — Wire Airbnb daily price into comp selection (≤ 1 day; gated on data landing)

**Trigger:** first batch of Airbnb priced rows confirmed in `rental_prices_by_date` (or equivalent table once the scraper writes its first successful run).

**Change:**
- Insert `airbnb_daily` as **rank 1.5** in `selectCompPriceSources` — ahead of the static fallback, peer to `pvrpv_daily`.
- Source-mix is exposed in `summary.composition.airbnb_baseline` already; add a sibling `airbnb_priced` counter so dashboards can distinguish.
- No math change. Just one more priced source feeding the same unweighted median.

**Success metric:** `summary.composition.priced_share` (= priced rows ÷ pool size) goes up; `static_share` goes down. Track in the `/health/pricing-tool` signal.

**Risk control:** ship behind a per-neighborhood toggle for the first 48 hours; default on once the first day's source-mix telemetry looks clean.

---

## Phase 1 — Freshness/source-weighted aggregation (1–2 weeks)

**Change:**
- Replace unweighted median with a **freshness-weighted median** when `pool_size >= 6`.
- Per-comp weight = `priceFreshnessWeight × sourceWeight`. `priceFreshnessWeight` already exists. `sourceWeight` initial values: `airbnb_priced = 1.0`, `pvrpv_daily = 1.0`, `airbnb_baseline = 0.6`, `static_fallback = 0.4`.
- Thin pools (`< 6`) keep the current unweighted method as fallback. No change for them.

**Shadow rollout:**
- Compute both methods, return both in the response (`recommended_price` and `recommended_price_weighted_shadow`) for 7 days. Log the delta.
- Flip the headline to weighted only after the shadow delta stabilizes within ±5% on at least 80% of high-confidence requests.

**Success metric:** weighted-vs-unweighted delta is small in median (low overall drift) but **directionally correct** on segments where the source mix is skewed (e.g. ZR with high static share should move down slightly).

---

## Phase 2 — DB-backed calibration tables for premiums (2–4 weeks)

**Change:**
- New table `pricing_calibration_premiums` keyed by `(neighborhood, bedroom_bucket, season_regime, feature_key)` → `multiplier`.
- Move hardcoded constants (view, rooftop, plunge, terrace, finish, beachfront) into rows.
- Code reads from a cached view, falls back to current hardcoded constants if a row is missing — **never** breaks live pricing on a missing calibration entry.
- Monthly calibration job populates the table from realized comp distributions, **not** code patches.

**Out of scope for v3.4:** auto-tuning. Phase 2 just gives operators a safe place to edit premiums without shipping code; the auto-fit job is v3.5.

**Success metric:** number of premium edits shipped via DB write rather than code patch; zero regressions on the existing live endpoint.

---

## Phase 3 — Backtesting framework + release gating (4–6 weeks)

**Change:**
- New table `pricing_recommendation_log` — one row per quote returned: timestamp, request hash, returned price + bands, comp IDs used, confidence score, source-mix composition, model version.
- Join later to realized outcomes (booking lead time, occupancy proxy, revenue proxy from `listing_price_quotes` and calendar data).
- Backtest runner under `scripts/backtest/` produces a comparison table: current model vs simpler baseline (segment median) vs one variant at a time.
- **Release gate:** no coefficient or weight change ships to live unless it beats the baseline on the targeted segment in the offline backtest.

**Success metric:** at least one coefficient change shipped *because* the backtest justified it; at least one tuning idea *rejected* because the backtest contradicted it.

---

## Hygiene — Seasonality multiplier doc/runtime sync (parallel to Phase 0)

Single source of truth for monthly seasonality multipliers. Move all constants to one module, generate the README/comments from that module, and add a typecheck-time assertion that `pv-seasonality.ts` and `computeSeasonalSweep` agree. Tracked in its own issue.

---

## Sequencing & Dependencies

```
                                                  ┌─ shadow week ─┐
Hygiene  ─────────────────────────────────────────┤
                                                  │
Phase 0  ──▶ Phase 1 weighted shadow  ──▶ Phase 1 cutover
   ▲                                              │
   │                                              ▼
   └─ gated on first Airbnb priced rows in DB    Phase 2 calibration tables
                                                              │
                                                              ▼
                                                       Phase 3 backtesting
                                                            + release gate
```

- Phase 0 unblocks Phase 1 — weighting is only meaningful once a real `airbnb_priced` source exists.
- Phase 2 is independently shippable but is more useful after Phase 1 (so calibration changes can be measured against weighted output).
- Phase 3 is independently shippable but most valuable last, when there are real changes to gate.

---

## Out of Scope for v3.4

- Forward-demand v2 (event registry expansion beyond Tier 1, auto-apply, etc.) — separate track.
- Stay vs Rent v1.1 copy refinement and range display — tracked in #21.
- Elevator amenity scoring bug — tracked in #22; fixed independently when root-caused.
- AirDNA integration as a macro prior — deferred until Phase 2 lands; AirDNA is calibration-layer input, not direct comp input.
- VRBO per-night pricing — current ingestion is synthetic fee/total modeling, not true daily calendar; revisit when discovery throughput improves.

---

## How to update this doc

This roadmap is the source of truth. When a phase ships, update its section to **Status: Shipped** with the commit SHA and the realized metric. When scope shifts, edit the phase here *first*, then update the corresponding GitHub issue.
