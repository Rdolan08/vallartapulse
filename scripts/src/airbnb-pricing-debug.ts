/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic v7 — capture EVERY /api/v3/ request the browser makes.
 *
 * v6 wins: live SHA captured (00d95994294488977b...), browser's own
 *   StaysPdpSections XHR returned 200 + 64KB body.
 * v6 gaps:
 *   (1) structuredDisplayPrice is null in all 4 hits even in the BROWSER's
 *       own response. So either price lives under a different key, OR
 *       there's a separate pricing XHR we're not intercepting.
 *   (2) Direct fetch with captured SHA returned ValidationError at column 34
 *       of variables. Browser URL has no variables in query string →
 *       it's a POST, not a GET. Our hand-crafted variables shape is wrong.
 *
 * v7 plan:
 *   A) Intercept ALL /api/v3/ requests/responses (not just StaysPdpSections).
 *      Print method, URL, request body, response body size for each. This
 *      reveals any secondary pricing XHR (StaysPdpReservation, ChinaProduct…,
 *      etc.).
 *   B) For each /api/v3/ response: deep-search for any non-null field whose
 *      key matches /price|amount|total|rate|fee|cost|charge|payment/i AND
 *      value is a string OR has a nested {amount, currencyCode}. Print
 *      every hit with path + preview.
 *   C) Replay the exact captured request body as POST against the captured
 *      URL. Should return identical bytes → validates the production
 *      adapter pattern (one browser launch per refresh to grab SHA + canon
 *      request body, then plain POST for every quote).
 */

import { chromium, type Browser, type Page, type Request, type Response } from "playwright";

const DEFAULT_EXTERNAL_ID = "1610096526897460312";
const NAV_TIMEOUT_MS = 20_000;
const PRICE_WAIT_MS = 30_000;

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

const PRICE_KEY_RE = /price|amount|total|rate|fee|cost|charge|payment|night|stay/i;

interface PriceHit {
  path: string;
  key: string;
  preview: string;
}

function huntPrice(root: unknown): PriceHit[] {
  const out: PriceHit[] = [];
  function preview(v: unknown): string {
    try {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return (s ?? "").slice(0, 250);
    } catch {
      return String(v).slice(0, 250);
    }
  }
  function walk(v: unknown, path: string, depth: number): void {
    if (out.length >= 120) return;
    if (depth > 25) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) {
      for (let i = 0; i < Math.min(v.length, 80); i++) walk(v[i], `${path}[${i}]`, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (PRICE_KEY_RE.test(k)) {
        const meaningful =
          val !== null &&
          val !== undefined &&
          val !== "" &&
          !(Array.isArray(val) && val.length === 0) &&
          !(typeof val === "object" && Object.keys(val as object).length === 0);
        if (meaningful) {
          // Filter junk: skip pure logging-id strings + ratings under 100 (counts/reviews)
          const isLoggingId = typeof val === "string" && /^pdp\.|loggingId|component$/i.test(val);
          if (!isLoggingId) {
            out.push({ path: `${path}.${k}`, key: k, preview: preview(val) });
          }
        }
      }
      walk(val, `${path}.${k}`, depth + 1);
    }
  }
  walk(root, "$", 0);
  return out;
}

interface CapturedXhr {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
}

async function captureV3Traffic(page: Page, pdpUrl: string): Promise<CapturedXhr[]> {
  const captured: CapturedXhr[] = [];
  const reqByUrlMethod = new Map<string, Request>();

  page.on("request", (req: Request) => {
    if (req.url().includes("/api/v3/")) {
      reqByUrlMethod.set(`${req.method()} ${req.url()}`, req);
    }
  });

  page.on("response", async (response: Response) => {
    const url = response.url();
    if (!url.includes("/api/v3/")) return;
    const req = response.request();
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "(unreadable)";
    }
    let postData: string | null = null;
    try {
      postData = req.postData();
    } catch {
      postData = null;
    }
    captured.push({
      url,
      method: req.method(),
      requestHeaders: await req.allHeaders().catch(() => ({})),
      requestBody: postData,
      status: response.status(),
      responseHeaders: await response.allHeaders().catch(() => ({})),
      responseBody: body,
    });
    const opName = url.match(/\/api\/v3\/([A-Za-z]+)/)?.[1] ?? "?";
    console.log(
      `  ✓ ${req.method()} ${opName.padEnd(28)} status=${response.status()}  ` +
        `req=${postData ? postData.length + "B" : "(none)"}  res=${body.length}B`,
    );
  });

  console.log(`navigating to ${pdpUrl}`);
  await page
    .goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
    .catch((err) => console.log(`  navigation warning: ${(err as Error).message}`));

  // Try to coax the booking-flow XHR by interacting with the page
  await page.waitForTimeout(2000);
  // Scroll to force the floating footer to render
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

  console.log(`waiting ${PRICE_WAIT_MS}ms total for /api/v3/ traffic to settle…`);
  await page.waitForTimeout(PRICE_WAIT_MS);

  return captured;
}

async function probe(externalId: string, daysOut: number, nights: number, label: string): Promise<void> {
  console.log(pad(`PROBE [${label}]`));
  const { checkin, checkout } = makeWindow(daysOut, nights);
  const pdpUrl =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}?` +
    `check_in=${checkin}&check_out=${checkout}&adults=2`;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const captured = await captureV3Traffic(page, pdpUrl);

    console.log(pad(`SUMMARY: ${captured.length} /api/v3/ XHR(s)`));
    for (let i = 0; i < captured.length; i++) {
      const x = captured[i];
      const opName = x.url.match(/\/api\/v3\/([A-Za-z]+)/)?.[1] ?? "?";
      console.log(`\n— [${i}] ${x.method} ${opName} (status ${x.status})`);
      console.log(`  url: ${x.url.slice(0, 220)}${x.url.length > 220 ? "…" : ""}`);
      if (x.requestBody) {
        console.log(`  request body (first 500): ${x.requestBody.slice(0, 500)}`);
      }
      if (x.status >= 200 && x.status < 300 && x.responseBody.length < 500_000) {
        try {
          const json = JSON.parse(x.responseBody);
          const hits = huntPrice(json);
          console.log(`  response shape: ${shapeOf(json, 0, 3)}`);
          console.log(`  PRICE HITS: ${hits.length}`);
          for (const h of hits.slice(0, 25)) {
            console.log(`    [${h.key}] ${h.path}`);
            console.log(`      → ${h.preview}`);
          }
          if (hits.length > 25) console.log(`    …+${hits.length - 25} more`);
        } catch {
          console.log(`  (non-JSON response, first 200: ${x.responseBody.slice(0, 200)})`);
        }
      }
    }

    // If we have any StaysPdpSections POST, replay it directly as proof-of-concept
    const sps = captured.find(
      (c) => c.url.includes("/api/v3/StaysPdpSections") && c.method === "POST" && c.requestBody,
    );
    if (sps) {
      console.log(pad("REPLAY: direct POST with captured body"));
      const res = await fetch(sps.url, {
        method: "POST",
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "content-type": sps.requestHeaders["content-type"] ?? "application/json",
          "accept": "*/*",
          "accept-language": "en-US,en;q=0.9",
          "x-airbnb-api-key": "d306zoyjsyarp7ifhu67rjxn52tv0t20",
          "x-airbnb-graphql-platform": "web",
          "x-airbnb-graphql-platform-client": "minimalist-niobe",
          "referer": pdpUrl,
        },
        body: sps.requestBody!,
      });
      const text = await res.text();
      console.log(`HTTP ${res.status}, body bytes ${text.length}, first 400: ${text.slice(0, 400)}`);
      if (res.ok) {
        try {
          const j = JSON.parse(text);
          const hits = huntPrice(j);
          console.log(`replay PRICE HITS: ${hits.length}`);
          for (const h of hits.slice(0, 10)) {
            console.log(`  [${h.key}] ${h.path} → ${h.preview}`);
          }
        } catch {
          /* */
        }
      }
    } else {
      console.log("\n(no StaysPdpSections POST captured — replay skipped)");
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  const externalId = externalIdArg ?? DEFAULT_EXTERNAL_ID;
  console.log("starting airbnb-pricing-debug v7 (full /api/v3/ capture) — externalId:", externalId);
  await probe(externalId, 30, 3, "30d-out / 3 nights");
  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
