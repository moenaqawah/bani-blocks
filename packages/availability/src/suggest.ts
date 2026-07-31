/**
 * The whole per-group suggestion pipeline (ADR-004 A.1), as one pure function.
 *
 * The executor's only remaining job is fetching busy time and calling this.
 * Keeping the decision here means tests can drive the real logic with an
 * in-memory calendar instead of re-implementing it — a fake that reimplements
 * the thing it is testing proves nothing.
 */

import { mergeCalendars } from "./calendars.js";
import { buildGrid, toHHMM, windowSuggestions } from "./window.js";
import type { HHMM, ISODate, Interval } from "./types.js";

export interface EmployeeOffer {
  employee: string;
  times: HHMM[];
}

export interface SuggestParams {
  date: ISODate;
  durationMin: number;
  /** Employees able to perform the group, already filtered by preference. */
  capable: readonly string[];
  busyByEmployee: Readonly<Record<string, readonly Interval[]>>;
  /** The customer's own appointments — busy on EVERY employee's calendar. */
  customerBusy: readonly Interval[];
  hours: { openHour: number; closeHour: number; slotMinutes: number };
  /** Nothing before this may be offered; enforced by trimming the grid. */
  leadCutoff: Date;
  cap: number;
  maxEmployees: number;
  near?: HHMM;
  direction?: "earlier" | "later";
}

export interface SuggestResult {
  offers: EmployeeOffer[];
  /** True when capable employees were left out of the payload. */
  more: boolean;
}

export function suggestOffers(params: SuggestParams): SuggestResult {
  const grid = buildGrid(
    params.date,
    params.hours.openHour,
    params.hours.closeHour,
    params.hours.slotMinutes,
  ).filter((slot) => slot > params.leadCutoff);

  const offers: EmployeeOffer[] = [];
  for (const employee of params.capable) {
    const merged = mergeCalendars(params.busyByEmployee[employee] ?? [], params.customerBusy);

    const times = windowSuggestions(merged, params.durationMin, grid, {
      slotMinutes: params.hours.slotMinutes,
      cap: params.cap,
      ...(params.near ? { near: params.near } : {}),
      ...(params.direction === "earlier" ? { before: params.near } : {}),
      ...(params.direction === "later" ? { after: params.near } : {}),
    }).map(toHHMM);

    if (times.length > 0) offers.push({ employee, times });
  }

  // Payload discipline: the employees with the most availability first, the
  // rest collapsed into "more".
  offers.sort((a, b) => b.times.length - a.times.length || a.employee.localeCompare(b.employee));
  const shown = offers.slice(0, params.maxEmployees);

  return { offers: shown, more: offers.length > shown.length };
}
