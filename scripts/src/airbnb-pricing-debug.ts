/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v5 — definitive: does the PDP HTML already contain the price?
 *
 * Findings carried forward (all the dead ends):
 *   v1: PdpAvailabilityCalendar = availability-only (no prices).
 *       v2 REST pdp_listing_booking_details = HTTP 404 retired.
 *   v2: StaysPdpSections is the right operation. PDP-blob structuredDisplayPrice
 *       fields are null (price hydrates client-side).
 *   v3: niobeClientData has 1 entry; my SHA extractor guessed wrong shape.
 *   v4: Verbatim niobeClientData[0][0] is NOT a JSON Apollo request — it's an
 *       Apollo CACHE KEY in the form `<operationName>:<canonicalVariablesJson>`.
 *       Contains operationName + variables but NO SHA. All 52 bundles searched
 *       exhaustively for `"<op>":"<64hex>"` — 0 hits. SHA is not statically
 *       discoverable from PDP HTML or top-level bundles.
 *
 * BUT — niobeClientData[0][1] is the FULL response object Airbnb already
 * SSR'd into the page. It's exactly what the browser would have gotten back
 * from the GraphQL call. The previous "structuredDisplayPrice = null" hit
 * search only checked one field name. Modern Airbnb sometimes carries the
 * price under different keys (priceDisplayString, displayPrice, p3DisplayRate,
 * priceWithoutDiscount, displayPriceComponents, etc.).
 *
 * v5 probe — definitive answer:
 *   PROBE J: walk niobeClientData[0][1] and collect EVERY field whose key OR
 *     value (when stringified) contains "price", "total", "amount", "rate",
 *     "fee", "cost", "USD", "$", or matches a price-shaped number. Print
 *     each with path + value preview. If any non-null price-shaped field
 *     exists in the SSR response, we drop GraphQL entirely and scrape the
 *     PDP HTML directly — no SHA management, no auth, no anti-bot risk
 *     beyond the same load a browser makes.
 *
 *     If nothing useful is found, we have to escalate to a Playwright-based
 *     XHR interception adapter (capture the live SHA from the actual
 *     hydrated browser request).
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_EXTERNAL_ID = "1610096526897460312";

function pad(label: string): string {
  return `\n══════ ${label} ${"═".repeat(Math.max(0, 70 - label.length))}`;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function makeWindow(daysOut: number, nights: number): { checkin: string; checkout: string } {
  const ci = new Date();
  ci.setUTCDate(ci.getUTCDate() + daysOut);
  const co = new Date(ci);
  co.setUTCDate(co.getUTCDate() + nights);
  return { checkin: fmtDate(ci), checkout: fmtDate(co) };
}

async function fetchPdpHtml(externalId: string, window: { checkin: string; checkout: string }): Promise<string> {
  const url =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}?` +
    `check_in=${window.checkin}&check_out=${window.checkout}&adults=2`;
  console.log("URL:", url);
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  console.log("HTTP:", res.status);
  return await res.text();
}

function extractNiobeResponse(html: string): unknown | null {
  const m = /<script[^>]*id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!m) return null;
  let blob: unknown;
  try {
    blob = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const niobe = (blob as { niobeClientData?: unknown[] }).niobeClientData;
  if (!Array.isArray(niobe) || niobe.length === 0) return null;
  const entry = niobe[0];
  if (!Array.isArray(entry) || entry.length < 2) return null;
  return entry[1]; // the response object
}

const PRICE_KEY_RE = /price|total|amount|rate|fee|cost|charge|payment|booking|usd|mxn/i;
const PRICE_VALUE_RE = /\$|USD|MXN|MX\$|peso|priceless|dollar|night|guest|^\d{1,5}(?:[.,]\d{2})?$/i;

interface PriceHit {
  path: string;
  key: string;
  type: string;
  preview: string;
}

function huntPriceFields(root: unknown, maxHits = 80): PriceHit[] {
  const out: PriceHit[] = [];
  function preview(v: unknown): string {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return (s ?? "").slice(0, 200);
    } catch {
      return String(v).slice(0, 200);
    }
  }
  function walk(v: unknown, path: string, depth: number): void {
    if (out.length >= maxHits) return;
    if (depth > 30) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 100); i++) walk(v[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const keyMatches = PRICE_KEY_RE.test(k);
      let valMatches = false;
      if (typeof val === "string" && PRICE_VALUE_RE.test(val)) valMatches = true;
      if (keyMatches || valMatches) {
        // Only record if the value is non-null/non-empty and looks meaningful
        const isMeaningful =
          val !== null &&
          val !== undefined &&
          val !== "" &&
          !(Array.isArray(val) && val.length === 0) &&
          !(typeof val === "object" && Object.keys(val as object).length === 0);
        if (isMeaningful) {
          out.push({
            path: `${path}.${k}`,
            key: k,
            type: Array.isArray(val) ? `array[${val.length}]` : typeof val,
            preview: preview(val),
          });
        }
      }
      walk(val, `${path}.${k}`, depth + 1);
    }
  }
  walk(root, "$", 0);
  return out;
}

async function probe(externalId: string, daysOut: number, nights: number, label: string): Promise<void> {
  console.log(pad(`PROBE J [${label}]: search PDP SSR response for price fields`));
  const window = makeWindow(daysOut, nights);
  console.log(`window: ${window.checkin} → ${window.checkout} (${nights} nights)`);
  const html = await fetchPdpHtml(externalId, window);
  console.log("HTML length:", html.length);
  const response = extractNiobeResponse(html);
  if (!response) {
    console.log("could not extract niobe response");
    return;
  }
  console.log("niobe response top-level keys:", Object.keys(response as object).join(", "));

  const hits = huntPriceFields(response);
  console.log(`\nfound ${hits.length} price-shaped fields with non-empty values:`);
  // Group by key for readability
  const byKey = new Map<string, PriceHit[]>();
  for (const h of hits) {
    if (!byKey.has(h.key)) byKey.set(h.key, []);
    byKey.get(h.key)!.push(h);
  }
  // Sort keys by hit count desc, show top hits
  const sortedKeys = [...byKey.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, list] of sortedKeys) {
    console.log(`\n[${key}] ×${list.length}`);
    for (const h of list.slice(0, 3)) {
      console.log(`  ${h.path}`);
      console.log(`    type=${h.type}  preview: ${h.preview}`);
    }
    if (list.length > 3) console.log(`  …+${list.length - 3} more`);
  }
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  const externalId = externalIdArg ?? DEFAULT_EXTERNAL_ID;
  console.log("starting airbnb-pricing-debug v5 — externalId:", externalId);
  // Two windows so we can confirm the price field actually changes with dates
  // (proving it's a real per-window quote, not a static rate card)
  await probe(externalId, 30, 3, "30d-out / 3 nights");
  await probe(externalId, 60, 7, "60d-out / 7 nights");
  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
