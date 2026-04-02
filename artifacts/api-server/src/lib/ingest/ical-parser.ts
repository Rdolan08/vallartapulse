/**
 * ingest/ical-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal iCal (RFC 5545) parser.  No external dependencies.
 * Handles Airbnb / VRBO / direct booking calendar feeds.
 */

import type { ICalEvent, ICalParseResult } from "./types.js";

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseICalDate(value: string): string {
  const v = value.split(";").pop()?.trim() ?? value.trim();
  if (/^\d{8}T\d{6}Z?$/.test(v)) {
    const d = v.replace("Z", "");
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  return v;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseDuration(dur: string): number {
  const days = dur.match(/(\d+)D/i)?.[1];
  const weeks = dur.match(/(\d+)W/i)?.[1];
  return (weeks ? parseInt(weeks) * 7 : 0) + (days ? parseInt(days) : 0);
}

// ── Core parser ───────────────────────────────────────────────────────────────

export function parseICalText(raw: string, sourceUrl?: string): ICalParseResult {
  const events: ICalEvent[] = [];
  const errors: string[] = [];

  const lines = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");

  let inEvent = false;
  let current: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }

    if (line === "END:VEVENT") {
      inEvent = false;
      try {
        const uid     = current["UID"]      ?? `generated-${Date.now()}`;
        const summary = current["SUMMARY"];
        const status  = current["STATUS"];

        const rawStart = Object.entries(current).find(([k]) => k.startsWith("DTSTART"))?.[1];
        const rawEnd   = Object.entries(current).find(([k]) => k.startsWith("DTEND"))?.[1];
        const duration = current["DURATION"];

        if (!rawStart) {
          errors.push(`VEVENT ${uid} missing DTSTART — skipped`);
          continue;
        }

        const start = parseICalDate(rawStart);
        let end: string;

        if (rawEnd) {
          end = parseICalDate(rawEnd);
        } else if (duration) {
          end = addDays(start, parseDuration(duration));
        } else {
          end = addDays(start, 1);
        }

        events.push({ uid, summary, status, start, end, raw: current });
      } catch (err) {
        errors.push(`Parse error on VEVENT: ${String(err)}`);
      }
      continue;
    }

    if (inEvent) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key   = line.slice(0, colonIdx).toUpperCase();
        const value = line.slice(colonIdx + 1);
        current[key] = value;
      }
    }
  }

  return { source_url: sourceUrl, event_count: events.length, events, errors };
}

export async function fetchAndParseICal(url: string): Promise<ICalParseResult> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "VallartaPulse/1.0 (+https://www.vallartapulse.com)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    return {
      source_url: url,
      event_count: 0,
      events: [],
      errors: [`HTTP ${resp.status} fetching iCal feed`],
    };
  }
  const raw = await resp.text();
  return parseICalText(raw, url);
}
