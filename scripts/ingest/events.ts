/**
 * Ingest data/events/market-events.csv → market_events.
 */
import { db } from "@workspace/db";
import { marketEventsTable } from "@workspace/db/schema";
import { sql } from "drizzle-orm";
import { resolve } from "node:path";
import { readCsv, str, bool } from "./_csv";

export const EVENTS_CSV = resolve(import.meta.dirname, "../../data/events/market-events.csv");

export async function ingestEvents(): Promise<{ inserted: number }> {
  const rows = readCsv(EVENTS_CSV);
  return db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE market_events RESTART IDENTITY`);
    if (rows.length === 0) return { inserted: 0 };
    await tx.insert(marketEventsTable).values(rows.map((r) => ({
      slug:                str(r.slug)!,
      title:               str(r.title)!,
      titleEs:             str(r.title_es)!,
      category:            str(r.category)!,
      severity:            str(r.severity)!,
      geography:           str(r.geography)!,
      startDate:           str(r.start_date)!,
      endDate:             str(r.end_date),
      peakImpactStart:     str(r.peak_impact_start),
      peakImpactEnd:       str(r.peak_impact_end),
      bookingShockStart:   str(r.booking_shock_start),
      bookingShockEnd:     str(r.booking_shock_end),
      recoveryWindowEnd:   str(r.recovery_window_end),
      confidence:          str(r.confidence)!,
      sourceType:          str(r.source_type)!,
      summary:             str(r.summary)!,
      summaryEs:           str(r.summary_es)!,
      expectedEffects:     str(r.expected_effects)!,
      recoveryPattern:     str(r.recovery_pattern)!,
      affectedMetrics:     str(r.affected_metrics) ?? "airport,tourism,pricing",
      anomalyWeightConfig: str(r.anomaly_weight_config),
      notes:               str(r.notes),
      isActive:            bool(r.is_active),
    })));
    return { inserted: rows.length };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestEvents().then((r) => { console.log("events:", r); process.exit(0); });
}
