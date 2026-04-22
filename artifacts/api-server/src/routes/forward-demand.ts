/**
 * routes/forward-demand.ts — v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Three endpoints:
 *
 *   POST /api/rental/forward-demand
 *     → Compute the per-night forward-demand recommendation for a request.
 *       Body: { neighborhood, check_in, check_out, comp_median }
 *       Returns the gate decision and (if it fires) the qualifying nights.
 *
 *   POST /api/rental/forward-demand/track-shown
 *     → Log that the recommendation panel rendered for a specific night.
 *       Body: { listing_id?, night_date, event_label, bucket,
 *               recommended_price, comp_median_at_show }
 *
 *   POST /api/rental/forward-demand/track-applied
 *     → Log that the operator clicked Apply on a specific night.
 *       Body: { observation_id, applied_at? }
 *
 * No pricing math. No comp-engine changes. Read-only relative to all
 * existing pricing surfaces.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { forwardDemandObservationsTable } from "@workspace/db/schema";
import { composeForwardDemand } from "../lib/forward-demand";

const router: IRouter = Router();

// ── POST /api/rental/forward-demand ──────────────────────────────────────
const ComposeBody = z.object({
  neighborhood: z.string().min(1),
  check_in: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  comp_median: z.number().positive(),
});

router.post("/rental/forward-demand", async (req, res) => {
  const parse = ComposeBody.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request", details: parse.error.flatten() });
  }
  const { neighborhood, check_in, check_out, comp_median } = parse.data;
  try {
    const result = composeForwardDemand(neighborhood, check_in, check_out, comp_median);
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, "forward-demand compose failed");
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/rental/forward-demand/track-shown ──────────────────────────
const TrackShownBody = z.object({
  listing_id: z.number().int().positive().nullable().optional(),
  night_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  event_label: z.string().min(1),
  bucket: z.enum(["early", "mid", "late", "very_late"]),
  recommended_price: z.number().positive(),
  comp_median_at_show: z.number().positive(),
});

router.post("/rental/forward-demand/track-shown", async (req, res) => {
  const parse = TrackShownBody.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request", details: parse.error.flatten() });
  }
  const body = parse.data;
  try {
    const inserted = await db
      .insert(forwardDemandObservationsTable)
      .values({
        listingId: body.listing_id ?? null,
        nightDate: body.night_date,
        eventLabel: body.event_label,
        bucket: body.bucket,
        recommendedPrice: body.recommended_price,
        compMedianAtShow: body.comp_median_at_show,
      })
      .returning({ id: forwardDemandObservationsTable.id });
    return res.json({ observation_id: inserted[0]?.id ?? null });
  } catch (err) {
    req.log.error({ err }, "forward-demand track-shown failed");
    // Tracking failures must not impact the user surface — return 200 with
    // a soft error so the UI doesn't render a failure state.
    return res.json({ observation_id: null, tracking_error: true });
  }
});

// ── POST /api/rental/forward-demand/track-applied ────────────────────────
const TrackAppliedBody = z.object({
  observation_id: z.number().int().positive(),
});

router.post("/rental/forward-demand/track-applied", async (req, res) => {
  const parse = TrackAppliedBody.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request", details: parse.error.flatten() });
  }
  try {
    await db
      .update(forwardDemandObservationsTable)
      .set({ recommendationApplied: sql`now()` })
      .where(
        and(
          eq(forwardDemandObservationsTable.id, parse.data.observation_id),
        ),
      );
    return res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "forward-demand track-applied failed");
    return res.json({ ok: false, tracking_error: true });
  }
});

export default router;
