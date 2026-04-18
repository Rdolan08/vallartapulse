/**
 * Investigation-only probe: fetch a small set of Airbnb listings and report
 * which hydration anchors are present in the SSR HTML. No DB writes.
 *
 * Anchors checked:
 *   1. JSON-LD blocks (current parser primary signal)
 *   2. Apollo "data-deferred-state-{N}" scripts (current parser secondary)
 *   3. __NEXT_DATA__ script (untested fallback)
 *   4. window.__APOLLO_STATE__ inline assignment
 *   5. niobeMinimalClientState (Airbnb-internal Apollo serialization)
 *   6. Generic VacationRental schema.org keywords anywhere in body
 *   7. Block detection (captcha / 429 / "Sorry, something went wrong")
 *
 * Saves each HTML to /tmp/airbnb-probe-{id}.html for follow-up inspection.
 */
import { fetchWithBrowser, closeBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";
import { writeFile } from "node:fs/promises";

interface Probe {
  id: string;
  url: string;
  hydrationMs: number;
}

const URLS: Probe[] = [
  { id: "29764486",     url: "https://www.airbnb.com/rooms/29764486",     hydrationMs: 25_000 },
  { id: "13935677",     url: "https://www.airbnb.com/rooms/13935677",     hydrationMs: 25_000 },
  { id: "51332052",     url: "https://www.airbnb.com/rooms/51332052",     hydrationMs: 25_000 },
  { id: "53860136",     url: "https://www.airbnb.com/rooms/53860136",     hydrationMs: 25_000 },
  { id: "986576320529", url: "https://www.airbnb.com/rooms/986576320529", hydrationMs: 25_000 },
  { id: "142188006292", url: "https://www.airbnb.com/rooms/142188006292", hydrationMs: 25_000 },
  { id: "150230730061", url: "https://www.airbnb.com/rooms/150230730061", hydrationMs: 25_000 },
  { id: "162285620375", url: "https://www.airbnb.com/rooms/162285620375", hydrationMs: 25_000 },
];

interface AnchorReport {
  id: string;
  url: string;
  bytes: number;
  fetchMs: number;
  blocked: boolean | "captcha" | "429" | "soft" | false;
  jsonLdCount: number;
  jsonLdHasVacationRental: boolean;
  jsonLdHasProduct: boolean;
  apolloDeferredScripts: number;       // <script id="data-deferred-state-N">
  apolloDeferredHasListing: boolean;   // contains "DemandStayListing" payload key
  nextDataPresent: boolean;            // <script id="__NEXT_DATA__">
  nextDataBytes: number;
  windowApolloAssign: boolean;         // window.__APOLLO_STATE__ = inline
  niobeMinimalClient: boolean;         // "niobeMinimalClientState" anywhere
  vacationRentalKeyword: boolean;      // "VacationRental" anywhere in body
  demandStayListingKeyword: boolean;   // "DemandStayListing" anywhere
  bedroomKeyword: boolean;             // "bedroom" appears in body
  titleTag: string | null;
  ogTitleTag: string | null;
  error?: string;
}

function detectBlock(html: string): AnchorReport["blocked"] {
  const lo = html.slice(0, 5000).toLowerCase();
  if (lo.includes("captcha") || lo.includes("are you a human") || lo.includes("px-captcha")) return "captcha";
  if (lo.includes("too many requests") || lo.includes("rate limit")) return "429";
  if (html.length < 5_000 && !lo.includes("airbnb")) return "soft";
  return false;
}

function countMatches(html: string, re: RegExp): number {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(html) !== null) n++;
  return n;
}

function extractTag(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m ? m[1].slice(0, 120) : null;
}

async function probeOne(p: Probe): Promise<AnchorReport> {
  const t0 = Date.now();
  let html = "";
  let err: string | undefined;
  try {
    html = await fetchWithBrowser(p.url, {
      timeoutMs: p.hydrationMs,
      waitForSelector: 'script[type="application/ld+json"], script[id^="data-deferred-state"], script#__NEXT_DATA__',
      fallbackOnTimeout: true,
    });
  } catch (e) {
    err = (e as Error).message?.slice(0, 200) ?? String(e);
  }
  const fetchMs = Date.now() - t0;
  await writeFile(`/tmp/airbnb-probe-${p.id}.html`, html).catch(() => {});

  const blocked = html ? detectBlock(html) : false;
  const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  let jsonLdHasVacationRental = false;
  let jsonLdHasProduct = false;
  for (const block of jsonLdMatches) {
    if (/"VacationRental"/i.test(block)) jsonLdHasVacationRental = true;
    if (/"Product"/i.test(block)) jsonLdHasProduct = true;
  }
  const apolloDeferred = countMatches(html, /<script[^>]+id=["']data-deferred-state-\d+["'][^>]*>/gi);
  const apolloDeferredHasListing = /"DemandStayListing"/.test(html);
  const nextDataMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  const nextDataBytes = nextDataMatch ? nextDataMatch[1].length : 0;
  const windowApolloAssign = /window\.__APOLLO_STATE__\s*=/.test(html);
  const niobeMinimalClient = /niobeMinimalClientState/.test(html);
  const vacationRentalKeyword = /VacationRental/.test(html);
  const demandStayListingKeyword = /DemandStayListing/.test(html);
  const bedroomKeyword = /bedroom/i.test(html);
  const titleTag = extractTag(html, /<title>([^<]+)<\/title>/i);
  const ogTitleTag = extractTag(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);

  return {
    id: p.id, url: p.url, bytes: html.length, fetchMs, blocked,
    jsonLdCount: jsonLdMatches.length, jsonLdHasVacationRental, jsonLdHasProduct,
    apolloDeferredScripts: apolloDeferred, apolloDeferredHasListing,
    nextDataPresent: !!nextDataMatch, nextDataBytes,
    windowApolloAssign, niobeMinimalClient,
    vacationRentalKeyword, demandStayListingKeyword, bedroomKeyword,
    titleTag, ogTitleTag, error: err,
  };
}

async function main() {
  console.log(`Probing ${URLS.length} listings (concurrent batch of 4) ...`);
  const reports: AnchorReport[] = [];
  for (let i = 0; i < URLS.length; i += 4) {
    const batch = URLS.slice(i, i + 4);
    const r = await Promise.all(batch.map(probeOne));
    reports.push(...r);
    for (const rep of r) {
      console.log(
        `\n--- id=${rep.id} (${rep.bytes} bytes, ${rep.fetchMs} ms${rep.blocked ? `, blocked=${rep.blocked}` : ""}${rep.error ? `, ERR=${rep.error}` : ""}) ---`,
      );
      console.log(`  jsonLd:  count=${rep.jsonLdCount}  vacationRental=${rep.jsonLdHasVacationRental}  product=${rep.jsonLdHasProduct}`);
      console.log(`  apollo:  deferredScripts=${rep.apolloDeferredScripts}  hasListing=${rep.apolloDeferredHasListing}`);
      console.log(`  nextData: present=${rep.nextDataPresent}  bytes=${rep.nextDataBytes}`);
      console.log(`  other:   windowApollo=${rep.windowApolloAssign}  niobeMin=${rep.niobeMinimalClient}  hasKeywordVR=${rep.vacationRentalKeyword}  hasKeywordDSL=${rep.demandStayListingKeyword}  hasKeywordBedroom=${rep.bedroomKeyword}`);
      console.log(`  title:   ${rep.titleTag ?? "(none)"}`);
      console.log(`  ogTitle: ${rep.ogTitleTag ?? "(none)"}`);
    }
  }

  console.log("\n\n═══════════════ SUMMARY ═══════════════");
  console.log(`Total probed: ${reports.length}`);
  const successJsonLd = reports.filter((r) => r.jsonLdHasVacationRental || r.jsonLdHasProduct).length;
  const successApollo = reports.filter((r) => r.apolloDeferredHasListing).length;
  const successNext   = reports.filter((r) => r.nextDataPresent && r.nextDataBytes > 1000).length;
  const blocked       = reports.filter((r) => r.blocked).length;
  const failedFetch   = reports.filter((r) => r.error).length;
  const anyAnchor     = reports.filter((r) =>
    r.jsonLdHasVacationRental || r.jsonLdHasProduct || r.apolloDeferredHasListing || (r.nextDataPresent && r.nextDataBytes > 1000),
  ).length;
  console.log(`  fetch failed:                       ${failedFetch}`);
  console.log(`  blocked (captcha/429/soft):         ${blocked}`);
  console.log(`  JSON-LD VacationRental/Product:     ${successJsonLd}`);
  console.log(`  Apollo data-deferred-state listing: ${successApollo}`);
  console.log(`  __NEXT_DATA__ (>1KB):               ${successNext}`);
  console.log(`  ANY structured anchor present:      ${anyAnchor}`);
  console.log(`  fully unrecoverable (no anchors):   ${reports.length - anyAnchor - failedFetch - blocked}`);
  console.log("\nHTML samples saved to /tmp/airbnb-probe-{id}.html");

  await closeBrowser();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
