import { extractSearchCards } from "../../artifacts/api-server/src/lib/ingest/airbnb-search-adapter.js";
import { fetchAirbnbResidential } from "./lib/airbnb-residential-fetch.js";

async function main() {
  const urls = {
    WORKING: "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes",
    MY_BUCKET: "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes?min_bedrooms=2&max_bedrooms=2&price_min=200&price_max=400&room_types%5B%5D=Entire+home%2Fapt",
    ONLY_BR: "https://www.airbnb.com/s/Zona-Romantica--Puerto-Vallarta--Mexico/homes?min_bedrooms=2",
  };
  for (const [name, url] of Object.entries(urls)) {
    const r = await fetchAirbnbResidential(url, { timeoutMs: 25000 });
    const cards = extractSearchCards(r.html);
    console.log(`${name}: status=${r.status} len=${r.html.length} cardsExtracted=${cards.length}`);
    if (cards.length > 0) console.log(`  first 3:`, cards.slice(0,3).map(c=>({id:c.id,name:c.name?.slice(0,30),beds:c.bedrooms})));
    await new Promise(r=>setTimeout(r, 2500));
  }
}
main();
