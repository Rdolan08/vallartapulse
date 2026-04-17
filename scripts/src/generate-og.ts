/**
 * VallartaPulse — OG Image Generator
 *
 * Takes real 1200×630 screenshots of each page on the live site and saves
 * them to artifacts/pv-datastore/public/og/{slug}.png for social previews.
 *
 * Usage:
 *   BASE_URL=https://www.vallartapulse.com pnpm --filter @workspace/scripts run og
 *
 * In GitHub Actions the BASE_URL is set automatically.
 */

import { chromium } from "playwright";
import { existsSync, mkdirSync, copyFileSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_OG = resolve(__dirname, "../../artifacts/pv-datastore/public/og");
const BASE_URL = (process.env.BASE_URL ?? "https://www.vallartapulse.com").replace(/\/$/,'');

mkdirSync(PUBLIC_OG, { recursive: true });

interface Route {
  path: string;
  slug: string;
  /** Extra wait after networkidle — charts need time to paint */
  waitMs: number;
  /** CSS selector that must be visible before we screenshot */
  readySelector?: string;
}

const ROUTES: Route[] = [
  { path: "/",              slug: "home",          waitMs: 4000, readySelector: ".recharts-wrapper, [data-kpi]" },
  { path: "/tourism",       slug: "tourism",       waitMs: 5000, readySelector: ".recharts-wrapper" },
  { path: "/rental-market", slug: "rental-market", waitMs: 5000, readySelector: ".recharts-wrapper" },
  { path: "/pricing-tool",  slug: "pricing-tool",  waitMs: 2000, readySelector: "form, [data-pricing-form]" },
  { path: "/economic",      slug: "economic",      waitMs: 5000, readySelector: ".recharts-wrapper" },
  { path: "/safety",        slug: "safety",        waitMs: 5000, readySelector: ".recharts-wrapper" },
  { path: "/weather",       slug: "weather",       waitMs: 5000, readySelector: ".recharts-wrapper" },
  { path: "/sources",       slug: "sources",       waitMs: 2000 },
  { path: "/about",         slug: "about",         waitMs: 2000, readySelector: "img[alt='Ryan Dolan']" },
  { path: "/contact",       slug: "contact",       waitMs: 1500 },
];

type Result = { slug: string; ok: boolean; error?: string };

async function screenshot(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newPage"]>>,  
  route: Route
): Promise<Result> {
  const url = `${BASE_URL}${route.path}`;
  const outPath = resolve(PUBLIC_OG, `${route.slug}.png`);
  const tmpPath = `${outPath}.tmp.png`;

  try {
    console.log(`  → ${url}`);

    const waitUntil = route.slug === "tourism" ? "domcontentloaded" : "networkidle";
    await page.goto(url, { waitUntil, timeout: 30_000 });

    // Wait for fonts (document.fonts.ready)
    await page.evaluate(() => document.fonts.ready);

    // Wait for a specific element if provided
    if (route.readySelector) {
      try {
        await page.waitForSelector(route.readySelector, { timeout: 10_000 });
      } catch {
        console.warn(`    ⚠ readySelector "${route.readySelector}" not found — continuing anyway`);
      }
    }

    // Extra time for chart animations to settle
    await page.waitForTimeout(route.waitMs);

    // Hide scrollbars
    await page.addStyleTag({
      content: `
        ::-webkit-scrollbar { display: none !important; }
        * { scrollbar-width: none !important; }
      `,
    });

    // Capture exactly 1200×630 from top-left
    await page.screenshot({
      path: tmpPath,
      clip: { x: 0, y: 0, width: 1200, height: 630 },
      type: "png",
    });

    // Only replace existing file if the new capture is non-trivial (> 20 KB)
    const { statSync } = await import("fs");
    const size = statSync(tmpPath).size;
    if (size < 20_000) {
      throw new Error(`Screenshot suspiciously small (${size} bytes) — skipping`);
    }

    renameSync(tmpPath, outPath);
    console.log(`    ✓ saved (${Math.round(size / 1024)} KB)`);
    return { slug: route.slug, ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    ✗ FAILED: ${msg}`);
    // Clean up temp file if it exists
    if (existsSync(tmpPath)) {
      try { renameSync(tmpPath, `${outPath}.broken`); } catch { /* ignore */ }
    }
    return { slug: route.slug, ok: false, error: msg };
  }
}

async function main() {
  console.log(`\n🖼  VallartaPulse OG Screenshot Generator`);
  console.log(`   Base URL : ${BASE_URL}`);
  console.log(`   Output   : ${PUBLIC_OG}\n`);

  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "en-US",
  });

  // Block unnecessary resources to speed up renders
  await context.route(/\.(woff2?|ttf|eot)(\?.*)?$/, (route) => route.continue());
  await context.route(/google-analytics|gtag|intercom|hotjar|segment/, (route) => route.abort());

  const results: Result[] = [];

  for (const route of ROUTES) {
    const page = await context.newPage();
    const result = await screenshot(page, route);
    results.push(result);
    await page.close();
  }

  await browser.close();

  // Summary report
  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Results: ${passed.length} succeeded, ${failed.length} failed`);

  if (passed.length) {
    console.log(`\n  ✓ Succeeded:`);
    passed.forEach((r) => console.log(`    - ${r.slug}`));
  }
  if (failed.length) {
    console.log(`\n  ✗ Failed:`);
    failed.forEach((r) => console.log(`    - ${r.slug}: ${r.error}`));
    process.exit(1);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});