import { freeBusy, freeBusyMulti, type BusyInterval } from "./freebusy.js";
import { slotGrid, localToUtc, localWeekday, AppError } from "@bani/shared";

export interface LiveBookingLike {
  starts_at: Date;
  ends_at: Date;
  resource_code?: string; // optional — bookings without it are treated as busy for all
}

export interface FreeSlot {
  start: Date;
  resource: string; // resource code this slot belongs to
}

export interface SlotConfig {
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
}

export interface SlotResult {
  slots: Date[];            // distinct start times across ALL resources (union)
  freeByResource: Record<string, Date[]>;  // resourceCode → free starts
  totalFree: number;        // distinct start times
  busyIntervals: BusyInterval[];
}

/**
 * Compute free slots for a given local date across ALL resources.
 * One freeBusyMulti call covers all calendars. Slots are per-resource.
 */
export async function computeSlots(
  cfg: SlotConfig,
  localDate: string,
  now: Date,
  liveBookings: LiveBookingLike[],
): Promise<SlotResult> {
  const grid = slotGrid(localDate);
  const leadCutoff = new Date(now.getTime() + cfg.leadTimeMinutes * 60_000);
  const candidates = grid.filter((s) => s > leadCutoff);

  if (candidates.length === 0) {
    return { slots: [], freeByResource: {}, totalFree: 0, busyIntervals: [] };
  }

  const dayStart = localToUtc(`${localDate}T00:00`);
  const dayEnd = localToUtc(`${localDate}T24:00`);

  // One freeBusyMulti call for all calendars
  let multiResult;
  try {
    multiResult = await freeBusyMulti(cfg, dayStart, dayEnd);
  } catch (err) {
    throw new AppError("CALENDAR", "FreeBusy query failed", err);
  }

  const resourceCodes = Object.keys(cfg.calendars);
  const freeByResource: Record<string, Date[]> = {};

  for (const rc of resourceCodes) {
    const calBusy = multiResult.busy[rc] ?? [];
    // Live bookings for this specific resource
    const resourceLiveBookings = liveBookings.filter(
      (b) => !b.resource_code || b.resource_code === rc,
    ).map((b) => ({ start: b.starts_at, end: b.ends_at }));
    // Live bookings without a resource_code are busy for ALL resources
    const untypedBookings = liveBookings.filter(
      (b) => !b.resource_code,
    ).map((b) => ({ start: b.starts_at, end: b.ends_at }));

    const allBusy = [...calBusy, ...resourceLiveBookings, ...untypedBookings];

    const free = candidates.filter((slotStart) => {
      const slotEnd = new Date(slotStart.getTime() + cfg.slotMinutes * 60_000);
      return !allBusy.some((b) => slotStart < b.end && slotEnd > b.start);
    });

    freeByResource[rc] = free;
  }

  // Union of distinct start times across all resources
  const unionSet = new Map<number, Date>();
  for (const starts of Object.values(freeByResource)) {
    for (const s of starts) {
      unionSet.set(s.getTime(), s);
    }
  }
  const slots = Array.from(unionSet.values()).sort((a, b) => a.getTime() - b.getTime());

  return {
    slots,
    freeByResource,
    totalFree: slots.length,
    busyIntervals: Object.values(multiResult.busy).flat(),
  };
}

/**
 * Select up to N slots, evenly spread across the free set.
 * For "what's available Tuesday?" — use nearestSlots for "17:00 just went".
 */
export function spreadSlots(slots: Date[], max: number): Date[] {
  if (slots.length <= max) return slots;
  const indices: number[] = [];
  for (let i = 0; i < max; i++) {
    indices.push(Math.round((i * (slots.length - 1)) / (max - 1)));
  }
  return indices.map((idx) => slots[idx]!);
}

/**
 * Pick the N slots nearest (by absolute time distance) to a requested start.
 * Sorted chronologically for display. For "the time I asked for just went —
 * what's closest?".
 */
export function nearestSlots(freeStarts: Date[], requested: Date, n: number): Date[] {
  const withDist = freeStarts.map((d) => ({
    date: d,
    dist: Math.abs(d.getTime() - requested.getTime()),
  }));
  withDist.sort((a, b) => a.dist - b.dist);
  const nearest = withDist.slice(0, n).map((x) => x.date);
  nearest.sort((a, b) => a.getTime() - b.getTime());
  return nearest;
}

export interface DaySlotResult {
  date: string;
  closed: boolean;
  slots: Date[];
  freeByResource: Record<string, Date[]>;
  totalFree: number;
}

function addDaysToLocalDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Compute free slots across a run of consecutive local days with a SINGLE
 * freeBusyMulti call spanning the whole range. Returns per-day results
 * with per-resource free slot maps.
 */
export async function computeSlotsRange(
  cfg: SlotConfig,
  startDate: string,
  numDays: number,
  now: Date,
  liveBookings: LiveBookingLike[],
): Promise<DaySlotResult[]> {
  const rangeStartUtc = localToUtc(`${startDate}T00:00`);
  const rangeEndUtc = localToUtc(`${addDaysToLocalDate(startDate, numDays)}T00:00`);

  let multiResult;
  try {
    multiResult = await freeBusyMulti(cfg, rangeStartUtc, rangeEndUtc);
  } catch (err) {
    throw new AppError("CALENDAR", "FreeBusy query failed", err);
  }

  const resourceCodes = Object.keys(cfg.calendars);
  const leadCutoff = new Date(now.getTime() + cfg.leadTimeMinutes * 60_000);

  const results: DaySlotResult[] = [];
  for (let i = 0; i < numDays; i++) {
    const dateStr = i === 0 ? startDate : addDaysToLocalDate(startDate, i);
    const weekday = localWeekday(localToUtc(`${dateStr}T12:00`));
    if (cfg.closedWeekdays.includes(weekday)) {
      results.push({ date: dateStr, closed: true, slots: [], freeByResource: {}, totalFree: 0 });
      continue;
    }

    const dayStart = localToUtc(`${dateStr}T00:00`);
    const dayEnd = localToUtc(`${dateStr}T24:00`);
    const candidates = slotGrid(dateStr).filter((s) => s > leadCutoff);

    const freeByResource: Record<string, Date[]> = {};
    for (const rc of resourceCodes) {
      const calBusy = (multiResult.busy[rc] ?? []).filter(
        (b) => b.start < dayEnd && b.end > dayStart,
      );
      const resourceLiveBookings = liveBookings
        .filter((b) => !b.resource_code || b.resource_code === rc)
        .filter((b) => b.starts_at < dayEnd && b.ends_at > dayStart)
        .map((b) => ({ start: b.starts_at, end: b.ends_at }));
      const allBusy = [...calBusy, ...resourceLiveBookings];

      const free = candidates.filter((slotStart) => {
        const slotEnd = new Date(slotStart.getTime() + cfg.slotMinutes * 60_000);
        return !allBusy.some((b) => slotStart < b.end && slotEnd > b.start);
      });
      freeByResource[rc] = free;
    }

    const unionSet = new Map<number, Date>();
    for (const starts of Object.values(freeByResource)) {
      for (const s of starts) {
        unionSet.set(s.getTime(), s);
      }
    }
    const slots = Array.from(unionSet.values()).sort((a, b) => a.getTime() - b.getTime());

    results.push({ date: dateStr, closed: false, slots, freeByResource, totalFree: slots.length });
  }
  return results;
}

// ─── Bundle-aware helpers ───────────────────────────────────────────────

/**
 * Filter slots to only those from resources capable of ALL given services.
 * `freeByResource` is the per-resource free slot map from computeSlots.
 */
export function filterSlotsByCapability(
  freeByResource: Record<string, Date[]>,
  resourceCanDo: (rc: string) => boolean,
): Record<string, Date[]> {
  const filtered: Record<string, Date[]> = {};
  for (const [rc, slots] of Object.entries(freeByResource)) {
    if (resourceCanDo(rc)) {
      filtered[rc] = slots;
    }
  }
  return filtered;
}

/**
 * Run-length scan: find start times where `k` consecutive slots are free
 * ON THE SAME resource. Returns starts where the full block fits contiguously.
 * `k = ceil(durationMinutes / slotMinutes)`.
 */
export function findContiguousBlocks(
  freeByResource: Record<string, Date[]>,
  durationMinutes: number,
  slotMinutes: number,
): FreeSlot[] {
  const k = Math.ceil(durationMinutes / slotMinutes);
  const results: FreeSlot[] = [];

  for (const [rc, slots] of Object.entries(freeByResource)) {
    if (slots.length < k) continue;
    // Sort for safety
    const sorted = [...slots].sort((a, b) => a.getTime() - b.getTime());
    const slotMs = slotMinutes * 60_000;

    // Walk the sorted list looking for k consecutive slots
    let runStart = 0;
    for (let i = 1; i <= sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i];
      // Check if the run broke
      if (curr && curr.getTime() === prev.getTime() + slotMs) {
        // Still contiguous — continue
        if (i - runStart + 1 >= k) {
          // We have a run of at least k starting at runStart
          results.push({ start: sorted[runStart]!, resource: rc });
          runStart++; // advance to find the next overlapping block
        }
      } else {
        // Run broke; restart from i
        runStart = i;
      }
    }
  }

  // Deduplicate by (start time, resource)
  const seen = new Set<string>();
  return results.filter((s) => {
    const key = `${s.start.getTime()}-${s.resource}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Union distinct start times across multiple resources into one set.
 * Two employees free at 11:00 is ONE offerable time, with no employee
 * chosen yet.
 */
export function unionSlotsAcrossResources(
  freeByResource: Record<string, Date[]>,
): Date[] {
  const set = new Map<number, Date>();
  for (const starts of Object.values(freeByResource)) {
    for (const s of starts) {
      set.set(s.getTime(), s);
    }
  }
  return Array.from(set.values()).sort((a, b) => a.getTime() - b.getTime());
}
