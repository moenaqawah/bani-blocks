/**
 * What each verdict means.
 *
 * This replaces the bilingual template pack: one line of meaning per decision
 * instead of two hand-written messages. The renderer is told what happened and
 * writes it in the customer's language; it is never told which words to use,
 * because `voice.ts` covers that and the values are already resolved.
 *
 * Keep these descriptive, not prescriptive — "the booking is made" rather than
 * "say Booked ✅". Phrasing is the renderer's job; truth is this file's.
 */

import { SPEECH_ACTS } from "@bani/orchestrator";

const MEANINGS: Record<keyof typeof SPEECH_ACTS, string> = {
  greeting: "A first hello. Welcome them and ask what they need.",
  chitchat:
    "Conversation, not a request — a hello, a thank you, a goodbye, a passing remark. Their exact " +
    "words are given below; just reply to them like a person would. Nothing has to happen.",
  unclear: "Their message could not be understood. Apologise lightly and ask them to rephrase.",

  ask_services: "We do not yet know which service they want. Ask.",
  ask_date: "We know the services but not the day. Ask which day suits them.",
  offer_slots:
    "These are the ONLY times available for these services on this day, per employee. " +
    "List them and ask which they want. `remainingGroups` above zero means more of their " +
    "visit still needs booking after this — tell them you will sort that next.",

  no_slots: "Nothing is free for these services that day. If a nextOpenDay is given, suggest it.",
  closed_day: "The salon is closed that day. If a nextOpenDay is given, suggest it.",
  past_date: "That day has already passed. Ask for an upcoming one.",
  beyond_horizon: "That is further ahead than we book. Ask for a nearer day.",
  no_capable_employee: "Nobody on the team performs these services. Say so plainly.",
  calendar_error: "A technical problem reading the calendar. Apologise and ask them to try shortly.",

  booked:
    "THE APPOINTMENT IS NOW MADE. Confirm it with the day, the time range, the employee and the " +
    "booking reference. The reference is how they cancel later.",
  visit_complete: "Everything they asked for is now booked. Close warmly.",

  slot_taken:
    "Someone else took that exact time a moment ago, so THE BOOKING DID NOT HAPPEN. " +
    "Say so, then give the fresh times that follow.",
  customer_busy: "They already have an appointment overlapping that time, so it was not booked.",
  too_many_visits: "They are at the limit of upcoming appointments. Suggest cancelling or moving one.",
  duplicate_service: "They already hold this service that day, so it was not added twice.",
  outside_hours: "The service is longer than the time left before closing, so it was not booked.",
  too_soon: "Too close to now — we need more notice. It was not booked.",
  slot_not_offered:
    "They asked for a time that is not among the available ones. Say so and repeat the real list.",

  unknown_employee: "The name they used matches nobody on the team. Ask them to repeat it.",
  employee_cannot_do:
    "The employee they asked for does not perform these services. Say who does, and offer them.",

  ask_replace_draft:
    "They have an unfinished visit and are now asking for a different day. Ask whether to drop " +
    "the unfinished one and start the new request, or finish the old one first. NOTHING has " +
    "changed yet.",
  draft_replaced: "The old unfinished visit has been set aside, as they asked.",
  draft_kept: "The old visit is being continued, as they asked. Restate what is still to book.",

  ask_cancel_confirm:
    "EVERY appointment listed here is about to be cancelled — the choice is already made, so " +
    "never ask them to pick between them or offer them as alternatives. If there are several, " +
    "confirm them as a group ('shall I cancel both/all three?'). NOTHING IS CANCELLED YET: ask " +
    "them to confirm, and list every one so they can see what they are agreeing to.",
  cancelled: "THE APPOINTMENT IS NOW CANCELLED. Confirm it, with its reference.",
  cancel_aborted: "They decided against cancelling. Nothing was cancelled.",
  cancel_not_found: "No appointment of theirs matches that reference.",
  nothing_to_cancel: "They have no upcoming appointments at all.",
  which_booking:
    "They have several appointments and have NOT yet said which they mean. This IS the " +
    "pick-one case: list them and ask which. Nothing is being cancelled.",
  cancel_failed: "The cancellation could not be completed. Ask them to call the salon.",
  current_bookings: "Their upcoming appointments, for information.",
  past_bookings:
    "Appointments they have ALREADY HAD, most recent first. These are history — do not offer " +
    "to change or cancel them.",
  no_bookings:
    "They have nothing in this scope: no upcoming appointments, or no past ones. Say so and " +
    "offer to book.",

  too_many_services: "More services than one visit allows; only the first `max` were kept.",
  cannot_answer:
    "They asked something this assistant does not answer — a price, a product, salon policy, " +
    "anything beyond booking. DO NOT ANSWER IT, even if you believe you know: these facts " +
    "change and a confident wrong answer is worse than none. Say warmly that you only handle " +
    "appointments, suggest they call the salon for that, and offer to book something.",
};

/**
 * The definitions for just the verdicts in this reply.
 *
 * Sending all ~35 on every call costs input tokens on a latency-sensitive
 * path, and a typical reply carries one or two. Trimming also sharpens the
 * instruction: the model reads only what applies.
 */
export function verdictGuideFor(verdicts: readonly string[]): string {
  const wanted = [...new Set(verdicts)].filter((v) => v in MEANINGS);
  return [
    "## What each verdict means",
    "",
    ...wanted.map(
      (v) =>
        `- **${v}** (${SPEECH_ACTS[v as keyof typeof SPEECH_ACTS]}): ${MEANINGS[v as keyof typeof MEANINGS]}`,
    ),
  ].join("\n");
}
