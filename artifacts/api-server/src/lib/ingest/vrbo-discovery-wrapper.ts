/**
 * ingest/vrbo-discovery-wrapper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2b composition wrapper for VRBO. Built for symmetry with the Airbnb
 * wrapper but INTENTIONALLY NOT WIRED INTO THE RUNNER YET — Phase 2b's first
 * live run is Airbnb-only per scope.
 *
 * Calling fetchVrboSeedBatch() throws unless `force: true` is passed, so
 * accidental invocation from the CLI cannot trigger live VRBO traffic.
 */

import type { DiscoverySeed } from "./seed-generator.js";
import type { AirbnbBatch } from "./airbnb-discovery-wrapper.js";

export type VrboBatch = AirbnbBatch;

export async function fetchVrboSeedBatch(
  _seed: DiscoverySeed,
  opts: { maxCards?: number; force?: boolean } = {}
): Promise<VrboBatch> {
  if (!opts.force) {
    throw new Error(
      "fetchVrboSeedBatch: VRBO live discovery is intentionally disabled in " +
        "Phase 2b until the Airbnb path is verified end-to-end. Pass {force:true} " +
        "to override (not recommended in this session)."
    );
  }
  // Future: thin wrapper around the existing vrbo-search-adapter.ts. Same
  // shape as fetchAirbnbSeedBatch — one batch per call, block detection, etc.
  throw new Error("fetchVrboSeedBatch: not implemented — see Phase 2b notes.");
}
