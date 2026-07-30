import { tool, type ToolSet } from "ai";
import { z } from "zod/v4";
import type { Sql } from "postgres";
import type { GcalClient } from "@bani/gcal-tool";
import {
  BUSINESS,
  SERVICES,
} from "./config.js";
import {
  createBooking as dbCreateBooking,
  confirmBooking,
  failBooking,
  findBookingByRef,
  findLiveBookingsForDay,
  findUpcomingLiveBookingForCustomer,
  cancelBooking as dbCancelBooking,
} from "@bani/db";
import {
  utcToLocalParts,
  localWeekday,
  localToUtc,
  slotGrid,
  generateRef,
  logger,
} from "@bani/shared";

export interface ToolContext {
  sql: Sql;
  gcal: GcalClient;
  customerId: string;
  conversationId: string;
  waPhone: string;
  now: Date;
}

// ─── check_availability ────────────────────────────────────────────

// ─── check_available_days ──────────────────────────────────────────
// A day-level survey (no exact times) across a range — meant to precede
// check_availability once the customer picks a specific day. Added
// 2026-07-28: keeps the multi-day scan lean (a handful of bytes per day,
// no slot lists) since exact times aren't needed until a day is chosen.

export interface DaySummary {
  date: string;
  weekday: string;
  closed: boolean; // true on a closed weekday (e.g. Friday)
  totalFree: number;
}

export type CheckAvailableDaysResult =
  | { ok: true; days: DaySummary[] }
  | {
      ok: false;
      date: string;
      reason: "PAST_DATE" | "BEYOND_HORIZON" | "NO_SLOTS" | "CALENDAR_ERROR";
      message: string;
      nextOpenDate?: string;
    };

// ─── check_availability ─────────────────────────────────────────────

export type CheckAvailabilityResult =
  | {
      ok: true;
      date: string;
      weekday: string;
      slots: string[];
      totalFree: number;
      // Present only when the `time` param was passed — whether that EXACT
      // time is free, checked against the full free-slot set (not just the
      // 5-slot `slots` sample above). Added 2026-07-28: without this, a
      // requested time that fell outside the displayed sample had no
      // definitive answer, and the model would sometimes guess rather than
      // following rule 1 ("never state a time is free without checking").
      requestedTimeAvailable?: boolean;
    }
  | {
      ok: false;
      date: string;
      reason:
        | "CLOSED_FRIDAY"
        | "PAST_DATE"
        | "BEYOND_HORIZON"
        | "NO_SLOTS"
        | "CALENDAR_ERROR";
      message: string;
      nextOpenDate?: string;
    };

// ─── create_booking ─────────────────────────────────────────────────

export type CreateBookingResult =
  | {
      ok: true;
      ref: string;
      datetimeLocal: string;
      weekday: string;
      service: string;
      name: string;
    }
  | {
      ok: false;
      reason:
        | "SLOT_TAKEN"
        | "OUTSIDE_HOURS"
        | "CLOSED_FRIDAY"
        | "PAST_TIME"
        | "TOO_SOON"
        | "BEYOND_HORIZON"
        | "INVALID_SLOT"
        | "ALREADY_HAS_BOOKING"
        | "CALENDAR_ERROR";
      message: string;
      alternatives?: string[];
      existingRef?: string;
    };

// ─── reschedule_booking ──────────────────────────────────────────────
// Added 2026-07-28: a plain cancel_booking-then-create_booking sequence
// (the original design's only reschedule path) cancels the old slot
// BEFORE the new one is secured — if the new booking then fails for any
// reason, the customer is left with nothing. This tool reverses that:
// it only cancels the old booking after the new one is confirmed, so a
// failed reschedule always leaves the customer's original appointment
// intact.

export type RescheduleBookingResult =
  | {
      ok: true;
      oldRef: string;
      newRef: string;
      datetimeLocal: string;
      weekday: string;
      service: string;
      name: string;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "ALREADY_CANCELLED"
        | "ALREADY_PASSED"
        | "SLOT_TAKEN"
        | "OUTSIDE_HOURS"
        | "CLOSED_FRIDAY"
        | "PAST_TIME"
        | "TOO_SOON"
        | "BEYOND_HORIZON"
        | "INVALID_SLOT"
        | "ALREADY_HAS_BOOKING"
        | "CALENDAR_ERROR";
      message: string;
      alternatives?: string[];
    };

// ─── cancel_booking ─────────────────────────────────────────────────

export type CancelBookingResult =
  | {
      ok: true;
      ref: string;
      datetimeLocal: string;
      service: string;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "NOT_YOURS"
        | "ALREADY_CANCELLED"
        | "ALREADY_PASSED"
        | "CALENDAR_ERROR";
      message: string;
    };

// ─── get_my_booking ─────────────────────────────────────────────────
// Looks up the customer's own upcoming booking straight from the DB,
// keyed off ctx.customerId — independent of conversation history, so
// it still works after the history recency window has aged a booking
// confirmation out of context. Added 2026-07-29.

export type GetMyBookingResult =
  | {
      found: true;
      ref: string;
      datetimeLocal: string;
      weekday: string;
      service: string;
      name: string;
    }
  | {
      found: false;
      // Present when a live booking existed in our DB but its Calendar
      // event is gone or cancelled — i.e. the salon cancelled it directly
      // in Calendar rather than through cancel_booking. We reconcile our
      // own record to 'cancelled' right here when this happens.
      cancelledBySalon?: {
        ref: string;
        datetimeLocal: string;
        service: string;
      };
    };

// ─── helpers ────────────────────────────────────────────────────────

function findService(code: string): (typeof SERVICES)[number] | undefined {
  return SERVICES.find((s) => s.code === code);
}

function nextOpenDay(date: string): string {
  // Find the next non-Friday date from the given local date
  // Used when returning CLOSED_FRIDAY or NO_SLOTS with nextOpenDate
  const parts = date.split("-").map(Number);
  const d = new Date(Date.UTC(parts[0]!, (parts[1] ?? 1) - 1, parts[2] ?? 1, -3, 0, 0)); // -3h to get Amman midnight
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 5); // Friday
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ─── factory ────────────────────────────────────────────────────────

export function buildTools(ctx: ToolContext): ToolSet {
  const tools = {
    check_available_days: tool({
      description:
        "Survey which days in a range have ANY free slots, without listing exact times. Use this " +
        "when the customer asks broadly — 'what's free this week', 'any day works', 'what's your " +
        "earliest opening' — to see which days are worth offering BEFORE calling check_availability " +
        "for a specific one. Cheap: one call covers up to 14 days.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "The first day to check, in Amman local time, format YYYY-MM-DD. Resolve words like 'tomorrow' yourself.",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(14)
          .describe("How many consecutive days to check starting from and including `date`."),
      }),
      execute: async ({ date, days }): Promise<CheckAvailableDaysResult> => {
        const todayParts = utcToLocalParts(ctx.now);
        if (date < todayParts.date) {
          return { ok: false, date, reason: "PAST_DATE", message: "That date is in the past." };
        }
        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(horizonDate.getUTCDate() + BUSINESS.horizonDays);
        if (date > utcToLocalParts(horizonDate).date) {
          return {
            ok: false,
            date,
            reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.`,
          };
        }

        const rangeStart = localToUtc(`${date}T00:00`);
        const rangeEndExclusive = new Date(rangeStart.getTime() + days * 24 * 60 * 60 * 1000);
        let liveBookings;
        try {
          liveBookings = await findLiveBookingsForDay(ctx.sql, rangeStart, rangeEndExclusive);
        } catch {
          return {
            ok: false,
            date,
            reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly.",
          };
        }

        let dayResults;
        try {
          dayResults = await ctx.gcal.computeSlotsRange(
            date,
            days,
            ctx.now,
            liveBookings.map((b) => ({
              starts_at: new Date(b.starts_at),
              ends_at: new Date(b.ends_at),
            })),
          );
        } catch {
          return {
            ok: false,
            date,
            reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly.",
          };
        }

        const daySummaries: DaySummary[] = dayResults.map((d) => ({
          date: d.date,
          weekday: utcToLocalParts(localToUtc(`${d.date}T10:00`)).weekdayEn,
          closed: d.closed,
          totalFree: d.totalFree,
        }));

        const anyFree = daySummaries.some((d) => d.totalFree > 0);
        if (!anyFree) {
          const next = nextOpenDay(daySummaries[daySummaries.length - 1]?.date ?? date);
          return {
            ok: false,
            date,
            reason: "NO_SLOTS",
            message: `No slots available in the next ${days} days.`,
            nextOpenDate: next,
          };
        }

        return { ok: true, days: daySummaries };
      },
    }),

    check_availability: tool({
      description:
        "Get the real free 30-minute appointment slots for ONE day. Call this before offering or " +
        "confirming any time. Never assume availability. If the customer has named a SPECIFIC time, " +
        "pass `time` too — the response's requestedTimeAvailable tells you definitively whether that " +
        "exact time is free, even if it isn't one of the (at most 5) times shown in `slots`.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "The day to check, in Amman local time, format YYYY-MM-DD. Resolve words like 'tomorrow' yourself.",
          ),
        time: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional()
          .describe(
            "A specific time the customer named, format HH:mm on the :00/:30 grid. Only set this " +
              "when confirming one exact time — omit it for a general 'what's available' check.",
          ),
      }),
      execute: async ({ date, time }): Promise<CheckAvailabilityResult> => {
        // Validate weekday first
        const wd = localToUtc(`${date}T10:00`);
        const weekday = localWeekday(wd);

        if ((BUSINESS.closedWeekdays as readonly number[]).includes(weekday)) {
          const next = nextOpenDay(date);
          return {
            ok: false,
            date,
            reason: "CLOSED_FRIDAY",
            message: "Friday is closed. The next open day is Saturday.",
            nextOpenDate: next,
          };
        }

        // Check date bounds
        const todayParts = utcToLocalParts(ctx.now);
        if (date < todayParts.date) {
          return {
            ok: false,
            date,
            reason: "PAST_DATE",
            message: "That date is in the past.",
          };
        }

        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(horizonDate.getUTCDate() + BUSINESS.horizonDays);
        const horizonParts = utcToLocalParts(horizonDate);
        if (date > horizonParts.date) {
          return {
            ok: false,
            date,
            reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.`,
          };
        }

        // Build grid + filter by lead time
        const grid = slotGrid(date);
        const leadCutoff = new Date(
          ctx.now.getTime() + BUSINESS.leadTimeMinutes * 60_000,
        );
        let candidates = grid.filter((s) => s > leadCutoff);

        if (candidates.length === 0) {
          // All slots are too soon (only possible for today)
          const next = nextOpenDay(date);
          return {
            ok: false,
            date,
            reason: "NO_SLOTS",
            message: "No slots available for this date.",
            nextOpenDate: next,
          };
        }

        // Query live bookings for this day
        const dayStart = localToUtc(`${date}T00:00`);
        const dayEnd = localToUtc(`${date}T24:00`);
        let liveBookings;
        try {
          liveBookings = await findLiveBookingsForDay(
            ctx.sql,
            dayStart,
            dayEnd,
          );
        } catch {
          return {
            ok: false,
            date,
            reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly.",
          };
        }

        // Compute free slots via calendar
        let result;
        try {
          result = await ctx.gcal.computeSlots(
            date,
            ctx.now,
            liveBookings.map((b) => ({
              starts_at: new Date(b.starts_at),
              ends_at: new Date(b.ends_at),
            })),
          );
        } catch {
          return {
            ok: false,
            date,
            reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly.",
          };
        }

        const freeSlots = result.slots;

        if (freeSlots.length === 0) {
          const next = nextOpenDay(date);
          return {
            ok: false,
            date,
            reason: "NO_SLOTS",
            message: "No slots available that day. Here is the next open day.",
            nextOpenDate: next,
          };
        }

        // Spread selection
        const displayed = ctx.gcal.spreadSlots(
          freeSlots,
          BUSINESS.maxSlotsOffered,
        );

        const slotStrings = displayed.map((s) => {
          const p = utcToLocalParts(s);
          return p.time;
        });

        const weekdayName = utcToLocalParts(
          localToUtc(`${date}T10:00`),
        ).weekdayEn;

        let requestedTimeAvailable: boolean | undefined;
        if (time) {
          const requestedStart = localToUtc(`${date}T${time}`);
          requestedTimeAvailable = freeSlots.some(
            (s) => s.getTime() === requestedStart.getTime(),
          );
        }

        return {
          ok: true,
          date,
          ...(requestedTimeAvailable !== undefined ? { requestedTimeAvailable } : {}),
          weekday: weekdayName,
          slots: slotStrings,
          totalFree: freeSlots.length,
        };
      },
    }),

    create_booking: tool({
      description:
        "Create the appointment. Only call after the customer has explicitly confirmed the exact " +
        "date, time, service, and their name.",
      inputSchema: z.object({
        datetime: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
          .describe(
            "Appointment start in Amman local time, format YYYY-MM-DDTHH:mm. Minutes must be 00 or 30.",
          ),
        name: z
          .string()
          .min(2)
          .max(60)
          .describe("The customer's name as they gave it."),
        service: z
          .enum(["haircut", "blowdry", "color", "keratin", "manicure"])
          .describe("The service code."),
      }),
      execute: async (input): Promise<CreateBookingResult> => {
        const { datetime, name, service } = input;

        // 1. Validate
        const [datePart, timePart] = datetime.split("T") as [string, string];
        const [hourStr, minStr] = (timePart ?? "00:00").split(":") as [
          string,
          string,
        ];
        const hour = Number(hourStr);
        const minutes = Number(minStr);

        if (minutes !== 0 && minutes !== 30) {
          return {
            ok: false,
            reason: "INVALID_SLOT",
            message: "Appointments are on the hour or half-hour only.",
          };
        }

        const startsAt = localToUtc(datetime);
        const weekday = localWeekday(startsAt);

        if ((BUSINESS.closedWeekdays as readonly number[]).includes(weekday)) {
          return {
            ok: false,
            reason: "CLOSED_FRIDAY",
            message: "We are closed on Fridays.",
          };
        }

        if (
          hour < BUSINESS.openHour ||
          hour > BUSINESS.closeHour ||
          (hour === BUSINESS.closeHour && minutes > 0) ||
          (hour === BUSINESS.closeHour - 1 && minutes > 30)
        ) {
          return {
            ok: false,
            reason: "OUTSIDE_HOURS",
            message: "That time is outside working hours.",
          };
        }

        if (startsAt <= ctx.now) {
          return {
            ok: false,
            reason: "PAST_TIME",
            message: "That time has already passed.",
          };
        }

        const leadCutoff = new Date(
          ctx.now.getTime() + BUSINESS.leadTimeMinutes * 60_000,
        );
        if (startsAt < leadCutoff) {
          return {
            ok: false,
            reason: "TOO_SOON",
            message: `Appointments must be booked at least ${BUSINESS.leadTimeMinutes} minutes in advance.`,
          };
        }

        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(
          horizonDate.getUTCDate() + BUSINESS.horizonDays,
        );
        if (startsAt > horizonDate) {
          return {
            ok: false,
            reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.`,
          };
        }

        // 2. One live booking per customer at a time — covers both an
        // exact-slot retry and a genuinely different second booking, so a
        // customer can't hold multiple slots (or let the model double-book
        // them via a retried tool call). Cancel-then-rebook is the only
        // path to change an existing booking (see Rescheduling in the
        // system prompt).
        const existing = await findUpcomingLiveBookingForCustomer(
          ctx.sql,
          ctx.customerId,
          ctx.now,
        );
        if (existing) {
          const existingParts = utcToLocalParts(new Date(existing.starts_at));
          return {
            ok: false,
            reason: "ALREADY_HAS_BOOKING",
            message: `You already have an upcoming booking (ref: ${existing.ref}, ${existingParts.human}). Cancel it first if you want to book a different time.`,
            existingRef: existing.ref,
          };
        }

        // 3. Reserve in Postgres
        const endsAt = new Date(
          startsAt.getTime() + BUSINESS.slotMinutes * 60_000,
        );
        const ref = generateRef();
        const svc = findService(service);
        const serviceName = svc?.en ?? service;

        const booking = await dbCreateBooking(ctx.sql, {
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          customerName: name,
          serviceCode: service,
          startsAt,
          endsAt,
          ref,
        });

        if ("conflict" in booking) {
          // SLOT_TAKEN — compute alternatives
          try {
            const dayStart = localToUtc(`${datePart}T00:00`);
            const dayEnd = localToUtc(`${datePart}T24:00`);
            const live = await findLiveBookingsForDay(
              ctx.sql,
              dayStart,
              dayEnd,
            );
            const slotResult = await ctx.gcal.computeSlots(
              datePart,
              ctx.now,
              live.map((b) => ({
                starts_at: new Date(b.starts_at),
                ends_at: new Date(b.ends_at),
              })),
            );
            const alts = ctx.gcal
              .spreadSlots(slotResult.slots, 3)
              .map((s) => utcToLocalParts(s).time);
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message: "That slot was just taken. Here are some alternatives.",
              alternatives: alts,
            };
          } catch {
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message: "That slot was just taken. Please try another time.",
            };
          }
        }

        // Now booking is definitely a Booking
        const bookingRow = booking;

        // 4. Re-check Google
        try {
          const busy = await ctx.gcal.freeBusy(startsAt, endsAt);
          if (busy.length > 0) {
            await failBooking(ctx.sql, bookingRow.id);
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message:
                "That slot was just booked. Please try another time.",
            };
          }
        } catch {
          await failBooking(ctx.sql, booking.id);
          return {
            ok: false,
            reason: "CALENDAR_ERROR",
            message: "Could not complete booking. Please try again.",
          };
        }

        // 5. Create Google Calendar event
        const eventId = bookingRow.id.replace(/-/g, "").toLowerCase();
        const parts = utcToLocalParts(startsAt);

        try {
          await ctx.gcal.insertEvent({
            eventId,
            summary: `${serviceName} — ${name}`,
            description: `Booked via WhatsApp. Ref ${ref}. Phone +${ctx.waPhone}.`,
            startLocal: `${parts.date}T${parts.time}:00`,
            endLocal: `${utcToLocalParts(endsAt).date}T${utcToLocalParts(endsAt).time}:00`,
          });
        } catch {
          await failBooking(ctx.sql, booking.id);
          return {
            ok: false,
            reason: "CALENDAR_ERROR",
            message: "Could not complete booking. Please try again.",
          };
        }

        // 6. Confirm
        await confirmBooking(ctx.sql, bookingRow.id, eventId);

        const datetimeLocal = parts.human;

        return {
          ok: true,
          ref,
          datetimeLocal,
          weekday: parts.weekdayEn,
          service: serviceName,
          name,
        };
      },
    }),

    reschedule_booking: tool({
      description:
        "Move an existing appointment to a new date/time. Use this instead of cancel_booking + " +
        "create_booking whenever the customer wants to CHANGE an appointment they already have — " +
        "it only releases the old slot after the new one is safely booked, so they never end up " +
        "with nothing. Only call after the customer has explicitly confirmed the new date, time, " +
        "service, and name.",
      inputSchema: z.object({
        oldRef: z
          .string()
          .regex(/^BK-[A-Z0-9]{6}$/i)
          .describe("The reference of the existing booking being replaced."),
        datetime: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
          .describe(
            "New appointment start in Amman local time, format YYYY-MM-DDTHH:mm. Minutes must be 00 or 30.",
          ),
        name: z
          .string()
          .min(2)
          .max(60)
          .describe("The customer's name as they gave it."),
        service: z
          .enum(["haircut", "blowdry", "color", "keratin", "manicure"])
          .describe("The service code for the new appointment."),
      }),
      execute: async (input): Promise<RescheduleBookingResult> => {
        const { oldRef, datetime, name, service } = input;

        // 1. The old booking must be real, ours, and still live.
        const oldBooking = await findBookingByRef(ctx.sql, oldRef);
        if (!oldBooking || oldBooking.customer_id !== ctx.customerId) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message: "I couldn't find a booking with that reference.",
          };
        }
        if (oldBooking.status === "cancelled") {
          return {
            ok: false,
            reason: "ALREADY_CANCELLED",
            message: "This booking was already cancelled.",
          };
        }
        const oldStartsAt = new Date(oldBooking.starts_at);
        if (oldStartsAt < ctx.now) {
          return {
            ok: false,
            reason: "ALREADY_PASSED",
            message: "This appointment has already passed. Please call the salon directly.",
          };
        }

        // 2. Validate the new slot — identical rules to create_booking.
        const [datePart, timePart] = datetime.split("T") as [string, string];
        const [hourStr, minStr] = (timePart ?? "00:00").split(":") as [string, string];
        const hour = Number(hourStr);
        const minutes = Number(minStr);

        if (minutes !== 0 && minutes !== 30) {
          return {
            ok: false,
            reason: "INVALID_SLOT",
            message: "Appointments are on the hour or half-hour only.",
          };
        }

        const startsAt = localToUtc(datetime);
        const weekday = localWeekday(startsAt);

        if ((BUSINESS.closedWeekdays as readonly number[]).includes(weekday)) {
          return { ok: false, reason: "CLOSED_FRIDAY", message: "We are closed on Fridays." };
        }
        if (
          hour < BUSINESS.openHour ||
          hour > BUSINESS.closeHour ||
          (hour === BUSINESS.closeHour && minutes > 0) ||
          (hour === BUSINESS.closeHour - 1 && minutes > 30)
        ) {
          return { ok: false, reason: "OUTSIDE_HOURS", message: "That time is outside working hours." };
        }
        if (startsAt <= ctx.now) {
          return { ok: false, reason: "PAST_TIME", message: "That time has already passed." };
        }
        const leadCutoff = new Date(ctx.now.getTime() + BUSINESS.leadTimeMinutes * 60_000);
        if (startsAt < leadCutoff) {
          return {
            ok: false,
            reason: "TOO_SOON",
            message: `Appointments must be booked at least ${BUSINESS.leadTimeMinutes} minutes in advance.`,
          };
        }
        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(horizonDate.getUTCDate() + BUSINESS.horizonDays);
        if (startsAt > horizonDate) {
          return {
            ok: false,
            reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.`,
          };
        }

        // 3. Defensive: any OTHER live booking besides the one being
        // replaced still blocks — the one-at-a-time guardrail should have
        // already prevented this, but don't assume it.
        const otherExisting = await findUpcomingLiveBookingForCustomer(
          ctx.sql,
          ctx.customerId,
          ctx.now,
          oldBooking.id,
        );
        if (otherExisting) {
          return {
            ok: false,
            reason: "ALREADY_HAS_BOOKING",
            message: `You already have another upcoming booking (ref: ${otherExisting.ref}). Cancel it first.`,
          };
        }

        // 4. Reserve the NEW booking in Postgres. The old booking is not
        // touched yet — if this fails, the customer keeps what they had.
        const endsAt = new Date(startsAt.getTime() + BUSINESS.slotMinutes * 60_000);
        const newRef = generateRef();
        const svc = findService(service);
        const serviceName = svc?.en ?? service;

        const newBooking = await dbCreateBooking(ctx.sql, {
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          customerName: name,
          serviceCode: service,
          startsAt,
          endsAt,
          ref: newRef,
        });

        if ("conflict" in newBooking) {
          try {
            const dayStart = localToUtc(`${datePart}T00:00`);
            const dayEnd = localToUtc(`${datePart}T24:00`);
            const live = await findLiveBookingsForDay(ctx.sql, dayStart, dayEnd);
            const slotResult = await ctx.gcal.computeSlots(
              datePart,
              ctx.now,
              live.map((b) => ({ starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at) })),
            );
            const alts = ctx.gcal
              .spreadSlots(slotResult.slots, 3)
              .map((s) => utcToLocalParts(s).time);
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message: "That slot was just taken. Here are some alternatives. Your original booking is unchanged.",
              alternatives: alts,
            };
          } catch {
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message: "That slot was just taken. Your original booking is unchanged.",
            };
          }
        }

        const newBookingRow = newBooking;

        // 5. Re-check Google for the new slot. Still haven't touched the old booking.
        try {
          const busy = await ctx.gcal.freeBusy(startsAt, endsAt);
          if (busy.length > 0) {
            await failBooking(ctx.sql, newBookingRow.id);
            return {
              ok: false,
              reason: "SLOT_TAKEN",
              message: "That slot was just booked. Your original booking is unchanged.",
            };
          }
        } catch {
          await failBooking(ctx.sql, newBookingRow.id);
          return {
            ok: false,
            reason: "CALENDAR_ERROR",
            message: "Could not complete the reschedule. Your original booking is unchanged.",
          };
        }

        // 6. Create the new Calendar event. Still haven't touched the old booking.
        const eventId = newBookingRow.id.replace(/-/g, "").toLowerCase();
        const parts = utcToLocalParts(startsAt);
        try {
          await ctx.gcal.insertEvent({
            eventId,
            summary: `${serviceName} — ${name}`,
            description: `Booked via WhatsApp. Ref ${newRef}. Phone +${ctx.waPhone}.`,
            startLocal: `${parts.date}T${parts.time}:00`,
            endLocal: `${utcToLocalParts(endsAt).date}T${utcToLocalParts(endsAt).time}:00`,
          });
        } catch {
          await failBooking(ctx.sql, newBookingRow.id);
          return {
            ok: false,
            reason: "CALENDAR_ERROR",
            message: "Could not complete the reschedule. Your original booking is unchanged.",
          };
        }

        // 7. The new booking is real and confirmed. ONLY NOW release the old one.
        await confirmBooking(ctx.sql, newBookingRow.id, eventId);

        if (oldBooking.gcal_event_id) {
          try {
            await ctx.gcal.deleteEvent(oldBooking.gcal_event_id);
          } catch {
            // Best effort: the new booking is already confirmed and live,
            // so the old one must still be marked cancelled below even if
            // its Calendar event couldn't be removed — otherwise the
            // customer would appear to hold two live bookings, which the
            // one-at-a-time guardrail should never allow (§5.6 takes the
            // same stance: a customer told "done" must not still occupy
            // the old slot in our own table, even if Calendar cleanup failed).
            logger.error("Failed to delete old Calendar event during reschedule", {
              conversationId: ctx.conversationId,
              bookingRef: oldRef,
            });
          }
        }
        await dbCancelBooking(ctx.sql, oldBooking.id);

        return {
          ok: true,
          oldRef,
          newRef,
          datetimeLocal: parts.human,
          weekday: parts.weekdayEn,
          service: serviceName,
          name,
        };
      },
    }),

    get_my_booking: tool({
      description:
        "Look up the customer's own current upcoming appointment (ref, date, time, service, name), " +
        "if any. Use this whenever the customer asks about their booking without giving you a " +
        "reference code — e.g. 'when is my appointment', 'what did I book', 'remind me my ref' — " +
        "or before cancel_booking/reschedule_booking when they don't know their ref. Takes no " +
        "input — the customer is already identified from WhatsApp. Also detects if the salon " +
        "cancelled the appointment directly (not through you) — check cancelledBySalon in the result.",
      inputSchema: z.object({}),
      execute: async (): Promise<GetMyBookingResult> => {
        const booking = await findUpcomingLiveBookingForCustomer(
          ctx.sql,
          ctx.customerId,
          ctx.now,
        );
        if (!booking) return { found: false };

        const parts = utcToLocalParts(new Date(booking.starts_at));
        const svc = findService(booking.service_code);
        const serviceName = svc?.en ?? booking.service_code;

        // Our DB only learns of a cancellation through cancel_booking /
        // reschedule_booking — if staff cancelled the event directly in
        // Calendar, this row would otherwise sit as 'confirmed' forever.
        // Check live, and reconcile our own record if it's gone.
        if (booking.gcal_event_id) {
          try {
            const calEvent = await ctx.gcal.getEvent(booking.gcal_event_id);
            if (!calEvent.exists || calEvent.status === "cancelled") {
              await dbCancelBooking(ctx.sql, booking.id);
              return {
                found: false,
                cancelledBySalon: {
                  ref: booking.ref,
                  datetimeLocal: parts.human,
                  service: serviceName,
                },
              };
            }
          } catch {
            // Calendar check failed — fall back to trusting our own DB
            // record rather than blocking the lookup entirely.
          }
        }

        return {
          found: true,
          ref: booking.ref,
          datetimeLocal: parts.human,
          weekday: parts.weekdayEn,
          service: serviceName,
          name: booking.customer_name,
        };
      },
    }),

    cancel_booking: tool({
      description:
        "Cancel an existing appointment using its reference code, e.g. BK-7F3K2Q.",
      inputSchema: z.object({
        ref: z
          .string()
          .regex(/^BK-[A-Z0-9]{6}$/i)
          .describe(
            "The booking reference the customer received when booking.",
          ),
      }),
      execute: async ({ ref }): Promise<CancelBookingResult> => {
        const booking = await findBookingByRef(ctx.sql, ref);

        if (!booking) {
          return {
            ok: false,
            reason: "NOT_FOUND",
            message:
              "I couldn't find a booking with that reference.",
          };
        }

        // NOT_YOURS: ref exists but belongs to a different customer
        if (booking.customer_id !== ctx.customerId) {
          return {
            ok: false,
            reason: "NOT_FOUND", // same wording as NOT_FOUND deliberately
            message:
              "I couldn't find a booking with that reference.",
          };
        }

        if (booking.status === "cancelled") {
          return {
            ok: false,
            reason: "ALREADY_CANCELLED",
            message:
              "This booking was already cancelled.",
          };
        }

        const startsAt = new Date(booking.starts_at);
        if (startsAt < ctx.now) {
          return {
            ok: false,
            reason: "ALREADY_PASSED",
            message:
              "This appointment has already passed. Please call the salon directly.",
          };
        }

        // Delete Google Calendar event
        if (booking.gcal_event_id) {
          try {
            await ctx.gcal.deleteEvent(booking.gcal_event_id);
          } catch {
            return {
              ok: false,
              reason: "CALENDAR_ERROR",
              message:
                "Could not cancel the appointment. Please try again or call the salon.",
            };
          }
        }

        await dbCancelBooking(ctx.sql, booking.id);

        const parts = utcToLocalParts(startsAt);
        const svc = findService(booking.service_code);
        const serviceName = svc?.en ?? booking.service_code;

        return {
          ok: true,
          ref: booking.ref,
          datetimeLocal: parts.human,
          service: serviceName,
        };
      },
    }),
  };

  return tools;
}
