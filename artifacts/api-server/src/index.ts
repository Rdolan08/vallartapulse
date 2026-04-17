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
  });
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup");
  process.exit(1);
});
