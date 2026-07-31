/**
 * The speech act of every reply block.
 *
 * Two blocks can carry byte-identical facts and differ only in whether the
 * thing has happened, is being proposed, or failed — `cancelled` and
 * `ask_cancel_confirm` both say "BK-000123, Monday, 11:00". The fact
 * post-check cannot separate those, so the distinction is stated as data
 * rather than left for the renderer to infer from a tag name.
 *
 * Declared as a total record over the union, so adding a `ReplyBlock` kind
 * without deciding its mood is a compile error.
 */

import type { ReplyBlock } from "./types.js";

export type SpeechAct =
  /** It has happened. Past tense. It is real. */
  | "done"
  /** It did NOT happen. Never imply success. */
  | "failed"
  /** You are asking. Nothing has happened yet. */
  | "question"
  /** Stating a fact; no action either way. */
  | "info";

export const SPEECH_ACTS: Record<ReplyBlock["kind"], SpeechAct> = {
  greeting: "info",
  chitchat: "info",
  unclear: "question",

  ask_services: "question",
  ask_date: "question",
  offer_slots: "question",

  no_slots: "failed",
  closed_day: "failed",
  past_date: "failed",
  beyond_horizon: "failed",
  no_capable_employee: "failed",
  calendar_error: "failed",

  booked: "done",
  visit_complete: "info",

  slot_taken: "failed",
  customer_busy: "failed",
  too_many_visits: "failed",
  duplicate_service: "info",
  outside_hours: "failed",
  too_soon: "failed",
  slot_not_offered: "failed",

  unknown_employee: "question",
  employee_cannot_do: "question",

  ask_replace_draft: "question",
  draft_replaced: "done",
  draft_kept: "info",

  ask_cancel_confirm: "question",
  cancelled: "done",
  cancel_aborted: "info",
  cancel_not_found: "failed",
  nothing_to_cancel: "info",
  which_booking: "question",
  cancel_failed: "failed",
  current_bookings: "info",
  past_bookings: "info",
  no_bookings: "info",

  too_many_services: "info",
  cannot_answer: "info",
};

export function actOf(block: ReplyBlock): SpeechAct {
  return SPEECH_ACTS[block.kind];
}
