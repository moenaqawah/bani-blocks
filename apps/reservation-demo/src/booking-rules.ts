/**
 * Booking slot validation — pure, policy-parameterised rules.
 *
 * Extended for multi-resource: validation now accepts an optional
 * `durationMinutes` so the last-bookable-start check is service-dependent.
 */

import { localToUtc, localWeekday } from "@bani/shared";
import { BUSINESS, RESOURCES } from "./config.js";

// ─── reason codes — single source of truth ──────────────────────────

/** The 6 validation-specific rejection reasons. */
export type SlotValidationReason =
  | "INVALID_SLOT"
  | "CLOSED_FRIDAY"
  | "OUTSIDE_HOURS"
  | "PAST_TIME"
  | "TOO_SOON"
  | "BEYOND_HORIZON";

/** Reasons create_bookings can return beyond validation failures. */
export type CreateBookingReason =
  | SlotValidationReason
  | "SLOT_TAKEN"
  | "RESOURCE_CANNOT_DO_SERVICE"
  | "CUSTOMER_BUSY"
  | "TOO_MANY_UPCOMING"
  | "DUPLICATE_SERVICE_SAME_DAY"
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
  | "ALREADY_CANCELLED"
  | "ALREADY_PASSED"
  | "CALENDAR_ERROR";

/** Reasons check_availability / check_available_days can return. */
export type AvailabilityReason =
  | "CLOSED_FRIDAY"
  | "PAST_DATE"
  | "BEYOND_HORIZON"
  | "NO_SLOTS"
  | "RESOURCE_CANNOT_DO_SERVICE"
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
 * `datetime` is an Amman-local ISO string `YYYY-MM-DDTHH:mm`.
 * `durationMinutes` is optional — when provided, the OUTSIDE_HOURS check
 * ensures the end time is also within business hours (a 180-min keratin
 * can't start at 19:00 because it would end at 22:00).
 */
export function validateSlot(
  datetime: string,
  policy: SlotPolicy,
  durationMinutes?: number,
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

  // 3. Working hours
  // Calculate end hour:minutes from start + duration
  const dur = durationMinutes ?? 30;
  const endTotalMinutes = hour * 60 + minutes + dur;
  const endHour = Math.floor(endTotalMinutes / 60);
  const endMin = endTotalMinutes % 60;

  // Start must be within [openHour, closeHour)
  if (hour < policy.openHour) {
    return {
      ok: false,
      reason: "OUTSIDE_HOURS",
      message: "That time is before opening hours.",
    };
  }

  // End must be ≤ closeHour (exclusive at closeHour:00, or exactly at closeHour:00)
  if (
    endHour > policy.closeHour ||
    (endHour === policy.closeHour && endMin > 0)
  ) {
    return {
      ok: false,
      reason: "OUTSIDE_HOURS",
      message: `This service takes ${dur} minutes and would finish after closing time (${policy.closeHour}:00).`,
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
  durationMinutes?: number,
): ValidateSlotResult {
  return validateSlot(datetime, {
    openHour: BUSINESS.openHour,
    closeHour: BUSINESS.closeHour,
    closedWeekdays: BUSINESS.closedWeekdays,
    leadTimeMinutes: BUSINESS.leadTimeMinutes,
    horizonDays: BUSINESS.horizonDays,
    now,
  }, durationMinutes);
}

// ─── capability check ────────────────────────────────────────────────

export type CapabilityResult =
  | { ok: true }
  | { ok: false; unbookableServices: string[]; capableInstead: string[] };

/**
 * Check if a resource can perform every service in the list.
 * Returns the unbookable services and which resources CAN do them on failure.
 */
export function checkResourceCapability(
  resourceCode: string,
  serviceCodes: string[],
): CapabilityResult {
  const r = RESOURCES.find((x) => x.code === resourceCode);
  if (!r || !r.active) {
    return {
      ok: false,
      unbookableServices: serviceCodes,
      capableInstead: findCapableAlternatives(serviceCodes),
    };
  }
  if (typeof r.services === "string") return { ok: true };

  const allowed = r.services;
  const unbookable = serviceCodes.filter((sc) => !allowed.includes(sc));
  if (unbookable.length === 0) return { ok: true };

  return {
    ok: false,
    unbookableServices: unbookable,
    capableInstead: findCapableAlternatives(unbookable),
  };
}

function findCapableAlternatives(serviceCodes: string[]): string[] {
  return RESOURCES
    .filter((r) => r.active && (
      typeof r.services === "string" ||
      serviceCodes.every((sc) => (r.services as readonly string[]).includes(sc))
    ))
    .map((r) => r.code);
}
