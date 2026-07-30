/**
 * Booking slot validation — pure, policy-parameterised rules.
 *
 * Extracted from the duplicated validation blocks that existed verbatim in
 * create_booking.execute and reschedule_booking.execute. Returns a
 * discriminated union carrying the parsed Date and datePart on success so
 * callers never re-parse after validation.
 */

import { localToUtc, localWeekday } from "@bani/shared";
import { BUSINESS } from "./config.js";

// ─── reason codes — single source of truth ──────────────────────────

/** The 6 validation-specific rejection reasons. */
export type SlotValidationReason =
  | "INVALID_SLOT"
  | "CLOSED_FRIDAY"
  | "OUTSIDE_HOURS"
  | "PAST_TIME"
  | "TOO_SOON"
  | "BEYOND_HORIZON";

/** Reasons create_booking can return beyond validation failures. */
export type CreateBookingReason =
  | SlotValidationReason
  | "SLOT_TAKEN"
  | "ALREADY_HAS_BOOKING"
  | "CALENDAR_ERROR";

/** Reasons reschedule_booking can return beyond validation failures. */
export type RescheduleBookingReason =
  | CreateBookingReason
  | "NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "ALREADY_PASSED";

/** Reasons cancel_booking can return. */
export type CancelBookingReason =
  | "NOT_FOUND"
  | "NOT_YOURS"
  | "ALREADY_CANCELLED"
  | "ALREADY_PASSED"
  | "CALENDAR_ERROR";

/** Reasons check_availability / check_available_days can return. */
export type AvailabilityReason =
  | "CLOSED_FRIDAY"
  | "PAST_DATE"
  | "BEYOND_HORIZON"
  | "NO_SLOTS"
  | "CALENDAR_ERROR";

// ─── policy ──────────────────────────────────────────────────────────

export interface SlotPolicy {
  openHour: number;
  closeHour: number;
  closedWeekdays: readonly number[];
  leadTimeMinutes: number;
  horizonDays: number;
  now: Date;
}

// ─── result ──────────────────────────────────────────────────────────

export type ValidateSlotResult =
  | {
      ok: true;
      startsAt: Date;
      datePart: string;
    }
  | {
      ok: false;
      reason: SlotValidationReason;
      message: string;
    };

// ─── validate ────────────────────────────────────────────────────────

/**
 * Validate a slot datetime string against business policy.
 *
 * The `datetime` parameter is an Amman-local ISO string in the format
 * `YYYY-MM-DDTHH:mm` (no seconds, no offset). Minutes must be `00` or `30`.
 *
 * Returns a discriminated union — the caller branches on `ok` and gets
 * the parsed `startsAt` and `datePart` for free on success, so it never
 * needs to re-parse or re-derive them.
 */
export function validateSlot(
  datetime: string,
  policy: SlotPolicy,
): ValidateSlotResult {
  const split = datetime.split("T");
  const datePart = split[0]!;
  const timePart = split[1] ?? "00:00";
  const timeSplit = timePart.split(":");
  const hourStr = timeSplit[0] ?? "0";
  const minStr = timeSplit[1] ?? "0";
  const hour = Number(hourStr);
  const minutes = Number(minStr);

  // 1. Slot granularity — must be :00 or :30
  if (minutes !== 0 && minutes !== 30) {
    return {
      ok: false,
      reason: "INVALID_SLOT",
      message: "Appointments are on the hour or half-hour only.",
    };
  }

  const startsAt = localToUtc(datetime);
  const weekday = localWeekday(startsAt);

  // 2. Closed weekday (e.g. Friday)
  if (policy.closedWeekdays.includes(weekday)) {
    return {
      ok: false,
      reason: "CLOSED_FRIDAY",
      message: "We are closed on Fridays.",
    };
  }

  // 3. Working hours — [openHour, closeHour), last start at (closeHour - 1):30
  if (
    hour < policy.openHour ||
    hour > policy.closeHour ||
    (hour === policy.closeHour && minutes > 0) ||
    (hour === policy.closeHour - 1 && minutes > 30)
  ) {
    return {
      ok: false,
      reason: "OUTSIDE_HOURS",
      message: "That time is outside working hours.",
    };
  }

  // 4. Not in the past
  if (startsAt <= policy.now) {
    return {
      ok: false,
      reason: "PAST_TIME",
      message: "That time has already passed.",
    };
  }

  // 5. Lead time
  const leadCutoff = new Date(
    policy.now.getTime() + policy.leadTimeMinutes * 60_000,
  );
  if (startsAt < leadCutoff) {
    return {
      ok: false,
      reason: "TOO_SOON",
      message: `Appointments must be booked at least ${policy.leadTimeMinutes} minutes in advance.`,
    };
  }

  // 6. Booking horizon
  const horizonDate = new Date(policy.now);
  horizonDate.setUTCDate(
    horizonDate.getUTCDate() + policy.horizonDays,
  );
  if (startsAt > horizonDate) {
    return {
      ok: false,
      reason: "BEYOND_HORIZON",
      message: `We only book up to ${policy.horizonDays} days ahead.`,
    };
  }

  return { ok: true, startsAt, datePart };
}

/**
 * Convenience wrapper — calls validateSlot with this app's BUSINESS policy.
 */
export function validateSlotWithBusiness(
  datetime: string,
  now: Date,
): ValidateSlotResult {
  return validateSlot(datetime, {
    openHour: BUSINESS.openHour,
    closeHour: BUSINESS.closeHour,
    closedWeekdays: BUSINESS.closedWeekdays,
    leadTimeMinutes: BUSINESS.leadTimeMinutes,
    horizonDays: BUSINESS.horizonDays,
    now,
  });
}
