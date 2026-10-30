/* Fire-history mode: date-range helpers (YYYY-MM-DD, UTC). */
export const MAX_HISTORY_DAYS = 31;
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/** Validate a history date range (YYYY-MM-DD, inclusive). Returns an error message key or null. */
export function historyRangeError(from: string, to: string, today = isoDay(new Date())): "history.errOrder" | "history.errMax" | "history.errFuture" | "history.errMissing" | null {
  if (!from || !to) return "history.errMissing";
  if (from > to) return "history.errOrder";
  if (to > today) return "history.errFuture";
  if (dayDiff(from, to) + 1 > MAX_HISTORY_DAYS) return "history.errMax";
  return null;
}

