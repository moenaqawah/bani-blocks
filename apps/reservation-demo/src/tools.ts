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
  findLiveBookingForCustomerAt,
  cancelBooking as dbCancelBooking,
} from "@bani/db";
import {
  utcToLocalParts,
  localWeekday,
  localToUtc,
  slotGrid,
  generateRef,
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

export type CheckAvailabilityResult =
  | {
      ok: true;
      date: string;
      weekday: string;
      slots: string[];
      totalFree: number;
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
        | "DUPLICATE_BOOKING"
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
    check_availability: tool({
      description:
        "Get the real free 30-minute appointment slots for ONE day. Call this before offering or " +
        "confirming any time. Never assume availability.",
      inputSchema: z.object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe(
            "The day to check, in Amman local time, format YYYY-MM-DD. Resolve words like 'tomorrow' yourself.",
          ),
      }),
      execute: async ({ date }): Promise<CheckAvailabilityResult> => {
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

        return {
          ok: true,
          date,
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

        // 2. Duplicate check
        const existing = await findLiveBookingForCustomerAt(
          ctx.sql,
          ctx.customerId,
          startsAt,
        );
        if (existing) {
          return {
            ok: false,
            reason: "DUPLICATE_BOOKING",
            message: `You already have a booking at this time (ref: ${existing.ref}).`,
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
