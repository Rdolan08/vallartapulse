import { fetchWithBrowser } from "../../artifacts/api-server/src/lib/ingest/browser-fetch.js";
import fs from "fs";
const url = "https://www.airbnb.com/rooms/30316776";
const html = await fetchWithBrowser(url, { timeoutMs: 35000, waitForSelector: "h1, [data-section-id], button[data-section-id]", fallbackOnTimeout: true });
fs.writeFileSync("/tmp/room.html", html);
console.log("html bytes:", html.length);
for (const tok of ["DemandStayListing","propertyType","listingRooms","SbuiAmenitiesSection","amenitySection","reviewsCount","starRating","ListingDescription","capacity","personCapacity","numberOfBedrooms","numberOfBathrooms","numberOfBaths","Coordinate","latitude","hostName","HostProfile","\"name\":\"Listing\"","listingMetadata","title","sectionConfiguration","SECTION_DETAILS","Hosted by","__typename","data-deferred-state","__APOLLO_STATE__","muscache.com"]) {
  console.log(tok, "→", html.split(tok).length - 1);
}
process.exit(0);
