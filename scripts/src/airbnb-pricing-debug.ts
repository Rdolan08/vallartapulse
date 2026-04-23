/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v4 — final SHA discovery for StaysPdpSections.
 *
 * Findings carried forward:
 *   v1: PdpAvailabilityCalendar = availability-only.
 *       v2 REST pdp_listing_booking_details = HTTP 404 retired.
 *   v2: StaysPdpSections is the right operation (PersistedQueryNotFound w/
 *       stale SHA, NOT route_not_found). PDP HTML structuredDisplayPrice
 *       is null at SSR (price hydrates client-side).
 *   v3: niobeClientData has 1 entry with shape [string, string] but my JSON
 *       parse of the signature found 0 SHAs — guessed wrong about shape.
 *       52 bundle URLs found but only 6 searched, all runtime/core, no
 *       operation maps.
 *
 * v4 probes — exhaustively pull the SHA from one of the two sources we know
 * have it:
 *   PROBE G — dump the niobeClientData[0][0] signature verbatim (first 800
 *     chars) so we can see the actual shape and write a correct extractor.
 *     Also tries multiple extractor strategies: JSON.parse, regex for
 *     sha256Hash, regex for any 64-hex string adjacent to "operationName".
 *   PROBE H — fetch ALL 52 bundle URLs in batches of 8 (parallel within a
 *     batch, sequential across batches to be polite). Search each for any
 *     operation→64hex mapping.
 *   PROBE I — if a SHA was found, retry StaysPdpSections and dump the
 *     structured price.
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

async function fetchPdpHtml(externalId: string): Promise<string> {
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
  console.log("PDP HTML fetch:", res.status);
  return await res.text();
}

function extractBlob(html: string): unknown | null {
  const m = /<script[^>]*id="data-deferred-state-0"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(
    html,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * PROBE G — dump niobeClientData[0][0] verbatim and try every extraction strategy.
 */
function probeNiobe(html: string): Array<{ operationName: string; sha: string }> {
  console.log(pad("PROBE G: niobeClientData verbatim + extraction"));
  const blob = extractBlob(html);
  if (!blob) {
    console.log("no deferred-state blob");
    return [];
  }
  const niobe = (blob as { niobeClientData?: unknown[] }).niobeClientData;
  if (!Array.isArray(niobe)) {
    console.log("no niobeClientData array");
    return [];
  }
  console.log(`niobeClientData has ${niobe.length} entries`);

  const out: Array<{ operationName: string; sha: string }> = [];
  for (let i = 0; i < niobe.length; i++) {
    const entry = niobe[i];
    if (!Array.isArray(entry)) {
      console.log(`  [${i}] not an array, type=${typeof entry}`);
      continue;
    }
    console.log(`  [${i}] array of length ${entry.length}; element types: ${entry.map((e) => typeof e).join(", ")}`);

    const sig = entry[0];
    if (typeof sig === "string") {
      console.log(`  [${i}][0] string, length ${sig.length}, first 800:`);
      console.log("    " + sig.slice(0, 800).replace(/\n/g, "\\n"));

      // Strategy 1: regex for any operationName + sha256Hash combo
      const opM = /operationName["']?\s*[:=]\s*["']([A-Za-z]+)["']/.exec(sig);
      const shaM = /sha256Hash["']?\s*[:=]\s*["']([a-f0-9]{64})["']/.exec(sig);
      if (opM) console.log(`    → opName regex: ${opM[1]}`);
      if (shaM) console.log(`    → sha regex: ${shaM[1]}`);
      if (opM && shaM) out.push({ operationName: opM[1], sha: shaM[1] });

      // Strategy 2: any 64-hex anywhere in sig
      const anyShas = sig.match(/[a-f0-9]{64}/g) ?? [];
      if (anyShas.length > 0) {
        console.log(`    → 64-hex hits in sig (up to 5): ${anyShas.slice(0, 5).join(", ")}`);
        // If we have an op name but no explicit sha match, pair it with the first 64-hex
        if (opM && !shaM && anyShas[0]) {
          out.push({ operationName: opM[1], sha: anyShas[0] });
        }
      }
    } else {
      console.log(`  [${i}][0] not a string, type=${typeof sig}, shape=${shapeOf(sig)}`);
    }
  }
  return out;
}

/**
 * PROBE H — search ALL bundle URLs for operation→sha mappings.
 */
async function probeBundles(html: string): Promise<Array<{ operationName: string; sha: string; from: string }>> {
  console.log(pad("PROBE H: exhaustive bundle search"));
  const urls = extractBundleUrls(html);
  console.log(`searching ${urls.length} bundles for operation SHAs…`);
  const ops = ["StaysPdpSections", "PdpAvailabilityCalendar", "StaysPdpReservationFlow", "StartStaysCheckout"];
  const found: Array<{ operationName: string; sha: string; from: string }> = [];
  const BATCH = 8;
  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (u) => {
        try {
          const r = await fetch(u, { headers: { "user-agent": UA, "accept": "*/*" } });
          if (!r.ok) return { url: u, hits: [] as Array<{ operationName: string; sha: string }> };
          const js = await r.text();
          const hits: Array<{ operationName: string; sha: string }> = [];
          for (const op of ops) {
            const re = new RegExp(`["']${op}["']\\s*[:=]\\s*["']([a-f0-9]{64})["']`);
            const m = re.exec(js);
            if (m) hits.push({ operationName: op, sha: m[1] });
          }
          return { url: u, hits };
        } catch {
          return { url: u, hits: [] as Array<{ operationName: string; sha: string }> };
        }
      }),
    );
    for (const r of results) {
      for (const h of r.hits) {
        found.push({ ...h, from: r.url.slice(-60) });
        console.log(`  ✓ ${h.operationName.padEnd(28)} ${h.sha}  (…${r.url.slice(-60)})`);
      }
    }
    // Early exit if we have what we need
    if (found.find((f) => f.operationName === "StaysPdpSections")) {
      console.log(`  (early exit at batch ${i / BATCH + 1} — found StaysPdpSections)`);
      break;
    }
  }
  console.log(`bundle search total: ${found.length} hits`);
  return found;
}

function extractBundleUrls(html: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /https:\/\/a0\.muscache\.com\/airbnb\/static\/[^"' ]+\.js/g,
    /<script[^>]+src="(https?:[^"]+\.js)"/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      out.add(m[1] ?? m[0]);
    }
  }
  return [...out];
}

async function tryStaysPdpSections(externalId: string, sha: string): Promise<void> {
  console.log(pad(`PROBE I: StaysPdpSections with SHA ${sha.slice(0, 12)}…`));
  const { checkin, checkout } = makeWindow(30, 3);
  for (const idVariant of [
    { label: "base64", id: Buffer.from(`StayListing:${externalId}`).toString("base64") },
    { label: "raw numeric", id: externalId },
  ]) {
    console.log(`\n— ${idVariant.label}`);
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
    const text = await res.text();
    console.log("BODY (first 600):", text.slice(0, 600));
    if (res.ok) {
      try {
        const json = JSON.parse(text);
        const sdpHits = findKeysAnywhere(json, [
          "structuredDisplayPrice",
          "priceBreakdown",
          "displayPrice",
          "price",
          "BOOK_IT_FLOATING_FOOTER",
        ]);
        const nonNull = sdpHits.filter((h) => h.value !== null);
        console.log(`SDP hits: ${sdpHits.length} (non-null: ${nonNull.length})`);
        const sdp = nonNull.find((h) => h.key === "structuredDisplayPrice");
        if (sdp) {
          console.log("\n*** WORKING PRICE PAYLOAD ***");
          console.log(JSON.stringify(sdp.value, null, 2).slice(0, 3500));
          return; // success — no need to try the other variant
        }
        // Print non-null hits with paths so I can see what's there
        for (const h of nonNull.slice(0, 10)) {
          console.log(`  [${h.key}] at ${h.path} → ${shapeOf(h.value, 0, 2)}`);
        }
      } catch (err) {
        console.log("JSON parse failed:", (err as Error).message);
      }
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
      if (wantedSet.has(k)) out.push({ key: k, path: `${path}.${k}`, value: val });
      walk(val, `${path}.${k}`, depth + 1);
    }
  }
  walk(root, "$", 0);
  return out;
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  const externalId = externalIdArg ?? DEFAULT_EXTERNAL_ID;
  console.log("starting airbnb-pricing-debug v4 — externalId:", externalId);

  console.log(pad("FETCH PDP HTML"));
  const html = await fetchPdpHtml(externalId);
  console.log("HTML length:", html.length);

  const niobeShas = probeNiobe(html);
  console.log(`\nniobe SHA extraction yielded: ${niobeShas.length}`);
  niobeShas.forEach((p) => console.log(`  ${p.operationName.padEnd(28)} ${p.sha}`));

  const bundleShas = await probeBundles(html);

  const bestSps =
    niobeShas.find((s) => s.operationName === "StaysPdpSections")?.sha ??
    bundleShas.find((s) => s.operationName === "StaysPdpSections")?.sha ??
    null;

  if (bestSps) {
    await tryStaysPdpSections(externalId, bestSps);
  } else {
    console.log(pad("PROBE I: SKIPPED — no StaysPdpSections SHA discovered"));
    console.log(
      "If we reached this with all 52 bundles searched and niobe verbatim dumped, " +
        "the next step is to run a headless browser (Playwright) to capture the " +
        "real XHR Airbnb makes — there is no static-discovery path.",
    );
  }

  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
