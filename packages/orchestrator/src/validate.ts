/**
 * The "meaning" half of ADR-004's two-layer validation.
 *
 * Shape is already guaranteed by the translator's zod schema; what is
 * checked here is whether the labelled value means anything in this
 * business — a real date, an open day, a time that was actually offered.
 */

import type { HHMM, ISODate } from "@bani/availability";
import { daysBetween, isValidDate, nextOpenDay, weekdayOf } from "./dates.js";
import type { Offer, OrchestratorConfig, ReplyBlock } from "./types.js";

export type DateCheck = { ok: true; date: ISODate } | { ok: false; block: ReplyBlock };

export function checkVisitDate(
  raw: string,
  today: ISODate,
  config: OrchestratorConfig,
): DateCheck {
  if (!isValidDate(raw)) return { ok: false, block: { kind: "unclear" } };
  if (raw < today) return { ok: false, block: { kind: "past_date", date: raw } };

  if (daysBetween(today, raw) > config.horizonDays) {
    return {
      ok: false,
      block: { kind: "beyond_horizon", date: raw, horizonDays: config.horizonDays },
    };
  }

  if (config.closedWeekdays.includes(weekdayOf(raw))) {
    return {
      ok: false,
      block: {
        kind: "closed_day",
        date: raw,
        nextOpenDate: nextOpenDay(raw, config.closedWeekdays),
      },
    };
  }

  return { ok: true, date: raw };
}

/**
 * The anti-hallucination lock: a slot may only be chosen if this exact
 * employee/time pair was offered for this group.
 */
export function findOfferFor(
  offers: readonly Offer[] | null,
  time: HHMM,
  employee?: string,
): Offer | null {
  if (!offers) return null;
  const candidates = offers.filter((o) => o.times.includes(time));
  if (candidates.length === 0) return null;
  if (!employee) return candidates[0] ?? null;
  return candidates.find((o) => o.employee === employee) ?? null;
}
