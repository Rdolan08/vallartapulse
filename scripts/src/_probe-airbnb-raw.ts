/**
 * Investigation-only: raw HTTP fetch via proxy (no browser).
 * Compares what Airbnb's SSR shell ships before client-side hydration.
 */
import { writeFile } from "node:fs/promises";

const PROXY_URL = process.env.PROXY_URL;
if (!PROXY_URL) { console.error("PROXY_URL not set"); process.exit(1); }

const URLS = [
  "https://www.airbnb.com/rooms/29764486",
  "https://www.airbnb.com/rooms/13935677",
  "https://www.airbnb.com/rooms/51332052",
  "https://www.airbnb.com/rooms/53860136",
  "https://www.airbnb.com/rooms/986576320529",
  "https://www.airbnb.com/rooms/142188006292",
  "https://www.airbnb.com/rooms/150230730061",
  "https://www.airbnb.com/rooms/162285620375",
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchOne(url: string): Promise<{ url: string; status: number | string; bytes: number; ms: number; html: string; err?: string }> {
  const t0 = Date.now();
  try {
    const { ProxyAgent } = await import("undici");
    const agent = new ProxyAgent(PROXY_URL!);
    const res = await fetch(url, {
      // @ts-expect-error: undici dispatcher
      dispatcher: agent,
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "accept-encoding": "gzip, deflate, br",
        "upgrade-insecure-requests": "1",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25_000),
    });
    const html = await res.text();
    return { url, status: res.status, bytes: html.length, ms: Date.now() - t0, html };
  } catch (e) {
    return { url, status: "err", bytes: 0, ms: Date.now() - t0, html: "", err: (e as Error).message?.slice(0, 200) };
  }
}

interface Anchors {
  jsonLdCount: number;
  jsonLdHasVacationRental: boolean;
  jsonLdHasProduct: boolean;
  apolloDeferredScripts: number;
  apolloDeferredHasListing: boolean;
  nextDataPresent: boolean;
  nextDataBytes: number;
  windowApolloAssign: boolean;
  niobeMinimalClient: boolean;
  vacationRentalKw: boolean;
  demandStayListingKw: boolean;
  bedroomKw: boolean;
  ogTitle: string | null;
  title: string | null;
}

function checkAnchors(html: string): Anchors {
  const ldBlocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const apolloDeferred = (html.match(/<script[^>]+id=["']data-deferred-state-\d+["'][^>]*>/gi) ?? []).length;
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  return {
    jsonLdCount: ldBlocks.length,
    jsonLdHasVacationRental: ldBlocks.some((b) => /"VacationRental"/i.test(b)),
    jsonLdHasProduct: ldBlocks.some((b) => /"Product"/i.test(b)),
    apolloDeferredScripts: apolloDeferred,
    apolloDeferredHasListing: /"DemandStayListing"/.test(html),
    nextDataPresent: !!nextData,
    nextDataBytes: nextData ? nextData[1].length : 0,
    windowApolloAssign: /window\.__APOLLO_STATE__\s*=/.test(html),
    niobeMinimalClient: /niobeMinimalClientState/.test(html),
    vacationRentalKw: /VacationRental/.test(html),
    demandStayListingKw: /DemandStayListing/.test(html),
    bedroomKw: /bedroom/i.test(html),
    ogTitle: (html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ?? null)?.slice(0, 100) ?? null,
    title: (html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null)?.slice(0, 100) ?? null,
  };
}

async function main() {
  console.log("Raw HTTP probe via proxy (no browser) ...\n");
  const results = await Promise.all(URLS.map(fetchOne));
  for (const r of results) {
    const id = r.url.match(/rooms\/(\d+)/)?.[1] ?? "?";
    await writeFile(`/tmp/airbnb-raw-${id}.html`, r.html).catch(() => {});
    if (r.err) {
      console.log(`id=${id} ERR ${r.err} (${r.ms}ms)`);
      continue;
    }
    const a = checkAnchors(r.html);
    console.log(`id=${id} status=${r.status} bytes=${r.bytes} ms=${r.ms}`);
    console.log(`  jsonLd:  ${a.jsonLdCount} blocks  vacationRental=${a.jsonLdHasVacationRental}  product=${a.jsonLdHasProduct}`);
    console.log(`  apollo:  deferredScripts=${a.apolloDeferredScripts}  hasListing=${a.apolloDeferredHasListing}`);
    console.log(`  nextData: present=${a.nextDataPresent}  bytes=${a.nextDataBytes}`);
    console.log(`  other:   windowApollo=${a.windowApolloAssign}  niobeMin=${a.niobeMinimalClient}  KW(VR=${a.vacationRentalKw} DSL=${a.demandStayListingKw} br=${a.bedroomKw})`);
    console.log(`  ogTitle: ${a.ogTitle ?? "(none)"}`);
    console.log(`  title:   ${a.title ?? "(none)"}`);
    console.log();
  }

  console.log("════ SUMMARY ════");
  const ok = results.filter((r) => !r.err && typeof r.status === "number" && r.status === 200);
  console.log(`http 200:  ${ok.length}/${results.length}`);
  const reports = ok.map((r) => checkAnchors(r.html));
  console.log(`  with JSON-LD VacationRental/Product:  ${reports.filter((a) => a.jsonLdHasVacationRental || a.jsonLdHasProduct).length}`);
  console.log(`  with Apollo DemandStayListing:         ${reports.filter((a) => a.apolloDeferredHasListing).length}`);
  console.log(`  with __NEXT_DATA__ payload (>1KB):     ${reports.filter((a) => a.nextDataPresent && a.nextDataBytes > 1000).length}`);
  console.log(`  with ANY structured anchor:            ${reports.filter((a) => a.jsonLdHasVacationRental || a.jsonLdHasProduct || a.apolloDeferredHasListing || (a.nextDataPresent && a.nextDataBytes > 1000)).length}`);
  console.log(`  with og:title (last-resort):           ${reports.filter((a) => a.ogTitle).length}`);
  console.log("\nHTML samples saved to /tmp/airbnb-raw-{id}.html");
  process.exit(0);
}
main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
