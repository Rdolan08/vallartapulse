/**
 * ingest/airbnb-graphql-quote-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-checkpoint Airbnb quote adapter — accommodation/cleaning/service/tax/
 * total breakdown, used by airbnb-pricing-runner.ts.
 *
 * Strategy (after 7 dead-end iterations on REST + GraphQL JSON parsing):
 *   We hit Airbnb the same way a real visitor does — render the PDP in
 *   headless Chromium, wait for the booking sidebar, and scrape the rendered
 *   price text. The reasons:
 *     1. /api/v2/pdp_listing_booking_details was retired (404).
 *     2. /api/v3/StaysPdpSections returns 200 but the actual price string
 *        lives in a deeply-nested AccessibilityLabel / displayString that
 *        moves around between A/B test buckets. Trying to keep a JSON
 *        path map current is a losing game.
 *     3. /api/v3/PdpAvailabilityCalendar returns price.localPriceFormatted=null
 *        for most listings (host-hidden by default).
 *     4. The DOM in the booking sidebar always renders the price for an
 *        unauthenticated visitor — that's what the `$N x M nights / $X
 *        cleaning fee / $Y Airbnb service fee / $Z taxes / $T total before
 *        taxes` block is for. Scraping it is robust to JSON shape churn.
 *
 * Networking / IP:
 *   Browser navigation only, no proxy. MUST run from a residential IP
 *   (the Mac mini). Datacenter IPs (Railway, GH runners) trip Airbnb's
 *   bot scoring within a handful of PDP loads.
 *
 * Performance:
 *   ~3-5 sec per quote (page load + sidebar render). For the 50-listing /
 *   ~30-checkpoint daily cohort that's ~75 min — within nightly cron budget.
 *   We reuse one Chromium process across the whole run to amortize startup.
 *
 * Cleanup:
 *   Callers MUST invoke `shutdownQuoteBrowser()` at the end of a run so
 *   the Chromium process exits cleanly. The runner does this in its
 *   finally{} block.
 */

import { chromium, type Browser, type BrowserContext } from "playwright";

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PAGE_NAV_TIMEOUT_MS = 35_000;
const SIDEBAR_WAIT_MS = 18_000;

const QUOTE_SHA_SENTINEL = "playwright-dom-scrape";

export interface AirbnbQuoteResult {
  accommodationUsd: number | null;
  cleaningFeeUsd: number | null;
  serviceFeeUsd: number | null;
  taxesUsd: number | null;
  totalPriceUsd: number | null;
  currency: string;
  shaUsed: string;
  available: boolean;
  errors: string[];
  staleSha: boolean;
}

export interface QuoteShaDiscoveryResult {
  sha: string;
  source: "fallback" | "cache" | "discovered";
}

/* ────────────────────────────────────────────────────────────────────────── */
/* SHA discovery (no-op — we don't use persisted queries here)                */
/* ────────────────────────────────────────────────────────────────────────── */

let quoteShaSource: "fallback" | "cache" | "discovered" = "fallback";

export async function getOrDiscoverQuoteSha(
  opts?: { forceRediscover?: boolean },
): Promise<QuoteShaDiscoveryResult> {
  if (opts?.forceRediscover) {
    quoteShaSource = "discovered";
  } else if (quoteShaSource === "fallback") {
    quoteShaSource = "cache";
  }
  return { sha: QUOTE_SHA_SENTINEL, source: quoteShaSource };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Process-level browser                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    userAgent: REALISTIC_UA,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  // Block heavy assets we don't need — speeds up navigation ~3x.
  await context.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (t === "image" || t === "media" || t === "font") return route.abort();
    return route.continue();
  });
  return context;
}

export async function shutdownQuoteBrowser(): Promise<void> {
  try {
    if (context) {
      await context.close().catch(() => {});
      context = null;
    }
    if (browser) {
      await browser.close().catch(() => {});
      browser = null;
    }
  } catch {
    // best-effort cleanup
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Quote fetch via DOM scrape                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export async function fetchAirbnbQuote(
  externalId: string,
  sha: string,
  opts: { checkin: string; checkout: string; guestCount: number },
): Promise<AirbnbQuoteResult> {
  const errors: string[] = [];
  const baseResult: AirbnbQuoteResult = {
    accommodationUsd: null,
    cleaningFeeUsd: null,
    serviceFeeUsd: null,
    taxesUsd: null,
    totalPriceUsd: null,
    currency: "USD",
    shaUsed: sha,
    available: false,
    errors,
    staleSha: false,
  };

  let ctx: BrowserContext;
  try {
    ctx = await getContext();
  } catch (err) {
    errors.push(`browser launch: ${err instanceof Error ? err.message : String(err)}`);
    return baseResult;
  }

  const url =
    `https://www.airbnb.com/rooms/${encodeURIComponent(externalId)}` +
    `?check_in=${opts.checkin}` +
    `&check_out=${opts.checkout}` +
    `&adults=${Math.max(1, opts.guestCount | 0)}`;

  const page = await ctx.newPage();
  let sidebarText = "";
  let pageTitle = "";
  let bodyPreview = "";

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    pageTitle = await page.title().catch(() => "");

    // Booking sidebar — section id BOOK_IT_SIDEBAR / BOOK_IT_FLOATING_FOOTER.
    // Wait for ANY price-shaped string to appear in it.
    const sidebar = page.locator('[data-section-id*="BOOK_IT"]').first();
    await sidebar
      .waitFor({ state: "attached", timeout: SIDEBAR_WAIT_MS })
      .catch(() => {});

    // Wait until the sidebar actually renders dollars (not just skeleton).
    // Passed as a string so TS doesn't try to typecheck DOM globals here.
    await page
      .waitForFunction(
        `(() => {
          const el = document.querySelector('[data-section-id*="BOOK_IT"]');
          if (!el) return false;
          const t = el.innerText || "";
          return /\\$\\d/.test(t);
        })()`,
        null,
        { timeout: SIDEBAR_WAIT_MS },
      )
      .catch(() => {});

    // Try to expand "Show price details" so all line items render.
    const expandBtn = page
      .locator(
        'button:has-text("Show price details"), button:has-text("price details"), ' +
          'button[aria-label*="price details" i]',
      )
      .first();
    if ((await expandBtn.count().catch(() => 0)) > 0) {
      await expandBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
    }

    sidebarText = await sidebar
      .innerText({ timeout: 3000 })
      .catch(() => "");

    // Fallback: if section locator missed, dump body text and let the
    // parser hunt — it's tolerant of extra noise.
    if (!sidebarText || !/\$\d/.test(sidebarText)) {
      sidebarText = await page
        .locator("body")
        .innerText({ timeout: 3000 })
        .catch(() => "");
    }
  } catch (err) {
    errors.push(`playwright nav: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await page.close().catch(() => {});
  }

  if (!sidebarText || !/\$\d/.test(sidebarText)) {
    errors.push(
      "no price text rendered in booking sidebar (listing may be unbookable for this window, " +
        "host hidden pricing, or Airbnb served a bot-challenge page)",
    );
    return baseResult;
  }

  const parsed = parsePriceLines(sidebarText);

  return {
    accommodationUsd: parsed.accommodation,
    cleaningFeeUsd: parsed.cleaning,
    serviceFeeUsd: parsed.service,
    taxesUsd: parsed.taxes,
    totalPriceUsd: parsed.total,
    currency: "USD",
    shaUsed: sha,
    available: parsed.total !== null && parsed.total > 0,
    errors,
    staleSha: false,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Parser                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

interface ParsedPrice {
  accommodation: number | null;
  cleaning: number | null;
  service: number | null;
  taxes: number | null;
  total: number | null;
}

function extractDollar(s: string): number | null {
  // Handles "$1,234", "$1,234.50", "US$1,234", "MX$3,245", "$1234"
  const m = s.match(/\$\s?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number.parseFloat(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Parse the booking sidebar's rendered text.
 *
 * Examples of what lines look like (current Airbnb 2026):
 *   "$245 x 3 nights"            → accommodation
 *   "$245 night x 3 nights"      → accommodation (newer A/B variant)
 *   "$735.00"                    → matched on the same row as accommodation
 *   "Cleaning fee" / "$75"       → cleaning  (often split across two lines)
 *   "Airbnb service fee" / "$104" → service
 *   "Taxes" / "$58"              → taxes
 *   "Total before taxes" / "$914" → subtotal-ish (NOT real total)
 *   "Total" / "$972"             → real total
 *
 * We walk lines in order; when a label line ("Cleaning fee", "Total",
 * etc.) has no dollar on the same line, we look at the NEXT line with a
 * dollar.
 */
function parsePriceLines(text: string): ParsedPrice {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let accommodation: number | null = null;
  let cleaning: number | null = null;
  let service: number | null = null;
  let taxes: number | null = null;
  let totalBeforeTaxes: number | null = null;
  let total: number | null = null;

  /** Find the next dollar value after index `i`, including line `i` itself. */
  const dollarAt = (i: number): number | null => {
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const v = extractDollar(lines[k]);
      if (v !== null) return v;
    }
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Accommodation: "$245 x 3 nights" or "$245 night x 3 nights"
    if (/\$[\d,]+(?:\.\d+)?(?:\s+\w+)?\s*[x×]\s*\d+\s*nights?/i.test(line)) {
      // The line with the multiplication shows per-night; the SAME row's
      // right-aligned column shows the subtotal. Look ahead for the row
      // total ($x*nights).
      const perNight = extractDollar(line);
      const nightsMatch = line.match(/[x×]\s*(\d+)\s*nights?/i);
      const nights = nightsMatch ? Number.parseInt(nightsMatch[1], 10) : 0;
      // Try to find the row-total dollar value within the next 2 lines —
      // Airbnb renders it as a separate text node alongside the multiplier.
      let rowTotal: number | null = null;
      for (let k = i + 1; k < Math.min(lines.length, i + 3); k++) {
        const v = extractDollar(lines[k]);
        if (v !== null && (!perNight || v >= perNight)) {
          rowTotal = v;
          break;
        }
      }
      if (rowTotal !== null) {
        accommodation = rowTotal;
      } else if (perNight && nights > 0) {
        accommodation = perNight * nights;
      }
      continue;
    }

    if (cleaning === null && /cleaning/i.test(lower)) {
      cleaning = dollarAt(i);
      continue;
    }
    if (service === null && /service fee/i.test(lower)) {
      service = dollarAt(i);
      continue;
    }
    if (taxes === null && /^taxes?$/i.test(lower.replace(/\s+/g, " ").trim())) {
      taxes = dollarAt(i);
      continue;
    }
    if (taxes === null && /\btax(es)?\b/i.test(lower) && !/before tax/i.test(lower)) {
      taxes = dollarAt(i);
      continue;
    }
    if (totalBeforeTaxes === null && /total before tax/i.test(lower)) {
      totalBeforeTaxes = dollarAt(i);
      continue;
    }
    // "Total" alone (not "Total before taxes") = the real grand total.
    if (total === null && /^total$/i.test(lower.trim())) {
      total = dollarAt(i);
      continue;
    }
  }

  // Real total fallback chain:
  //   1. Explicit "Total" line.
  //   2. totalBeforeTaxes + taxes (when both present).
  //   3. accommodation + cleaning + service + taxes (synthesized).
  if (total === null && totalBeforeTaxes !== null && taxes !== null) {
    total = round2(totalBeforeTaxes + taxes);
  }
  if (total === null) {
    const sum =
      (accommodation ?? 0) + (cleaning ?? 0) + (service ?? 0) + (taxes ?? 0);
    if (sum > 0 && accommodation !== null) total = round2(sum);
  }

  return { accommodation, cleaning, service, taxes, total };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
