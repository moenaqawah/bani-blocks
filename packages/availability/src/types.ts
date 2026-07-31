/**
 * Availability engine types — ADR-004 Appendix A.
 *
 * Everything here is data. The engine performs no I/O: callers supply
 * busy intervals (from Google freeBusy and the bookings table) and get
 * candidate start times back.
 */

/** Amman-local calendar date, `YYYY-MM-DD`. */
export type ISODate = string;

/** Amman-local wall-clock time, `HH:MM`, always 24-hour and zero-padded. */
export type HHMM = string;

/** A half-open busy span `[start, end)` in absolute time. */
export interface Interval {
  start: Date;
  end: Date;
}

/** One service the business sells. */
export interface ServiceDef {
  code: string;
  durationMinutes: number;
}

/** One bookable employee. */
export interface EmployeeDef {
  code: string;
  /** Service codes this employee can perform. */
  services: readonly string[];
  active: boolean;
}

/**
 * A group is the unit that becomes ONE booking: a set of services that a
 * single employee can perform back-to-back in one contiguous block.
 *
 * `key` is derived from the sorted service codes, so it is stable across
 * turns and readable in logs and in the state block shown to the translator.
 */
export interface Group {
  key: string;
  services: string[];
  durationMin: number;
  /** Employee codes able to perform every service in the group. */
  capable: string[];
}

/** Grid/window options for {@link windowSuggestions}. */
export interface WindowOptions {
  /** Grid granularity in minutes — must match the grid passed in. */
  slotMinutes: number;
  /** Maximum number of times returned. */
  cap: number;
  /**
   * Bias the result towards times adjacent to an already-booked group:
   * booking hair at 10:00 makes 11:00 the first nails offer.
   */
  near?: HHMM;
  /** Only return times strictly before `near`. */
  before?: HHMM;
  /** Only return times strictly after `near`. */
  after?: HHMM;
}
