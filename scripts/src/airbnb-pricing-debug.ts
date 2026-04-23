/**
 * scripts/src/airbnb-pricing-debug.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Diagnostic for the airbnb-pricing pipeline. Hits the two endpoints the
 * adapters use against ONE real listing and dumps the raw responses so we
 * can see exactly what Airbnb is returning vs what the adapter parsers
 * expect. Run from the Mac mini (residential IP).
 *
 *     pnpm --filter @workspace/scripts run debug:airbnb-pricing
 *
 * Optional: pass a specific external_id as the first arg.
 *
 *     pnpm --filter @workspace/scripts run debug:airbnb-pricing -- 12345...
 *
 * NEVER call this from Railway/CI — Airbnb IP-blocks datacenter ranges and
 * the diagnostic would lie about what a real Mac mini run would see.
 */

const AIRBNB_API_KEY = "d306zoyjsyarp7ifhu67rjxn52tv0t20";
const BOOTSTRAP_SHA =
  "8f08e03c7bd16fcad3c92a3592c19a8b559a0d0855a84028d1163d4733ed9ade";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function pad(label: string): string {
  return `\n══════ ${label} ${"═".repeat(Math.max(0, 70 - label.length))}`;
}

function shapeOf(v: unknown, depth = 0, maxDepth = 4): string {
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
    .slice(0, 12)
    .map((k) => `${k}: ${shapeOf(o[k], depth + 1, maxDepth)}`)
    .join(", ");
  const more = keys.length > 12 ? `, …+${keys.length - 12}` : "";
  return `{ ${inner}${more} }`;
}

/**
 * Default external_id is the most-recently scraped airbnb listing as of
 * 2026-04-23 (pulled directly from the Railway DB). Any 18-19 digit
 * airbnb listing id will work — pass one as argv[2] to override.
 */
const DEFAULT_EXTERNAL_ID = "1610096526897460312";

function pickListing(externalIdArg: string | undefined): { externalId: string } {
  return { externalId: externalIdArg ?? DEFAULT_EXTERNAL_ID };
}

async function probeCalendar(externalId: string): Promise<void> {
  console.log(pad("CALENDAR: PdpAvailabilityCalendar GraphQL"));
  const today = new Date();
  const variables = {
    request: {
      count: 12,
      listingId: externalId,
      month: today.getUTCMonth() + 1,
      year: today.getUTCFullYear(),
    },
  };
  const extensions = {
    persistedQuery: { version: 1, sha256Hash: BOOTSTRAP_SHA },
  };
  const url =
    `https://www.airbnb.com/api/v3/PdpAvailabilityCalendar/${BOOTSTRAP_SHA}?` +
    `operationName=PdpAvailabilityCalendar&locale=en&currency=USD&` +
    `variables=${encodeURIComponent(JSON.stringify(variables))}&` +
    `extensions=${encodeURIComponent(JSON.stringify(extensions))}`;
  console.log("URL:", url.slice(0, 180) + "…");
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "x-airbnb-api-key": AIRBNB_API_KEY,
      "x-airbnb-graphql-platform": "web",
      "x-airbnb-graphql-platform-client": "minimalist-niobe",
    },
  });
  console.log("HTTP:", res.status);
  const text = await res.text();
  console.log("BODY (first 800 chars):");
  console.log(text.slice(0, 800));
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    console.log("\nTOP-LEVEL SHAPE:", shapeOf(json));
    const pdc = (json as { data?: { merlin?: { pdpAvailabilityCalendar?: { calendarMonths?: Array<{ days?: unknown[] }> } } } })
      .data?.merlin?.pdpAvailabilityCalendar;
    if (pdc?.calendarMonths) {
      console.log("CALENDAR MONTHS:", pdc.calendarMonths.length);
      const firstMonth = pdc.calendarMonths[0];
      const firstDay = firstMonth?.days?.[0];
      console.log("FIRST DAY SHAPE:", shapeOf(firstDay));
      console.log("FIRST DAY (raw):", JSON.stringify(firstDay, null, 2));
      // Check across all days how many actually have a price
      let withPrice = 0;
      let availableCount = 0;
      let total = 0;
      for (const m of pdc.calendarMonths) {
        for (const d of (m.days ?? []) as Array<{ available?: boolean; price?: unknown }>) {
          total++;
          if (d.available) availableCount++;
          if (d.price && typeof d.price === "object") {
            const p = d.price as Record<string, unknown>;
            if (
              (typeof p.localPrice === "number" && p.localPrice > 0) ||
              (typeof p.localPriceFormatted === "string" && p.localPriceFormatted.length > 0)
            ) {
              withPrice++;
            }
          }
        }
      }
      console.log(
        `DAY STATS: total=${total} available=${availableCount} withPrice=${withPrice}`,
      );
    }
  } catch (err) {
    console.log("not json or parse failed:", (err as Error).message);
  }
}

async function probeQuoteRest(externalId: string): Promise<void> {
  console.log(pad("QUOTE: v2 REST pdp_listing_booking_details"));
  // pick a window 30-33 days from today (3 nights)
  const checkin = new Date();
  checkin.setUTCDate(checkin.getUTCDate() + 30);
  const checkout = new Date(checkin);
  checkout.setUTCDate(checkout.getUTCDate() + 3);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    _format: "for_web_with_date",
    check_in: fmt(checkin),
    check_out: fmt(checkout),
    number_of_adults: "2",
    number_of_children: "0",
    number_of_infants: "0",
    number_of_pets: "0",
    _intents: "p3",
    currency: "USD",
    locale: "en",
    key: AIRBNB_API_KEY,
  });
  const url = `https://www.airbnb.com/api/v2/pdp_listing_booking_details/${encodeURIComponent(externalId)}?${params.toString()}`;
  console.log("URL:", url.slice(0, 220) + "…");
  console.log("WINDOW:", fmt(checkin), "→", fmt(checkout));
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "x-airbnb-api-key": AIRBNB_API_KEY,
    },
  });
  console.log("HTTP:", res.status);
  const text = await res.text();
  console.log("BODY (first 1200 chars):");
  console.log(text.slice(0, 1200));
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    console.log("\nTOP-LEVEL SHAPE:", shapeOf(json));
    const detail = (json as { pdp_listing_booking_details?: unknown[] }).pdp_listing_booking_details?.[0];
    if (detail) {
      console.log("DETAIL[0] SHAPE:", shapeOf(detail, 0, 5));
      const d = detail as Record<string, unknown>;
      if (d.price) {
        console.log("price (raw):", JSON.stringify(d.price, null, 2).slice(0, 1500));
      } else {
        console.log("NO `price` field on detail[0]. Available keys:", Object.keys(d).join(", "));
      }
    }
  } catch (err) {
    console.log("not json or parse failed:", (err as Error).message);
  }
}

async function probeAlternativeQuote(externalId: string): Promise<void> {
  console.log(pad("QUOTE: alternative — StaysPdpSections (v3 GraphQL)"));
  // Airbnb's modern unauthenticated price-quote path is via the
  // StaysPdpSections operation — section_ids includes BOOK_IT_FLOATING_FOOTER
  // which carries the structured price even for unbooked windows. This is
  // the fallback we'd migrate to if v2 REST is dead.
  const checkin = new Date();
  checkin.setUTCDate(checkin.getUTCDate() + 30);
  const checkout = new Date(checkin);
  checkout.setUTCDate(checkout.getUTCDate() + 3);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const url =
    `https://www.airbnb.com/api/v2/pdp_listing_booking_details/${encodeURIComponent(externalId)}?` +
    `_format=for_web_with_date&check_in=${fmt(checkin)}&check_out=${fmt(checkout)}` +
    `&number_of_adults=2&_intents=p3&currency=USD&locale=en`; // no key param
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      "accept": "*/*",
      "x-airbnb-api-key": AIRBNB_API_KEY,
    },
  });
  console.log("v2 REST without `key=` query param — HTTP:", res.status);
  const text = await res.text();
  console.log("BODY (first 400 chars):", text.slice(0, 400));
}

async function main(): Promise<void> {
  const externalIdArg = process.argv[2];
  console.log("starting airbnb-pricing-debug…");
  const listing = pickListing(externalIdArg);
  console.log("listing externalId:", listing.externalId);
  await probeCalendar(listing.externalId);
  await probeQuoteRest(listing.externalId);
  await probeAlternativeQuote(listing.externalId);
  console.log(pad("DONE"));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
