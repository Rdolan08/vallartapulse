/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v6 — Playwright XHR interception.
 *
 * All static-discovery paths are now confirmed dead:
 *   v1: PdpAvailabilityCalendar = availability-only.
 *       v2 REST pdp_listing_booking_details = HTTP 404 retired.
 *   v2: StaysPdpSections is the right operation; SHA is stale.
 *   v3: niobeClientData[0][0] is the Apollo cache key (operationName +
 *       canonical variables), not a request — no SHA inside.
 *   v4: All 52 top-level bundles searched — 0 SHA mappings (chunks are
 *       lazy-loaded via webpack asyncRequire, not in static <script src>s).
 *   v5: PDP SSR response (niobeClientData[0][1]) has bookingPrefetchData.
 *       barPrice = null and structuredDisplayPrice = null on every section.
 *       Pricing is genuinely loaded client-side after hydration.
 *
 * v6 — let real Airbnb JS execute and intercept the actual XHR:
 *   1. Launch headless Chromium.
 *   2. Register response listener for any URL matching /api/v3/StaysPdpSections/.
 *   3. Navigate to the PDP with check_in/check_out.
 *   4. Wait for the price XHR to land (or timeout).
 *   5. Print:
 *        - The request URL (contains live SHA in the path).
 *        - The response status, top-level shape.
 *        - Any non-null structuredDisplayPrice payload.
 *        - The extracted SHA so we can use it for direct fetches.
 *   6. As a follow-up bonus: with the SHA captured, do a direct fetch (no
 *      browser) for a different window to prove the SHA is reusable.
 *
 * Mac mini setup (one-time):
 *   pnpm install
 *   pnpm exec playwright install chromium
 */

import { chromium, type Browser, type Page, type Response } from "playwright";

const DEFAULT_EXTERNAL_ID = "1610096526897460312";
const NAV_TIMEOUT_MS = 30_000;
const PRICE_WAIT_MS = 25_000;

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

function shapeOf(v: unknown, depth = 0, maxDepth = 3): string {
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
    .slice(0, 10)
    .map((k) => `${k}: ${shapeOf(o[k], depth + 1, maxDepth)}`)
    .join(", ");
  const more = keys.length > 10 ? `, …+${keys.length - 10}` : "";
  return `{ ${inner}${more} }`;
}

function findKeysAnywhere(
  root: unknown,
  wanted: string[],
): Array<{ key: string; path: string; value: unknown }> {
  const out: Array<{ key: string; path: string; value: unknown }> = [];
  const wantedSet = new Set(wanted);
  function walk(v: unknown, path: string, depth: number): void {
    if (depth > 20 || out.length > 200) return;
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 100); i++) walk(v[i], `${path}[${i}]`, depth + 1);
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

interface CapturedXhr {
  url: string;
  status: number;
  body: string;
  sha: string | null;
}

async function captureStaysPdpSectionsXhr(
  page: Page,
  pdpUrl: string,
): Promise<CapturedXhr[]> {
  const captured: CapturedXhr[] = [];

  page.on("response", async (response: Response) => {
    const url = response.url();
    if (!url.includes("/api/v3/StaysPdpSections")) return;
    try {
      const body = await response.text();
      const shaMatch = /\/api\/v3\/StaysPdpSections\/([a-f0-9]{64})/.exec(url);
      captured.push({
        url,
        status: response.status(),
        body,
        sha: shaMatch ? shaMatch[1] : null,
      });
      console.log(
        `  ✓ intercepted StaysPdpSections XHR — status=${response.status()}, ` +
          `body bytes=${body.length}, sha=${shaMatch ? shaMatch[1].slice(0, 16) + "…" : "(none)"}`,
      );
    } catch (err) {
      console.log(`  ✗ failed to read XHR body: ${(err as Error).message}`);
    }
  });

  console.log(`navigating to ${pdpUrl}`);
  await page.goto(pdpUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS }).catch((err) => {
    console.log(`  navigation warning: ${(err as Error).message}`);
  });

  // Give XHRs a chance to fire after networkidle (price often lands a beat later)
  console.log(`waiting up to ${PRICE_WAIT_MS}ms for StaysPdpSections XHR…`);
  const start = Date.now();
  while (captured.length === 0 && Date.now() - start < PRICE_WAIT_MS) {
    await page.waitForTimeout(500);
  }
  return captured;
}

async function probeWithBrowser(
  browser: Browser,
  externalId: string,
  daysOut: number,
  nights: number,
  label: string,
): Promise<string | null> {
  console.log(pad(`PROBE [${label}]`));
  const { checkin, checkout } = makeWindow(daysOut, nights);
  const pdpUrl =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}?` +
    `check_in=${checkin}&check_out=${checkout}&adults=2`;

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  let foundSha: string | null = null;
  try {
    const captured = await captureStaysPdpSectionsXhr(page, pdpUrl);
    console.log(`captured ${captured.length} StaysPdpSections XHR(s)`);
    for (let i = 0; i < captured.length; i++) {
      const x = captured[i];
      console.log(`\n— XHR #${i + 1}`);
      console.log(`  URL: ${x.url.slice(0, 200)}${x.url.length > 200 ? "…" : ""}`);
      console.log(`  status: ${x.status}`);
      console.log(`  sha: ${x.sha ?? "(not in URL — POST body?)"}`);
      if (x.sha && !foundSha) foundSha = x.sha;
      if (x.status >= 200 && x.status < 300) {
        try {
          const json = JSON.parse(x.body);
          console.log(`  shape: ${shapeOf(json, 0, 3)}`);
          const sdpHits = findKeysAnywhere(json, ["structuredDisplayPrice"]);
          const nonNull = sdpHits.filter((h) => h.value !== null);
          console.log(`  structuredDisplayPrice hits: ${sdpHits.length} (non-null: ${nonNull.length})`);
          if (nonNull.length > 0) {
            console.log(`\n  *** WORKING PRICE PAYLOAD (XHR #${i + 1}) ***`);
            console.log(`  path: ${nonNull[0].path}`);
            console.log(JSON.stringify(nonNull[0].value, null, 2).slice(0, 4000));
          }
        } catch (err) {
          console.log(`  body preview (not JSON): ${x.body.slice(0, 300)}`);
        }
      } else {
        console.log(`  body preview: ${x.body.slice(0, 300)}`);
      }
    }
  } finally {
    await context.close();
  }
  return foundSha;
}

async function tryDirectFetch(externalId: string, sha: string, daysOut: number, nights: number): Promise<void> {
  console.log(pad(`DIRECT FETCH with captured SHA ${sha.slice(0, 12)}…`));
  const { checkin, checkout } = makeWindow(daysOut, nights);
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
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "x-airbnb-api-key": "d306zoyjsyarp7ifhu67rjxn52tv0t20",
      "x-airbnb-graphql-platform": "web",
      "x-airbnb-graphql-platform-client": "minimalist-niobe",
    },
  });
  console.log("HTTP:", res.status);
  const text = await res.text();
  console.log("body bytes:", text.length, "first 400:", text.slice(0, 400));
  if (res.ok) {
    try {
      const json = JSON.parse(text);
      const nonNull = findKeysAnywhere(json, ["structuredDisplayPrice"]).filter((h) => h.value !== null);
      console.log(`structuredDisplayPrice non-null hits: ${nonNull.length}`);
      if (nonNull.length > 0) {
        console.log("\n*** DIRECT FETCH SUCCESS — production adapter can use this exact pattern ***");
        console.log(JSON.stringify(nonNull[0].value, null, 2).slice(0, 3000));
      }
    } catch (err) {
      console.log("parse failed:", (err as Error).message);
    }
  }
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  const externalId = externalIdArg ?? DEFAULT_EXTERNAL_ID;
  console.log("starting airbnb-pricing-debug v6 (Playwright) — externalId:", externalId);

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    console.log("chromium launched");

    const sha1 = await probeWithBrowser(browser, externalId, 30, 3, "30d-out / 3 nights");

    if (sha1) {
      // Prove the captured SHA is reusable for direct fetches with a different window
      await tryDirectFetch(externalId, sha1, 60, 7);
    } else {
      console.log(pad("NO SHA CAPTURED"));
      console.log("Possible reasons: page didn't make XHR within timeout, Airbnb served");
      console.log("a captcha/challenge, or operation name changed. Increase PRICE_WAIT_MS or");
      console.log("inspect with headless: false locally to see what the page actually shows.");
    }
  } finally {
    if (browser) await browser.close();
    console.log(pad("DONE"));
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
