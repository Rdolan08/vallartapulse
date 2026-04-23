/**
 * scripts/src/airbnb-quote-test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DB-free single-listing quote tester. Calls the production
 * fetchAirbnbQuote() adapter directly so we can debug bot detection,
 * sidebar rendering, and parser regressions WITHOUT needing
 * RAILWAY_DATABASE_URL or the cohort-selection query.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx ./src/airbnb-quote-test.ts \
 *     <externalId> [checkin=YYYY-MM-DD] [checkout=YYYY-MM-DD] [guests=2]
 *
 * Examples:
 *   # Test the known-live MarshmallowTown listing for Jun 20-22:
 *   pnpm --filter @workspace/scripts exec tsx ./src/airbnb-quote-test.ts \
 *     53116610 2026-06-20 2026-06-22 2
 *
 *   # Default dates = today+30 / today+32, guests=2:
 *   pnpm --filter @workspace/scripts exec tsx ./src/airbnb-quote-test.ts 53116610
 *
 * Output: JSON with the full AirbnbQuoteResult including any errors AND
 * the dump file paths written to /tmp on failure.
 */

import {
  fetchAirbnbQuote,
  getOrDiscoverQuoteSha,
  shutdownQuoteBrowser,
} from "../../artifacts/api-server/src/lib/ingest/airbnb-graphql-quote-adapter.js";

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultCheckin(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 30);
  return fmtDate(d);
}

function defaultCheckout(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 32);
  return fmtDate(d);
}

async function main(): Promise<number> {
  const [externalId, checkinArg, checkoutArg, guestsArg] = process.argv.slice(2);
  if (!externalId) {
    console.error("usage: airbnb-quote-test.ts <externalId> [checkin] [checkout] [guests]");
    return 1;
  }
  const checkin = checkinArg || defaultCheckin();
  const checkout = checkoutArg || defaultCheckout();
  const guestCount = guestsArg ? Math.max(1, Number.parseInt(guestsArg, 10) || 2) : 2;

  console.log(
    JSON.stringify({
      event: "quote-test.start",
      externalId,
      checkin,
      checkout,
      guestCount,
      ts: new Date().toISOString(),
    }),
  );

  let sha = "";
  try {
    const discovery = await getOrDiscoverQuoteSha();
    sha = discovery.sha;
  } catch (err) {
    // The DOM-scrape adapter doesn't actually use the SHA, but the runner
    // contract requires one. If discovery throws, just pass an empty string.
    console.error(
      "WARN: getOrDiscoverQuoteSha failed (non-fatal for DOM scrape):",
      err instanceof Error ? err.message : String(err),
    );
  }

  const t0 = Date.now();
  const result = await fetchAirbnbQuote(externalId, sha, { checkin, checkout, guestCount });
  const elapsedMs = Date.now() - t0;

  console.log(
    JSON.stringify(
      { event: "quote-test.done", elapsedMs, result },
      null,
      2,
    ),
  );

  return result.totalPriceUsd !== null ? 0 : 2;
}

main()
  .then(async (code) => {
    await shutdownQuoteBrowser().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    await shutdownQuoteBrowser().catch(() => {});
    process.exit(1);
  });
