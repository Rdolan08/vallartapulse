/**
 * Run every ingestor in dependency order. Safe to run repeatedly.
 *
 *   pnpm --filter @workspace/scripts run ingest
 *
 * Order matters: data_sources record_counts depend on the metric tables,
 * so we ingest sources LAST.
 */
import { ingestAirport } from "./airport";
import { ingestTourism } from "./tourism";
import { ingestSafety } from "./safety";
import { ingestEconomic } from "./economic";
import { ingestWeather } from "./weather";
import { ingestEvents } from "./events";
import { ingestSources } from "./sources";

export async function ingestAll(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  for (const [name, fn] of [
    ["airport",  ingestAirport],
    ["tourism",  ingestTourism],
    ["safety",   ingestSafety],
    ["economic", ingestEconomic],
    ["weather",  ingestWeather],
    ["events",   ingestEvents],
    ["sources",  ingestSources],   // last — depends on counts above
  ] as const) {
    const start = Date.now();
    const { inserted } = await fn();
    const ms = Date.now() - start;
    results[name] = inserted;
    console.log(`✓ ${name.padEnd(9)} ${String(inserted).padStart(5)} rows (${ms}ms)`);
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestAll()
    .then((r) => { console.log("\nAll ingestors complete:", r); process.exit(0); })
    .catch((err) => { console.error("Ingest failed:", err); process.exit(1); });
}
