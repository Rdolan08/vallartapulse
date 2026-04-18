import { fetchWithBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";
import fs from "fs";
const url = "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes?adults=2&checkin=2026-04-24&checkout=2026-04-27&min_bedrooms=2";
const html = await fetchWithBrowser(url, { timeoutMs: 30000, waitForSelector: "a[href*='/rooms/']", fallbackOnTimeout: true });
fs.writeFileSync("/tmp/airbnb.html", html);
console.log("html bytes:", html.length);
for (const tok of ["niobeMinimalClientData", "staysSearch", "structuredStayDisplayPrice", "avgRatingA11yLabel", "contextualPictures", "data-deferred-state", "__NEXT_DATA__", "pricingQuote", "primaryLine", "secondaryLine", 'data-testid="listing-card-title"', 'data-testid="price-availability', "muscache.com", "&quot;listing&quot;", "&quot;pricingQuote&quot;"]) {
  console.log(tok, "→", html.split(tok).length - 1);
}
process.exit(0);
