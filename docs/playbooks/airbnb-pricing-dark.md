# Playbook: "Airbnb pricing has gone dark"

## When this fires

The daily `Airbnb Pricing Refresh` GitHub Action (`.github/workflows/airbnb-pricing-refresh.yml`)
emits a `::error::` and exits non-zero, **or** the freshness check
(`scripts/freshness.sh`, dashboard card on `/sources`) shows the
`Airbnb pricing` pipeline as RED.

On a `fail` verdict the workflow now also pushes notifications:

- **Slack** — if the `SLACK_WEBHOOK_URL` repo secret is configured, a
  message lands in the ops channel with the `alertReason`, run stats,
  and one-click links to this playbook and the failing run.
- **GitHub issue** — a single open issue labelled `airbnb-pricing-dark`
  is reused for the duration of an outage. The first failure opens it;
  subsequent daily failures comment on it instead of opening duplicates.
  Close the issue once a refresh succeeds.

The runner publishes a `summary.alertLevel ∈ {ok, warn, fail}` field —
`fail` means one of:

| Reason                                                         | What it means                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `All N listings failed`                                        | Every listing in today's cohort failed. Airbnb is blocking the proxy or the SHA is permanently dead. |
| `0 quotes written despite a non-empty cohort`                  | Calendar fetches "succeeded" but came back empty for everyone — usually a malformed payload from a fingerprint block. |
| `SHA rediscovered N times in one run` (N > 1)                  | The persisted-query hash rotated mid-run AND the freshly-discovered hash also went stale. The fallback SHA is being relied on. |
| Freshness: `Newest quote >2d old` / `>50% of cohort stale >14d` | Multiple cycles have failed silently. The pipeline has been dark for days. |

## First 10 minutes — triage

1. **Check the GH Actions step summary.** It will print
   `Verdict: fail — <reason>`, attempted/ok counts, quotes written, and the
   number of SHA rediscoveries.
2. **Hit the freshness endpoint** to see how bad it is across the whole
   cohort (not just today's 50-listing slice):
   ```bash
   curl -s "$RAILWAY_API_URL/api/ingest/airbnb-pricing-freshness" | jq
   ```
   Look at `listingsStale14d`, `newestQuoteAgeHours`, and `alertReason`.
3. **Inspect the database directly** for context across all sources:
   ```bash
   RAILWAY_DATABASE_URL=... ./scripts/freshness.sh prod
   ```
   The `Airbnb pricing — pass/fail verdict` block is the same signal,
   straight from `listing_price_quotes`.

## Diagnose by failure mode

### A) "All N listings failed" or "0 quotes written"

Most common cause: Airbnb has fingerprinted the Playwright SHA-discovery
session, or the residential proxy is no longer resolving `www.airbnb.com`.

1. Re-run the workflow manually with `max_listings: 5` for a quick canary.
2. If still failing: pull the per-listing errors out of the response —
   the API returns `listings[].error` (truncated to 200 chars). Common
   strings:
   - `403`, `429`, `bot`, `captcha` → fingerprint blocked. Rotate the
     Playwright user-agent / viewport / proxy session id in
     `airbnb-graphql-pricing-adapter.ts`.
   - `ENOTFOUND`, `proxy`, `tunnel` → residential proxy is down. Check
     the proxy provider dashboard before touching code.
   - `staleSha` on every listing → see (B).

### B) "SHA rediscovered N times in one run"

The persisted-query SHA rotates roughly every few months. If rediscovery
runs more than once per refresh, the discovered SHA is itself going
stale within minutes — Airbnb is shadow-banning the discovery session.

1. Force a fresh discovery by hand (Railway shell):
   ```
   curl -X POST localhost:$PORT/api/ingest/airbnb-pricing-refresh \
     -H "X-Internal-Token: $INTERNAL_TRIGGER_TOKEN" \
     -d '{"maxListings":1}'
   ```
2. If the single-listing canary also returns `staleSha`, the hard-coded
   fallback SHA in `airbnb-graphql-pricing-adapter.ts` is also dead.
   Update it from a fresh browser-recorded request and ship.

### C) Freshness RED but today's run was OK

The runner only processes 50 stale-first listings per day, so a recent
green run does not mean the whole cohort is fresh. If `listingsStale14d`
is large but `alertLevel: "ok"`:

1. Bump `max_listings` for a few cycles (workflow_dispatch input).
2. Confirm the cohort filter still matches what you expect — the runner
   filters to `is_active = true AND external_id ~ '^[0-9]+$'` and any
   recent change to `rental_listings` activation logic could orphan a
   batch.

## Verifying recovery

After a fix:

1. Re-run `airbnb-pricing-refresh.yml` via `workflow_dispatch`.
2. The step summary should print `Verdict: ok` and a non-zero `Quotes
   written` count.
3. Within 24h, `/api/ingest/airbnb-pricing-freshness` should return
   `alertLevel: "ok"` and `newestQuoteAgeHours < 30`.
4. The Sources page card "Airbnb pricing pipeline" should flip back to
   green.

## Related files

- `artifacts/api-server/src/lib/ingest/airbnb-pricing-runner.ts` — produces `summary.alertLevel`
- `artifacts/api-server/src/lib/ingest/airbnb-graphql-pricing-adapter.ts` — SHA discovery + fallback
- `artifacts/api-server/src/routes/ingest.ts` — `/ingest/airbnb-pricing-freshness` endpoint
- `scripts/freshness.sh` — the `listing_price_quotes` block
- `.github/workflows/airbnb-pricing-refresh.yml` — pass/fail gate
- `artifacts/pv-datastore/src/pages/sources.tsx` — dashboard card
