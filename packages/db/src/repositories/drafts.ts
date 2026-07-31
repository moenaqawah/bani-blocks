import type { Sql } from "postgres";
import { AppError } from "@bani/shared";
import type { VisitDraftRow } from "../types.js";

/**
 * Storage for the orchestrator's visit state (ADR-004).
 *
 * Deliberately generic: `groups` and `pending_question` are opaque JSON here.
 * The domain shapes live in @bani/orchestrator and are mapped by the app, so
 * the database package never depends on the state machine.
 */

const OPEN_STATUSES = ["gathering", "active"];

export async function findOpenDraft(
  sql: Sql,
  customerId: string,
): Promise<VisitDraftRow | null> {
  const rows = await sql<VisitDraftRow[]>`
    select * from visit_drafts
    where customer_id = ${customerId}
      and status in ${sql(OPEN_STATUSES)}
    limit 1
  `;
  return rows[0] ?? null;
}

export interface SaveDraftInput {
  /** Existing row to update; null or empty inserts a new one. */
  id: string | null;
  customerId: string;
  conversationId: string | null;
  visitDate: string | null;
  groups: unknown;
  status: string;
  pendingQuestion: unknown;
  expiresAt: Date;
}

/**
 * Insert or update the customer's visit draft.
 *
 * A unique partial index allows only one open draft per customer. Callers run
 * inside the conversation lock, so a conflict means a stale id — we fall back
 * to updating whichever draft is currently open rather than failing the turn.
 */
export async function saveDraft(sql: Sql, input: SaveDraftInput): Promise<VisitDraftRow> {
  if (input.id) {
    const updated = await updateDraft(sql, input.id, input);
    if (updated) return updated;
  }

  try {
    const rows = await sql<VisitDraftRow[]>`
      insert into visit_drafts
        (customer_id, conversation_id, visit_date, groups, status, pending_question, expires_at)
      values
        (${input.customerId}, ${input.conversationId}, ${input.visitDate},
         ${sql.json(input.groups as never)}, ${input.status},
         ${input.pendingQuestion === null ? null : sql.json(input.pendingQuestion as never)},
         ${input.expiresAt})
      returning *
    `;
    return rows[0]!;
  } catch (err: unknown) {
    if (!isUniqueViolation(err)) throw new AppError("DB", "Failed to save visit draft", err);

    const open = await findOpenDraft(sql, input.customerId);
    if (!open) throw new AppError("DB", "Failed to save visit draft", err);
    const updated = await updateDraft(sql, open.id, input);
    if (!updated) throw new AppError("DB", "Failed to save visit draft", err);
    return updated;
  }
}

async function updateDraft(
  sql: Sql,
  id: string,
  input: SaveDraftInput,
): Promise<VisitDraftRow | null> {
  const rows = await sql<VisitDraftRow[]>`
    update visit_drafts
    set visit_date       = ${input.visitDate},
        groups           = ${sql.json(input.groups as never)},
        status           = ${input.status},
        pending_question = ${input.pendingQuestion === null ? null : sql.json(input.pendingQuestion as never)},
        conversation_id  = ${input.conversationId},
        expires_at       = ${input.expiresAt},
        updated_at       = now()
    where id = ${id}
    returning *
  `;
  return rows[0] ?? null;
}

/**
 * Mark open drafts past their TTL as expired. Never touches `bookings` —
 * an abandoned half-visit's booked groups are ordinary appointments.
 */
export async function expireStaleDrafts(sql: Sql, now: Date): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update visit_drafts
    set status = 'expired', updated_at = now()
    where status in ${sql(OPEN_STATUSES)}
      and expires_at <= ${now}
    returning id
  `;
  return rows.length;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as Record<string, string>).code === "23505"
  );
}
