import { type BusyInterval, freeBusy } from "./freebusy.js";
import { slotGrid, localToUtc } from "@bani/shared";

export interface LiveBookingLike {
  starts_at: Date;
  ends_at: Date;
}

export interface SlotConfig {
  calendarId: string;
  saEmail: string;
  saPrivateKeyPem: string;
  fetchImpl?: typeof fetch;
  openHour: number; // 10
  closeHour: number; // 20
  slotMinutes: number; // 30
  closedWeekdays: number[]; // [5] = Friday
  leadTimeMinutes: number; // 60
  horizonDays: number; // 60
}

export interface SlotResult {
  slots: Date[];
  totalFree: number;
  busyIntervals: BusyInterval[];
}

/**
 * Compute free slots for a given local date, considering:
 * 1. Working hours grid
 * 2. Lead time filter (slots must be >60 min from now)
 * 3. Google Calendar busy intervals
 * 4. Existing live bookings in the DB
 */
export async function computeSlots(
  cfg: SlotConfig,
  localDate: string,
  now: Date,
  liveBookings: LiveBookingLike[],
): Promise<SlotResult> {
  // Build the grid of candidate slot starts
  const grid = slotGrid(localDate);

  // Filter by lead time
  const leadCutoff = new Date(now.getTime() + cfg.leadTimeMinutes * 60_000);
  const candidates = grid.filter((s) => s > leadCutoff);

  if (candidates.length === 0) {
    return { slots: [], totalFree: 0, busyIntervals: [] };
  }

  // Query Google Calendar for busy intervals
  const dayStart = localToUtc(`${localDate}T00:00`);
  const dayEnd = localToUtc(`${localDate}T24:00`);

  let busy: BusyInterval[] = [];
  try {
    busy = await freeBusy(cfg, dayStart, dayEnd);
  } catch {
    throw new Error("CALENDAR_ERROR");
  }

  // Also consider live bookings as busy
  const bookingBusy: BusyInterval[] = liveBookings.map((b) => ({
    start: b.starts_at,
    end: b.ends_at,
  }));

  const allBusy = [...busy, ...bookingBusy];

  // Filter out overlapping slots (half-open interval comparison)
  const free = candidates.filter((slotStart) => {
    const slotEnd = new Date(slotStart.getTime() + cfg.slotMinutes * 60_000);
    const overlaps = allBusy.some(
      (b) => slotStart < b.end && slotEnd > b.start,
    );
    return !overlaps;
  });

  return { slots: free, totalFree: free.length, busyIntervals: busy };
}

/**
 * Select up to N slots, evenly spread across the free set.
 */
export function spreadSlots(slots: Date[], max: number): Date[] {
  if (slots.length <= max) return slots;
  const indices: number[] = [];
  for (let i = 0; i < max; i++) {
    indices.push(Math.round((i * (slots.length - 1)) / (max - 1)));
  }
  return indices.map((idx) => slots[idx]!);
}
