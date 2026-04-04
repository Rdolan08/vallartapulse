/**
 * cruise-schedule.ts
 * Fetches upcoming cruise ship arrivals for Puerto Vallarta from CruiseDig,
 * parses ship name / cruise line / passenger count / arrival date, and caches
 * the result in memory for 12 hours.
 *
 * HTML structure (Drupal-based):
 *   <div class="name"><a href="/ships/{slug}">Ship Name</a></div>
 *   <div class="occupancy"><a href="/cruise-line">Cruise Line</a></div>  (optional)
 *   <div class="occupancy">2.882 passengers</div>
 *   <div class="schedule__datetime">07 Apr 2026 - <span...><span>07:00</span></span></div>
 *
 * Source: https://cruisedig.com/ports/puerto-vallarta-mexico/arrivals
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

export interface CruiseArrival {
  ship: string;
  shipUrl: string;
  line: string;
  passengers: number;
  date: string;   // "YYYY-MM-DD"
  time: string;   // "HH:MM"
}

interface Cache {
  data: CruiseArrival[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
let cache: Cache | null = null;

const MONTH: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseCruiseArrivals(html: string): CruiseArrival[] {
  // 1. Extract all ship name entries (always has /ships/ in href)
  const ships: Array<{ name: string; url: string }> = [];
  const shipRe = /<div[^>]*class="name"[^>]*>[\s\S]*?<a[^>]+href="([^"]*\/ships\/[^"]*)"[^>]*>([^<]+)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = shipRe.exec(html)) !== null) {
    ships.push({ url: `https://cruisedig.com${m[1]}`, name: m[2].trim() });
  }

  // 2. Extract passenger counts in order: "2.882 passengers" or "540 passengers"
  // European thousands separator (dot), so "2.882" = 2882
  const passengersArr: number[] = [];
  const passRe = /<div[^>]*class="occupancy"[^>]*>([\d][.\d\s]*)\s*passengers\s*<\/div>/gi;
  while ((m = passRe.exec(html)) !== null) {
    const n = parseInt(m[1].replace(/[.\s]/g, ""), 10);
    if (!isNaN(n) && n >= 50 && n <= 20000) passengersArr.push(n);
  }

  // 3. Extract cruise line names from occupancy divs that contain anchor links
  // (not all ships have a cruise line div)
  // We need to match lines to ships positionally, so extract ALL occupancy divs in order
  const allOccupancy: Array<{ isLine: boolean; lineName?: string; passengers?: number }> = [];
  const occRe = /<div[^>]*class="occupancy"[^>]*>([\s\S]*?)<\/div>/gi;
  while ((m = occRe.exec(html)) !== null) {
    const inner = m[1];
    const passMatch = inner.match(/([\d][.\d\s]*)\s*passengers/i);
    if (passMatch) {
      const n = parseInt(passMatch[1].replace(/[.\s]/g, ""), 10);
      allOccupancy.push({ isLine: false, passengers: isNaN(n) ? 0 : n });
    } else {
      const linkMatch = inner.match(/href="([^"]+)"[^>]*>([^<]+)<\/a>/);
      if (linkMatch) {
        allOccupancy.push({ isLine: true, lineName: linkMatch[2].trim() });
      }
    }
  }

  // 4. Extract date+time entries
  const dates: Array<{ date: string; time: string }> = [];
  const dateRe = /<div[^>]*class="schedule__datetime"[^>]*>(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s*-[\s\S]*?data-time="(\d{1,2}:\d{2})"/gi;
  while ((m = dateRe.exec(html)) !== null) {
    const [, day, monStr, year, time] = m;
    const mon = MONTH[monStr.toLowerCase()];
    if (!mon) continue;
    dates.push({ date: `${year}-${mon}-${day.padStart(2, "0")}`, time });
  }

  // 5. Build cruise line mapping: walk allOccupancy in order, pairing each "line" entry
  //    to the next "passengers" entry (a ship block is: [optional line], passengers)
  const linePerPassenger: string[] = [];
  let pendingLine = "";
  for (const occ of allOccupancy) {
    if (occ.isLine) {
      pendingLine = occ.lineName ?? "";
    } else {
      linePerPassenger.push(pendingLine);
      pendingLine = "";
    }
  }

  // 6. Zip: ships, passengers, lines, dates — shortest length wins
  const count = Math.min(ships.length, passengersArr.length, dates.length);
  const arrivals: CruiseArrival[] = [];

  for (let i = 0; i < count; i++) {
    arrivals.push({
      ship: ships[i].name,
      shipUrl: ships[i].url,
      line: linePerPassenger[i] ?? "",
      passengers: passengersArr[i],
      date: dates[i].date,
      time: dates[i].time,
    });
  }

  return arrivals;
}

async function fetchAndParse(): Promise<CruiseArrival[]> {
  const res = await fetch(
    "https://cruisedig.com/ports/puerto-vallarta-mexico/arrivals",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );
  if (!res.ok) throw new Error(`CruiseDig returned HTTP ${res.status}`);
  const html = await res.text();
  const arrivals = parseCruiseArrivals(html);
  logger.info({ count: arrivals.length }, "cruise-schedule: parsed arrivals");
  return arrivals;
}

router.get("/metrics/cruise-schedule", async (req, res) => {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    res.json(cache.data);
    return;
  }

  try {
    const data = await fetchAndParse();
    cache = { data, fetchedAt: now };
    res.json(data);
  } catch (err) {
    logger.error({ err }, "cruise-schedule: fetch/parse failed");
    if (cache) {
      res.json(cache.data);
    } else {
      res.status(502).json({ error: "Could not fetch cruise schedule" });
    }
  }
});

export default router;
