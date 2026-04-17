import { readFileSync } from "node:fs";

/**
 * Minimal RFC-4180 CSV parser. Handles quoted fields with embedded commas,
 * newlines, and escaped quotes (""). Returns an array of objects keyed by
 * the header row. Empty strings are returned as `null`.
 */
export function readCsv<T = Record<string, string | null>>(path: string): T[] {
  const text = readFileSync(path, "utf8");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0].length > 0))
    .map((r) => {
      const obj: Record<string, string | null> = {};
      for (let h = 0; h < header.length; h++) {
        const v = r[h] ?? "";
        obj[header[h]] = v === "" ? null : v;
      }
      return obj as T;
    });
}

export const num = (v: string | null): number | null => v === null ? null : Number(v);
export const int = (v: string | null): number | null => v === null ? null : parseInt(v, 10);
export const str = (v: string | null): string | null => v;
export const bool = (v: string | null): boolean => v === "t" || v === "true";
