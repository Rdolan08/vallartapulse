/**
 * ingest/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Canonical normalized listing model.  Every source adapter returns this shape.
 * Downstream: persist.ts maps it to InsertRentalListing for the DB.
 */

export type SourceKey =
  | "pvrpv"
  | "airbnb"
  | "vrbo"
  | "local_agency"
  | "owner_direct"
  | "manual"
  | "csv";

export interface NormalizedRentalListing {
  source: SourceKey;
  source_listing_id: string;
  source_url: string;

  title?: string;
  neighborhood?: string;
  building_name?: string;
  cross_streets?: string;

  property_type?: string;
  bedrooms?: number;
  bathrooms?: number;
  max_guests?: number;
  sqft?: number | null;

  year_built?: number | null;

  price_nightly_usd?: number | null;
  price_nightly_mxn?: number | null;
  cleaning_fee_usd?: number | null;
  min_nights?: number | null;

  latitude?: number | null;
  longitude?: number | null;

  amenities_raw?: string[];
  amenities_normalized?: string[];

  rating_value?: number | null;
  review_count?: number | null;

  scraped_at?: string;
}

export interface IngestResult {
  ok: boolean;
  source: SourceKey;
  source_url: string;
  listing_id?: number;
  normalized: NormalizedRentalListing;
  warnings: string[];
  error?: string;
}

export interface ICalEvent {
  uid: string;
  summary?: string;
  status?: string;
  start: string;
  end: string;
  raw?: Record<string, string>;
}

export interface ICalParseResult {
  source_url?: string;
  event_count: number;
  events: ICalEvent[];
  errors: string[];
}
