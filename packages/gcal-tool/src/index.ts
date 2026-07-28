import { freeBusy, type BusyInterval } from "./freebusy.js";
import { insertEvent, deleteEvent, type InsertEventInput } from "./events.js";
import {
  computeSlots,
  computeSlotsRange,
  spreadSlots,
  type SlotConfig,
  type SlotResult,
  type LiveBookingLike,
  type DaySlotResult,
} from "./slots.js";

export type { BusyInterval, InsertEventInput, SlotConfig, SlotResult, LiveBookingLike, DaySlotResult };

export interface GcalClient {
  freeBusy(timeMin: Date, timeMax: Date): Promise<BusyInterval[]>;
  insertEvent(e: InsertEventInput): Promise<{ created: boolean }>;
  deleteEvent(eventId: string): Promise<void>;
  computeSlots(localDate: string, now: Date, liveBookings: LiveBookingLike[]): Promise<SlotResult>;
  computeSlotsRange(
    startDate: string,
    numDays: number,
    now: Date,
    liveBookings: LiveBookingLike[],
  ): Promise<DaySlotResult[]>;
  spreadSlots(slots: Date[], max: number): Date[];
}

export function createGcalClient(cfg: {
  calendarId: string;
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
    calendarId: cfg.calendarId,
    saEmail: cfg.saEmail,
    saPrivateKeyPem: cfg.saPrivateKeyPem,
    ...(cfg.fetchImpl ? { fetchImpl: cfg.fetchImpl } : {}),
  };

  return {
    freeBusy: (timeMin, timeMax) =>
      freeBusy(authCfg, timeMin, timeMax),

    insertEvent: (e) =>
      insertEvent(authCfg, e),

    deleteEvent: (eventId) =>
      deleteEvent(authCfg, eventId),

    computeSlots: (localDate, now, liveBookings) =>
      computeSlots(cfg, localDate, now, liveBookings),

    computeSlotsRange: (startDate, numDays, now, liveBookings) =>
      computeSlotsRange(cfg, startDate, numDays, now, liveBookings),

    spreadSlots,
  };
}
