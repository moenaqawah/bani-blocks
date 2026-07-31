import type { Interval } from "./types.js";

/**
 * Merge an employee's busy time with the customer's own busy time into one
 * effective calendar.
 *
 * Folding the customer's bookings into EVERY employee's calendar is the
 * no-self-conflict guarantee of ADR-004 A.1 step 3: a suggestion can never
 * overlap something the customer already holds, including a group booked
 * earlier in this same visit.
 */
export function mergeCalendars(
  employeeBusy: readonly Interval[],
  customerBusy: readonly Interval[],
): Interval[] {
  return normalizeIntervals([...employeeBusy, ...customerBusy]);
}

/** Sort by start and coalesce overlapping or touching spans. */
export function normalizeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start.getTime() <= last.end.getTime()) {
      if (current.end > last.end) last.end = current.end;
      continue;
    }
    merged.push({ start: new Date(current.start), end: new Date(current.end) });
  }
  return merged;
}

/** True when `[start, end)` touches any of the (normalized) busy spans. */
export function overlapsAny(
  start: Date,
  end: Date,
  busy: readonly Interval[],
): boolean {
  return busy.some((b) => start < b.end && end > b.start);
}
