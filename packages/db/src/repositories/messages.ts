import type { Sql } from "postgres";
import type { Message, InboundRow, OutboundRow, ToolRow } from "../types.js";
import { logger } from "@bani/shared";
import type { JSONValue } from "postgres";

/**
 * Insert an inbound message. Returns null if the wa_message_id is a duplicate.
 */
export async function insertInbound(
  sql: Sql,
  m: InboundRow,
): Promise<Message | null> {
  const rows = await sql<Message[]>`
    insert into messages (conversation_id, customer_id, role, content, wa_message_id, wa_direction)
    values (${m.conversationId}, ${m.customerId}, 'user', ${m.content}, ${m.waMessageId}, 'in')
    on conflict (wa_message_id) do nothing
    returning id
  `;
  if (rows.length === 0) {
    logger.debug("Duplicate inbound message");
    return null;
  }
  return rows[0]!;
}

/**
 * Insert an outbound (assistant or canned) message.
 */
export async function insertOutbound(
  sql: Sql,
  m: OutboundRow,
): Promise<Message> {
  const rows = await sql<Message[]>`
    insert into messages (conversation_id, customer_id, role, content, tool_name, wa_message_id, wa_direction, wa_error)
    values (${m.conversationId}, ${m.customerId}, 'assistant', ${m.content},
            ${m.toolName ?? null}, ${m.waMessageId ?? null}, 'out',
            ${m.waError ? sql.json(m.waError as JSONValue) : null})
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error("insertOutbound returned no row");
  return row;
}

/**
 * Insert a tool execution record (for debugging and evals).
 */
export async function insertToolRow(
  sql: Sql,
  r: ToolRow,
): Promise<Message> {
  const rows = await sql<Message[]>`
    insert into messages (conversation_id, customer_id, role, tool_name, tool_payload, wa_direction)
    values (${r.conversationId}, ${r.customerId}, 'tool', ${r.toolName},
            ${sql.json(r.payload as JSONValue)}, 'none')
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error("insertToolRow returned no row");
  return row;
}

/**
 * Load conversation history for the agent, excluding the current message
 * and tool rows. Returns oldest → newest order.
 *
 * `sinceDate` bounds history by recency, independent of the conversation's
 * open/closed status — a conversation can stay open indefinitely (each gap
 * under 24h), but anything older than `sinceDate` is excluded here so the
 * agent isn't fed hours-old, possibly-stale context (e.g. slot availability
 * mentioned much earlier that may no longer hold).
 */
export async function loadHistory(
  sql: Sql,
  conversationId: string,
  limit: number,
  excludeMessageId: string,
  sinceDate: Date,
): Promise<Message[]> {
  const rows = await sql<Message[]>`
    select * from messages
    where conversation_id = ${conversationId}
      and role in ('user', 'assistant')
      and id <> ${excludeMessageId}
      and created_at > ${sinceDate}
    order by created_at desc
    limit ${limit}
  `;
  // Reverse to chronological order
  return rows.reverse();
}

/**
 * Record a Meta send failure on the outbound message row.
 */
export async function recordSendFailure(
  sql: Sql,
  messageId: string,
  error: unknown,
): Promise<void> {
  await sql`
    update messages
    set wa_error = ${sql.json(error as JSONValue)}
    where id = ${messageId}
  `;
}
