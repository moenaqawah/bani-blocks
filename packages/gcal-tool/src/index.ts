import { freeBusy, freeBusyMulti, type BusyInterval, type FreeBusyMultiResult } from "./freebusy.js";
import { insertEvent, deleteEvent, getEvent, type InsertEventInput, type GetEventResult } from "./events.js";
import {
  computeSlots,
  computeSlotsRange,
  spreadSlots,
  nearestSlots,
  type SlotConfig,
  type SlotResult,
  type LiveBookingLike,
  type DaySlotResult,
  type FreeSlot,
} from "./slots.js";

export { filterSlotsByCapability, findContiguousBlocks, unionSlotsAcrossResources } from "./slots.js";
export type {
  BusyInterval,
  FreeBusyMultiResult,
  InsertEventInput,
  GetEventResult,
  SlotConfig,
  SlotResult,
  LiveBookingLike,
  DaySlotResult,
  FreeSlot,
};

export interface GcalClient {
  calendars: Record<string, string>;  // resourceCode → calendarId
  /** Multi-calendar free/busy — one request for N calendars */
  freeBusyMulti(timeMin: Date, timeMax: Date): Promise<FreeBusyMultiResult>;
  /** Single-calendar free/busy for narrow re-checks */
  freeBusy(calendarId: string, timeMin: Date, timeMax: Date): Promise<BusyInterval[]>;
  /** Insert event on a specific resource's calendar */
  insertEvent(resourceCode: string, e: InsertEventInput): Promise<{ created: boolean }>;
  /** Delete event from a specific resource's calendar */
  deleteEvent(resourceCode: string, eventId: string): Promise<void>;
  /** Get event from a specific resource's calendar */
  getEvent(resourceCode: string, eventId: string): Promise<GetEventResult>;
  /** Compute free slots for a single day, per resource */
  computeSlots(localDate: string, now: Date, liveBookings: LiveBookingLike[]): Promise<SlotResult>;
  /** Compute free slots across a date range, per resource */
  computeSlotsRange(
    startDate: string,
    numDays: number,
    now: Date,
    liveBookings: LiveBookingLike[],
  ): Promise<DaySlotResult[]>;
  /** Spread N slots evenly across a set */
  spreadSlots(slots: Date[], max: number): Date[];
  /** Pick the N slots nearest to a requested time */
  nearestSlots(slots: Date[], requested: Date, n: number): Date[];
  /** Resolve a resource code to a calendar id */
  calendarForResource(resourceCode: string): string | undefined;
}

export function createGcalClient(cfg: {
  calendars: Record<string, string>;  // resourceCode → calendarId
  saEmail: string;
  saPrivateKeyPem: string;
  fetchImpl?: typeof fetch;
  openHour: number;
  closeHour: number;
  slotMinutes: number;
  closedWeekdays: number[];
  leadTimeMinutes: number;
  horizonDays: number;
}): GcalClient {
  const authCfg = {
    saEmail: cfg.saEmail,
    saPrivateKeyPem: cfg.saPrivateKeyPem,
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };

  function calendarForResource(resourceCode: string): string | undefined {
    return cfg.calendars[resourceCode];
  }

  return {
    calendars: cfg.calendars,

    freeBusyMulti: (timeMin, timeMax) =>
      freeBusyMulti(
        { ...authCfg, calendars: cfg.calendars },
        timeMin,
        timeMax,
      ),

    freeBusy: (calendarId, timeMin, timeMax) =>
      freeBusy({ ...authCfg, calendarId }, timeMin, timeMax),

    insertEvent: (resourceCode, e) => {
      const calendarId = calendarForResource(resourceCode);
      if (!calendarId) {
        throw new Error(`Unknown resource code: ${resourceCode}`);
      }
      return insertEvent(authCfg, calendarId, e);
    },

    deleteEvent: (resourceCode, eventId) => {
      const calendarId = calendarForResource(resourceCode);
      if (!calendarId) {
        throw new Error(`Unknown resource code: ${resourceCode}`);
      }
      return deleteEvent(authCfg, calendarId, eventId);
    },

    getEvent: (resourceCode, eventId) => {
      const calendarId = calendarForResource(resourceCode);
      if (!calendarId) {
        throw new Error(`Unknown resource code: ${resourceCode}`);
      }
      return getEvent(authCfg, calendarId, eventId);
    },

    computeSlots: (localDate, now, liveBookings) =>
      computeSlots(cfg, localDate, now, liveBookings),

    computeSlotsRange: (startDate, numDays, now, liveBookings) =>
      computeSlotsRange(cfg, startDate, numDays, now, liveBookings),

    spreadSlots,

    nearestSlots,

    calendarForResource,
  };
}
