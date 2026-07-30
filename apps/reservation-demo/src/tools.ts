import { tool, type ToolSet } from "ai";
import { z } from "zod/v4";
import type { Sql } from "postgres";
import type { GcalClient } from "@bani/gcal-tool";
import {
  BUSINESS,
  SERVICES,
  RESOURCES,
  RESOURCE_CODES,
  SERVICE_CODES,
  BOOKING_LIMITS,
  getServiceDuration,
  getTotalDuration,
  resourceCanDo,
  capableResources,
} from "./config.js";
import {
  validateSlotWithBusiness,
  checkResourceCapability,
  type CreateBookingReason,
  type RescheduleBookingReason,
  type CancelBookingReason,
  type AvailabilityReason,
} from "./booking-rules.js";
import {
  createBookingBundle,
  setBundleGcalEventId,
  failBundle,
  cancelBundle,
  findBookingByRef,
  findLiveBookingsInGroup,
  findLiveBookingsForDay,
  findUpcomingLiveBookingsForCustomer,
  countUpcomingVisitsForCustomer,
  findDuplicateServiceOnDay,
  cancelBooking as dbCancelBooking,
} from "@bani/db";
import {
  findContiguousBlocks,
  type FreeSlot,
} from "@bani/gcal-tool";
import {
  utcToLocalParts,
  localWeekday,
  localToUtc,
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

// ─── type definitions ──────────────────────────────────────────────────

export interface DaySummary {
  date: string;
  weekday: string;
  closed: boolean;
  totalFree: number;
}

export type CheckAvailableDaysResult =
  | { ok: true; days: DaySummary[] }
  | { ok: false; date: string; reason: AvailabilityReason; message: string; nextOpenDate?: string };

// ─── Visit plan types — the primary output of check_availability ──────

/** One bundle within a visit plan — a contiguous block on one employee. */
export interface VisitPlanBundle {
  services: string[];
  resource: string;
  resourceName: string;
  start: string;              // "HH:MM" Amman local
  durationMinutes: number;
}

/** A complete, validated way to do all requested services. */
export interface VisitPlan {
  bundles: VisitPlanBundle[];
  totalDurationMinutes: number;
}

export type CheckAvailabilityResult =
  | {
      ok: true;
      date: string;
      weekday: string;
      plans: VisitPlan[];
      /** Total distinct start-time combinations across all groupings. */
      totalPlans: number;
    }
  | {
      ok: false;
      date: string;
      reason: AvailabilityReason;
      message: string;
      nextOpenDate?: string;
      unbookableServices?: string[];
      capableInstead?: string[];
      /** When a named employee can't do the service, include alternative plans. */
      alternativePlans?: VisitPlan[];
    };

export type BundleResultItem =
  | {
      ok: true;
      ref: string;
      datetimeLocal: string;
      weekday: string;
      services: string[];
      durationMinutes: number;
      resource: string;
      resourceName: string;
      name: string;
    }
  | {
      ok: false;
      reason: CreateBookingReason;
      message: string;
      alternatives?: string[];
    };

export type CreateBookingsResult = {
  results: BundleResultItem[];
  bookingGroupId: string;
};

export type RescheduleBookingResult =
  | { ok: true; oldRef: string; newRef: string; datetimeLocal: string;
      weekday: string; service: string; name: string; }
  | { ok: false; reason: RescheduleBookingReason; message: string; alternatives?: string[] };

export type CancelBookingResult =
  | { ok: true; ref: string; datetimeLocal: string; service: string;
      otherBundlesInVisit?: { ref: string; service: string; datetimeLocal: string }[]; }
  | { ok: false; reason: CancelBookingReason; message: string };

export interface GetMyBookingsResultItem {
  ref: string;
  datetimeLocal: string;
  weekday: string;
  services: string[];
  resource: string;
  resourceName: string;
  name: string;
}

export type GetMyBookingsResult =
  | { found: true; bookings: GetMyBookingsResultItem[]; upcomingVisits: number; maxVisits: number; }
  | { found: false; cancelledBySalon?: { ref: string; datetimeLocal: string; service: string } };

// ─── helpers ────────────────────────────────────────────────────────────

function findService(code: string): (typeof SERVICES)[number] | undefined {
  return SERVICES.find((s) => s.code === code);
}

function findResource(code: string): (typeof RESOURCES)[number] | undefined {
  return RESOURCES.find((r) => r.code === code);
}

function nextOpenDay(date: string): string {
  const parts = date.split("-").map(Number);
  const d = new Date(Date.UTC(parts[0]!, (parts[1] ?? 1) - 1, parts[2] ?? 1, -3, 0, 0));
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 5);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Enumerate all valid ways to partition services across capable employees.
 * Brute-force: for each service, find all capable employees; then
 * try merging services into shared bundles where employees overlap.
 */
function enumerateBundles(
  serviceCodes: string[],
  namedResource?: string,
): Array<Array<{ services: string[]; resource: string }>> {
  if (serviceCodes.length === 0) return [];

  // If employee named, they must cover every service
  if (namedResource) {
    const canDo = serviceCodes.every((sc) => resourceCanDo(namedResource, [sc]));
    if (canDo) {
      return [[{ services: [...serviceCodes], resource: namedResource }]];
    }
    return [];
  }

  // For each service, get the list of capable resources
  const perService: string[][] = serviceCodes.map((sc) => capableResources([sc]));
  // If any service has zero capable resources, no solution
  if (perService.some((candidates) => candidates.length === 0)) return [];

  const results: Array<Array<{ services: string[]; resource: string }>> = [];

  function assign(
    idx: number,
    bundles: Map<string, string[]>,
  ) {
    if (idx === serviceCodes.length) {
      const bundleList = Array.from(bundles.entries())
        .filter(([, svcs]) => svcs.length > 0)
        .map(([rc, svcs]) => ({ services: [...svcs].sort(), resource: rc }));
      results.push(bundleList);
      return;
    }

    const svc = serviceCodes[idx]!;
    const candidates = perService[idx]!;

    for (const rc of candidates) {
      const existing = bundles.get(rc) ?? [];
      const combined = [...existing, svc];
      if (!resourceCanDo(rc, combined)) continue;

      const newBundles = new Map(bundles);
      newBundles.set(rc, combined);
      assign(idx + 1, newBundles);
    }
  }

  assign(0, new Map());

  // Deduplicate
  const seen = new Set<string>();
  return results.filter((bundles) => {
    const key = bundles
      .map((b) => `${[...b.services].sort().join(",")}:${b.resource}`)
      .sort()
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Generate all valid visit plans for a grouping by finding all compatible
 * start-time combinations. A plan is valid iff each bundle has a contiguous
 * free block and bundle N+1 starts >= bundle N ends.
 */
const MAX_PLANS = 5;

function generatePlans(
  grouping: Array<{ services: string[]; resource: string }>,
  freeByResource: Record<string, Date[]>,
): VisitPlan[] {
  if (grouping.length === 0) return [];

  // Pre-compute contiguous blocks for each bundle in this grouping
  const bundleBlocksList: Array<{
    bundleIdx: number;
    blocks: FreeSlot[];
  }> = [];

  for (let i = 0; i < grouping.length; i++) {
    const b = grouping[i]!;
    const dur = getTotalDuration(b.services);
    const resourceSlots: Record<string, Date[]> = {
      [b.resource]: freeByResource[b.resource] ?? [],
    };
    const blocks = findContiguousBlocks(resourceSlots, dur, BUSINESS.slotMinutes);
    if (blocks.length === 0) return []; // This grouping can't work
    bundleBlocksList.push({ bundleIdx: i, blocks });
  }

  const plans: VisitPlan[] = [];

  function walk(bundleIdx: number, acc: Array<{ start: Date }>) {
    if (plans.length >= MAX_PLANS) return;

    if (bundleIdx >= bundleBlocksList.length) {
      const bundles: VisitPlanBundle[] = acc.map((entry, bi) => {
        const g = grouping[bi]!;
        const rInfo = findResource(g.resource);
        return {
          services: g.services,
          resource: g.resource,
          resourceName: rInfo?.en ?? g.resource,
          start: utcToLocalParts(entry.start).time,
          durationMinutes: getTotalDuration(g.services),
        };
      });

      plans.push({
        bundles,
        totalDurationMinutes: bundles.reduce((s, b) => s + b.durationMinutes, 0),
      });
      return;
    }

    const { blocks } = bundleBlocksList[bundleIdx]!;
    const prevEndMs = bundleIdx > 0
      ? acc[bundleIdx - 1]!.start.getTime() +
        getTotalDuration(grouping[bundleIdx - 1]!.services) * 60_000
      : 0;

    for (const block of blocks) {
      if (bundleIdx > 0 && block.start.getTime() < prevEndMs) continue;
      walk(bundleIdx + 1, [...acc, { start: block.start }]);
      if (plans.length >= MAX_PLANS) return;
    }
  }

  walk(0, []);
  return plans;
}

/** Score plans: fewer bundles first, then less dead time between bundles. */
function scorePlan(plan: VisitPlan): number {
  let deadMinutes = 0;
  for (let i = 1; i < plan.bundles.length; i++) {
    const prev = plan.bundles[i - 1]!;
    const curr = plan.bundles[i]!;
    const prevEndMin = timeStrToMinutes(prev.start) + prev.durationMinutes;
    const currStartMin = timeStrToMinutes(curr.start);
    deadMinutes += Math.max(0, currStartMin - prevEndMin);
  }
  return (100 - plan.bundles.length) * 1000 - deadMinutes;
}

// ─── factory ────────────────────────────────────────────────────────────

export function buildTools(ctx: ToolContext): ToolSet {
  /**
   * Compute alternatives for a failed bundle that do NOT overlap with
   * already-confirmed spans from earlier bundles in the same visit.
   */
  async function computeNonOverlappingAlternatives(
    datePart: string,
    services: string[],
    namedResource: string,
    confirmedSpans: Array<{ start: Date; end: Date }>,
    requestedStart: Date,
  ): Promise<string[]> {
    try {
      const dayStart = localToUtc(`${datePart}T00:00`);
      const dayEnd = localToUtc(`${datePart}T24:00`);
      const live = await findLiveBookingsForDay(ctx.sql, dayStart, dayEnd);
      const slotResult = await ctx.gcal.computeSlots(
        datePart, ctx.now,
        live.map((b) => ({
          starts_at: new Date(b.starts_at),
          ends_at: new Date(b.ends_at),
          resource_code: b.resource_code,
        })),
      );

      const totalDur = getTotalDuration(services);
      const resourceSlots: Record<string, Date[]> = {
        [namedResource]: slotResult.freeByResource[namedResource] ?? [],
      };
      const blocks = findContiguousBlocks(resourceSlots, totalDur, BUSINESS.slotMinutes);

      // Filter out blocks that overlap with confirmed spans
      const validBlocks = blocks.filter((b) => {
        const blockEnd = new Date(b.start.getTime() + totalDur * 60_000);
        return !confirmedSpans.some((span) =>
          b.start < span.end && blockEnd > span.start,
        );
      });

      const blockStarts = validBlocks.map((b) => b.start);
      return ctx.gcal.nearestSlots(blockStarts, requestedStart, 3)
        .map((s) => utcToLocalParts(s).time);
    } catch (err) {
      logger.error("alternatives computation failed", { msg: String(err) });
      return [];
    }
  }

  const tools = {
    check_available_days: tool({
      description:
        "Survey which days in a range have ANY free slots, without listing exact times. Use this " +
        "when the customer asks broadly — 'what's free this week', 'any day works', 'what's your " +
        "earliest opening' — to see which days are worth offering BEFORE calling check_availability " +
        "for a specific one. Cheap: one call covers up to 14 days.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("The first day to check, in Amman local time, format YYYY-MM-DD."),
        days: z.number().int().min(1).max(14)
          .describe("How many consecutive days to check starting from and including `date`."),
        services: z.array(z.enum(SERVICE_CODES)).optional()
          .describe("Optional: only count days that have slots for these specific services. Omit to count all slots."),
      }),
      execute: async ({ date, days, services }): Promise<CheckAvailableDaysResult> => {
        const todayParts = utcToLocalParts(ctx.now);
        if (date < todayParts.date) {
          return { ok: false, date, reason: "PAST_DATE", message: "That date is in the past." };
        }
        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(horizonDate.getUTCDate() + BUSINESS.horizonDays);
        if (date > utcToLocalParts(horizonDate).date) {
          return { ok: false, date, reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.` };
        }

        const rangeStart = localToUtc(`${date}T00:00`);
        const rangeEndExclusive = new Date(rangeStart.getTime() + days * 24 * 60 * 60 * 1000);
        let liveBookings;
        try {
          liveBookings = await findLiveBookingsForDay(ctx.sql, rangeStart, rangeEndExclusive);
        } catch (err) {
          logger.error("findLiveBookingsForDay failed", { msg: String(err) });
          return { ok: false, date, reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly." };
        }

        let dayResults;
        try {
          dayResults = await ctx.gcal.computeSlotsRange(
            date, days, ctx.now,
            liveBookings.map((b) => ({
              starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at),
              resource_code: b.resource_code,
            })),
          );
        } catch (err) {
          logger.error("computeSlotsRange failed", { msg: String(err) });
          return { ok: false, date, reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly." };
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
          return { ok: false, date, reason: "NO_SLOTS",
            message: `No slots available in the next ${days} days.`, nextOpenDate: next };
        }

        return { ok: true, days: daySummaries };
      },
    }),

    check_availability: tool({
      description:
        "Get available time slots for ONE day, for one or more services. Returns complete " +
        "visit plans — each plan is a fully-validated way to do ALL services, with specific " +
        "start times and employees already assigned. Offer the top 2–3 plans, let the customer " +
        "pick one, then pass their chosen plan's bundles directly to create_bookings. " +
        "If the customer names a specific employee, pass `resource`. " +
        "If they name a specific time, pass `time` and plans near that time are prioritized.",
      inputSchema: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("The day to check, Amman local time YYYY-MM-DD."),
        services: z.array(z.enum(SERVICE_CODES)).min(1).max(3)
          .describe("The service codes to check availability for. Pass ALL services the customer wants."),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional()
          .describe("A specific time the customer named, format HH:mm."),
        resource: z.enum(RESOURCE_CODES).optional()
          .describe("The employee code if the customer named a specific stylist."),
      }),
      execute: async ({ date, services, time, resource }): Promise<CheckAvailabilityResult> => {
        // Validate weekday
        const wd = localToUtc(`${date}T10:00`);
        const weekday = localWeekday(wd);
        if ((BUSINESS.closedWeekdays as readonly number[]).includes(weekday)) {
          const next = nextOpenDay(date);
          return { ok: false, date, reason: "CLOSED_FRIDAY",
            message: "Friday is closed. The next open day is Saturday.", nextOpenDate: next };
        }

        // Date bounds
        const todayParts = utcToLocalParts(ctx.now);
        if (date < todayParts.date) {
          return { ok: false, date, reason: "PAST_DATE", message: "That date is in the past." };
        }
        const horizonDate = new Date(ctx.now);
        horizonDate.setUTCDate(horizonDate.getUTCDate() + BUSINESS.horizonDays);
        if (date > utcToLocalParts(horizonDate).date) {
          return { ok: false, date, reason: "BEYOND_HORIZON",
            message: `We only book up to ${BUSINESS.horizonDays} days ahead.` };
        }

        // Capability check when employee named
        if (resource) {
          const cap = checkResourceCapability(resource, services);
          if (!cap.ok) {
            // Try to generate alternative plans with capable employees
            let alternativePlans: VisitPlan[] | undefined;
            try {
              const allGroupings = enumerateBundles(services);
              if (allGroupings.length > 0) {
                const dayStart = localToUtc(`${date}T00:00`);
                const dayEnd = localToUtc(`${date}T24:00`);
                const live = await findLiveBookingsForDay(ctx.sql, dayStart, dayEnd);
                const slotResult = await ctx.gcal.computeSlots(
                  date, ctx.now,
                  live.map((b) => ({
                    starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at),
                    resource_code: b.resource_code,
                  })),
                );
                const allPlans: VisitPlan[] = [];
                for (const g of allGroupings) {
                  allPlans.push(...generatePlans(g, slotResult.freeByResource));
                }
                allPlans.sort((a, b) => scorePlan(b) - scorePlan(a));
                if (allPlans.length > 0) {
                  alternativePlans = allPlans.slice(0, MAX_PLANS);
                }
              }
            } catch {
              // alternatives are best-effort
            }
            const result: CheckAvailabilityResult = {
              ok: false, date, reason: "RESOURCE_CANNOT_DO_SERVICE",
              message: `${findResource(resource)?.en ?? resource} can't do: ${cap.unbookableServices.join(", ")}.`,
              unbookableServices: cap.unbookableServices,
              capableInstead: cap.capableInstead,
            };
            if (alternativePlans) {
              (result as Record<string, unknown>).alternativePlans = alternativePlans;
            }
            return result;
          }
        }

        // Get live bookings and compute slots
        const dayStart = localToUtc(`${date}T00:00`);
        const dayEnd = localToUtc(`${date}T24:00`);
        let liveBookings;
        try {
          liveBookings = await findLiveBookingsForDay(ctx.sql, dayStart, dayEnd);
        } catch (err) {
          logger.error("findLiveBookingsForDay failed", { msg: String(err) });
          return { ok: false, date, reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly." };
        }

        let slotResult;
        try {
          slotResult = await ctx.gcal.computeSlots(
            date, ctx.now,
            liveBookings.map((b) => ({
              starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at),
              resource_code: b.resource_code,
            })),
          );
        } catch (err) {
          logger.error("computeSlots failed", { msg: String(err) });
          return { ok: false, date, reason: "CALENDAR_ERROR",
            message: "Could not check availability. Please try again shortly." };
        }

        // Enumerate bundle groupings
        const groupings = enumerateBundles(services, resource);

        if (groupings.length === 0) {
          return { ok: false, date, reason: "NO_SLOTS",
            message: "No one can perform all of these services together, and splitting isn't possible.",
            nextOpenDate: nextOpenDay(date) };
        }

        // Generate visit plans for each grouping
        let allPlans: VisitPlan[] = [];
        for (const grouping of groupings) {
          const plans = generatePlans(grouping, slotResult.freeByResource);
          allPlans.push(...plans);
        }

        if (allPlans.length === 0) {
          if (resource) {
            const othersHaveSlots = Object.entries(slotResult.freeByResource)
              .some(([rc, sl]) => rc !== resource && sl.length > 0 && resourceCanDo(rc, services));
            const msg = othersHaveSlots
              ? `${findResource(resource)?.en ?? resource} has no slots that fit, but others do. Want me to check?`
              : `${findResource(resource)?.en ?? resource} has no availability that fits all services.`;
            return { ok: false, date, reason: "NO_SLOTS",
              message: msg, nextOpenDate: nextOpenDay(date) };
          }
          return { ok: false, date, reason: "NO_SLOTS",
            message: "No contiguous block fits all services. Try splitting across employees or a different day.",
            nextOpenDate: nextOpenDay(date) };
        }

        // Score and sort
        allPlans.sort((a, b) => scorePlan(b) - scorePlan(a));

        // If a time preference was given, bump plans that start near that time
        if (time) {
          const requestedMin = timeStrToMinutes(time);
          allPlans.sort((a, b) => {
            const aDist = Math.abs(timeStrToMinutes(a.bundles[0]!.start) - requestedMin);
            const bDist = Math.abs(timeStrToMinutes(b.bundles[0]!.start) - requestedMin);
            return aDist - bDist;
          });
        }

        const topPlans = allPlans.slice(0, MAX_PLANS);
        const weekdayName = utcToLocalParts(localToUtc(`${date}T10:00`)).weekdayEn;

        return {
          ok: true, date, weekday: weekdayName,
          plans: topPlans,
          totalPlans: allPlans.length,
        };
      },
    }),

    create_bookings: tool({
      description:
        "Create appointments for a multi-service visit. Only call after the customer " +
        "has explicitly confirmed the date, time, ALL services, their name, and the employee. " +
        "Pass bundles from the visit plan the customer chose — do NOT modify them. " +
        "Bundles are attempted in order; booked bundles are KEPT even if a later one fails. " +
        "If every bundle fails, the call errors so you must retry with a different plan.",
      inputSchema: z.object({
        name: z.string().min(2).max(60)
          .describe("The customer's name as they gave it."),
        bundles: z.array(z.object({
          services: z.array(z.enum(SERVICE_CODES)).min(1).max(3)
            .describe("Services in this bundle (one employee does them all as one block)."),
          datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
            .describe("Block start in Amman local time YYYY-MM-DDTHH:mm."),
          resource: z.enum(RESOURCE_CODES)
            .describe("Specific employee for this bundle — from the chosen plan."),
        })).min(1).max(3)
          .describe("Bundles in start-time order. Each is one contiguous block on one employee."),
      }),
      execute: async (input): Promise<CreateBookingsResult> => {
        const { name, bundles: rawBundles } = input;
        const bookingGroupId = crypto.randomUUID();

        // Validate bundle ordering: each bundle must start >= previous bundle's end.
        const sorted = [...rawBundles].sort((a, b) => a.datetime.localeCompare(b.datetime));
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1]!;
          const curr = sorted[i]!;
          const prevDur = getTotalDuration(prev.services);
          const prevStart = localToUtc(prev.datetime);
          const prevEnd = new Date(prevStart.getTime() + prevDur * 60_000);
          const prevEndLocal = utcToLocalParts(prevEnd);
          const prevEndStr = `${prevEndLocal.date}T${prevEndLocal.time}`;
          if (curr.datetime < prevEndStr) {
            return {
              results: [{
                ok: false,
                reason: "CUSTOMER_BUSY",
                message: "Bundles overlap. Each bundle must start after the previous one ends.",
              }],
              bookingGroupId,
            };
          }
        }

        // Visit cap check
        const visitCount = await countUpcomingVisitsForCustomer(ctx.sql, ctx.customerId, ctx.now);
        if (visitCount >= BOOKING_LIMITS.maxUpcomingVisits) {
          const existing = await findUpcomingLiveBookingsForCustomer(ctx.sql, ctx.customerId, ctx.now);
          const refs = existing.map((b) => b.ref);
          return {
            results: [{
              ok: false,
              reason: "TOO_MANY_UPCOMING",
              message: `You already have ${visitCount} upcoming appointments. Want to move or cancel one instead?`,
              alternatives: refs,
            }],
            bookingGroupId,
          };
        }

        const results: BundleResultItem[] = [];
        const confirmedSpans: Array<{ start: Date; end: Date }> = [];

        for (const bundle of sorted) {
          const { services, datetime, resource: namedResource } = bundle;
          const totalDuration = getTotalDuration(services);

          // 1. Validate slot with duration
          const validation = validateSlotWithBusiness(datetime, ctx.now, totalDuration);
          if (!validation.ok) {
            results.push({ ok: false, reason: validation.reason, message: validation.message });
            continue;
          }
          const { startsAt, datePart } = validation;

          // 2. Capability check
          const cap = checkResourceCapability(namedResource, services);
          if (!cap.ok) {
            results.push({
              ok: false, reason: "RESOURCE_CANNOT_DO_SERVICE",
              message: `${findResource(namedResource)?.en ?? namedResource} can't do: ${cap.unbookableServices.join(", ")}.`,
            });
            continue;
          }

          // 3. Near-duplicate guard
          let isDup = false;
          for (const svc of services) {
            const dup = await findDuplicateServiceOnDay(ctx.sql, ctx.customerId, svc, datePart);
            if (dup) {
              results.push({
                ok: false, reason: "DUPLICATE_SERVICE_SAME_DAY",
                message: `You already have a ${svc} booked that day (ref: ${dup.ref}).`,
                alternatives: [dup.ref],
              });
              isDup = true;
              break;
            }
          }
          if (isDup) continue;

          // 4. Resolve calendar
          const calId = ctx.gcal.calendarForResource(namedResource);
          if (!calId) {
            results.push({ ok: false, reason: "CALENDAR_ERROR",
              message: "Could not resolve employee calendar." });
            continue;
          }

          const bundleId = crypto.randomUUID();
          const bundleEnd = new Date(startsAt.getTime() + totalDuration * 60_000);
          const eventId = bundleId.replace(/-/g, "").toLowerCase();
          const parts = utcToLocalParts(startsAt);
          const endParts = utcToLocalParts(bundleEnd);
          const serviceNames = services.map((sc) => findService(sc)?.en ?? sc).join(" + ");
          const resourceInfo = findResource(namedResource);

          // Pre-build the DB rows (we'll insert them AFTER Google succeeds)
          const refs = services.map(() => generateRef());
          const rows = services.map((svc, i) => {
            const dur = getServiceDuration(svc);
            const svcStart = new Date(startsAt.getTime() +
              services.slice(0, i).reduce((s, c) => s + getServiceDuration(c) * 60_000, 0));
            const svcEnd = new Date(svcStart.getTime() + dur * 60_000);
            return {
              customerId: ctx.customerId,
              conversationId: ctx.conversationId,
              customerName: name,
              serviceCode: svc,
              resourceCode: namedResource,
              bookingGroupId,
              bundleId,
              startsAt: svcStart,
              endsAt: svcEnd,
              ref: refs[i]!,
            };
          });

          // 5. GOOGLE FIRST — narrow freeBusy re-check
          try {
            const busy = await ctx.gcal.freeBusy(calId, startsAt, bundleEnd);
            if (busy.length > 0) {
              const alts = await computeNonOverlappingAlternatives(
                datePart, services, namedResource, confirmedSpans, startsAt,
              );
              results.push({
                ok: false, reason: "SLOT_TAKEN",
                message: "That time was just booked by someone else.",
                ...(alts.length > 0 ? { alternatives: alts } : {}),
              });
              continue;
            }
          } catch (err) {
            logger.error("freeBusy re-check failed", { msg: String(err) });
            results.push({ ok: false, reason: "CALENDAR_ERROR",
              message: "Could not verify availability. Please try again." });
            continue;
          }

          // 6. GOOGLE — create Calendar event
          try {
            await ctx.gcal.insertEvent(namedResource, {
              eventId,
              summary: `${serviceNames} — ${name}`,
              description: `Booked via WhatsApp. Ref ${rows[0]!.ref}. Phone +${ctx.waPhone}.`,
              startLocal: `${parts.date}T${parts.time}:00`,
              endLocal: `${endParts.date}T${endParts.time}:00`,
            });
          } catch (err) {
            logger.error("insertEvent failed", { msg: String(err) });
            results.push({ ok: false, reason: "CALENDAR_ERROR",
              message: "Could not complete booking. Please try again." });
            continue;
          }

          // 7. DB — store what Google accepted
          const insertResult = await createBookingBundle(ctx.sql, rows);
          if ("conflict" in insertResult) {
            // DB conflict after Google success — delete the Google event
            try { await ctx.gcal.deleteEvent(namedResource, eventId); } catch {
              logger.error("Failed to delete Google event after DB conflict", { eventId });
            }
            if (insertResult.conflict === "customer") {
              results.push({
                ok: false, reason: "CUSTOMER_BUSY",
                message: "You already have a booking overlapping this time.",
              });
              break;
            }
            const alts = await computeNonOverlappingAlternatives(
              datePart, services, namedResource, confirmedSpans, startsAt,
            );
            results.push({
              ok: false, reason: "SLOT_TAKEN",
              message: "That time was just taken from another channel.",
              ...(alts.length > 0 ? { alternatives: alts } : {}),
            });
            continue;
          }

          // Link Google event id to DB rows
          await setBundleGcalEventId(ctx.sql, bundleId, eventId);

          // Track confirmed span
          confirmedSpans.push({ start: startsAt, end: bundleEnd });

          results.push({
            ok: true,
            ref: rows[0]!.ref,
            datetimeLocal: parts.human,
            weekday: parts.weekdayEn,
            services: services,
            durationMinutes: totalDuration,
            resource: namedResource,
            resourceName: resourceInfo?.en ?? namedResource,
            name,
          });
        }

        // If every single bundle failed, throw
        if (results.length > 0 && results.every((r) => !r.ok)) {
          const reasons = results
            .map((r) => ("message" in r ? r.message : ""))
            .filter(Boolean)
            .join(" | ");
          throw new Error(`All bundles failed: ${reasons}`);
        }

        return { results, bookingGroupId };
      },
    }),

    reschedule_booking: tool({
      description:
        "Move an existing appointment to a new date/time. Use this instead of cancel + create " +
        "when the customer wants to CHANGE an appointment. Only releases the old slot after the new " +
        "one is confirmed.",
      inputSchema: z.object({
        oldRef: z.string().regex(/^BK-[A-Z0-9]{6}$/i)
          .describe("The reference of the existing booking being replaced."),
        datetime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
          .describe("New appointment start in Amman local time YYYY-MM-DDTHH:mm."),
        name: z.string().min(2).max(60)
          .describe("The customer's name as they gave it."),
        service: z.enum(SERVICE_CODES)
          .describe("The service code for the new appointment."),
      }),
      execute: async (input): Promise<RescheduleBookingResult> => {
        const { oldRef, datetime, name, service } = input;

        // Find old booking
        const oldBooking = await findBookingByRef(ctx.sql, oldRef);
        if (!oldBooking || oldBooking.customer_id !== ctx.customerId) {
          return { ok: false, reason: "NOT_FOUND", message: "I couldn't find a booking with that reference." };
        }
        if (oldBooking.status === "cancelled") {
          return { ok: false, reason: "ALREADY_CANCELLED", message: "This booking was already cancelled." };
        }
        const oldStartsAt = new Date(oldBooking.starts_at);
        if (oldStartsAt < ctx.now) {
          return { ok: false, reason: "ALREADY_PASSED",
            message: "This appointment has already passed. Please call the salon directly." };
        }

        // Validate new slot
        const dur = getServiceDuration(service);
        const validation = validateSlotWithBusiness(datetime, ctx.now, dur);
        if (!validation.ok) {
          return { ok: false, reason: validation.reason, message: validation.message };
        }
        const { startsAt, datePart } = validation;

        // Reserve new booking
        const endsAt = new Date(startsAt.getTime() + dur * 60_000);
        const newRef = generateRef();
        const svc = findService(service);
        const serviceName = svc?.en ?? service;
        const newGroupId = crypto.randomUUID();
        const newBundleId = crypto.randomUUID();

        // Reuse the old booking's resource
        const rc = oldBooking.resource_code;

        const newBooking = await createBookingBundle(ctx.sql, [{
          customerId: ctx.customerId,
          conversationId: ctx.conversationId,
          customerName: name,
          serviceCode: service,
          resourceCode: rc,
          bookingGroupId: newGroupId,
          bundleId: newBundleId,
          startsAt,
          endsAt,
          ref: newRef,
        }]);

        if ("conflict" in newBooking) {
          try {
            const dayStart = localToUtc(`${datePart}T00:00`);
            const dayEnd = localToUtc(`${datePart}T24:00`);
            const live = await findLiveBookingsForDay(ctx.sql, dayStart, dayEnd);
            const slotResult = await ctx.gcal.computeSlots(
              datePart, ctx.now,
              live.map((b) => ({
                starts_at: new Date(b.starts_at), ends_at: new Date(b.ends_at),
                resource_code: b.resource_code,
              })),
            );
            const alts = ctx.gcal.spreadSlots(slotResult.slots, 3)
              .map((s) => utcToLocalParts(s).time);
            return {
              ok: false, reason: "SLOT_TAKEN",
              message: "That slot was just taken. Your original booking is unchanged.",
              alternatives: alts,
            };
          } catch (err) {
            logger.error("alternatives computation failed", { msg: String(err) });
            return {
              ok: false, reason: "SLOT_TAKEN",
              message: "That slot was just taken. Your original booking is unchanged.",
            };
          }
        }

        // Re-check Google
        const calId = ctx.gcal.calendarForResource(rc);
        if (!calId) {
          await failBundle(ctx.sql, newBundleId);
          return { ok: false, reason: "CALENDAR_ERROR",
            message: "Could not resolve employee calendar. Your original booking is unchanged." };
        }

        try {
          const busy = await ctx.gcal.freeBusy(calId, startsAt, endsAt);
          if (busy.length > 0) {
            await failBundle(ctx.sql, newBundleId);
            return {
              ok: false, reason: "SLOT_TAKEN",
              message: "That slot was just booked. Your original booking is unchanged.",
            };
          }
        } catch (err) {
          logger.error("freeBusy re-check failed", { msg: String(err) });
          await failBundle(ctx.sql, newBundleId);
          return { ok: false, reason: "CALENDAR_ERROR",
            message: "Could not complete the reschedule. Your original booking is unchanged." };
        }

        // Create Calendar event on the same resource
        const eventId = newBundleId.replace(/-/g, "").toLowerCase();
        const parts = utcToLocalParts(startsAt);
        const endParts = utcToLocalParts(endsAt);

        try {
          await ctx.gcal.insertEvent(rc, {
            eventId,
            summary: `${serviceName} — ${name}`,
            description: `Booked via WhatsApp. Ref ${newRef}. Phone +${ctx.waPhone}.`,
            startLocal: `${parts.date}T${parts.time}:00`,
            endLocal: `${endParts.date}T${endParts.time}:00`,
          });
        } catch (err) {
          logger.error("insertEvent failed", { msg: String(err) });
          await failBundle(ctx.sql, newBundleId);
          return { ok: false, reason: "CALENDAR_ERROR",
            message: "Could not complete the reschedule. Your original booking is unchanged." };
        }

        // Link Calendar event
        await setBundleGcalEventId(ctx.sql, newBundleId, eventId);

        // Delete old Calendar event
        if (oldBooking.gcal_event_id) {
          try {
            await ctx.gcal.deleteEvent(rc, oldBooking.gcal_event_id);
          } catch (err) {
            logger.error("Failed to delete old Calendar event during reschedule", {
              bookingRef: oldRef,
            });
          }
        }
        await dbCancelBooking(ctx.sql, oldBooking.id);

        return {
          ok: true, oldRef, newRef,
          datetimeLocal: parts.human, weekday: parts.weekdayEn,
          service: serviceName, name,
        };
      },
    }),

    get_my_bookings: tool({
      description:
        "Look up the customer's own current upcoming appointments. Returns all live bookings " +
        "grouped by bundle, plus how many visits they have vs. the limit. Use this whenever the " +
        "customer asks about their bookings without giving a reference code.",
      inputSchema: z.object({}),
      execute: async (): Promise<GetMyBookingsResult> => {
        const bookings = await findUpcomingLiveBookingsForCustomer(
          ctx.sql, ctx.customerId, ctx.now,
        );

        if (bookings.length === 0) return { found: false };

        const visitCount = await countUpcomingVisitsForCustomer(ctx.sql, ctx.customerId, ctx.now);

        // Group by bundle_id
        const byBundle = new Map<string, typeof bookings>();
        for (const b of bookings) {
          const key = b.bundle_id;
          if (!byBundle.has(key)) byBundle.set(key, []);
          byBundle.get(key)!.push(b);
        }

        const result: GetMyBookingsResultItem[] = [];
        for (const [, bundleRows] of byBundle) {
          const first = bundleRows[0]!;
          const parts = utcToLocalParts(new Date(first.starts_at));
          const svcNames = bundleRows.map((r) => findService(r.service_code)?.en ?? r.service_code);
          const rInfo = findResource(first.resource_code);

          result.push({
            ref: first.ref,
            datetimeLocal: parts.human,
            weekday: parts.weekdayEn,
            services: svcNames,
            resource: first.resource_code,
            resourceName: rInfo?.en ?? first.resource_code,
            name: first.customer_name,
          });
        }

        return {
          found: true,
          bookings: result,
          upcomingVisits: visitCount,
          maxVisits: BOOKING_LIMITS.maxUpcomingVisits,
        };
      },
    }),

    cancel_booking: tool({
      description:
        "Cancel an existing appointment using its reference code, e.g. BK-7F3K2Q. " +
        "If the visit has other bundles, they are returned so the agent can ask whether to cancel those too.",
      inputSchema: z.object({
        ref: z.string().regex(/^BK-[A-Z0-9]{6}$/i)
          .describe("The booking reference the customer received when booking."),
      }),
      execute: async ({ ref }): Promise<CancelBookingResult> => {
        const booking = await findBookingByRef(ctx.sql, ref);

        if (!booking || booking.customer_id !== ctx.customerId) {
          return { ok: false, reason: "NOT_FOUND", message: "I couldn't find a booking with that reference." };
        }
        if (booking.status === "cancelled") {
          return { ok: false, reason: "ALREADY_CANCELLED", message: "This booking was already cancelled." };
        }
        const startsAt = new Date(booking.starts_at);
        if (startsAt < ctx.now) {
          return { ok: false, reason: "ALREADY_PASSED",
            message: "This appointment has already passed. Please call the salon directly." };
        }

        // Check if visit has other live bundles
        const otherBundles = await findLiveBookingsInGroup(ctx.sql, booking.booking_group_id);
        const otherBundleIds = new Set(
          otherBundles.filter((b) => b.bundle_id !== booking.bundle_id).map((b) => b.bundle_id),
        );

        // Delete Calendar event for this bundle
        if (booking.gcal_event_id) {
          try {
            await ctx.gcal.deleteEvent(booking.resource_code, booking.gcal_event_id);
          } catch (err) {
            logger.error("deleteEvent failed in cancel_booking", { msg: String(err) });
            return { ok: false, reason: "CALENDAR_ERROR",
              message: "Could not cancel the appointment. Please try again or call the salon." };
          }
        }

        await cancelBundle(ctx.sql, booking.bundle_id);

        const parts = utcToLocalParts(startsAt);
        const svc = findService(booking.service_code);
        const serviceName = svc?.en ?? booking.service_code;

        const others: { ref: string; service: string; datetimeLocal: string }[] = [];
        if (otherBundleIds.size > 0) {
          for (const bid of otherBundleIds) {
            const bundleRows = otherBundles.filter((b) => b.bundle_id === bid);
            if (bundleRows.length > 0) {
              const first = bundleRows[0]!;
              const bp = utcToLocalParts(new Date(first.starts_at));
              others.push({
                ref: first.ref,
                service: bundleRows.map((r) => r.service_code).join("+"),
                datetimeLocal: bp.human,
              });
            }
          }
        }

        return {
          ok: true, ref: booking.ref, datetimeLocal: parts.human, service: serviceName,
          ...(others.length > 0 ? { otherBundlesInVisit: others } : {}),
        };
      },
    }),
  };

  return tools;
}
