const _now = new Date();

export const CURRENT_YEAR  = _now.getFullYear();
export const CURRENT_MONTH = _now.getMonth() + 1; // 1-indexed

// Last month for which a full calendar month of data is available.
// e.g. on April 1st → lastCompletedMonth = 3 (March)
export const LAST_COMPLETED_MONTH = CURRENT_MONTH > 1 ? CURRENT_MONTH - 1 : 12;
export const LAST_COMPLETED_YEAR  = CURRENT_MONTH > 1 ? CURRENT_YEAR : CURRENT_YEAR - 1;

export const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

export const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Years that have monthly data in the DB
export const MONTHLY_DATA_YEARS = [2022, 2023, 2024, 2025, 2026].filter(y => y <= CURRENT_YEAR);

// Years that have annual economic data in the DB
export const ANNUAL_DATA_YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026].filter(y => y <= CURRENT_YEAR);

// Returns the available months for a given year (1-indexed array)
export function availableMonths(year: number): number[] {
  if (year < CURRENT_YEAR) return [1,2,3,4,5,6,7,8,9,10,11,12];
  // Current year: only completed months
  return Array.from({ length: LAST_COMPLETED_MONTH }, (_, i) => i + 1);
}

// Human-readable label for year selector option, e.g. "2026 (Jan–Mar)"
export function yearLabel(year: number): string {
  if (year < CURRENT_YEAR) return String(year);
  const end = MONTH_SHORT[LAST_COMPLETED_MONTH - 1];
  return `${year} (Jan\u2013${end})`;
}

// Clamp a month to the available range for a year
export function clampMonth(year: number, month: number): number {
  const avail = availableMonths(year);
  if (avail.includes(month)) return month;
  return avail[avail.length - 1] ?? 1;
}
