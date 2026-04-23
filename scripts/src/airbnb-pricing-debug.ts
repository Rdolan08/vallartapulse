/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v2 for the airbnb-pricing pipeline.
 *
 * Findings from v1 (commit a09d6ab):
 *   - PdpAvailabilityCalendar GraphQL returns availability-only — every
 *     `price.localPriceFormatted` is null and there's no `localPrice` field.
 *     Calendar adapter cannot ever produce nightly prices via this op.
 *   - v2 REST pdp_listing_booking_details is RETIRED (HTTP 404
 *     route_not_found, with or without `key=` param).
 *
 * v2 probe plan — find a working pricing path:
 *   PROBE A (highest priority): scrape PDP HTML with check_in/check_out
 *     query params. The booking-widget structured price is SSR'd into the
 *     `<script id="data-deferred-state-0" type="application/json">` blob.
 *     If we can parse fees/total out of this, we drop GraphQL entirely.
 *
 *   PROBE B: hit StaysPdpSections GraphQL with section_ids=BOOK_IT_FLOATING_FOOTER
 *     and check check_in/check_out. The modern unauthenticated price-quote
 *     path. Try with both raw numeric and base64-encoded listing IDs.
 *
 *   PROBE C: dump every 64-hex SHA referenced in the PDP HTML near a known
 *     operation name. Tells us if SHA rediscovery from PDP-only is even
 *     viable (vs needing a separate JS bundle fetch).
 *
 * Run from the Mac mini residential IP only. Replit/Railway will be IP-blocked
 * and lie about what a real run sees.
 *
 *     pnpm --filter @workspace/scripts run debug:airbnb-pricing
 *     pnpm --filter @workspace/scripts run debug:airbnb-pricing -- 1508818201576753078
 */

const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_EXTERNAL_ID = "1610096526897460312";

function pad(label: string): string {
  return `\n══════ ${label} ${"═".repeat(Math.max(0, 70 - label.length))}`;
}

function shapeOf(v: unknown, depth = 0, maxDepth = 4): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (depth >= maxDepth) return `[…${v.length}]`;
    return `[${v.length} × ${shapeOf(v[0], depth + 1, maxDepth)}]`;
  }
  const t = typeof v;
  if (t !== "object") return t;
  if (depth >= maxDepth) return "{…}";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return "{}";
  const inner = keys
    .slice(0, 12)
    .map((k) => `${k}: ${shapeOf(o[k], depth + 1, maxDepth)}`)
    .join(", ");
  const more = keys.length > 12 ? `, …+${keys.length - 12}` : "";
  return `{ ${inner}${more} }`;
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

/**
 * PROBE A — PDP HTML with check_in/check_out. Look for the structured price
 * in the SSR'd JSON blob.
 */
async function probePdpHtml(externalId: string): Promise<void> {
  console.log(pad("PROBE A: PDP HTML scrape (check_in/check_out)"));
  const { checkin, checkout } = makeWindow(30, 3);
  const url =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}?` +
    `check_in=${checkin}&check_out=${checkout}&adults=2`;
  console.log("URL:", url);
  console.log("WINDOW:", checkin, "→", checkout);
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  console.log("HTTP:", res.status, "→", res.url);
  if (!res.ok) {
    console.log("BODY (first 400):", (await res.text()).slice(0, 400));
    return;
  }
  const html = await res.text();
  console.log("HTML length:", html.length);

  // Look for the deferred-state JSON blob.
  const blobMatch = /<script[^>]*id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!blobMatch) {
    console.log("NO data-deferred-state-0 blob found. Searching for any data-deferred-state…");
    const anyBlob = /<script[^>]*id="(data-deferred-state[^"]*)"/g;
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = anyBlob.exec(html)) !== null) ids.push(m[1]);
    console.log("found script IDs:", ids.slice(0, 10).join(", ") || "(none)");
    return;
  }
  const raw = blobMatch[1];
  console.log("blob length:", raw.length);

  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch (err) {
    console.log("blob JSON parse failed:", (err as Error).message);
    console.log("blob first 200:", raw.slice(0, 200));
    return;
  }
  console.log("blob top-level shape:", shapeOf(blob, 0, 3));

  // Hunt for fields that look like price breakdown — search the whole tree
  // for keys we expect: structuredDisplayPrice, priceBreakdown, total, etc.
  const hits = findKeysAnywhere(blob, [
    "structuredDisplayPrice",
    "priceBreakdown",
    "explanationData",
    "BOOK_IT_FLOATING_FOOTER",
    "BOOK_IT_SIDEBAR",
    "totalPrice",
    "displayPrice",
    "rate",
    "cleaningFee",
  ]);
  console.log("\nKEY HITS in blob:");
  for (const h of hits.slice(0, 20)) {
    console.log(`  [${h.key}] at ${h.path} → ${shapeOf(h.value, 0, 2)}`);
  }

  // If we find structuredDisplayPrice, dump the first hit fully.
  const sdp = hits.find((h) => h.key === "structuredDisplayPrice");
  if (sdp) {
    console.log("\nFULL structuredDisplayPrice (first found):");
    console.log(JSON.stringify(sdp.value, null, 2).slice(0, 2500));
  } else {
    console.log("\nNO structuredDisplayPrice found — sample of blob keys:");
    if (typeof blob === "object" && blob !== null) {
      console.log(Object.keys(blob as Record<string, unknown>).slice(0, 20).join(", "));
    }
  }
}

/**
 * PROBE B — StaysPdpSections GraphQL. Try a known-recent SHA bootstrap with
 * both raw numeric and base64 ID encodings.
 */
async function probeStaysPdpSections(externalId: string): Promise<void> {
  console.log(pad("PROBE B: StaysPdpSections GraphQL"));
  // Known-recent (late 2025) bootstrap SHA. May be stale.
  const sha = "f70b9f30bf25fa1b3b3937a7e6b5fa46905a6cda6fd25dcf71cf42c624a5cdaf";
  const { checkin, checkout } = makeWindow(30, 3);

  for (const idVariant of [
    { label: "raw numeric", id: externalId },
    { label: "base64", id: Buffer.from(`StayListing:${externalId}`).toString("base64") },
  ]) {
    console.log(`\n— variant: ${idVariant.label} (id=${idVariant.id.slice(0, 60)}…)`);
    const variables = {
      id: idVariant.id,
      pdpSectionsRequest: {
        adults: "2",
        children: null,
        infants: null,
        pets: 0,
        layouts: ["SIDEBAR", "SINGLE_COLUMN"],
        sectionIds: ["BOOK_IT_FLOATING_FOOTER", "BOOK_IT_SIDEBAR"],
        checkIn: checkin,
        checkOut: checkout,
      },
    };
    const extensions = { persistedQuery: { version: 1, sha256Hash: sha } };
    const url =
      `https://www.airbnb.com/api/v3/StaysPdpSections/${sha}?` +
      `operationName=StaysPdpSections&locale=en&currency=USD&` +
      `variables=${encodeURIComponent(JSON.stringify(variables))}&` +
      `extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "x-airbnb-api-key": AIRBNB_API_KEY,
        "x-airbnb-graphql-platform": "web",
        "x-airbnb-graphql-platform-client": "minimalist-niobe",
      },
    });
    console.log("HTTP:", res.status);
    const body = await res.text();
    console.log("BODY (first 600):", body.slice(0, 600));
  }
}

/**
 * PROBE C — dump every 64-hex SHA found near operation names in PDP HTML.
 */
async function probeShaDiscovery(externalId: string): Promise<void> {
  console.log(pad("PROBE C: SHA discovery from PDP HTML"));
  const url = `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}`;
  const res = await fetch(url, { headers: { "user-agent": UA } });
  console.log("HTTP:", res.status);
  if (!res.ok) return;
  const html = await res.text();
  const ops = ["PdpAvailabilityCalendar", "StaysPdpSections", "StaysPdpReservation", "StartStaysCheckout"];
  for (const op of ops) {
    const re = new RegExp(`"${op}"\\s*:\\s*"([a-f0-9]{64})"`);
    const m = re.exec(html);
    if (m) {
      console.log(`  ${op}: ${m[1]}`);
    } else {
      // Try a looser search: the op name appearing within 200 chars of a 64-hex string
      const loose = new RegExp(
        `${op}[\\s\\S]{0,300}?([a-f0-9]{64})|([a-f0-9]{64})[\\s\\S]{0,300}?${op}`,
      );
      const m2 = loose.exec(html);
      if (m2) console.log(`  ${op}: ${m2[1] ?? m2[2]} (loose match)`);
      else console.log(`  ${op}: NOT FOUND in PDP HTML`);
    }
  }

  // Also: list any _next/static or similar JS bundle URLs we'd need to fetch
  // for a deeper SHA hunt.
  const bundles: string[] = [];
  const bundleRe = /(https:\/\/[a-z0-9.-]+\/_next\/static\/[^"']+\.js|src="(\/static\/[^"]+\.js)")/gi;
  let bm: RegExpExecArray | null;
  while ((bm = bundleRe.exec(html)) !== null) {
    bundles.push(bm[0]);
    if (bundles.length >= 5) break;
  }
  console.log("first JS bundle refs (up to 5):", bundles.length ? bundles : "(none)");
}

/**
 * Walk an arbitrary JSON value and return locations of any keys matching
 * `wanted`. Used to find pricing-shaped data in the deferred-state blob.
 */
function findKeysAnywhere(
  root: unknown,
  wanted: string[],
): Array<{ key: string; path: string; value: unknown }> {
  const out: Array<{ key: string; path: string; value: unknown }> = [];
  const wantedSet = new Set(wanted);
  function walk(v: unknown, path: string, depth: number): void {
    if (depth > 18) return;
    if (out.length > 60) return;
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 50); i++) walk(v[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (wantedSet.has(k)) {
        out.push({ key: k, path: `${path}.${k}`, value: val });
      }
      walk(val, `${path}.${k}`, depth + 1);
    }
  }
  walk(root, "$", 0);
  return out;
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  const externalId = externalIdArg ?? DEFAULT_EXTERNAL_ID;
  console.log("starting airbnb-pricing-debug v2 — externalId:", externalId);
  await probePdpHtml(externalId);
  await probeStaysPdpSections(externalId);
  await probeShaDiscovery(externalId);
  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
