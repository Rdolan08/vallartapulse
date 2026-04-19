/**
 * ingest/airbnb-graphql-quote-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Compile-only stub for the Airbnb reservation-flow (full-quote) GraphQL
 * adapter. See airbnb-graphql-pricing-adapter.ts for the same rationale —
 * the runner imports this module unconditionally, so esbuild needs it to
 * exist for the production bundle to build. Real implementation pending.
 */

export interface AirbnbQuoteResult {
  accommodationUsd: number | null;
  cleaningFeeUsd: number | null;
  serviceFeeUsd: number | null;
  taxesUsd: number | null;
  totalPriceUsd: number | null;
  staleSha: boolean;
}

export interface QuoteShaDiscoveryResult {
  sha: string;
  source: "cache" | "rediscovered";
}

const NOT_IMPLEMENTED =
  "airbnb-graphql-quote-adapter is not implemented in this build. " +
  "The reservation-flow GraphQL replay code has not landed yet. " +
  "Do not call /ingest/airbnb-pricing-refresh until this module is wired up.";

export async function fetchAirbnbQuote(
  _externalId: string,
  _sha: string,
  _opts: { checkin: string; checkout: string; guestCount: number },
): Promise<AirbnbQuoteResult> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function getOrDiscoverQuoteSha(
  _opts?: { forceRediscover?: boolean },
): Promise<QuoteShaDiscoveryResult> {
  throw new Error(NOT_IMPLEMENTED);
}
