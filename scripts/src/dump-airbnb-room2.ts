import { fetchWithBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";
import fs from "fs";
const url = "https://www.airbnb.com/rooms/143707493577";
const t0 = Date.now();
const html = await fetchWithBrowser(url, { timeoutMs: 60000, waitForSelector: 'script[type="application/ld+json"]', fallbackOnTimeout: true });
console.log("ms:", Date.now() - t0, "bytes:", html.length);
fs.writeFileSync("/tmp/room2.html", html);
for (const tok of ["DemandStayListing","application/ld+json","VacationRental","captcha","Access","blocked","muscache","__APOLLO","NEXT_DATA"]) {
  console.log(tok, "→", html.split(tok).length - 1);
}
process.exit(0);
