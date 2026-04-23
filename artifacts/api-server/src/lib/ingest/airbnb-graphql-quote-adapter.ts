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
  // CRITICAL: warm the session by visiting the homepage once. Without this,
  // every subsequent /rooms/<id> hit looks like a brand-new no-cookie bot
  // session and Airbnb fast-paths it to the homepage redirect (we proved
  // this empirically — adding ctx.clearCookies() per quote broke ALL
  // listings, including the known-live MarshmallowTown 53116610). The
  // homepage nav sets the bev / _abp / _airbed_session_id / etc cookies
  // that anti-scraping checks expect on listing requests. We only do this
  // once per process — let cookies accumulate naturally after that.
  try {
    const warmup = await context.newPage();
    await warmup.goto("https://www.airbnb.com/", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    // Brief settle so background JS can set its cookies.
    await warmup.waitForTimeout(1_500);
    await warmup.close().catch(() => {});
  } catch {
    // Non-fatal — if warmup fails the per-listing nav will still try.
  }
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

  // DO NOT clear cookies between quotes. We tried it as a defensive
  // measure and it broke EVERY listing — Airbnb fast-paths cookie-less
  // requests to the homepage redirect (validated 2026-04-23 against
  // listing 53116610 which is alive in a normal browser). Cookies set
  // by the homepage warmup in getContext() must persist across the
  // entire run so /rooms/<id> requests look like a real session.

  const page = await ctx.newPage();
  let sidebarText = "";
  let pageTitle = "";
  let bodyPreview = "";
  let pageRef: typeof page | null = page;

  // Helper: write HTML + screenshot dump of the current page state to /tmp.
  // Always best-effort. Returns the list of paths written.
  const dumpFailureArtifacts = async (reason: string): Promise<string[]> => {
    if (!pageRef || process.env.AIRBNB_PRICING_DUMP === "0") return [];
    const paths: string[] = [];
    try {
      const ts = Date.now();
      const tag = `${externalId}-${opts.checkin}-${reason}-${ts}`;
      const htmlPath = `/tmp/airbnb-debug-${tag}.html`;
      const pngPath = `/tmp/airbnb-debug-${tag}.png`;
      const html = await pageRef.content().catch(() => "");
      if (html) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
        paths.push(htmlPath);
      }
      await pageRef.screenshot({ path: pngPath, fullPage: false }).catch(() => {});
      paths.push(pngPath);
    } catch {
      /* best-effort */
    }
    return paths;
  };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_NAV_TIMEOUT_MS });
    pageTitle = await page.title().catch(() => "");

    // Fast-path: if the title is the generic Airbnb homepage / "Oops!" 404
    // page, the listing has been delisted (or we got soft-blocked into a
    // redirect). Bail immediately — no point waiting 18s for a sidebar
    // that will never render.
    if (
      /^Airbnb: Vacation Rentals/i.test(pageTitle) ||
      /Oops/i.test(pageTitle) ||
      /Page not found/i.test(pageTitle)
    ) {
      bodyPreview = (
        await page.locator("body").innerText({ timeout: 2000 }).catch(() => "")
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const dumpPaths = await dumpFailureArtifacts("delisted");
      await page.close().catch(() => {});
      pageRef = null;
      const dumpPart = dumpPaths.length > 0 ? ` dump=${dumpPaths.join(",")}` : "";
      errors.push(
        `delisted-or-blocked title="${pageTitle.slice(0, 80)}" ` +
          `body="${bodyPreview}"${dumpPart}`,
      );
      return baseResult;
    }

    // Booking sidebar — Airbnb SPLITS this into two sections:
    //   BOOK_IT_SIDEBAR — the FORM (date pickers, guests, Reserve button,
    //                     "$0 today" deposit text). NO actual stay price.
    //   BOOK_IT_NAV     — the price summary ("$287 $265 for 2 nights",
    //                     line items, fees, Total). The numbers we want.
    //
    // The previous version used .first() which always picked
    // BOOK_IT_SIDEBAR — so the wait timed out (18s) never seeing a
    // non-zero price, and the parser got the form text instead of the
    // price summary. We now wait for ANY BOOK_IT_* section to attach,
    // and the wait/extract logic below reads ALL of them concatenated.
    const sidebar = page.locator('[data-section-id*="BOOK_IT"]');
    await sidebar
      .first()
      .waitFor({ state: "attached", timeout: SIDEBAR_WAIT_MS })
      .catch(() => {});

    // Wait until the sidebar actually renders the REAL stay price.
    //
    // The previous version of this wait used /\$\d/ which matched the
    // "$0 today" deposit placeholder Airbnb renders FIRST while the
    // pricing API is still in-flight. Result: we exited the wait early
    // and scraped a sidebar that still had the literal text "loading"
    // at the end (validated 2026-04-23 against listing 53116610).
    //
    // The fix: require BOTH conditions before we consider the sidebar
    // ready —
    //   (a) a non-zero dollar amount appears anywhere in the sidebar
    //       (\$[1-9]\d* — must start with 1-9 so "$0 today" doesn't
    //       satisfy it). The real stay price is always >=$10.
    //   (b) the literal substring "loading" is GONE from the sidebar
    //       (case-insensitive). This is Airbnb's skeleton placeholder
    //       and disappears the instant the price API resolves.
    //
    // Passed as a string so TS doesn't try to typecheck DOM globals here.
    // Walks ALL BOOK_IT_* sections (querySelectorAll) and concatenates
    // their innerText — the price summary lives in BOOK_IT_NAV, not
    // BOOK_IT_SIDEBAR (the form), so we MUST look at both.
    await page
      .waitForFunction(
        `(() => {
          const els = document.querySelectorAll('[data-section-id*="BOOK_IT"]');
          if (!els.length) return false;
          let combined = "";
          for (const el of els) combined += " " + (el.innerText || "");
          if (/loading/i.test(combined)) return false;
          return /\\$[1-9]\\d*/.test(combined);
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

    // Concatenate ALL BOOK_IT_* sections (BOOK_IT_SIDEBAR has the form,
    // BOOK_IT_NAV has the actual price summary). allInnerTexts() returns
    // an array — joining with a separator gives the parser one blob to
    // hunt through. Without this we'd only see the form text.
    const sidebarTexts = await sidebar
      .allInnerTexts()
      .catch(() => [] as string[]);
    sidebarText = sidebarTexts.join(" \n ");

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
  }

  if (!sidebarText || !/\$\d/.test(sidebarText)) {
    bodyPreview = (
      await (pageRef
        ? pageRef.locator("body").innerText({ timeout: 2000 }).catch(() => "")
        : Promise.resolve(""))
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    const dumpPaths = await dumpFailureArtifacts("nosidebar");
    await page.close().catch(() => {});
    pageRef = null;

    const titlePart = pageTitle ? ` title="${pageTitle.slice(0, 80)}"` : "";
    const bodyPart = bodyPreview ? ` body="${bodyPreview}"` : "";
    const dumpPart = dumpPaths.length > 0 ? ` dump=${dumpPaths.join(",")}` : "";
    errors.push(
      "no price text rendered in booking sidebar" + titlePart + bodyPart + dumpPart,
    );
    return baseResult;
  }

  const parsed = parsePriceLines(sidebarText);

  // Parser-fail dump: sidebar HAD $ text but parser couldn't extract a Total.
  // We need to SEE the text to fix the parser. Dump before closing the page.
  if (parsed.total === null) {
    const dumpPaths = await dumpFailureArtifacts("noparse");
    const sidebarSnippet = sidebarText.replace(/\s+/g, " ").trim().slice(0, 300);
    await page.close().catch(() => {});
    pageRef = null;
    const dumpPart = dumpPaths.length > 0 ? ` dump=${dumpPaths.join(",")}` : "";
    errors.push(
      `parser found $ but no Total. sidebar="${sidebarSnippet}"${dumpPart}`,
    );
    return baseResult;
  }

  await page.close().catch(() => {});
  pageRef = null;

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

  // Collapsed-view fallback: short stays (often 1-3 nights) and many
  // listings render only the inline summary "$287 $265 for 2 nights"
  // without a "Total" row, "Cleaning fee" row, or expandable breakdown.
  // In that case the loop above sets nothing and we land here with
  // total=null. Hunt for the pattern in the FULL text:
  //
  //   ($N1 )?($N2 )?for K nights
  //
  // The LAST dollar amount immediately before "for K nights" is the
  // real (post-discount) stay total. If only one $ appears, that's it;
  // if two, the second is the actual price (first is strikethrough).
  // We treat the result as both `accommodation` and `total` because
  // for collapsed views Airbnb is showing the all-in nightly average ×
  // nights without separating fees — and the rest of the pipeline
  // treats `total` as the source of truth anyway.
  if (total === null) {
    const collapsed = text.match(
      /(?:\$([\d,]+(?:\.\d+)?)\s+)?\$([\d,]+(?:\.\d+)?)\s+(?:[A-Za-z\s]*?\s+)?for\s+(\d+)\s+nights?/i,
    );
    if (collapsed) {
      const actual = Number.parseFloat(collapsed[2].replace(/,/g, ""));
      if (Number.isFinite(actual) && actual > 0) {
        total = actual;
        if (accommodation === null) accommodation = actual;
      }
    }
  }

  return { accommodation, cleaning, service, taxes, total };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
