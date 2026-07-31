/**
 * The effects executor — the only place the orchestrator's decisions touch
 * the outside world (ADR-004 Layer 2's I/O boundary).
 *
 * Every function here takes a fully-decided effect and reports what happened.
 * None of them decides anything: no choosing employees, no picking times, no
 * "helpfully" retrying with different values. That is `step()`'s job.
 */

import type { Sql } from "postgres";
import { capableEmployees, suggestOffers, type Interval } from "@bani/availability";
import type { Effect, EffectResult } from "@bani/orchestrator";
import { nextOpenDay } from "@bani/orchestrator";
import type { GcalClient } from "@bani/gcal-tool";
import {
  cancelBundle,
  countUpcomingVisitsForCustomer,
  createBookingBundle,
  findBookingByRef,
  findDuplicateServiceOnDay,
  findPastBookingsForCustomer,
  findLiveBookingsForDay,
  setBundleGcalEventId,
  type Booking,
} from "@bani/db";
import { generateRef, localToUtc, logger, utcToLocalParts } from "@bani/shared";
import { validateSlotWithBusiness } from "./booking-rules.js";
import { BOOKING_LIMITS, BUSINESS } from "./config.js";
import { ORCHESTRATOR_CONFIG, serviceDuration } from "./salon.js";

export interface EffectContext {
  sql: Sql;
  gcal: GcalClient;
  customerId: string;
  conversationId: string;
  customerName: string;
  waPhone: string;
  /** Shared by every booking in one visit, so "cancel the visit" is one query. */
  bookingGroupId: string;
  now: Date;
}

export function createExecutor(ctx: EffectContext) {
  return async function execute(effect: Effect): Promise<EffectResult> {
    switch (effect.kind) {
      case "ComputeSuggestions":
        return computeSuggestions(ctx, effect);
      case "CreateBooking":
        return createBooking(ctx, effect);
      case "CancelBooking":
        return cancelBooking(ctx, effect);
      case "FetchPastBookings":
        return fetchPastBookings(ctx, effect);
    }
  };
}

// ─── ComputeSuggestions ─────────────────────────────────────────────────

async function computeSuggestions(
  ctx: EffectContext,
  effect: Extract<Effect, { kind: "ComputeSuggestions" }>,
): Promise<EffectResult> {
  const fail = (reason: "NO_SLOTS" | "CALENDAR_ERROR" | "NO_CAPABLE_EMPLOYEE"): EffectResult => ({
    kind: "SuggestionsComputed",
    group: effect.group,
    ok: false,
    reason,
    ...(reason === "NO_SLOTS"
      ? { nextOpenDate: nextOpenDay(effect.date, BUSINESS.closedWeekdays) }
      : {}),
  });

  const capable = effect.employeePref
    ? [effect.employeePref]
    : capableEmployees(effect.services, ORCHESTRATOR_CONFIG.employees);
  if (capable.length === 0) return fail("NO_CAPABLE_EMPLOYEE");

  let googleBusy: Record<string, Interval[]>;
  let dayBookings: Booking[];
  try {
    const dayStart = localToUtc(`${effect.date}T00:00`);
    const dayEnd = localToUtc(`${effect.date}T24:00`);
    [googleBusy, dayBookings] = await Promise.all([
      ctx.gcal.freeBusyMulti(dayStart, dayEnd).then((r) => r.busy),
      findLiveBookingsForDay(ctx.sql, dayStart, dayEnd),
    ]);
  } catch (err) {
    logger.error("ComputeSuggestions: calendar read failed", { msg: String(err) });
    return fail("CALENDAR_ERROR");
  }

  // Google's busy time plus what this employee already holds in our own DB.
  const busyByEmployee: Record<string, Interval[]> = {};
  for (const employee of capable) {
    busyByEmployee[employee] = [
      ...(googleBusy[employee] ?? []),
      ...toIntervals(dayBookings.filter((b) => b.resource_code === employee)),
    ];
  }

  const { offers, more } = suggestOffers({
    date: effect.date,
    durationMin: effect.durationMin,
    capable,
    busyByEmployee,
    // The customer's own appointments are busy time on EVERY employee's
    // calendar — the no-self-conflict guarantee (ADR-004 A.1 step 3).
    customerBusy: toIntervals(dayBookings.filter((b) => b.customer_id === ctx.customerId)),
    hours: {
      openHour: BUSINESS.openHour,
      closeHour: BUSINESS.closeHour,
      slotMinutes: BUSINESS.slotMinutes,
    },
    // Lead time is enforced by trimming the grid, so it cannot be bypassed by
    // a suggestion the customer then picks.
    leadCutoff: new Date(ctx.now.getTime() + BUSINESS.leadTimeMinutes * 60_000),
    cap: ORCHESTRATOR_CONFIG.maxSlotsOffered,
    maxEmployees: ORCHESTRATOR_CONFIG.maxEmployeesOffered,
    ...(effect.near ? { near: effect.near } : {}),
    ...(effect.direction ? { direction: effect.direction } : {}),
  });

  if (offers.length === 0) return fail("NO_SLOTS");

  return { kind: "SuggestionsComputed", group: effect.group, ok: true, offers, more };
}

function toIntervals(bookings: readonly Booking[]): Interval[] {
  return bookings.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) }));
}

// ─── CreateBooking ──────────────────────────────────────────────────────

async function createBooking(
  ctx: EffectContext,
  effect: Extract<Effect, { kind: "CreateBooking" }>,
): Promise<EffectResult> {
  const fail = (
    reason: Extract<EffectResult, { kind: "BookingCreated"; ok: false }>["reason"],
    extra: { conflictRef?: string; conflictService?: string } = {},
  ): EffectResult => ({ kind: "BookingCreated", group: effect.group, ok: false, reason, ...extra });

  const localIso = `${effect.date}T${effect.time}`;
  const validation = validateSlotWithBusiness(localIso, ctx.now, effect.durationMin);
  if (!validation.ok) {
    if (validation.reason === "TOO_SOON") return fail("TOO_SOON");
    if (validation.reason === "PAST_TIME") return fail("PAST_TIME");
    return fail("OUTSIDE_HOURS");
  }

  const visitCount = await countUpcomingVisitsForCustomer(ctx.sql, ctx.customerId, ctx.now, ctx.bookingGroupId);
  if (visitCount >= BOOKING_LIMITS.maxUpcomingVisits) return fail("TOO_MANY_UPCOMING");

  for (const service of effect.services) {
    const duplicate = await findDuplicateServiceOnDay(
      ctx.sql, ctx.customerId, service, effect.date, ctx.bookingGroupId,
    );
    if (duplicate) {
      return fail("DUPLICATE_SERVICE_SAME_DAY", {
        conflictRef: duplicate.ref,
        conflictService: service,
      });
    }
  }

  const startsAt = validation.startsAt;
  const endsAt = new Date(startsAt.getTime() + effect.durationMin * 60_000);
  const calendarId = ctx.gcal.calendarForResource(effect.employee);
  if (!calendarId) return fail("CALENDAR_ERROR");

  // Google first: a narrow re-check closes most of the TOCTOU window between
  // offering a slot and the customer picking it.
  try {
    if ((await ctx.gcal.freeBusy(calendarId, startsAt, endsAt)).length > 0) return fail("SLOT_TAKEN");
  } catch (err) {
    logger.error("CreateBooking: freeBusy re-check failed", { msg: String(err) });
    return fail("CALENDAR_ERROR");
  }

  const bundleId = crypto.randomUUID();
  const eventId = bundleId.replace(/-/g, "").toLowerCase();
  const rows = buildRows(ctx, effect, bundleId, startsAt);

  try {
    const start = utcToLocalParts(startsAt);
    const end = utcToLocalParts(endsAt);
    await ctx.gcal.insertEvent(effect.employee, {
      eventId,
      summary: `${effect.services.join(" + ")} — ${ctx.customerName}`,
      description: `Booked via WhatsApp. Ref ${rows[0]!.ref}. Phone +${ctx.waPhone}.`,
      startLocal: `${start.date}T${start.time}:00`,
      endLocal: `${end.date}T${end.time}:00`,
    });
  } catch (err) {
    logger.error("CreateBooking: insertEvent failed", { msg: String(err) });
    return fail("CALENDAR_ERROR");
  }

  // The exclusion constraint is the final arbiter — if it rejects the insert,
  // the Calendar event we just made has to go back.
  const inserted = await createBookingBundle(ctx.sql, rows);
  if ("conflict" in inserted) {
    await ctx.gcal.deleteEvent(effect.employee, eventId).catch(() => {
      logger.error("Failed to delete Calendar event after DB conflict", { eventId });
    });
    return fail(inserted.conflict === "customer" ? "CUSTOMER_BUSY" : "SLOT_TAKEN");
  }

  try {
    await setBundleGcalEventId(ctx.sql, bundleId, eventId);
  } catch (err) {
    // The booking is real and the customer will be told so; only the link
    // between row and Calendar event is missing.
    logger.error("Failed to link Calendar event to booking", { msg: String(err) });
  }

  return {
    kind: "BookingCreated",
    group: effect.group,
    ok: true,
    ref: rows[0]!.ref,
    date: effect.date,
    time: effect.time,
    employee: effect.employee,
    services: effect.services,
    durationMin: effect.durationMin,
  };
}

/** One row per service, laid back to back inside the group's block. */
function buildRows(
  ctx: EffectContext,
  effect: Extract<Effect, { kind: "CreateBooking" }>,
  bundleId: string,
  startsAt: Date,
) {
  let cursor = startsAt.getTime();
  return effect.services.map((service) => {
    const duration = serviceDuration(service) * 60_000;
    const row = {
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      customerName: ctx.customerName,
      serviceCode: service,
      resourceCode: effect.employee,
      bookingGroupId: ctx.bookingGroupId,
      bundleId,
      startsAt: new Date(cursor),
      endsAt: new Date(cursor + duration),
      ref: generateRef(),
    };
    cursor += duration;
    return row;
  });
}

// ─── CancelBooking ──────────────────────────────────────────────────────

async function cancelBooking(
  ctx: EffectContext,
  effect: Extract<Effect, { kind: "CancelBooking" }>,
): Promise<EffectResult> {
  const fail = (
    reason: Extract<EffectResult, { kind: "BookingCancelled"; ok: false }>["reason"],
  ): EffectResult => ({ kind: "BookingCancelled", ok: false, ref: effect.ref, reason });

  const booking = await findBookingByRef(ctx.sql, effect.ref);
  if (!booking || booking.customer_id !== ctx.customerId) return fail("NOT_FOUND");
  if (booking.status === "cancelled") return fail("ALREADY_CANCELLED");
  if (new Date(booking.starts_at) < ctx.now) return fail("ALREADY_PASSED");

  if (booking.gcal_event_id) {
    try {
      await ctx.gcal.deleteEvent(booking.resource_code, booking.gcal_event_id);
    } catch (err) {
      logger.error("CancelBooking: deleteEvent failed", { msg: String(err) });
      return fail("CALENDAR_ERROR");
    }
  }

  const cancelled = await cancelBundle(ctx.sql, booking.bundle_id);
  const parts = utcToLocalParts(new Date(booking.starts_at));

  return {
    kind: "BookingCancelled",
    ok: true,
    ref: booking.ref,
    date: parts.date,
    time: parts.time,
    services: (cancelled.length > 0 ? cancelled : [booking]).map((b) => b.service_code),
  };
}

// ─── FetchPastBookings ──────────────────────────────────────────────────

async function fetchPastBookings(
  ctx: EffectContext,
  effect: Extract<Effect, { kind: "FetchPastBookings" }>,
): Promise<EffectResult> {
  let rows: Booking[] = [];
  try {
    rows = await findPastBookingsForCustomer(ctx.sql, ctx.customerId, ctx.now, effect.limit);
  } catch (err) {
    // History is a nicety; failing to read it must not fail the turn.
    logger.error("FetchPastBookings failed", { msg: String(err) });
  }

  // Booking rows are per service; the customer thinks in appointments.
  const byBundle = new Map<string, Booking[]>();
  for (const row of rows) {
    const existing = byBundle.get(row.bundle_id);
    if (existing) existing.push(row);
    else byBundle.set(row.bundle_id, [row]);
  }

  return {
    kind: "PastBookingsFetched",
    bookings: [...byBundle.values()].map((bundle) => {
      const first = bundle[0]!;
      const parts = utcToLocalParts(new Date(first.starts_at));
      return {
        ref: first.ref,
        date: parts.date,
        time: parts.time,
        services: bundle.map((b) => b.service_code),
        employee: first.resource_code,
        bundleId: first.bundle_id,
        bookingGroupId: first.booking_group_id,
      };
    }),
  };
}
