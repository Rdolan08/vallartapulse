import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty } from "./lib/seed";
import { seedAmenitiesLookup, seedRentalListings } from "./lib/rental-ingest";
import { startScheduler } from "./lib/ingest/sync-scheduler.js";
import { startDailySync } from "./lib/daily-sync.js";

const port = Number(process.env["PORT"] ?? "3001");

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${process.env["PORT"]}"`);
}

async function main(): Promise<void> {
  // Block on seed: the API must not serve traffic against an empty or
  // half-loaded database. If ingest fails here, we exit rather than silently
  // serving nothing.
  try {
    await seedIfEmpty();
  } catch (err) {
    logger.error({ err }, "Seed failed — refusing to start with empty/partial database");
    process.exit(1);
  }

  // Non-canonical seeds (rental listings, amenities lookup) are best-effort:
  // they operate on separate tables the CSV pipeline does not own.
  seedAmenitiesLookup().catch((err) => {
    logger.error({ err }, "Amenities lookup seed failed — continuing anyway");
  });

  seedRentalListings().catch((err) => {
    logger.error({ err }, "Rental listings seed failed — continuing anyway");
  });

  startScheduler().catch((err) => {
    logger.error({ err }, "Sync scheduler start failed — continuing anyway");
  });

  startDailySync();

  app.listen(port, "0.0.0.0", (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");

    // Pricing-tool uptime probe — fire ONE internal self-test against
    // /api/rental/comps shortly after the server starts listening, so the
    // in-process `lastSuccessAt` counter that powers /api/health/pricing-tool
    // is populated within seconds of a Railway redeploy. Without this, every
    // Railway redeploy resets the counter and the dashboard pill goes yellow
    // until the next daily smoke check (which is also the only thing that
    // updates it from outside). Best-effort only: a failure here is logged
    // but never crashes the server, since the daily smoke workflow will
    // still take over.
    //
    // Same minimal payload the GitHub smoke workflow uses, picked because
    // Zona Romantica + 2 BR / 2 BA / 300 m to beach always has a populated
    // comp pool under any seasonal load.
    setTimeout(() => {
      const url = `http://127.0.0.1:${port}/api/rental/comps`;
      const payload = {
        neighborhood_normalized: "Zona Romantica",
        bedrooms: 2,
        bathrooms: 2,
        distance_to_beach_m: 300,
      };
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((r) => {
          if (r.ok) {
            logger.info({ status: r.status }, "Pricing-tool startup self-test succeeded");
          } else {
            logger.warn({ status: r.status }, "Pricing-tool startup self-test returned non-2xx");
          }
        })
        .catch((selfTestErr) => {
          logger.warn({ err: selfTestErr }, "Pricing-tool startup self-test failed (best-effort, ignoring)");
        });
    }, 2000);
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
