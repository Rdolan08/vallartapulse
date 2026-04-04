import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty, reseedEconomicIfOutdated } from "./lib/seed";
import { seedAmenitiesLookup, seedRentalListings } from "./lib/rental-ingest";
import { startScheduler } from "./lib/ingest/sync-scheduler.js";
import { startDailySync } from "./lib/daily-sync.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

seedIfEmpty().catch((err) => {
  logger.error({ err }, "Seed failed — continuing anyway");
});

reseedEconomicIfOutdated().catch((err) => {
  logger.error({ err }, "Economic reseed failed — continuing anyway");
});

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
