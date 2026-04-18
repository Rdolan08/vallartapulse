/**
 * ingest/identity.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Stable identity, dedup-aware upsert, and observation persistence for the
 * STR discovery pipeline (Phase 2a).
 *
 * Pure helpers (computeIdentityKey, canonicalizeUrl) have no I/O.
 * upsertListing / insertObservation talk to the @workspace/db layer.
 */

import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import {
  rentalListingsTable,
  listingSearchObservationsTable,
} from "@workspace/db/schema";
import { sql, eq } from "drizzle-orm";
import { mapToPricingToolBucket } from "../neighborhood-buckets.js";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface IdentityInput {
  source: string;
  externalId?: string | null;
  sourceUrl?: string | null;
}

/**
 * Stable cross-seed identity key.
 *   Preferred: "<source>:<external_id>"
 *   Fallback:  "<source>:url:<sha1(canonical_url)[0..16]>"
 */
export function computeIdentityKey(input: IdentityInput): string {
  const source = input.source.toLowerCase().trim();
  if (!source) throw new Error("computeIdentityKey: source is required");

  const ext = input.externalId?.trim();
  if (ext) return `${source}:${ext}`;

  if (input.sourceUrl) {
    const canon = canonicalizeUrl(input.sourceUrl);
    const hash = createHash("sha1").update(canon).digest("hex").slice(0, 16);
    return `${source}:url:${hash}`;
  }
  throw new Error(
    "computeIdentityKey: either externalId or sourceUrl is required"
  );
}

const STRIP_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "source_impression_id",
  "_set_bev_on_new_domain",
  "federated_search_id",
]);

/** Lowercased, hash-stripped, sorted-query canonical form of a listing URL. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) {
      if (STRIP_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    );
    u.search = "";
    for (const [k, v] of sorted) u.searchParams.append(k, v);
    return u.toString().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertListing
// ─────────────────────────────────────────────────────────────────────────────

export interface ObservationInput {
  source: string;
  externalId?: string | null;
  sourceUrl: string;
  title: string;
  neighborhoodRaw: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  maxGuests?: number | null;
  nightlyPriceUsd?: number | null;
  ratingOverall?: number | null;
  reviewCount?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  observedAt: Date;
}

export interface UpsertResult {
  listingId: number;
  identityKey: string;
  isNew: boolean;
  pricingToolBucket: string | null;
  parentRegion: string | null;
  mappingConfidence: string;
}

/**
 * Idempotent upsert from a search-card observation:
 *   • Lookup by identity_key first (preferred), then by (source, source_url).
 *   • Insert path: sets first_seen_at = last_seen_at = observedAt, seen_count = 1,
 *     lifecycle_status = 'active', plus pricing-tool bucket fields.
 *   • Update path: bumps last_seen_at, increments seen_count, lifecycle_status='active',
 *     and backfills pricing-tool bucket fields if previously null.
 */
export async function upsertListing(
  input: ObservationInput
): Promise<UpsertResult> {
  const identityKey = computeIdentityKey({
    source: input.source,
    externalId: input.externalId,
    sourceUrl: input.sourceUrl,
  });
  const mapping = mapToPricingToolBucket(input.neighborhoodRaw);
  const canonicalNeighborhood =
    mapping.canonical ?? mapping.pricingToolBucket ?? input.neighborhoodRaw;

  const existing = await db
    .select({ id: rentalListingsTable.id })
    .from(rentalListingsTable)
    .where(eq(rentalListingsTable.identityKey, identityKey))
    .limit(1);

  if (existing.length > 0) {
    const id = existing[0].id;
    await db
      .update(rentalListingsTable)
      .set({
        lastSeenAt: input.observedAt,
        seenCount: sql`COALESCE(${rentalListingsTable.seenCount}, 0) + 1`,
        lifecycleStatus: "active",
        updatedAt: new Date(),
        identityKey: sql`COALESCE(${rentalListingsTable.identityKey}, ${identityKey})`,
        parentRegionBucket: sql`COALESCE(${rentalListingsTable.parentRegionBucket}, ${mapping.parentRegion})`,
        normalizedNeighborhoodBucket: sql`COALESCE(${rentalListingsTable.normalizedNeighborhoodBucket}, ${mapping.pricingToolBucket})`,
        neighborhoodMappingConfidence: sql`COALESCE(${rentalListingsTable.neighborhoodMappingConfidence}, ${mapping.confidence})`,
      })
      .where(eq(rentalListingsTable.id, id));
    return {
      listingId: id,
      identityKey,
      isNew: false,
      pricingToolBucket: mapping.pricingToolBucket,
      parentRegion: mapping.parentRegion,
      mappingConfidence: mapping.confidence,
    };
  }

  const inserted = await db
    .insert(rentalListingsTable)
    .values({
      sourcePlatform: input.source,
      sourceUrl: input.sourceUrl,
      externalId: input.externalId ?? null,
      title: input.title,
      neighborhoodRaw: input.neighborhoodRaw,
      neighborhoodNormalized: canonicalNeighborhood,
      bedrooms: input.bedrooms ?? 0,
      bathrooms: input.bathrooms ?? 0,
      maxGuests: input.maxGuests ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
      nightlyPriceUsd: input.nightlyPriceUsd ?? null,
      ratingOverall: input.ratingOverall ?? null,
      reviewCount: input.reviewCount ?? null,
      scrapedAt: input.observedAt,
      dataConfidenceScore: 0.5,
      isActive: true,
      firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt,
      seenCount: 1,
      lifecycleStatus: "active",
      identityKey,
      parentRegionBucket: mapping.parentRegion,
      normalizedNeighborhoodBucket: mapping.pricingToolBucket,
      neighborhoodMappingConfidence: mapping.confidence,
    })
    .onConflictDoUpdate({
      target: [rentalListingsTable.sourcePlatform, rentalListingsTable.sourceUrl],
      set: {
        lastSeenAt: input.observedAt,
        seenCount: sql`COALESCE(${rentalListingsTable.seenCount}, 0) + 1`,
        lifecycleStatus: "active",
        identityKey: sql`COALESCE(${rentalListingsTable.identityKey}, ${identityKey})`,
        parentRegionBucket: sql`COALESCE(${rentalListingsTable.parentRegionBucket}, ${mapping.parentRegion})`,
        normalizedNeighborhoodBucket: sql`COALESCE(${rentalListingsTable.normalizedNeighborhoodBucket}, ${mapping.pricingToolBucket})`,
        neighborhoodMappingConfidence: sql`COALESCE(${rentalListingsTable.neighborhoodMappingConfidence}, ${mapping.confidence})`,
      },
    })
    .returning({ id: rentalListingsTable.id });

  return {
    listingId: inserted[0].id,
    identityKey,
    isNew: true,
    pricingToolBucket: mapping.pricingToolBucket,
    parentRegion: mapping.parentRegion,
    mappingConfidence: mapping.confidence,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// insertObservation
// ─────────────────────────────────────────────────────────────────────────────

export interface InsertObservationInput {
  listingId: number | null;
  source: string;
  externalListingId?: string | null;
  canonicalUrl?: string | null;
  observedAt: Date;
  /** The discovery_jobs seed permutation that produced this observation. */
  searchSeed?: unknown;
  titleDisplayed?: string | null;
  displayedNightlyPrice?: number | null;
  displayedTotalPrice?: number | null;
  currency?: string | null;
  displayedRating?: number | null;
  displayedReviewCount?: number | null;
  thumbnailUrl?: string | null;
  rawLocationText?: string | null;
  normalizedNeighborhoodBucket?: string | null;
  parentRegionBucket?: string | null;
  rawCardJson?: unknown;
}

export async function insertObservation(
  input: InsertObservationInput
): Promise<number> {
  const [row] = await db
    .insert(listingSearchObservationsTable)
    .values({
      listingId: input.listingId ?? null,
      source: input.source,
      externalListingId: input.externalListingId ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      observedAt: input.observedAt,
      searchSeed: input.searchSeed ?? null,
      titleDisplayed: input.titleDisplayed ?? null,
      displayedNightlyPrice: input.displayedNightlyPrice ?? null,
      displayedTotalPrice: input.displayedTotalPrice ?? null,
      currency: input.currency ?? null,
      displayedRating: input.displayedRating ?? null,
      displayedReviewCount: input.displayedReviewCount ?? null,
      thumbnailUrl: input.thumbnailUrl ?? null,
      rawLocationText: input.rawLocationText ?? null,
      normalizedNeighborhoodBucket: input.normalizedNeighborhoodBucket ?? null,
      parentRegionBucket: input.parentRegionBucket ?? null,
      rawCardJson: input.rawCardJson ?? null,
    })
    .returning({ id: listingSearchObservationsTable.id });
  return row.id;
}
