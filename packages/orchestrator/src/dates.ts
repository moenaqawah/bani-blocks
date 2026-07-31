/**
 * Calendar arithmetic on Amman-local `YYYY-MM-DD` / `HH:MM` strings.
 *
 * Deliberately string-in / string-out: `step()` receives "today" from its
 * caller and never reads a clock, which is what makes it property-testable.
 */

import type { HHMM, ISODate } from "@bani/availability";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function isValidDate(date: string): date is ISODate {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** 0 = Sunday … 6 = Saturday, in Amman-local terms. */
export function weekdayOf(date: ISODate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** The first open day strictly after `date`. */
export function nextOpenDay(date: ISODate, closedWeekdays: readonly number[]): ISODate {
  let candidate = addDays(date, 1);
  for (let guard = 0; guard < 14; guard++) {
    if (!closedWeekdays.includes(weekdayOf(candidate))) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/**
 * Accept the shapes a customer actually types — "11", "11:00", "9:30" —
 * and normalise to zero-padded `HH:MM`. Returns null for anything else.
 */
export function normalizeTime(raw: string): HHMM | null {
  const trimmed = raw.trim();
  const bare = /^([01]?\d|2[0-3])$/.exec(trimmed);
  if (bare) return `${bare[1]!.padStart(2, "0")}:00`;
  const match = TIME_RE.exec(trimmed);
  if (!match) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

export function minutesOf(time: HHMM): number {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function timeFromMinutes(total: number): HHMM {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function addMinutes(time: HHMM, minutes: number): HHMM {
  return timeFromMinutes(minutesOf(time) + minutes);
}
