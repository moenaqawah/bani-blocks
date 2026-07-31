/**
 * Orchestrator state, effects and reply payloads — ADR-004 Layer 2.
 *
 * Everything in this file is plain data with no behaviour, so `step()` can
 * stay a pure function of (state × input) and be property-tested without a
 * database, a calendar, or a model.
 */

import type { EmployeeDef, HHMM, ISODate, ServiceDef } from "@bani/availability";
import type { GroupKey, Intent } from "./intents.js";

// ─── configuration ──────────────────────────────────────────────────────

/**
 * Everything `step()` needs to know about the business. Supplied by the
 * client app's config.ts (ADR-002 tier 1) — the orchestrator itself hard-codes
 * nothing about salons.
 */
/** A roster employee plus the spellings customers actually use for them. */
export interface RosterEmployee extends EmployeeDef {
  aliases: readonly string[];
}

export interface OrchestratorConfig {
  services: readonly ServiceDef[];
  employees: readonly RosterEmployee[];
  /** JS weekday numbers (0 = Sunday) the business is closed. */
  closedWeekdays: readonly number[];
  horizonDays: number;
  maxUpcomingVisits: number;
  maxServicesPerVisit: number;
  /** Maximum times offered per employee in one message. */
  maxSlotsOffered: number;
  /** Employees listed per offer before collapsing to `more: true`. */
  maxEmployeesOffered: number;
}

// ─── draft state ────────────────────────────────────────────────────────

export type GroupState = "pending" | "awaiting_choice" | "booked" | "skipped";

/** Times a specific employee was offered for a group. Never invented later. */
export interface Offer {
  employee: string;
  times: HHMM[];
}

export interface VisitGroup {
  key: GroupKey;
  services: string[];
  durationMin: number;
  state: GroupState;
  /** The anti-hallucination lock: only these times may be chosen. */
  offered: Offer[] | null;
  bookingRef: string | null;
  employeePref: string | null;
  /** Set once booked, so the next group can be offered adjacent times. */
  bookedTime: HHMM | null;
  bookedEmployee: string | null;
}

export type DraftStatus =
  | "gathering"
  | "active"
  | "completed"
  | "expired"
  | "abandoned";

/**
 * What an unqualified "yes" refers to. Recorded whenever the orchestrator
 * asks something structural, so the answer resolves deterministically.
 */
export type PendingQuestion =
  | { kind: "need_services" }
  | { kind: "need_date" }
  | {
      kind: "replace_draft";
      incoming: { date?: ISODate; services: string[]; prefs?: readonly EmployeePrefResolved[] };
    }
  | { kind: "cancel_confirm"; refs: string[] }
  /**
   * We listed several appointments and asked which one. Without this, the
   * customer's answer ("the first one") lands on a turn with no memory of the
   * question, and the assistant asks again — forever.
   */
  | { kind: "which_booking"; refs: string[] };

export interface EmployeePrefResolved {
  service: string;
  employee: string;
}

export interface VisitDraft {
  id: string;
  visitDate: ISODate | null;
  groups: VisitGroup[];
  status: DraftStatus;
}

/** An upcoming confirmed booking, as the orchestrator needs to see it. */
export interface ActiveBooking {
  ref: string;
  date: ISODate;
  time: HHMM;
  services: string[];
  employee: string;
  bundleId: string;
  bookingGroupId: string;
}

export interface VisitState {
  draft: VisitDraft | null;
  /**
   * What an unqualified "yes" refers to right now. Kept beside the draft
   * rather than inside it because a cancellation confirmation is meaningful
   * even for a customer with no open visit.
   */
  pendingQuestion: PendingQuestion | null;
  bookings: ActiveBooking[];
  /** Amman-local "now", split so `step()` never touches a clock itself. */
  today: ISODate;
  nowTime: HHMM;
  customerName: string | null;
}

// ─── effects ────────────────────────────────────────────────────────────

/** The only I/O the orchestrator can ask for. */
export type Effect =
  | {
      kind: "ComputeSuggestions";
      group: GroupKey;
      date: ISODate;
      services: string[];
      durationMin: number;
      employeePref: string | null;
      near?: HHMM;
      direction?: "earlier" | "later";
    }
  | {
      kind: "CreateBooking";
      group: GroupKey;
      date: ISODate;
      time: HHMM;
      employee: string;
      services: string[];
      durationMin: number;
    }
  | { kind: "CancelBooking"; ref: string }
  /**
   * Read-only lookup of appointments already past. Upcoming ones are always in
   * `VisitState`, so only history needs fetching — and only when asked, rather
   * than on every turn.
   */
  | { kind: "FetchPastBookings"; limit: number };

export type SuggestionFailure =
  | "NO_SLOTS"
  | "CLOSED_DAY"
  | "PAST_DATE"
  | "BEYOND_HORIZON"
  | "NO_CAPABLE_EMPLOYEE"
  | "CALENDAR_ERROR";

export type BookingFailure =
  | "SLOT_TAKEN"
  | "CUSTOMER_BUSY"
  | "TOO_MANY_UPCOMING"
  | "DUPLICATE_SERVICE_SAME_DAY"
  | "OUTSIDE_HOURS"
  | "TOO_SOON"
  | "PAST_TIME"
  | "CALENDAR_ERROR";

export type CancelFailure =
  | "NOT_FOUND"
  | "ALREADY_CANCELLED"
  | "ALREADY_PASSED"
  | "CALENDAR_ERROR";

export type EffectResult =
  | {
      kind: "SuggestionsComputed";
      group: GroupKey;
      ok: true;
      offers: Offer[];
      more: boolean;
    }
  | {
      kind: "SuggestionsComputed";
      group: GroupKey;
      ok: false;
      reason: SuggestionFailure;
      nextOpenDate?: ISODate;
    }
  | {
      kind: "BookingCreated";
      group: GroupKey;
      ok: true;
      ref: string;
      date: ISODate;
      time: HHMM;
      employee: string;
      services: string[];
      durationMin: number;
    }
  | {
      kind: "BookingCreated";
      group: GroupKey;
      ok: false;
      reason: BookingFailure;
      conflictRef?: string;
      conflictService?: string;
    }
  | { kind: "BookingCancelled"; ok: true; ref: string; date: ISODate; time: HHMM; services: string[] }
  | { kind: "BookingCancelled"; ok: false; ref: string; reason: CancelFailure }
  | { kind: "PastBookingsFetched"; bookings: ActiveBooking[] };

// ─── reply payload ──────────────────────────────────────────────────────

/**
 * The facts the customer is told this turn. Layer 3 rephrases these; it may
 * not add to them. Every block has a template in the client's template pack.
 */
export type ReplyBlock =
  | { kind: "greeting" }
  | { kind: "chitchat" }
  | { kind: "unclear" }
  | { kind: "ask_services" }
  | { kind: "ask_date"; services: string[] }
  | {
      kind: "offer_slots";
      group: GroupKey;
      services: string[];
      date: ISODate;
      offers: Offer[];
      more: boolean;
      remainingGroups: number;
    }
  | { kind: "no_slots"; services: string[]; date: ISODate; nextOpenDate?: ISODate }
  | { kind: "closed_day"; date: ISODate; nextOpenDate?: ISODate }
  | { kind: "past_date"; date: ISODate }
  | { kind: "beyond_horizon"; date: ISODate; horizonDays: number }
  | { kind: "no_capable_employee"; services: string[] }
  | { kind: "calendar_error" }
  | {
      kind: "booked";
      ref: string;
      date: ISODate;
      time: HHMM;
      endTime: HHMM;
      employee: string;
      services: string[];
    }
  | { kind: "visit_complete" }
  | { kind: "slot_taken" }
  | { kind: "customer_busy" }
  | { kind: "too_many_visits"; count: number; max: number }
  | { kind: "duplicate_service"; service: string; ref: string }
  | { kind: "outside_hours"; services: string[] }
  | { kind: "too_soon" }
  | { kind: "slot_not_offered"; offers: Offer[]; date: ISODate }
  | { kind: "unknown_employee"; raw: string }
  | { kind: "employee_cannot_do"; employee: string; services: string[]; capableInstead: string[] }
  | { kind: "ask_replace_draft"; open: { date: ISODate | null; services: string[] }; incoming: { date?: ISODate; services: string[] } }
  | { kind: "draft_replaced" }
  | { kind: "draft_kept"; date: ISODate | null; services: string[] }
  | { kind: "ask_cancel_confirm"; bookings: ActiveBooking[] }
  | { kind: "cancelled"; ref: string; date: ISODate; time: HHMM; services: string[] }
  | { kind: "cancel_not_found"; ref?: string }
  | { kind: "cancel_aborted" }
  | { kind: "nothing_to_cancel" }
  | { kind: "which_booking"; bookings: ActiveBooking[] }
  | { kind: "cancel_failed"; ref: string; reason: CancelFailure }
  | { kind: "current_bookings"; bookings: ActiveBooking[] }
  | { kind: "past_bookings"; bookings: ActiveBooking[] }
  | { kind: "no_bookings"; scope: "upcoming" | "past" }
  | { kind: "too_many_services"; max: number }
  /**
   * A question this assistant does not answer. Deliberately carries NO fields:
   * passing the question through would invite the renderer to answer it, which
   * is the whole thing being prevented.
   */
  | { kind: "cannot_answer" };

export interface ReplyPayload {
  blocks: ReplyBlock[];
}

// ─── transition ─────────────────────────────────────────────────────────

export type StepInput =
  | { type: "intent"; intent: Intent }
  | { type: "effect_result"; result: EffectResult };

export interface Transition {
  state: VisitState;
  effects: Effect[];
  reply: ReplyPayload;
}
