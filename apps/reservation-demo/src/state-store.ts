/**
 * Loading and saving the orchestrator's state.
 *
 * The `visit_drafts` row is opaque JSON at the database layer; this module is
 * the single place where it becomes a typed `VisitState` and back. Because
 * state IS the flow, a conversation can pause for a day and resume exactly
 * where it stopped — nothing is reconstructed from message history.
 */

import type { Sql } from "postgres";
import {
  findOpenDraft,
  findUpcomingLiveBookingsForCustomer,
  saveDraft,
  type Booking,
  type VisitDraftRow,
} from "@bani/db";
import type {
  ActiveBooking,
  PendingQuestion,
  VisitDraft,
  VisitGroup,
  VisitState,
} from "@bani/orchestrator";
import { utcToLocalParts } from "@bani/shared";

/** How long an unfinished visit survives before the cron expires it. */
export const DRAFT_TTL_HOURS = 24;

export async function loadState(
  sql: Sql,
  customerId: string,
  now: Date,
  customerName: string | null,
): Promise<VisitState> {
  const [row, bookings] = await Promise.all([
    findOpenDraft(sql, customerId),
    findUpcomingLiveBookingsForCustomer(sql, customerId, now),
  ]);

  const parts = utcToLocalParts(now);
  return {
    draft: row ? toDraft(row) : null,
    pendingQuestion: (row?.pending_question as PendingQuestion | null) ?? null,
    bookings: groupBookings(bookings),
    today: parts.date,
    nowTime: parts.time,
    customerName,
  };
}

export async function saveState(
  sql: Sql,
  state: VisitState,
  customerId: string,
  conversationId: string,
  now: Date,
): Promise<VisitState> {
  const draft = state.draft;

  // A cancellation confirmation matters even for a customer with no visit, so
  // a bare question is carried by an otherwise-empty gathering draft.
  if (!draft && state.pendingQuestion === null) return state;

  const row = await saveDraft(sql, {
    id: draft?.id || null,
    customerId,
    conversationId,
    visitDate: draft?.visitDate ?? null,
    groups: draft?.groups ?? [],
    status: draft?.status ?? "gathering",
    pendingQuestion: state.pendingQuestion,
    expiresAt: new Date(now.getTime() + DRAFT_TTL_HOURS * 60 * 60 * 1000),
  });

  return draft ? { ...state, draft: { ...draft, id: row.id } } : state;
}

// ─── mapping ────────────────────────────────────────────────────────────

function toDraft(row: VisitDraftRow): VisitDraft {
  return {
    id: row.id,
    visitDate: normalizeDate(row.visit_date),
    groups: (row.groups as VisitGroup[] | null) ?? [],
    status: row.status,
  };
}

/** Postgres `date` arrives as a string or a Date depending on the driver. */
function normalizeDate(value: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : utcToLocalParts(value).date;
}

/**
 * Booking rows are per service; the orchestrator reasons in bundles, which is
 * the unit a customer recognises as "an appointment".
 */
function groupBookings(rows: readonly Booking[]): ActiveBooking[] {
  const byBundle = new Map<string, Booking[]>();
  for (const row of rows) {
    const existing = byBundle.get(row.bundle_id);
    if (existing) existing.push(row);
    else byBundle.set(row.bundle_id, [row]);
  }

  return [...byBundle.values()].map((bundle) => {
    const first = bundle[0]!;
    const parts = utcToLocalParts(new Date(first.starts_at));
    return {
      ref: first.ref,
      date: parts.date,
      time: parts.time,
      services: bundle.map((b) => b.service_code),
      employee: first.resource_code,
      bundleId: first.bundle_id,
      bookingGroupId: first.booking_group_id,
    };
  });
}
