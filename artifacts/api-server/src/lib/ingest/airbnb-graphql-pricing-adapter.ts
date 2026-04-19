/**
 * ingest/airbnb-graphql-pricing-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Compile-only stub for the Airbnb PdpAvailabilityCalendar GraphQL adapter.
 *
 * The runner (airbnb-pricing-runner.ts) and the routes that wire it up
 * import this module unconditionally, so the production bundle (esbuild)
 * cannot ship without it. The full implementation has not landed yet —
 * this stub exists so the API server build passes and Railway can deploy
 * every other route. Calling any function here throws a clear runtime
 * error so an operator sees exactly why the daily pricing pipeline is
 * inert, instead of getting silent corruption.
 */

export interface AirbnbGraphqlDay {
  date: string;
  available: boolean;
  nightlyPriceUsd: number | null;
}

export interface AirbnbGraphqlCalendarResult {
  days: AirbnbGraphqlDay[];
  daysReturned: number;
  daysWithPrice: number;
  staleSha: boolean;
  errors: string[];
}

export interface ShaDiscoveryResult {
  sha: string;
  source: "cache" | "rediscovered";
}

const NOT_IMPLEMENTED =
  "airbnb-graphql-pricing-adapter is not implemented in this build. " +
  "The PdpAvailabilityCalendar GraphQL replay code has not landed yet. " +
  "Do not call /ingest/airbnb-pricing-refresh until this module is wired up.";

export async function fetchAirbnbCalendarGraphql(
  _externalId: string,
  _sha: string,
  _opts: { today: Date },
): Promise<AirbnbGraphqlCalendarResult> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function getOrDiscoverSha(
  _opts?: { forceRediscover?: boolean },
): Promise<ShaDiscoveryResult> {
  throw new Error(NOT_IMPLEMENTED);
}
