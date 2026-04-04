/**
 * daily-sync.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Schedules an automatic daily refresh of all data sources at 8:00 AM Eastern.
 * Uses node-cron with America/New_York timezone so the job respects EST/EDT
 * transitions automatically.
 *
 * Cron expression: "0 8 * * *"
 *   ┌── minute    (0)
 *   │ ┌── hour    (8 = 8 AM)
 *   │ │ ┌── day   (* = every day)
 *   │ │ │ ┌── month
 *   │ │ │ │ ┌── weekday
 *   0 8 * * *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import cron from "node-cron";
import { syncAllSources } from "./source-sync.js";
import { logger } from "./logger.js";

export function startDailySync(): void {
  const expression = "0 8 * * *";
  const timezone   = "America/New_York";

  cron.schedule(
    expression,
    async () => {
      logger.info("Daily data-source sync starting (8:00 AM Eastern)");
      try {
        const result = await syncAllSources();
        logger.info(
          {
            syncedAt:     result.syncedAt,
            totalSources: result.totalSources,
            sources:      result.results.map((r) => ({
              name:    r.name,
              records: r.records,
              recount: r.recount,
            })),
          },
          "Daily sync complete"
        );
      } catch (err) {
        logger.error({ err }, "Daily data-source sync failed");
      }
    },
    { timezone }
  );

  // Log next scheduled run.
  // We determine ET hour directly via Intl to avoid the "locale string → Date"
  // timezone-stripping bug. node-cron handles the actual trigger time correctly.
  const now = new Date();
  const etHour = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false }).format(now),
    10
  );
  // If it's already past 8 AM ET, next fire is tomorrow; otherwise today.
  const daysAhead = etHour >= 8 ? 1 : 0;
  const nextRun = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  logger.info(
    {
      schedule:  `${expression} (${timezone})`,
      nextRunET: nextRun.toLocaleString("en-US", {
        timeZone: timezone,
        weekday: "long",
        month:   "long",
        day:     "numeric",
        year:    "numeric",
      }) + " at 8:00 AM Eastern",
    },
    "Daily data-source sync scheduled"
  );
}
