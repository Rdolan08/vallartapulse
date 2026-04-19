/**
 * In-process tracker for the last successful `/api/rental/comps` call.
 *
 * Powers `GET /api/health/pricing-tool` so the `/sources` dashboard and
 * the daily smoke workflow can both see whether the pricing tool is
 * reachable end-to-end (SPA host → Vercel rewrite → Railway API → comps
 * engine). The tracker is intentionally process-local: the smoke
 * workflow runs at least once a day, which is the same cadence as a
 * Railway redeploy/restart, so a missing timestamp after a restart is
 * indistinguishable from "no smoke check has run yet" — which the
 * health endpoint reports as `warn` until the next cron tick.
 *
 * Stored as ISO-8601 UTC strings so it can be returned verbatim.
 */

let lastSuccessAt: string | null = null;

export function recordPricingToolSuccess(now: Date = new Date()): void {
  lastSuccessAt = now.toISOString();
}

export function getLastPricingToolSuccess(): string | null {
  return lastSuccessAt;
}
