/**
 * ingest/browser-fetch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Playwright (Chromium) fetch transport for the discovery scrapers.
 *
 * Why this exists:
 *   - Static HTML fetches (direct + residential proxy) succeed at the network
 *     layer for VRBO/Airbnb but fail at the application layer:
 *       • VRBO returns HTTP 429 immediately due to TLS/header fingerprinting.
 *       • Airbnb returns 200 + a JS-shell page with no embedded listing cards.
 *   - A real browser presents an authentic TLS/HTTP2 fingerprint and executes
 *     the client-side JS that materialises the cards, then we read the fully
 *     rendered HTML and feed it into the existing extractors.
 *
 * Architecture:
 *   - One process-wide Chromium instance, launched lazily on first call,
 *     cached via `getBrowser()`. Reused across jobs to avoid the 1–2s
 *     launch cost per fetch.
 *   - Per-call: new BrowserContext (fresh cookies / storage), single page,
 *     navigate, wait for network idle, read page.content().
 *   - Proxy: PROXY_URL parsed into {server, username, password} for
 *     Playwright's launch.proxy (Chromium-level proxy, not page-level).
 *   - Hard timeout per fetch.
 *
 * No DB writes, no shared state beyond the cached Browser. Safe to call
 * concurrently — Playwright contexts are isolated.
 */

import type { Browser, BrowserContext, Page } from "playwright";
import {
  buildProxyParts,
  randomSession,
  shouldIgnoreHttpsErrors,
} from "./proxy-config.js";

let cachedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser && cachedBrowser.isConnected()) return cachedBrowser;
  if (launchPromise) return launchPromise;

  // Browser-level proxy is set once at launch and reused across contexts.
  // We rotate the Bright Data session token per browser launch (process
  // restart) — finer-grained per-context rotation would defeat the
  // homepage-warmed cookie pool that the cached browser is built around.
  const proxy = buildProxyParts({ session: randomSession() });

  launchPromise = (async () => {
    // Lazy import keeps the dependency optional for callers that never use
    // the browser mode (e.g. the api-server itself).
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
      // Browser-wide proxy. Username/password are sent automatically when the
      // upstream proxy issues a 407.
      ...(proxy ? { proxy } : {}),
    });
    cachedBrowser = browser;
    return browser;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

/** Close the cached browser. Tests / shutdown hooks can call this. */
export async function closeBrowser(): Promise<void> {
  if (cachedBrowser) {
    try {
      await cachedBrowser.close();
    } catch {
      // ignore — already gone
    }
    cachedBrowser = null;
  }
}

export interface BrowserFetchOpts {
  /**
   * How long to wait for the page to settle before reading HTML.
   * Default 25_000 ms. We use waitUntil:'networkidle' which fires when there
   * have been no network connections for 500ms — appropriate for SPAs.
   */
  timeoutMs?: number;
  /**
   * Optional CSS selector to wait for in addition to network-idle. If
   * provided, the fetch returns once EITHER networkidle OR the selector
   * appears, whichever comes first. Useful when networkidle never fires
   * because of background pings.
   */
  waitForSelector?: string;
  /**
   * If true, request HTML on `domcontentloaded` even if `networkidle`
   * never fires. Defaults to true (resilience > strictness).
   */
  fallbackOnTimeout?: boolean;
}

const REALISTIC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Open `url` in a new isolated browser context, wait for the page to settle,
 * and return the fully rendered HTML.
 *
 * Throws on navigation/auth/proxy errors. Returns whatever HTML is loaded
 * on networkidle (or selector-match) so downstream block-detection still
 * runs against the realistic body.
 */
export async function fetchWithBrowser(
  url: string,
  opts: BrowserFetchOpts = {}
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const fallbackOnTimeout = opts.fallbackOnTimeout ?? true;

  const browser = await getBrowser();

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    context = await browser.newContext({
      userAgent: REALISTIC_UA,
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/Mexico_City",
      // Don't ship a referer; behave like a fresh navigation.
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9",
      },
      // Bright Data MITMs the TLS chain — without this Playwright drops
      // every navigation with net::ERR_CERT_AUTHORITY_INVALID. Only
      // enabled when Bright Data is configured; legacy proxies stay strict.
      ignoreHTTPSErrors: shouldIgnoreHttpsErrors(),
    });
    page = await context.newPage();

    // Block heavy media to keep things snappy without changing the rendered
    // DOM structure used by the extractors.
    await page.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "media" || t === "font") {
        return route.abort();
      }
      return route.continue();
    });

    // Race networkidle against an optional selector wait.
    const navPromise = page.goto(url, {
      waitUntil: "networkidle",
      timeout: timeoutMs,
    });

    if (opts.waitForSelector) {
      await Promise.race([
        navPromise.catch(() => null),
        page.waitForSelector(opts.waitForSelector, { timeout: timeoutMs }).catch(() => null),
      ]);
    } else {
      try {
        await navPromise;
      } catch (err) {
        if (!fallbackOnTimeout) throw err;
        // Fall back to whatever HTML is there now — partial pages still
        // often contain enough card data to extract.
      }
    }

    return await page.content();
  } finally {
    if (page) {
      try { await page.close(); } catch { /* ignore */ }
    }
    if (context) {
      try { await context.close(); } catch { /* ignore */ }
    }
  }
}
