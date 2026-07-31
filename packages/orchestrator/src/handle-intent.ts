/**
 * Intent handlers — one per member of the intent catalog.
 *
 * Every handler is a pure function of (state, intent, config). None performs
 * I/O: they emit effects for the executor to run and reply blocks for the
 * renderer to phrase. An invalid or unrecognisable value can only ever
 * produce a clarifying question, never an action.
 */

import type { ISODate } from "@bani/availability";
import { nextOpenDay, normalizeTime } from "./dates.js";
import {
  awaitingGroups,
  buildGroups,
  draftServices,
  findGroup,
  isOpen,
  pendingGroups,
  repartition,
  replaceGroup,
  resetGroup,
  unbookedGroups,
} from "./draft.js";
import type { EmployeePref, Intent } from "./intents.js";
import { capableFor, knownServices, resolveEmployee } from "./roster.js";
import { Turn } from "./turn-builder.js";
import type {
  ActiveBooking,
  OrchestratorConfig,
  ReplyBlock,
  Transition,
  VisitDraft,
  VisitState,
} from "./types.js";
import { checkVisitDate, findOfferFor } from "./validate.js";

export function handleIntent(
  state: VisitState,
  intent: Intent,
  config: OrchestratorConfig,
): Transition {
  const turn = new Turn(state);

  switch (intent.kind) {
    case "new_visit":
      return newVisit(turn, intent, config);
    case "modify_visit":
      return modifyVisit(turn, intent, config);
    case "choose_slot":
      return chooseSlot(turn, intent, config);
    case "other_times":
      return otherTimes(turn, intent, config);
    case "list_bookings":
      return listBookings(turn, intent);
    case "cancel":
      return cancel(turn, intent);
    case "confirm":
      return confirm(turn, config);
    case "deny":
      return deny(turn);
    // This is a booking service, not a salon information line. Anything about
    // prices, products or policy is declined rather than answered: those facts
    // change without the code knowing, and a confident wrong answer about a
    // price is worse than no answer at all.
    case "question":
      return turn.say({ kind: "cannot_answer" }).done();
    case "chitchat":
      return reAsk(turn.say({ kind: "chitchat" })).done();
    case "unclear":
      return reAsk(turn.say({ kind: "unclear" })).done();
  }
}

// ─── new_visit ──────────────────────────────────────────────────────────

function newVisit(
  turn: Turn,
  intent: Extract<Intent, { kind: "new_visit" }>,
  config: OrchestratorConfig,
): Transition {
  const draft = turn.state.draft;

  if (isOpen(draft)) {
    const sameDay = !intent.date || !draft.visitDate || intent.date === draft.visitDate;

    // An answer to our own question is not a competing request. Having just
    // asked "which other day?", treating "Tuesday" as a rival visit and
    // offering to discard the draft would be absurd.
    if (sameDay || answersOpenQuestion(turn.state.pendingQuestion, intent)) {
      return modifyVisit(
        turn,
        {
          kind: "modify_visit",
          add: intent.services,
          ...(intent.date ? { new_date: intent.date } : {}),
          ...(intent.prefs ? { prefs: intent.prefs } : {}),
        },
        config,
      );
    }

    // A different day while something is still unbooked: the customer
    // chooses, and the orchestrator remembers what "yes" will mean.
    if (unbookedGroups(draft).length > 0) {
      return askReplaceDraft(turn, draft, intent, config);
    }
  }

  return startDraft(turn, intent.services, intent.date, intent.prefs, config);
}

/**
 * True when this `new_visit` is really the reply to the question the
 * orchestrator asked last turn — a day when it asked for a day, a service when
 * it asked for a service.
 */
function answersOpenQuestion(
  question: VisitState["pendingQuestion"],
  intent: Extract<Intent, { kind: "new_visit" }>,
): boolean {
  if (question?.kind === "need_date") return intent.date !== undefined;
  if (question?.kind === "need_services") return intent.services.length > 0;
  return false;
}

function askReplaceDraft(
  turn: Turn,
  draft: VisitDraft,
  intent: Extract<Intent, { kind: "new_visit" }>,
  config: OrchestratorConfig,
): Transition {
  const incoming = {
    ...(intent.date ? { date: intent.date } : {}),
    services: knownServices(intent.services, config),
    ...(intent.prefs ? { prefs: resolvePrefs(intent.prefs, config).resolved } : {}),
  };

  turn.ask({ kind: "replace_draft", incoming });
  return turn
    .say({
      kind: "ask_replace_draft",
      open: {
        date: draft.visitDate,
        services: unbookedGroups(draft).flatMap((g) => g.services),
      },
      incoming: {
        ...(intent.date ? { date: intent.date } : {}),
        services: incoming.services,
      },
    })
    .done();
}

/**
 * Create (or re-create) the open draft, asking for whichever required field
 * is missing. The draft — not the model — is the accumulator: a partial
 * request is stored and completed over as many turns as it takes.
 */
function startDraft(
  turn: Turn,
  rawServices: readonly string[],
  rawDate: ISODate | undefined,
  rawPrefs: readonly EmployeePref[] | undefined,
  config: OrchestratorConfig,
): Transition {
  const services = capServices(turn, knownServices(rawServices, config), config);

  // Reusing the open draft's id keeps the one-open-draft index satisfied.
  const draft: VisitDraft = {
    id: turn.state.draft?.id ?? "",
    visitDate: null,
    groups: [],
    status: "gathering",
  };

  if (services.length === 0) {
    turn.setDraft(draft).ask({ kind: "need_services" });
    return turn.say({ kind: "ask_services" }).done();
  }

  draft.groups = buildGroups(services, config);
  applyPrefs(turn, draft, rawPrefs, config);

  if (!rawDate) {
    turn.setDraft(draft).ask({ kind: "need_date" });
    return turn.say({ kind: "ask_date", services }).done();
  }

  const check = checkVisitDate(rawDate, turn.state.today, config);
  if (!check.ok) {
    turn.setDraft(draft).ask({ kind: "need_date" });
    return turn.say(check.block).done();
  }

  turn.setDraft({ ...draft, visitDate: check.date, status: "active" }).ask(null);
  return turn.advance(config).done();
}

// ─── modify_visit ───────────────────────────────────────────────────────

function modifyVisit(
  turn: Turn,
  intent: Extract<Intent, { kind: "modify_visit" }>,
  config: OrchestratorConfig,
): Transition {
  const draft = turn.state.draft;
  if (!isOpen(draft)) {
    return startDraft(turn, intent.add ?? [], intent.new_date, intent.prefs, config);
  }

  const removals = knownServices(intent.remove ?? [], config);
  reportBookedRemovals(turn, draft, removals);

  const surviving = draftServices(draft).filter((s) => !removals.includes(s));
  const added = knownServices(intent.add ?? [], config).filter((s) => !surviving.includes(s));
  const services = capServices(turn, [...surviving, ...added], config);

  if (services.length === 0) {
    turn.setDraft({ ...draft, groups: [], status: "gathering" }).ask({ kind: "need_services" });
    return turn.say({ kind: "ask_services" }).done();
  }

  let next: VisitDraft = { ...draft, groups: repartition(draft, services, config) };

  if (intent.new_date && intent.new_date !== next.visitDate) {
    const check = checkVisitDate(intent.new_date, turn.state.today, config);
    if (!check.ok) {
      turn.setDraft(next).ask({ kind: "need_date" });
      return turn.say(check.block).done();
    }
    next = { ...next, visitDate: check.date, groups: next.groups.map(resetUnsettled) };
  }

  applyPrefs(turn, next, intent.prefs, config);

  if (!next.visitDate) {
    turn.setDraft({ ...next, status: "gathering" }).ask({ kind: "need_date" });
    return turn.say({ kind: "ask_date", services }).done();
  }

  // Adding a service to a group already showing times invalidates that offer.
  for (const stale of awaitingGroups(next).filter((g) => added.some((s) => g.services.includes(s)))) {
    next = replaceGroup(next, resetGroup(stale));
  }

  turn.setDraft({ ...next, status: "active" }).ask(null);
  return turn.advance(config).done();
}

/** Removing an already-booked service is a cancellation, not an edit. */
function reportBookedRemovals(turn: Turn, draft: VisitDraft, removals: string[]): void {
  if (removals.length === 0) return;
  const refs = new Set(
    draft.groups
      .filter((g) => g.state === "booked" && g.services.some((s) => removals.includes(s)))
      .map((g) => g.bookingRef),
  );
  if (refs.size === 0) return;
  turn.say({
    kind: "which_booking",
    bookings: turn.state.bookings.filter((b) => refs.has(b.ref)),
  });
}

function resetUnsettled(group: VisitDraft["groups"][number]): VisitDraft["groups"][number] {
  return group.state === "booked" || group.state === "skipped" ? group : resetGroup(group);
}

// ─── choose_slot ────────────────────────────────────────────────────────

function chooseSlot(
  turn: Turn,
  intent: Extract<Intent, { kind: "choose_slot" }>,
  config: OrchestratorConfig,
): Transition {
  const draft = turn.state.draft;
  if (!isOpen(draft) || !draft.visitDate) return reAsk(turn.say({ kind: "unclear" })).done();

  const group = findGroup(draft, intent.group) ?? awaitingGroups(draft)[0];
  if (!group || group.state !== "awaiting_choice" || !group.offered) {
    return reAsk(turn.say({ kind: "unclear" })).done();
  }

  const notOffered: ReplyBlock = {
    kind: "slot_not_offered",
    offers: group.offered,
    date: draft.visitDate,
  };

  const time = normalizeTime(intent.time);
  if (!time) return turn.say(notOffered).done();

  let employeeCode: string | undefined;
  if (intent.employee) {
    const resolved = resolveEmployee(intent.employee, config);
    if (!resolved) return turn.say({ kind: "unknown_employee", raw: intent.employee }).done();
    if (!group.services.every((s) => resolved.services.includes(s))) {
      return turn
        .say({
          kind: "employee_cannot_do",
          employee: resolved.code,
          services: group.services,
          capableInstead: capableFor(group.services, config),
        })
        .done();
    }
    employeeCode = resolved.code;
  }

  // The offer list is the lock: only a time this group was actually shown,
  // for an employee it was actually shown for, can become a booking.
  const offer = findOfferFor(group.offered, time, employeeCode);
  if (!offer) return turn.say(notOffered).done();

  return turn
    .run({
      kind: "CreateBooking",
      group: group.key,
      date: draft.visitDate,
      time,
      employee: offer.employee,
      services: group.services,
      durationMin: group.durationMin,
    })
    .done();
}

// ─── other_times ────────────────────────────────────────────────────────

function otherTimes(
  turn: Turn,
  intent: Extract<Intent, { kind: "other_times" }>,
  config: OrchestratorConfig,
): Transition {
  const draft = turn.state.draft;
  if (!isOpen(draft) || !draft.visitDate) return reAsk(turn.say({ kind: "unclear" })).done();

  const group =
    findGroup(draft, intent.group) ?? awaitingGroups(draft)[0] ?? pendingGroups(draft)[0];
  if (!group) return reAsk(turn.say({ kind: "unclear" })).done();

  const anchor = group.offered?.[0]?.times[0];

  if (intent.hint === "another_day") {
    const check = checkVisitDate(
      nextOpenDay(draft.visitDate, config.closedWeekdays),
      turn.state.today,
      config,
    );
    if (!check.ok) return turn.say(check.block).done();
    turn.setDraft({ ...replaceGroup(draft, resetGroup(group)), visitDate: check.date });
    return turn.advance(config).done();
  }

  turn.setDraft(replaceGroup(draft, resetGroup(group)));
  return turn
    .run({
      kind: "ComputeSuggestions",
      group: group.key,
      date: draft.visitDate,
      services: group.services,
      durationMin: group.durationMin,
      employeePref: group.employeePref,
      ...(anchor ? { near: anchor } : {}),
      ...(intent.hint === "earlier" || intent.hint === "later" ? { direction: intent.hint } : {}),
    })
    .done();
}

// ─── cancel / confirm / deny ────────────────────────────────────────────

/**
 * "What do I have booked?" — answered from state, not from the customer.
 *
 * Upcoming appointments are already loaded every turn, so the common case
 * costs no query at all. Only history needs fetching, and only when asked.
 * Nobody should have to remember a reference code to ask about their own
 * appointments.
 */
function listBookings(
  turn: Turn,
  intent: Extract<Intent, { kind: "list_bookings" }>,
): Transition {
  const scope = intent.scope ?? "upcoming";

  if (scope !== "past") {
    turn.say(
      turn.state.bookings.length > 0
        ? { kind: "current_bookings", bookings: turn.state.bookings }
        : { kind: "no_bookings", scope: "upcoming" },
    );
  }

  if (scope === "past" || scope === "all") {
    turn.run({ kind: "FetchPastBookings", limit: PAST_BOOKINGS_SHOWN });
  }

  return turn.done();
}

/** Enough for "what did I have last time?", not a statement of account. */
const PAST_BOOKINGS_SHOWN = 5;

function cancel(turn: Turn, intent: Extract<Intent, { kind: "cancel" }>): Transition {
  const bookings = turn.state.bookings;
  if (bookings.length === 0) return turn.say({ kind: "nothing_to_cancel" }).done();

  // "cancel everything" — no need to make them pick one at a time.
  if (intent.scope === "all") return askCancelConfirm(turn, [...bookings]);

  if (intent.ref) {
    const needle = intent.ref.toUpperCase();
    const target = bookings.find((b) => b.ref.toUpperCase() === needle);
    if (!target) return turn.say({ kind: "cancel_not_found", ref: intent.ref }).done();
    return askCancelConfirm(turn, scopeOf(target, bookings, intent.scope));
  }

  if (bookings.length > 1) {
    // Record the question so the next message has something to resolve against.
    turn.ask({ kind: "which_booking", refs: bookings.map((b) => b.ref) });
    return turn.say({ kind: "which_booking", bookings }).done();
  }
  return askCancelConfirm(turn, scopeOf(bookings[0]!, bookings, intent.scope));
}

function scopeOf(
  target: ActiveBooking,
  bookings: readonly ActiveBooking[],
  scope: "visit" | "booking" | "all" | undefined,
): ActiveBooking[] {
  if (scope === "all") return [...bookings];
  if (scope !== "visit") return [target];
  return bookings.filter((b) => b.bookingGroupId === target.bookingGroupId);
}

/** Destructive effects always sit behind an explicit confirmation gate. */
function askCancelConfirm(turn: Turn, targets: ActiveBooking[]): Transition {
  turn.ask({ kind: "cancel_confirm", refs: targets.map((b) => b.ref) });
  return turn.say({ kind: "ask_cancel_confirm", bookings: targets }).done();
}

function confirm(turn: Turn, config: OrchestratorConfig): Transition {
  const question = turn.state.pendingQuestion;
  if (!question) return turn.say({ kind: "chitchat" }).done();

  switch (question.kind) {
    case "cancel_confirm":
      turn.ask(null);
      return turn.run(...question.refs.map((ref) => ({ kind: "CancelBooking" as const, ref }))).done();

    case "replace_draft":
      // Booked groups are independent bookings and survive; only the
      // unbooked remainder of the old draft is discarded.
      turn.ask(null).say({ kind: "draft_replaced" });
      return startDraft(
        turn,
        question.incoming.services,
        question.incoming.date,
        question.incoming.prefs,
        config,
      );

    // "Yes" to "which one?" or "what would you like?" carries no information.
    case "need_services":
    case "need_date":
    case "which_booking":
      return reAsk(turn.say({ kind: "unclear" })).done();
  }
}

function deny(turn: Turn): Transition {
  const question = turn.state.pendingQuestion;
  if (!question) return turn.say({ kind: "chitchat" }).done();

  switch (question.kind) {
    case "cancel_confirm":
      turn.ask(null);
      return turn.say({ kind: "cancel_aborted" }).done();

    case "replace_draft": {
      const draft = turn.state.draft;
      turn.ask(null);
      return turn
        .say({
          kind: "draft_kept",
          date: draft?.visitDate ?? null,
          services: draft ? unbookedGroups(draft).flatMap((g) => g.services) : [],
        })
        .done();
    }

    case "need_services":
    case "need_date":
    case "which_booking":
      return reAsk(turn.say({ kind: "chitchat" })).done();
  }
}

// ─── shared helpers ─────────────────────────────────────────────────────

/** Re-state whatever the orchestrator is still waiting on. */
function reAsk(turn: Turn): Turn {
  const { draft, pendingQuestion } = turn.state;

  const awaiting = draft ? awaitingGroups(draft)[0] : undefined;
  if (awaiting?.offered && draft?.visitDate) {
    return turn.say({
      kind: "offer_slots",
      group: awaiting.key,
      services: awaiting.services,
      date: draft.visitDate,
      offers: awaiting.offered,
      more: false,
      remainingGroups: pendingGroups(draft).length,
    });
  }

  switch (pendingQuestion?.kind) {
    case "need_services":
      return turn.say({ kind: "ask_services" });
    case "need_date":
      return turn.say({ kind: "ask_date", services: draft ? draftServices(draft) : [] });
    case "cancel_confirm":
      return turn.say({
        kind: "ask_cancel_confirm",
        bookings: turn.state.bookings.filter((b) => pendingQuestion.refs.includes(b.ref)),
      });
    case "which_booking":
      return turn.say({
        kind: "which_booking",
        bookings: turn.state.bookings.filter((b) => pendingQuestion.refs.includes(b.ref)),
      });
    case "replace_draft":
      return turn.say({
        kind: "ask_replace_draft",
        open: {
          date: draft?.visitDate ?? null,
          services: draft ? unbookedGroups(draft).flatMap((g) => g.services) : [],
        },
        incoming: {
          ...(pendingQuestion.incoming.date ? { date: pendingQuestion.incoming.date } : {}),
          services: pendingQuestion.incoming.services,
        },
      });
    default:
      return turn;
  }
}

/** Enforce the per-visit service cap without silently dropping the request. */
function capServices(turn: Turn, services: string[], config: OrchestratorConfig): string[] {
  if (services.length <= config.maxServicesPerVisit) return services;
  turn.say({ kind: "too_many_services", max: config.maxServicesPerVisit });
  return services.slice(0, config.maxServicesPerVisit);
}

interface ResolvedPrefs {
  resolved: Array<{ service: string; employee: string }>;
  blocks: ReplyBlock[];
}

/** Raw customer wording → roster code, or a clarifying block. */
function resolvePrefs(
  prefs: readonly EmployeePref[] | undefined,
  config: OrchestratorConfig,
): ResolvedPrefs {
  const resolved: ResolvedPrefs["resolved"] = [];
  const blocks: ReplyBlock[] = [];

  for (const pref of prefs ?? []) {
    const employee = resolveEmployee(pref.employee, config);
    if (!employee) {
      blocks.push({ kind: "unknown_employee", raw: pref.employee });
      continue;
    }
    if (!employee.services.includes(pref.service)) {
      blocks.push({
        kind: "employee_cannot_do",
        employee: employee.code,
        services: [pref.service],
        capableInstead: capableFor([pref.service], config),
      });
      continue;
    }
    resolved.push({ service: pref.service, employee: employee.code });
  }

  return { resolved, blocks };
}

/** Pin a preferred employee onto the group that employee fully covers. */
function applyPrefs(
  turn: Turn,
  draft: VisitDraft,
  prefs: readonly EmployeePref[] | undefined,
  config: OrchestratorConfig,
): void {
  const { resolved, blocks } = resolvePrefs(prefs, config);
  turn.say(...blocks);

  for (const pref of resolved) {
    const group = draft.groups.find(
      (g) => g.state === "pending" && g.services.includes(pref.service),
    );
    if (!group) continue;

    if (!capableFor(group.services, config).includes(pref.employee)) {
      turn.say({
        kind: "employee_cannot_do",
        employee: pref.employee,
        services: group.services,
        capableInstead: capableFor(group.services, config),
      });
      continue;
    }

    group.employeePref = pref.employee;
    group.offered = null;
  }
}
