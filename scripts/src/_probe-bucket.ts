/**
 * scripts/src/_probe-bucket.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic probe for the Airbnb discovery extractor — designed to be run
 * directly from the residential Mac mini IP, NOT from the datacenter.
 *
 * Background: c997533 fixed long-form (18–19 digit) listing ID extraction
 * and the datacenter smoke test confirmed 20 cards per page. The Mac mini
 * still reports 0 cards across all three URL variants with status=200 and
 * ~813KB HTML bodies, which means Airbnb is serving the residential IP a
 * page shape we have NOT yet seen. This probe surfaces what's actually in
 * that payload so we can write the right parser instead of guessing again.
 *
 * Output, per URL variant:
 *   1. Status, length, what extractCandidateIds returns from THIS html
 *      (confirms the fix didn't quietly start working on a fresh fetch).
 *   2. Marker counts for the substrings we expect Airbnb to embed listing
 *      IDs near, plus framework-shape markers that tell us which page
 *      template we're looking at.
 *   3. First 2–3 regex captures for each pattern that produced ≥1 hit,
 *      so we can see the actual ID format being served.
 *   4. JSON-stringified ~600-char snippets around the first occurrence
 *      of `listingId`, `niobeClientData`, `staysSearch`, `presentation`
 *      — escapes newlines/backslashes so the console output is readable
 *      and grep-friendly.
 *
 * Run: pnpm exec tsx scripts/src/_probe-bucket.ts [bucketId]
 *      bucketId is currently informational only; the URL set below is
 *      hardcoded to the zona_romantica__2__200_400 variants because those
 *      are the buckets the user reported as failing.
 */

import { fetchAirbnbResidential } from "./lib/airbnb-residential-fetch.js";
import { extractCandidateIds } from "./lib/airbnb-search-cards-extract.js";

const URLS: Record<string, string> = {
  WORKING:
    "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes",
  MY_BUCKET:
    "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes?min_bedrooms=2&max_bedrooms=2&price_min=200&price_max=400&room_types%5B%5D=Entire+home%2Fapt",
  ONLY_BR:
    "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes?min_bedrooms=2",
};

// Substring markers — count occurrences only, no capture group needed.
// Cheap and order-independent; quickly tells us "is this string in the page
// at all?" before we waste regex time on capture.
const SUBSTRING_MARKERS = [
  "/rooms/",
  '"listingId"',
  '"listing_id"',
  '"stayId"',
  '"sectionId"',
  "niobeClientData",
  "__NEXT_DATA__",
  "staysSearch",
  "presentation",
  "deferredState",
  "ExploreStayMapInfo",
  "ExploreStayCard",
  "captcha",
  "px-captcha",
] as const;

// Capture-group regexes — for any pattern that has ≥1 hit we'll print the
// first 3 distinct captures to confirm the value shape (digit length, type).
const CAPTURE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "rooms_url", pattern: /\/rooms\/(\d{4,25})/g },
  { name: "listingId_json", pattern: /"listingId"\s*:\s*"?(\d{4,25})"?/g },
  { name: "listing_id_json", pattern: /"listing_id"\s*:\s*"?(\d{4,25})"?/g },
  { name: "stayId_json", pattern: /"stayId"\s*:\s*"?(\d{4,25})"?/g },
  { name: "id_long_json", pattern: /"id"\s*:\s*"(\d{15,25})"/g },
  // Base64-ish opaque IDs in case Airbnb has switched to encoded payloads.
  // 20–60 char window matches the "StayListing:12345" → base64 pattern
  // length we'd expect from a Relay/GraphQL global ID.
  {
    name: "encoded_id",
    pattern: /"id"\s*:\s*"([A-Za-z0-9+/=_-]{20,60})"/g,
  },
];

// Snippet anchors — slice ~600 chars (300 before, 300 after) around the
// first occurrence and JSON.stringify so escapes are visible.
const SNIPPET_ANCHORS = [
  "listingId",
  "niobeClientData",
  "staysSearch",
  "presentation",
  "ExploreStayMapInfo",
  "deferredState",
] as const;

function countSubstring(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function firstNCaptures(html: string, pattern: RegExp, n: number): string[] {
  const out: string[] = [];
  // Reset lastIndex so re-running against the same pattern reference is safe.
  pattern.lastIndex = 0;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null && out.length < n) {
    const v = m[1];
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
    // Guard against zero-length matches (shouldn't happen here but cheap).
    if (m.index === pattern.lastIndex) pattern.lastIndex++;
  }
  return out;
}

function snippetAround(html: string, anchor: string, padding = 300): string | null {
  const idx = html.indexOf(anchor);
  if (idx === -1) return null;
  const start = Math.max(0, idx - padding);
  const end = Math.min(html.length, idx + anchor.length + padding);
  return html.slice(start, end);
}

async function probe(name: string, url: string): Promise<void> {
  const r = await fetchAirbnbResidential(url, { timeoutMs: 25000 });
  console.log(`\n=== ${name} ===`);
  console.log(`URL: ${url}`);
  console.log(`status=${r.status} len=${r.html.length}`);

  // 1. What does the current extractor return on THIS html?
  const extraction = extractCandidateIds(r.html);
  console.log(
    `extractCandidateIds: ${extraction.ids.length} ids, hitsByPattern=${JSON.stringify(extraction.hitsByPattern)}`,
  );
  if (extraction.ids.length > 0) {
    console.log(`  first 5 ids: ${extraction.ids.slice(0, 5).join(", ")}`);
  }

  // 2. Substring marker counts.
  console.log(`-- substring marker counts --`);
  const substrCounts: Record<string, number> = {};
  for (const m of SUBSTRING_MARKERS) {
    substrCounts[m] = countSubstring(r.html, m);
  }
  console.log(JSON.stringify(substrCounts, null, 2));

  // 3. Capture samples for any non-zero pattern.
  console.log(`-- capture samples (first 3 distinct per pattern) --`);
  for (const { name: pname, pattern } of CAPTURE_PATTERNS) {
    const samples = firstNCaptures(r.html, pattern, 3);
    if (samples.length > 0) {
      console.log(
        `  ${pname}: ${samples.map((s) => `"${s}" (len=${s.length})`).join(", ")}`,
      );
    } else {
      console.log(`  ${pname}: 0 hits`);
    }
  }

  // 4. Snippets around shape anchors. JSON.stringify makes escapes visible.
  console.log(`-- snippets (600 chars around first occurrence) --`);
  for (const anchor of SNIPPET_ANCHORS) {
    const snip = snippetAround(r.html, anchor, 300);
    if (snip === null) {
      console.log(`  [${anchor}] NOT PRESENT`);
    } else {
      console.log(`  [${anchor}] ${JSON.stringify(snip)}`);
    }
  }
}

async function main(): Promise<void> {
  const requestedBucket = process.argv[2];
  if (requestedBucket) {
    console.log(`(probe target hint: ${requestedBucket} — using hardcoded URL set)`);
  }
  for (const [name, url] of Object.entries(URLS)) {
    try {
      await probe(name, url);
    } catch (e) {
      console.log(`\n=== ${name} ===\nERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Pace requests so we don't trip Airbnb's rate limiter mid-probe.
    await new Promise((r) => setTimeout(r, 2500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
