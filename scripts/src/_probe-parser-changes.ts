/**
 * Verifies changes 1 (delisted detector) + 2 (og:title fallback) against
 * the HTML samples saved during the previous investigation. Pure offline —
 * no network, no DB writes.
 */
import { readFileSync } from "node:fs";
import {
  parseAirbnbDetailHtml,
  extractOgTitle,
  parseOgTitle,
} from "../../artifacts/api-server/src/lib/ingest/airbnb-detail-adapter.js";

// Replicates the runner's looksDelisted (kept private there); we test the
// runner's behavior conceptually via the same predicate.
function looksDelisted(html: string): boolean {
  if (html.length > 6_000) return false;
  return html.includes("helpful_404.html.erb") ||
         html.includes("404 Page Not Found - Airbnb") ||
         /<title>\s*404\b/i.test(html);
}

const LIVE  = ["29764486", "13935677", "51332052", "53860136"];
const DEAD  = ["986576320529", "142188006292", "150230730061", "162285620375"];

function loadSample(id: string): string | null {
  try { return readFileSync(`/tmp/airbnb-raw-${id}.html`, "utf8"); }
  catch { return null; }
}

console.log("════════════ DELISTED DETECTOR ════════════");
for (const id of [...LIVE, ...DEAD]) {
  const html = loadSample(id);
  if (!html) { console.log(`  ${id}: (sample missing)`); continue; }
  const flagged = looksDelisted(html);
  const expected = DEAD.includes(id);
  const ok = flagged === expected ? "✓" : "✗ MISMATCH";
  console.log(`  ${id.padStart(13)}  bytes=${String(html.length).padStart(6)}  delisted=${flagged}  expected=${expected}  ${ok}`);
}

console.log("\n════════════ OG:TITLE EXTRACTION ════════════");
for (const id of LIVE) {
  const html = loadSample(id);
  if (!html) continue;
  const og = extractOgTitle(html);
  const parts = og ? parseOgTitle(og) : null;
  console.log(`  ${id}: og="${og}"`);
  if (parts) console.log(`             parsed:`, parts);
}

console.log("\n════════════ FULL PARSER PER LIVE SAMPLE ════════════");
for (const id of LIVE) {
  const html = loadSample(id);
  if (!html) continue;
  const r = parseAirbnbDetailHtml(html);
  const n = r.normalized;
  console.log(
    `  ${id}: status=${r.parseStatus}  ` +
    `title=${n.title ? "Y" : "N"}  br=${n.bedrooms ?? "—"}  ba=${n.bathrooms ?? "—"}  ` +
    `bedCnt=${n.bedCount ?? "—"}  guests=${n.maxGuests ?? "—"}  ` +
    `rating=${n.ratingOverall ?? "—"}  lat=${n.latitude ? "Y" : "N"}  ` +
    `pType=${n.propertyType ?? "—"}  loc=${n.rawLocationHints.addressLocality ?? "—"}`
  );
  if (r.parseErrors.length) {
    console.log(`            errors: ${r.parseErrors.slice(0, 4).join(" | ")}`);
  }
}

console.log("\n════════════ OG:TITLE UNIT TESTS ════════════");
const cases: { in: string; want: Partial<ReturnType<typeof parseOgTitle>> }[] = [
  { in: "Condo in Puerto Vallarta · ★4.96 · 2 bedrooms · 2 beds · 2 private baths",
    want: { propertyType: "Condo", neighborhood: "Puerto Vallarta", ratingOverall: 4.96, bedrooms: 2, bedCount: 2, bathrooms: 2 } },
  { in: "Rental unit in Sayulita · ★4.89 · 1 bedroom · 1 bed · 1 private bath",
    want: { propertyType: "Rental unit", neighborhood: "Sayulita", ratingOverall: 4.89, bedrooms: 1, bedCount: 1, bathrooms: 1 } },
  { in: "Studio in Romantic Zone · ★4.7 · 1 bed · 1 bath",
    want: { propertyType: "Studio", neighborhood: "Romantic Zone", ratingOverall: 4.7, bedrooms: 0, bedCount: 1, bathrooms: 1 } },
  { in: "Villa in Conchas Chinas · ★4.92 · 4 bedrooms · 6 beds · 4.5 baths",
    want: { propertyType: "Villa", neighborhood: "Conchas Chinas", ratingOverall: 4.92, bedrooms: 4, bedCount: 6, bathrooms: 4.5 } },
];
let pass = 0, fail = 0;
for (const c of cases) {
  const got = parseOgTitle(c.in);
  const mismatches: string[] = [];
  for (const [k, v] of Object.entries(c.want)) {
    if ((got as any)[k] !== v) mismatches.push(`${k}: got=${(got as any)[k]} want=${v}`);
  }
  if (mismatches.length === 0) { pass++; console.log(`  ✓ "${c.in.slice(0, 60)}..."`); }
  else { fail++; console.log(`  ✗ "${c.in.slice(0, 60)}..."  ${mismatches.join("; ")}`); }
}
console.log(`\nUnit tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
