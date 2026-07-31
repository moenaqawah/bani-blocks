import { localToUtc, utcToLocalParts } from "@bani/shared";
import { overlapsAny } from "./calendars.js";
import type { HHMM, ISODate, Interval, WindowOptions } from "./types.js";

/**
 * All slot starts inside opening hours for one local date.
 *
 * The grid doubles as the opening-hours bound: `windowSuggestions` only
 * accepts a start whose whole block is covered by grid slots, so a
 * 180-minute keratin can never be offered at 19:00.
 */
export function buildGrid(
  date: ISODate,
  openHour: number,
  closeHour: number,
  slotMinutes: number,
): Date[] {
  const slots: Date[] = [];
  const totalMinutes = (closeHour - openHour) * 60;
  for (let offset = 0; offset < totalMinutes; offset += slotMinutes) {
    const hour = openHour + Math.floor(offset / 60);
    const minute = offset % 60;
    slots.push(
      localToUtc(
        `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      ),
    );
  }
  return slots;
}

/**
 * Slide a `durationMin` window over the grid and return the start times
 * where the whole block is free.
 *
 * A start qualifies when every grid slot the block covers exists (so the
 * block finishes before closing) and none of them intersects busy time.
 */
export function windowSuggestions(
  merged: readonly Interval[],
  durationMin: number,
  grid: readonly Date[],
  opts: WindowOptions,
): Date[] {
  const slotsNeeded = Math.ceil(durationMin / opts.slotMinutes);
  const slotMs = opts.slotMinutes * 60_000;

  const fits: Date[] = [];
  for (let i = 0; i + slotsNeeded <= grid.length; i++) {
    const start = grid[i]!;
    const last = grid[i + slotsNeeded - 1]!;
    // Contiguity: the block must not straddle a gap in the grid.
    if (last.getTime() !== start.getTime() + (slotsNeeded - 1) * slotMs) continue;

    const end = new Date(start.getTime() + durationMin * 60_000);
    if (overlapsAny(start, end, merged)) continue;
    fits.push(start);
  }

  const filtered = applyDirection(fits, opts);
  return capByProximity(filtered, opts);
}

function applyDirection(starts: Date[], opts: WindowOptions): Date[] {
  const pivot = opts.near;
  if (!pivot) return starts;
  if (opts.before) return starts.filter((s) => toHHMM(s) < pivot);
  if (opts.after) return starts.filter((s) => toHHMM(s) > pivot);
  return starts;
}

/**
 * Keep the `cap` times closest to `near` (or the earliest `cap` when no
 * anchor is given), then restore chronological order for display.
 */
function capByProximity(starts: Date[], opts: WindowOptions): Date[] {
  if (starts.length <= opts.cap) return starts;
  if (!opts.near) return starts.slice(0, opts.cap);

  const anchor = starts[0]
    ? localToUtc(`${utcToLocalParts(starts[0]).date}T${opts.near}`).getTime()
    : 0;

  return [...starts]
    .sort((a, b) => Math.abs(a.getTime() - anchor) - Math.abs(b.getTime() - anchor))
    .slice(0, opts.cap)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** Amman-local `HH:MM` for an absolute time. */
export function toHHMM(d: Date): HHMM {
  return utcToLocalParts(d).time;
}
