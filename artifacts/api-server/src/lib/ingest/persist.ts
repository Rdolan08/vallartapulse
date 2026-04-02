/**
 * ingest/persist.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts a NormalizedRentalListing into a RawListing and persists it via
 * the existing ingestListing() pipeline (normalization + DB upsert).
 */

import { ingestListing } from "../rental-ingest.js";
import type { NormalizedRentalListing } from "./types.js";
import type { IngestResult } from "./types.js";

export async function persistNormalized(
  listing: NormalizedRentalListing,
): Promise<IngestResult> {
  const warnings: string[] = [];

  if (!listing.title) warnings.push("Missing title");
  if (!listing.neighborhood) warnings.push("Missing neighborhood");
  if (!listing.bedrooms) warnings.push("Missing bedrooms");
  if (!listing.price_nightly_usd) warnings.push("Missing price_nightly_usd");

  try {
    const { id, warnings: ingestWarnings } = await ingestListing({
      source_platform:  listing.source,
      source_url:       listing.source_url,
      external_id:      listing.source_listing_id,
      title:            listing.title ?? listing.source_listing_id,
      neighborhood_raw: listing.neighborhood ?? "",
      building_name:    listing.building_name,
      latitude:         listing.latitude ?? undefined,
      longitude:        listing.longitude ?? undefined,
      bedrooms:         listing.bedrooms ?? 0,
      bathrooms:        listing.bathrooms ?? 0,
      max_guests:       listing.max_guests ?? undefined,
      sqft:             listing.sqft ?? undefined,
      amenities_raw:    listing.amenities_raw,
      rating_overall:   listing.rating_value ?? undefined,
      review_count:     listing.review_count ?? undefined,
      nightly_price_usd: listing.price_nightly_usd ?? undefined,
      cleaning_fee_usd:  listing.cleaning_fee_usd ?? undefined,
      min_nights:        listing.min_nights ?? undefined,
      scraped_at:        listing.scraped_at ? new Date(listing.scraped_at) : new Date(),
    });

    return {
      ok: true,
      source: listing.source,
      source_url: listing.source_url,
      listing_id: id,
      normalized: listing,
      warnings: [...warnings, ...ingestWarnings],
    };
  } catch (err) {
    return {
      ok: false,
      source: listing.source,
      source_url: listing.source_url,
      normalized: listing,
      warnings,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
