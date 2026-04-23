/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v3 — final SHA hunt for StaysPdpSections.
 *
 * Findings carried forward:
 *   v1: PdpAvailabilityCalendar = availability-only, no prices.
 *       v2 REST pdp_listing_booking_details = HTTP 404, retired.
 *   v2: PDP HTML SSR's structuredDisplayPrice as null (price hydrated client-side).
 *       StaysPdpSections is the right operation (returned PersistedQueryNotFound
 *       with HTTP 400, NOT route_not_found like the dead v2 REST). We just
 *       need its current SHA.
 *
 * v3 probe plan — get a working SHA:
 *   PROBE D: parse the niobeClientData entries from the SSR'd blob. Each
 *     entry is [request_json, response_json] — the request contains
 *     extensions.persistedQuery.sha256Hash. Print every (operationName, sha)
 *     pair found. This is how Airbnb's own SSR recorded the SHAs the
 *     browser then used for client-side fetches.
 *   PROBE E: extract every a0.muscache.com bundle URL from PDP HTML, fetch
 *     up to the first 6, search each for `"StaysPdpSections":"<64hex>"`
 *     and `"PdpAvailabilityCalendar":"<64hex>"`. Backup discovery path
 *     for any operation niobeClientData didn't carry.
 *   PROBE F: if probes D or E found a SHA for StaysPdpSections, immediately
 *     retry the GraphQL call with it and dump the structured price.
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

async function fetchPdpHtml(externalId: string): Promise<{ html: string; url: string }> {
  const { checkin, checkout } = makeWindow(30, 3);
  const url =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}?` +
    `check_in=${checkin}&check_out=${checkout}&adults=2`;
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  console.log("PDP HTML fetch:", res.status, "→ length:", (await res.clone().text()).length);
  return { html: await res.text(), url };
}

/**
 * Walk niobeClientData and return every (operationName, sha256Hash) pair
 * we can extract from request signatures. Airbnb's SSR recorder serializes
 * each Apollo request as JSON containing extensions.persistedQuery.sha256Hash.
 */
function extractShasFromNiobe(html: string): Array<{ operationName: string; sha: string }> {
  const out: Array<{ operationName: string; sha: string }> = [];
  const blobMatch = /<script[^>]*id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!blobMatch) return out;
  let blob: unknown;
  try {
    blob = JSON.parse(blobMatch[1]);
  } catch {
    return out;
  }
  // niobeClientData is typically [ [requestSignatureString, responseJsonString], ... ]
  const niobe = (blob as { niobeClientData?: unknown[] }).niobeClientData;
  if (!Array.isArray(niobe)) return out;

  for (const entry of niobe) {
    if (!Array.isArray(entry) || entry.length < 1) continue;
    const sig = entry[0];
    if (typeof sig !== "string") continue;
    // The signature is a JSON-stringified Apollo request — parse and pull sha + opName
    try {
      const parsed = JSON.parse(sig);
      const opName =
        (parsed?.operationName as string | undefined) ??
        (parsed?.name as string | undefined) ??
        "unknown";
      const sha =
        parsed?.extensions?.persistedQuery?.sha256Hash ??
        parsed?.queryHash ??
        parsed?.sha ??
        null;
      if (typeof sha === "string" && /^[a-f0-9]{64}$/i.test(sha)) {
        out.push({ operationName: opName, sha });
      }
    } catch {
      // signature isn't pure JSON — try regex fallback on the raw string
      const opM = /"operationName"\s*:\s*"([^"]+)"/.exec(sig);
      const shaM = /"sha256Hash"\s*:\s*"([a-f0-9]{64})"/.exec(sig);
      if (opM && shaM) out.push({ operationName: opM[1], sha: shaM[1] });
    }
  }
  return out;
}

function extractBundleUrls(html: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /https:\/\/a0\.muscache\.com\/airbnb\/static\/[^"' ]+\.js/g,
    /https:\/\/[a-z0-9.-]+\/[^"' ]+\/packages\/[^"' ]+\.js/g,
    /<script[^>]+src="([^"]+\.js)"/g,
    /<link[^>]+rel="preload"[^>]+as="script"[^>]+href="([^"]+\.js)"/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const u = m[1] ?? m[0];
      if (u.startsWith("//")) out.add("https:" + u);
      else if (u.startsWith("/")) out.add("https://www.airbnb.com" + u);
      else out.add(u);
    }
  }
  return [...out];
}

async function searchBundleForShas(
  bundleUrl: string,
  ops: string[],
): Promise<Array<{ operationName: string; sha: string }>> {
  try {
    const res = await fetch(bundleUrl, { headers: { "user-agent": UA, "accept": "*/*" } });
    if (!res.ok) return [];
    const js = await res.text();
    const out: Array<{ operationName: string; sha: string }> = [];
    for (const op of ops) {
      const re = new RegExp(`"${op}"\\s*:\\s*"([a-f0-9]{64})"`);
      const m = re.exec(js);
      if (m) out.push({ operationName: op, sha: m[1] });
    }
    return out;
  } catch {
    return [];
  }
}

async function tryStaysPdpSections(externalId: string, sha: string): Promise<void> {
  console.log(pad(`PROBE F: StaysPdpSections with discovered SHA ${sha.slice(0, 12)}…`));
  const { checkin, checkout } = makeWindow(30, 3);
  const variables = {
    id: Buffer.from(`StayListing:${externalId}`).toString("base64"),
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
  const text = await res.text();
  console.log("BODY (first 500):", text.slice(0, 500));
  if (res.ok) {
    try {
      const json = JSON.parse(text);
      console.log("\nshape:", shapeOf(json, 0, 3));
      // Hunt for structuredDisplayPrice that ISN'T null
      const sdpHits = findKeysAnywhere(json, ["structuredDisplayPrice", "priceBreakdown", "BOOK_IT_FLOATING_FOOTER"]);
      const nonNullSdp = sdpHits.filter((h) => h.value !== null);
      console.log(`structuredDisplayPrice hits: ${sdpHits.length} (non-null: ${nonNullSdp.length})`);
      if (nonNullSdp.length > 0) {
        console.log("\nFIRST NON-NULL structuredDisplayPrice (truncated 3000):");
        console.log(JSON.stringify(nonNullSdp[0].value, null, 2).slice(0, 3000));
      } else if (sdpHits.length > 0) {
        // Even all-null is informative
        console.log("(all SDP hits were null — section ids might be wrong, try with no checkin to see what sections are available)");
      }
    } catch (err) {
      console.log("JSON parse failed:", (err as Error).message);
    }
  }
}

function findKeysAnywhere(
  root: unknown,
  wanted: string[],
): Array<{ key: string; path: string; value: unknown }> {
  const out: Array<{ key: string; path: string; value: unknown }> = [];
  const wantedSet = new Set(wanted);
  function walk(v: unknown, path: string, depth: number): void {
    if (depth > 18) return;
    if (out.length > 80) return;
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
  console.log("starting airbnb-pricing-debug v3 — externalId:", externalId);

  console.log(pad("FETCH PDP HTML"));
  const { html } = await fetchPdpHtml(externalId);

  console.log(pad("PROBE D: SHAs from niobeClientData SSR payload"));
  const niobeShas = extractShasFromNiobe(html);
  console.log(`found ${niobeShas.length} (operationName, sha) pairs in niobeClientData:`);
  for (const p of niobeShas) {
    console.log(`  ${p.operationName.padEnd(32)} ${p.sha}`);
  }

  console.log(pad("PROBE E: bundle URL hunt"));
  const bundles = extractBundleUrls(html);
  console.log(`found ${bundles.length} candidate JS bundle URLs (showing first 8):`);
  bundles.slice(0, 8).forEach((u) => console.log(`  ${u.slice(0, 140)}`));

  const ops = ["StaysPdpSections", "PdpAvailabilityCalendar", "StaysPdpReservationFlow"];
  const bundleShas: Array<{ operationName: string; sha: string; from: string }> = [];
  // Try the first 6 bundle URLs (we don't want to spam Airbnb)
  for (const u of bundles.slice(0, 6)) {
    const found = await searchBundleForShas(u, ops);
    for (const f of found) {
      bundleShas.push({ ...f, from: u.slice(0, 80) });
    }
    if (bundleShas.find((b) => b.operationName === "StaysPdpSections")) break; // we have what we need
  }
  console.log(`\nbundle SHA results: ${bundleShas.length}`);
  for (const b of bundleShas) {
    console.log(`  ${b.operationName.padEnd(28)} ${b.sha}  (from ${b.from})`);
  }

  // Pick best SHA for StaysPdpSections — prefer niobe (matches what real browser used)
  const bestSps =
    niobeShas.find((s) => s.operationName === "StaysPdpSections")?.sha ??
    bundleShas.find((s) => s.operationName === "StaysPdpSections")?.sha ??
    null;

  if (bestSps) {
    await tryStaysPdpSections(externalId, bestSps);
  } else {
    console.log(pad("PROBE F: SKIPPED — no StaysPdpSections SHA discovered"));
    console.log("Next steps if this happens: increase bundle search depth, or try POST with full query inline.");
  }

  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
