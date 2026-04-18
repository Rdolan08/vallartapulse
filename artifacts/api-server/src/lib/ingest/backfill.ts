/**
 * ingest/backfill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Idempotent backfill for the existing rental_listings rows so that the
 * Phase 1 lifecycle / identity / pricing-tool-bucket columns are populated.
 *
 * Rules:
 *   • first_seen_at  ← scraped_at  (only if NULL)
 *   • last_seen_at   ← scraped_at  (only if NULL)
 *   • seen_count     ← 1            (only if NULL or 0)
 *   • lifecycle_status ← 'active'   (only if NULL)
 *   • identity_key   ← computeIdentityKey(...)  (only if NULL)
 *   • parent_region_bucket / normalized_neighborhood_bucket /
 *     neighborhood_mapping_confidence ← mapToPricingToolBucket(neighborhood_raw)
 *     (only if currently NULL)
 *
 * No business-critical column is overwritten; every UPDATE uses COALESCE/IS NULL
 * guards so the script is safe to re-run any number of times.
 */

import { db } from "@workspace/db";
import { rentalListingsTable } from "@workspace/db/schema";
import { sql, eq } from "drizzle-orm";
import { computeIdentityKey } from "./identity.js";
import { mapToPricingToolBucket } from "../neighborhood-buckets.js";

export interface BackfillReport {
  scanned: number;
  updated: number;
  alreadyComplete: number;
  identityKeyAssigned: number;
  bucketsAssigned: number;
  unmappedNeighborhoods: number;
  byConfidence: Record<string, number>;
  byParentRegion: Record<string, number>;
  examplesUnmapped: string[];
}

export async function runBackfill(opts: {
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<BackfillReport> {
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? 10_000;

  const rows = await db
    .select({
      id: rentalListingsTable.id,
      sourcePlatform: rentalListingsTable.sourcePlatform,
      sourceUrl: rentalListingsTable.sourceUrl,
      externalId: rentalListingsTable.externalId,
      neighborhoodRaw: rentalListingsTable.neighborhoodRaw,
      scrapedAt: rentalListingsTable.scrapedAt,
      firstSeenAt: rentalListingsTable.firstSeenAt,
      lastSeenAt: rentalListingsTable.lastSeenAt,
      seenCount: rentalListingsTable.seenCount,
      lifecycleStatus: rentalListingsTable.lifecycleStatus,
      identityKey: rentalListingsTable.identityKey,
      parentRegionBucket: rentalListingsTable.parentRegionBucket,
      normalizedNeighborhoodBucket: rentalListingsTable.normalizedNeighborhoodBucket,
      neighborhoodMappingConfidence: rentalListingsTable.neighborhoodMappingConfidence,
    })
    .from(rentalListingsTable)
    .limit(limit);

  const report: BackfillReport = {
    scanned: rows.length,
    updated: 0,
    alreadyComplete: 0,
    identityKeyAssigned: 0,
    bucketsAssigned: 0,
    unmappedNeighborhoods: 0,
    byConfidence: {},
    byParentRegion: {},
    examplesUnmapped: [],
  };

  for (const row of rows) {
    const needsLifecycle =
      row.firstSeenAt == null ||
      row.lastSeenAt == null ||
      row.seenCount == null ||
      (row.seenCount ?? 0) === 0 ||
      row.lifecycleStatus == null;
    const needsIdentity = row.identityKey == null;
    const needsBucket =
      row.parentRegionBucket == null ||
      row.normalizedNeighborhoodBucket == null ||
      row.neighborhoodMappingConfidence == null;

    if (!needsLifecycle && !needsIdentity && !needsBucket) {
      report.alreadyComplete += 1;
      continue;
    }

    let identityKey: string | null = row.identityKey;
    if (needsIdentity) {
      try {
        identityKey = computeIdentityKey({
          source: row.sourcePlatform,
          externalId: row.externalId,
          sourceUrl: row.sourceUrl,
        });
      } catch {
        identityKey = null;
      }
    }

    const mapping = mapToPricingToolBucket(row.neighborhoodRaw);
    report.byConfidence[mapping.confidence] =
      (report.byConfidence[mapping.confidence] ?? 0) + 1;
    if (mapping.parentRegion) {
      report.byParentRegion[mapping.parentRegion] =
        (report.byParentRegion[mapping.parentRegion] ?? 0) + 1;
    }
    if (mapping.confidence === "unknown") {
      report.unmappedNeighborhoods += 1;
      if (report.examplesUnmapped.length < 10) {
        report.examplesUnmapped.push(row.neighborhoodRaw);
      }
    }

    if (dryRun) {
      report.updated += 1;
      if (needsIdentity && identityKey) report.identityKeyAssigned += 1;
      if (needsBucket && mapping.pricingToolBucket) report.bucketsAssigned += 1;
      continue;
    }

    const fallbackTs = row.scrapedAt ?? new Date();
    await db
      .update(rentalListingsTable)
      .set({
        firstSeenAt: sql`COALESCE(${rentalListingsTable.firstSeenAt}, ${fallbackTs})`,
        lastSeenAt: sql`COALESCE(${rentalListingsTable.lastSeenAt}, ${fallbackTs})`,
        seenCount: sql`CASE WHEN COALESCE(${rentalListingsTable.seenCount}, 0) = 0 THEN 1 ELSE ${rentalListingsTable.seenCount} END`,
        lifecycleStatus: sql`COALESCE(${rentalListingsTable.lifecycleStatus}, 'active')`,
        identityKey: identityKey
          ? sql`COALESCE(${rentalListingsTable.identityKey}, ${identityKey})`
          : rentalListingsTable.identityKey,
        parentRegionBucket: sql`COALESCE(${rentalListingsTable.parentRegionBucket}, ${mapping.parentRegion})`,
        normalizedNeighborhoodBucket: sql`COALESCE(${rentalListingsTable.normalizedNeighborhoodBucket}, ${mapping.pricingToolBucket})`,
        neighborhoodMappingConfidence: sql`COALESCE(${rentalListingsTable.neighborhoodMappingConfidence}, ${mapping.confidence})`,
        updatedAt: new Date(),
      })
      .where(eq(rentalListingsTable.id, row.id));

    report.updated += 1;
    if (needsIdentity && identityKey) report.identityKeyAssigned += 1;
    if (needsBucket && mapping.pricingToolBucket) report.bucketsAssigned += 1;
  }

  return report;
}
