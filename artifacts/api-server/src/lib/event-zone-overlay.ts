/**
 * event-zone-overlay.ts — Phase B (explanatory only)
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers for resolving the per-night zone (neighborhood) multiplier
 * candidate from an EventOverlay rule + a normalized neighborhood key, and
 * for enriching a Phase A EventAudit with the resulting zone candidate fields
 * for visibility in the API response.
 *
 * IMPORTANT — This module is EXPLANATORY ONLY in Phase B.
 *
 * Nothing in this file is read by the pricing math. The values produced here
 * appear in the API response under `seasonal.event_audit.nights[].zone_multiplier`
 * and `seasonal.event_audit.zone_avg_multiplier_candidate`, and are intended
 * purely for:
 *   1. operator visibility ("if zones were applied, what would they say?"),
 *   2. future empirical calibration (compare to actual observed deltas).
 *
 * The structural double-count question between the comp engine and a zone
 * uplift is NOT yet resolved. Activating zone math against price requires
 * empirical M_event_avg derived from Airbnb pricing history and is reserved
 * for a future phase.
 *
 * KNOWN LIMITATIONS (intentional in Phase B):
 *   • Multiple same-night events resolve by Phase A priority — no stacking.
 *   • Zone seeds are sparse (Pride PV + Bear Week / Beef Dip only) and
 *     conservative. They are NOT calibrated from observed market data.
 *   • Property-type adjustments are schema-only and ignored.
 *   • Per-night zone clamps to [EVENT_ZONE_MIN, EVENT_ZONE_MAX] purely for
 *     defense — the seed values are already inside the band.
 */

import {
  PV_EVENT_OVERLAYS,
  type EventOverlay,
  type EventAudit,
  type EventOverlayNightAudit,
} from "./pv-seasonality";

// ── Bounds ───────────────────────────────────────────────────────────────────
// Defensive clamps around the per-night zone multiplier and the stay-window
// final overlay candidate. None of these affect price in Phase B.
export const EVENT_ZONE_MIN = 0.95;
export const EVENT_ZONE_MAX = 1.40;
export const EVENT_ZONE_MULTIPLIER_CAP = 2.0;

/** A single audit night enriched with the Phase B zone candidate. */
export interface EventOverlayNightAuditEnriched extends EventOverlayNightAudit {
  /** Multiplier for the matched event in the request's neighborhood. 1.0 if no
   *  matching zone rule. NOT applied to price in Phase B. */
  zone_multiplier: number;
  /** multiplier_applied × zone_multiplier (capped). NOT applied to price in Phase B. */
  final_night_multiplier: number;
}

/** Audit + stay-level zone candidate fields. */
export interface EventAuditEnriched extends Omit<EventAudit, "nights"> {
  pricing_mode: "legacy_event_only";
  applied_neighborhood_key: string | null;
  nights: EventOverlayNightAuditEnriched[];
  /** Average of `multiplier_applied` across all nights. Same as Phase A semantics. */
  event_avg_multiplier: number;
  /** Average of `zone_multiplier` across all nights. Candidate only — NOT applied. */
  zone_avg_multiplier_candidate: number;
  /** Average of `final_night_multiplier` across all nights, capped. Candidate only. */
  final_overlay_multiplier_candidate: number;
}

/**
 * Resolve the zone multiplier for one night.
 * Returns 1.0 (neutral) when:
 *   • no event matched that night, OR
 *   • no neighborhood key was supplied, OR
 *   • the matching event has no eventImpactZones, OR
 *   • the request's neighborhood isn't listed in the event's zones.
 */
export function resolveNightZoneMultiplier(params: {
  eventKey: string | null | undefined;
  neighborhoodKey: string | null | undefined;
  eventRules?: readonly EventOverlay[];
}): number {
  const rules = params.eventRules ?? PV_EVENT_OVERLAYS;
  if (!params.eventKey || !params.neighborhoodKey) return 1.0;
  const rule = rules.find((r) => r.key === params.eventKey);
  if (!rule || !rule.eventImpactZones || rule.eventImpactZones.length === 0) return 1.0;
  const zone = rule.eventImpactZones.find((z) => z.neighborhoodKey === params.neighborhoodKey);
  if (!zone) return 1.0;
  return Math.min(EVENT_ZONE_MAX, Math.max(EVENT_ZONE_MIN, zone.multiplier));
}

/**
 * Enrich a Phase A EventAudit with per-night zone candidates and stay-level
 * averages. The returned object adds Phase B fields without touching the
 * Phase A `multiplier_applied` semantics.
 *
 * If `audit` is null (month-only request) the caller should not invoke this
 * helper — there is nothing to enrich.
 */
export function enrichAuditWithZoneCandidate(params: {
  audit: EventAudit;
  neighborhoodKey: string | null | undefined;
  eventRules?: readonly EventOverlay[];
}): EventAuditEnriched {
  const { audit, neighborhoodKey } = params;
  const rules = params.eventRules ?? PV_EVENT_OVERLAYS;

  const enrichedNights: EventOverlayNightAuditEnriched[] = audit.nights.map((n) => {
    const zoneMult = resolveNightZoneMultiplier({
      eventKey: n.matched_event_key,
      neighborhoodKey,
      eventRules: rules,
    });
    const rawFinal = n.multiplier_applied * zoneMult;
    const finalNight = Math.min(EVENT_ZONE_MULTIPLIER_CAP, rawFinal);
    return {
      ...n,
      zone_multiplier: parseFloat(zoneMult.toFixed(4)),
      final_night_multiplier: parseFloat(finalNight.toFixed(4)),
    };
  });

  const N = enrichedNights.length || 1;
  const sumEvent = enrichedNights.reduce((s, n) => s + n.multiplier_applied, 0);
  const sumZone = enrichedNights.reduce((s, n) => s + n.zone_multiplier, 0);
  const sumFinal = enrichedNights.reduce((s, n) => s + n.final_night_multiplier, 0);

  return {
    schema_version: audit.schema_version,
    pricing_mode: "legacy_event_only",
    applied_neighborhood_key: neighborhoodKey ?? null,
    nights: enrichedNights,
    event_avg_multiplier: parseFloat((sumEvent / N).toFixed(4)),
    zone_avg_multiplier_candidate: parseFloat((sumZone / N).toFixed(4)),
    final_overlay_multiplier_candidate: parseFloat(
      Math.min(EVENT_ZONE_MULTIPLIER_CAP, sumFinal / N).toFixed(4),
    ),
  };
}
