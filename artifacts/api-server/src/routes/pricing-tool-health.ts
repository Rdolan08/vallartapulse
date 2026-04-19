/**
 * GET /api/health/pricing-tool
 * ─────────────────────────────────────────────────────────────────────────
 * Uptime probe for the pricing tool's end-to-end path: SPA host →
 * Vercel /api/* rewrite → Railway API → comps engine. Powers the
 * "Pricing tool" tile on /sources alongside the Airbnb / VRBO / VV
 * dark-pipeline cards.
 *
 * Signal source: in-process `lastSuccessAt` updated by the
 * /api/rental/comps handler whenever it returns 200. The daily
 * `pricing-tool-smoke.yml` workflow guarantees at least one successful
 * call per 24h under healthy conditions, so a stale timestamp is a
 * direct indicator of a regression like the Vercel /api/* misroute that
 * has bitten this page twice.
 *
 * Thresholds (tuned to the daily smoke cadence):
 *   - lastSuccessAt within  36h → ok
 *   - lastSuccessAt within   7d → warn
 *   - older / null              → fail
 *
 * Response shape mirrors the other freshness endpoints
 * ({ alertLevel, alertReason, lastSuccessAt }) so the dashboard renders
 * it through the same `PipelineHealthCard`.
 */

import { Router, type IRouter } from "express";
import { getLastPricingToolSuccess } from "../lib/pricing-tool-uptime";

const router: IRouter = Router();

const WARN_AFTER_MS = 36 * 60 * 60 * 1000; // 36 hours
const FAIL_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

router.get("/health/pricing-tool", (_req, res) => {
  const lastSuccessAt = getLastPricingToolSuccess();
  const now = Date.now();

  let alertLevel: "ok" | "warn" | "fail" = "fail";
  let alertReason = "";

  if (!lastSuccessAt) {
    alertLevel = "warn";
    alertReason =
      "No successful /api/rental/comps call observed since this API process started. " +
      "Waiting for the next smoke check (runs daily and on every Vercel deploy).";
  } else {
    const ageMs = now - new Date(lastSuccessAt).getTime();
    if (ageMs <= WARN_AFTER_MS) {
      alertLevel = "ok";
    } else if (ageMs <= FAIL_AFTER_MS) {
      alertLevel = "warn";
      const hours = Math.round(ageMs / (60 * 60 * 1000));
      alertReason = `No successful comps call in ${hours}h — daily smoke check may have failed once.`;
    } else {
      alertLevel = "fail";
      const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
      alertReason =
        `No successful /api/rental/comps call in ${days}d. The pricing-tool ` +
        `pipeline (Vercel /api/* → Railway → comps engine) is likely broken — ` +
        `check the pricing-tool-smoke workflow and any open pricing-tool-dark issues.`;
    }
  }

  res.json({
    alertLevel,
    alertReason,
    lastSuccessAt,
  });
});

export default router;
