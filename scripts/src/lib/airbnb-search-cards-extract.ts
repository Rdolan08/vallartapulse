/**
 * scripts/src/lib/airbnb-search-cards-extract.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovery-stage candidate ID extraction from Airbnb search HTML.
 *
 * Why this exists separately from
 * `artifacts/api-server/src/lib/ingest/airbnb-search-adapter.ts`:
 *
 * The api-server adapter validates listing IDs with `/^\d{7,12}$/`. That
 * was correct historically — Airbnb IDs were 7–10 digits — but Airbnb
 * has been issuing 18–19 digit IDs to listings created in the last ~year,
 * e.g. "789061014916904742", "1530037013585048706". Anything posted with
 * the new ID format gets silently rejected by the old regex, which
 * produced the "no Airbnb listings created in the last hour" symptom
 * that prompted this fix.
 *
 * This extractor is intentionally narrow: it returns candidate IDs only.
 * The discovery runner does NOT need the full search-card metadata
 * (name / bedrooms / lat-lng) — it fetches each /rooms/{id} detail page
 * via `parseListingDetail` for that anyway. Returning just IDs keeps
 * the parser surface tiny and the failure mode visible.
 *
 * Extraction strategy (order matters for dedupe debugging — same ID via
 * multiple paths is fine, the Set collapses them):
 *
 *   1. /rooms/{id} hyperlinks. Still occasionally appear in residential
 *      responses; cheap regex catches them.
 *   2. "listingId":"\d+" — the actual shape Airbnb uses inside the embedded
 *      niobeClientData JSON for ExploreStayMapInfo and ExploreStayCard
 *      entries. This is the dominant path on current pages.
 *   3. "listing_id":"\d+" — snake_case variant occasionally seen in
 *      legacy bootstrapData payloads.
 *
 * Digit window: 7–19. 7 is the smallest valid Airbnb ID we've ever seen;
 * 19 covers current snowflake-style IDs with a small margin. Anything
 * outside that window is almost certainly noise (timestamps, request
 * IDs, internal tracking numbers).
 */

const ID_PATTERNS: readonly RegExp[] = [
  /\/rooms\/(\d{7,19})/g,
  /"listingId"\s*:\s*"?(\d{7,19})"?/g,
  /"listing_id"\s*:\s*"?(\d{7,19})"?/g,
];

export interface CandidateIdExtractionResult {
  /** Unique candidate IDs in stable insertion order (first-match wins). */
  ids: string[];
  /** Per-pattern hit counts for diagnostic visibility. */
  hitsByPattern: Record<string, number>;
}

export function extractCandidateIds(html: string): CandidateIdExtractionResult {
  const ids = new Set<string>();
  const hitsByPattern: Record<string, number> = {};

  for (const pattern of ID_PATTERNS) {
    const key = pattern.source;
    let count = 0;
    // Reset lastIndex defensively even though we constructed fresh /g regexes
    // above — being explicit makes the intent obvious to future readers and
    // avoids surprises if these are ever reused.
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(html)) !== null) {
      count++;
      const id = m[1];
      if (id) ids.add(id);
    }
    hitsByPattern[key] = count;
  }

  return { ids: Array.from(ids), hitsByPattern };
}
