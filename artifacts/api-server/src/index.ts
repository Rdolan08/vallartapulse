import app from "./app";
import { logger } from "./lib/logger";
import { seedIfEmpty, reseedEconomicIfOutdated, seed2026TourismData, seedUnemploymentRates, reseedTourismIfFake, repairDataSourceCounts, repairRentalMarketIfRandom, repairWeatherIfRandom, seedMarketEvents, repairAirportData, repairTourism2026Split, repairTourismCruiseData } from "./lib/seed";
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

repairAirportData().catch((err) => {
  logger.error({ err }, "Airport data repair failed — continuing anyway");
});

seedIfEmpty().catch((err) => {
  logger.error({ err }, "Seed failed — continuing anyway");
});

reseedEconomicIfOutdated().catch((err) => {
  logger.error({ err }, "Economic reseed failed — continuing anyway");
});

seed2026TourismData().catch((err) => {
  logger.error({ err }, "2026 tourism seed failed — continuing anyway");
});

repairTourism2026Split().catch((err) => {
  logger.error({ err }, "2026 tourism split repair failed — continuing anyway");
});

repairTourismCruiseData().catch((err) => {
  logger.error({ err }, "Tourism cruise data repair failed — continuing anyway");
});

seedUnemploymentRates().catch((err) => {
  logger.error({ err }, "Unemployment rate seed failed — continuing anyway");
});

reseedTourismIfFake().catch((err) => {
  logger.error({ err }, "Tourism seasonal reseed failed — continuing anyway");
});

repairDataSourceCounts().catch((err) => {
  logger.error({ err }, "Data source count repair failed — continuing anyway");
});

repairRentalMarketIfRandom().catch((err) => {
  logger.error({ err }, "Rental market repair failed — continuing anyway");
});

repairWeatherIfRandom().catch((err) => {
  logger.error({ err }, "Weather repair failed — continuing anyway");
});

seedMarketEvents().catch((err) => {
  logger.error({ err }, "Market events seed failed — continuing anyway");
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
