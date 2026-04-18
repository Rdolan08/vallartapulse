-- airbnb_comp_signal
-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2c: comp-ready normalized Airbnb signal layer.
--
-- Merges three sources into one row per Airbnb listing:
--   1. rental_listings              — durable identity + region/bucket mapping
--   2. listing_search_observations  — latest displayed price + card-level demand
--      (the row with the freshest observed_at per listingId, source='airbnb')
--   3. listing_details              — latest parse_status='ok' enrichment
--      (the row with the freshest enriched_at per listingId)
--
-- Authoritative-source rules (per Phase-2c brief):
--   - PRICE fields           → always from latest observation
--   - DETAIL fields (cap/type/title/desc/imageCount)
--                            → latest successful detail row, never fabricated
--   - GEOGRAPHY              → prefer rental_listings bucket/region
--                              (mapped during discovery, stable across
--                              re-observations); preserve raw hints from
--                              both sides
--   - LAT/LNG                → prefer detail (more precise — JSON-LD point),
--                              fall back to rental_listings
--   - RATING / REVIEW COUNT  → prefer detail's overall rating (covers full
--                              history) over the card's displayed_rating
--                              (only the visible-on-card snapshot)
--   - TITLE                  → detail title → observation title_displayed
--                              → rental_listings.title
--   - NULLS preserved        → never coalesce to default values; downstream
--                              consumers must check the *_signal flags
--   - bedrooms / bathrooms / amenities / hostName are NOT exposed here
--     because Phase 2b confirmed they are not present in SSR HTML at the
--     current render depth (0% coverage); exposing nulls under those names
--     would invite downstream fabrication.
--
-- Comp-usability flags:
--   minimal = bucket + derived_nightly_price + currency + canonical_url
--   rich    = minimal + ≥3 of:
--             rating+reviewCount, lat+lng, maxGuests, bedCount,
--             propertyType, imageCount, title
--
-- This view is read-only and idempotent. CREATE OR REPLACE makes setup safe
-- to re-run; no source-table mutation occurs.
CREATE OR REPLACE VIEW airbnb_comp_signal AS
WITH latest_obs AS (
  -- Tie-breaker: when two observations for the same listing share an
  -- observed_at (rare but possible — same scheduler tick can land two
  -- seeds on the same listing), prefer the higher serial id (the row
  -- physically inserted last). Guarantees stable, reproducible "latest".
  SELECT DISTINCT ON (listing_id)
    listing_id,
    observed_at,
    displayed_total_price,
    derived_nightly_price,
    currency,
    displayed_rating,
    displayed_review_count,
    title_displayed,
    raw_location_text,
    normalized_neighborhood_bucket AS obs_bucket,
    parent_region_bucket           AS obs_region,
    search_seed
  FROM listing_search_observations
  WHERE listing_id IS NOT NULL
    AND source = 'airbnb'
  ORDER BY listing_id, observed_at DESC, id DESC
),
latest_detail AS (
  -- Same tiebreaker rationale as latest_obs: prefer the higher id
  -- when enriched_at ties, so the view is reproducible across runs.
  SELECT DISTINCT ON (listing_id)
    listing_id,
    enriched_at,
    normalized_fields,
    parse_version
  FROM listing_details
  WHERE parse_status = 'ok'
  ORDER BY listing_id, enriched_at DESC, id DESC
),
merged AS (
  -- Defensive cast pattern for JSON-extracted fields:
  --   INT  → CASE WHEN x ~ '^-?[0-9]+$'                      THEN x::int END
  --   REAL → CASE WHEN x ~ '^-?[0-9]+(\.[0-9]+)?$'           THEN x::double precision END
  --   BOOL → CASE WHEN lower(x) IN ('true','false')          THEN x::boolean END
  -- These regex/whitelist guards prevent the entire view from erroring
  -- if a future adapter version writes a malformed value into
  -- normalized_fields (e.g. "two" instead of 2). Malformed values
  -- become NULL, preserving the brief's "preserve nulls" rule and
  -- letting the *_signal flags accurately reflect missing data.
  SELECT
    -- ── Identity ────────────────────────────────────────────────────────
    rl.id                              AS listing_id,
    rl.source_platform                 AS source_platform,
    rl.external_id                     AS external_listing_id,
    rl.source_url                      AS canonical_url,

    -- ── Geography ───────────────────────────────────────────────────────
    -- Discovery already mapped to a bucket; only fall back to the
    -- observation bucket if the master row's bucket is unknown.
    COALESCE(rl.normalized_neighborhood_bucket, lo.obs_bucket)
                                       AS normalized_neighborhood_bucket,
    COALESCE(rl.parent_region_bucket, lo.obs_region)
                                       AS parent_region_bucket,
    lo.raw_location_text               AS raw_location_text_obs,
    ld.normalized_fields->'rawLocationHints'->>'addressLocality'
                                       AS raw_location_locality_detail,
    ld.normalized_fields->'rawLocationHints'->>'apolloCity'
                                       AS raw_location_apollo_detail,
    COALESCE(
      CASE WHEN ld.normalized_fields->>'latitude' ~ '^-?[0-9]+(\.[0-9]+)?$'
           THEN (ld.normalized_fields->>'latitude')::double precision END,
      rl.latitude::double precision
    )                                  AS lat,
    COALESCE(
      CASE WHEN ld.normalized_fields->>'longitude' ~ '^-?[0-9]+(\.[0-9]+)?$'
           THEN (ld.normalized_fields->>'longitude')::double precision END,
      rl.longitude::double precision
    )                                  AS lng,

    -- ── Pricing (latest observation only) ───────────────────────────────
    lo.displayed_total_price           AS displayed_total_price,
    lo.currency                        AS currency,
    CASE WHEN lo.search_seed->>'stayLengthNights' ~ '^-?[0-9]+$'
         THEN (lo.search_seed->>'stayLengthNights')::int END
                                       AS stay_length_nights,
    lo.derived_nightly_price           AS derived_nightly_price,
    lo.observed_at                     AS observed_at,

    -- ── Quality / demand ────────────────────────────────────────────────
    -- Detail's ratingOverall is more authoritative than displayed_rating
    -- (the card snapshot). Same for review_count.
    COALESCE(
      CASE WHEN ld.normalized_fields->>'ratingOverall' ~ '^-?[0-9]+(\.[0-9]+)?$'
           THEN (ld.normalized_fields->>'ratingOverall')::real END,
      lo.displayed_rating
    )                                  AS rating_overall,
    COALESCE(
      CASE WHEN ld.normalized_fields->>'reviewCount' ~ '^-?[0-9]+$'
           THEN (ld.normalized_fields->>'reviewCount')::int END,
      lo.displayed_review_count
    )                                  AS review_count,
    CASE WHEN ld.normalized_fields->>'imageCount' ~ '^-?[0-9]+$'
         THEN (ld.normalized_fields->>'imageCount')::int END
                                       AS image_count,

    -- ── Capacity / type (detail-only — never inferred) ──────────────────
    CASE WHEN ld.normalized_fields->>'maxGuests' ~ '^-?[0-9]+$'
         THEN (ld.normalized_fields->>'maxGuests')::int END    AS max_guests,
    CASE WHEN ld.normalized_fields->>'bedCount' ~ '^-?[0-9]+$'
         THEN (ld.normalized_fields->>'bedCount')::int END     AS bed_count,
    ld.normalized_fields->>'propertyType'                      AS property_type,
    CASE WHEN lower(ld.normalized_fields->>'petsAllowed') IN ('true','false')
         THEN (ld.normalized_fields->>'petsAllowed')::boolean END
                                                               AS pets_allowed,

    -- ── Content ─────────────────────────────────────────────────────────
    COALESCE(ld.normalized_fields->>'title',
             lo.title_displayed,
             rl.title)                 AS title,
    ld.normalized_fields->>'description'         AS description,

    -- ── Provenance ──────────────────────────────────────────────────────
    ld.enriched_at                     AS detail_enriched_at,
    ld.parse_version                   AS detail_parse_version,
    (ld.listing_id IS NOT NULL)        AS has_detail_signal
  FROM rental_listings rl
  LEFT JOIN latest_obs    lo ON lo.listing_id = rl.id
  LEFT JOIN latest_detail ld ON ld.listing_id = rl.id
  WHERE rl.source_platform = 'airbnb'
)
SELECT
  m.*,

  -- ── Signal-presence flags ────────────────────────────────────────────
  (m.derived_nightly_price IS NOT NULL
     AND m.currency IS NOT NULL)                  AS has_price_signal,
  (m.lat IS NOT NULL AND m.lng IS NOT NULL)       AS has_geo_signal,
  (m.rating_overall IS NOT NULL
     AND m.review_count IS NOT NULL)              AS has_rating_signal,

  -- ── Comp-usability ───────────────────────────────────────────────────
  (m.normalized_neighborhood_bucket IS NOT NULL
     AND m.derived_nightly_price IS NOT NULL
     AND m.currency IS NOT NULL
     AND m.canonical_url IS NOT NULL)             AS is_comp_usable_minimal,

  (
    -- minimal usable…
    m.normalized_neighborhood_bucket IS NOT NULL
    AND m.derived_nightly_price IS NOT NULL
    AND m.currency IS NOT NULL
    AND m.canonical_url IS NOT NULL
    -- …plus ≥3 of the seven enrichment dimensions
    AND (
      (m.rating_overall IS NOT NULL AND m.review_count IS NOT NULL)::int +
      (m.lat IS NOT NULL AND m.lng IS NOT NULL)::int +
      (m.max_guests   IS NOT NULL)::int +
      (m.bed_count    IS NOT NULL)::int +
      (m.property_type IS NOT NULL)::int +
      (m.image_count  IS NOT NULL)::int +
      (m.title        IS NOT NULL)::int
    ) >= 3
  )                                               AS is_comp_usable_rich
FROM merged m;

COMMENT ON VIEW airbnb_comp_signal IS
  'Phase 2c: comp-ready merge of rental_listings + latest listing_search_observations + latest listing_details (parse_status=ok). Read-only. See lib/db/src/views/airbnb_comp_signal.sql for authoritative-source rules.';
