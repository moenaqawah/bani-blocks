/**
 * Effect-result handlers.
 *
 * An effect result re-enters the state machine exactly like an intent does,
 * which is what lets the orchestrator close its own queries: booking group 1
 * successfully is itself the trigger to offer group 2, with no model in the
 * loop and no extra customer turn.
 */

import { addMinutes } from "./dates.js";
import { findGroup, isOpen, pendingGroups, replaceGroup, resetGroup } from "./draft.js";
import { Turn } from "./turn-builder.js";
import type {
  EffectResult,
  OrchestratorConfig,
  ReplyBlock,
  Transition,
  VisitDraft,
  VisitGroup,
  VisitState,
} from "./types.js";

export function handleEffectResult(
  state: VisitState,
  result: EffectResult,
  config: OrchestratorConfig,
): Transition {
  const turn = new Turn(state);
  const draft = turn.state.draft;

  if (result.kind === "BookingCancelled") return cancelled(turn, result);

  if (result.kind === "PastBookingsFetched") {
    return turn
      .say(
        result.bookings.length > 0
          ? { kind: "past_bookings", bookings: result.bookings }
          : { kind: "no_bookings", scope: "past" },
      )
      .done();
  }

  if (!isOpen(draft)) return turn.done();

  const group = findGroup(draft, result.group);
  if (!group) return turn.done();

  return result.kind === "SuggestionsComputed"
    ? suggestions(turn, draft, group, result, config)
    : booking(turn, draft, group, result, config);
}

// ─── ComputeSuggestions ─────────────────────────────────────────────────

function suggestions(
  turn: Turn,
  draft: VisitDraft,
  group: VisitGroup,
  result: Extract<EffectResult, { kind: "SuggestionsComputed" }>,
  config: OrchestratorConfig,
): Transition {
  if (result.ok && result.offers.some((o) => o.times.length > 0)) {
    const offers = result.offers.filter((o) => o.times.length > 0);
    turn.setDraft(replaceGroup(draft, { ...group, state: "awaiting_choice", offered: offers }));
    return turn
      .say({
        kind: "offer_slots",
        group: group.key,
        services: group.services,
        date: draft.visitDate!,
        offers,
        more: result.more,
        remainingGroups: pendingGroups(draft).length - 1,
      })
      .done();
  }

  // Nothing to offer: the group stays pending and the orchestrator waits for
  // a new date rather than inventing one.
  turn.setDraft(replaceGroup(draft, resetGroup(group)));
  const reason = result.ok ? "NO_SLOTS" : result.reason;

  if (reason === "NO_CAPABLE_EMPLOYEE") {
    return turn.say({ kind: "no_capable_employee", services: group.services }).done();
  }
  if (reason === "CALENDAR_ERROR") {
    return turn.say({ kind: "calendar_error" }).done();
  }

  turn.ask({ kind: "need_date" });
  return turn.say(suggestionFailureBlock(reason, draft, group, result, config)).done();
}

function suggestionFailureBlock(
  reason: string,
  draft: VisitDraft,
  group: VisitGroup,
  result: Extract<EffectResult, { kind: "SuggestionsComputed" }>,
  config: OrchestratorConfig,
): ReplyBlock {
  const date = draft.visitDate!;
  const nextOpenDate = !result.ok ? result.nextOpenDate : undefined;

  switch (reason) {
    case "CLOSED_DAY":
      return { kind: "closed_day", date, ...(nextOpenDate ? { nextOpenDate } : {}) };
    case "PAST_DATE":
      return { kind: "past_date", date };
    case "BEYOND_HORIZON":
      return { kind: "beyond_horizon", date, horizonDays: config.horizonDays };
    default:
      return {
        kind: "no_slots",
        services: group.services,
        date,
        ...(nextOpenDate ? { nextOpenDate } : {}),
      };
  }
}

// ─── CreateBooking ──────────────────────────────────────────────────────

function booking(
  turn: Turn,
  draft: VisitDraft,
  group: VisitGroup,
  result: Extract<EffectResult, { kind: "BookingCreated" }>,
  config: OrchestratorConfig,
): Transition {
  if (result.ok) {
    turn.setDraft(
      replaceGroup(draft, {
        ...group,
        state: "booked",
        offered: null,
        bookingRef: result.ref,
        bookedTime: result.time,
        bookedEmployee: result.employee,
      }),
    );
    turn.state = {
      ...turn.state,
      bookings: [
        ...turn.state.bookings,
        {
          ref: result.ref,
          date: result.date,
          time: result.time,
          services: result.services,
          employee: result.employee,
          bundleId: "",
          bookingGroupId: "",
        },
      ],
    };

    const endTime = addMinutes(result.time, result.durationMin);
    turn.say({
      kind: "booked",
      ref: result.ref,
      date: result.date,
      time: result.time,
      endTime,
      employee: result.employee,
      services: result.services,
    });

    // Offer the next group adjacent to the one just booked.
    return turn.advance(config, endTime).done();
  }

  return bookingFailure(turn, draft, group, result, config);
}

function bookingFailure(
  turn: Turn,
  draft: VisitDraft,
  group: VisitGroup,
  result: Extract<EffectResult, { kind: "BookingCreated"; ok: false }>,
  config: OrchestratorConfig,
): Transition {
  const attempted = group.offered?.[0]?.times[0];

  /** Retry the same group with a fresh availability read. */
  const retry = (block: ReplyBlock): Transition => {
    turn.setDraft(replaceGroup(draft, resetGroup(group)));
    turn.say(block);
    return turn
      .run({
        kind: "ComputeSuggestions",
        group: group.key,
        date: draft.visitDate!,
        services: group.services,
        durationMin: group.durationMin,
        employeePref: group.employeePref,
        ...(attempted ? { near: attempted } : {}),
      })
      .done();
  };

  switch (result.reason) {
    case "SLOT_TAKEN":
      return retry({ kind: "slot_taken" });
    case "CUSTOMER_BUSY":
      return retry({ kind: "customer_busy" });
    case "OUTSIDE_HOURS":
      return retry({ kind: "outside_hours", services: group.services });
    case "TOO_SOON":
      return retry({ kind: "too_soon" });
    case "PAST_TIME":
      return retry({ kind: "past_date", date: draft.visitDate! });

    case "TOO_MANY_UPCOMING":
      turn.setDraft(replaceGroup(draft, resetGroup(group)));
      return turn
        .say(
          {
            kind: "too_many_visits",
            count: turn.state.bookings.length,
            max: config.maxUpcomingVisits,
          },
          { kind: "current_bookings", bookings: turn.state.bookings },
        )
        .done();

    case "DUPLICATE_SERVICE_SAME_DAY":
      // Already held — skip this group and carry on with the rest of the visit.
      turn.setDraft(replaceGroup(draft, { ...group, state: "skipped", offered: null }));
      turn.say({
        kind: "duplicate_service",
        service: result.conflictService ?? group.services[0]!,
        ref: result.conflictRef ?? "",
      });
      return turn.advance(config).done();

    case "CALENDAR_ERROR":
      return turn.say({ kind: "calendar_error" }).done();
  }
}

// ─── CancelBooking ──────────────────────────────────────────────────────

function cancelled(
  turn: Turn,
  result: Extract<EffectResult, { kind: "BookingCancelled" }>,
): Transition {
  if (!result.ok) {
    return turn.say({ kind: "cancel_failed", ref: result.ref, reason: result.reason }).done();
  }

  turn.state = {
    ...turn.state,
    bookings: turn.state.bookings.filter((b) => b.ref !== result.ref),
  };
  return turn
    .say({
      kind: "cancelled",
      ref: result.ref,
      date: result.date,
      time: result.time,
      services: result.services,
    })
    .done();
}
