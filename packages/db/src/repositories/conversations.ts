import type { Sql } from "postgres";
import type { Conversation } from "../types.js";
import { AppError } from "@bani/shared";

export async function getOrCreateOpenConversation(
  sql: Sql,
  customerId: string,
  now: Date,
): Promise<Conversation> {
  // Try to find the newest open conversation
  const existing = await sql<Conversation[]>`
    select * from conversations
    where customer_id = ${customerId}
      and status = 'open'
    order by last_message_at desc
    limit 1
  `;

  const conv = existing[0];

  // If found and within 24 hours, return it
  if (conv) {
    const lastMsg = conv.last_message_at;
    const diffMs = now.getTime() - new Date(lastMsg).getTime();
    const hours24 = 24 * 60 * 60 * 1000;
    if (diffMs < hours24) {
      return conv;
    }
    // Close it — older than 24 hours
    await sql`
      update conversations set status = 'closed'
      where id = ${conv.id}
    `;
  }

  // Create new conversation
  const rows = await sql<Conversation[]>`
    insert into conversations (customer_id, started_at, last_message_at)
    values (${customerId}, ${now}, ${now})
    returning *
  `;
  const row = rows[0];
  if (!row) throw new AppError("DB", "getOrCreateOpenConversation returned no row");
  return row;
}

export async function touchConversation(
  sql: Sql,
  conversationId: string,
  fromUser: boolean,
): Promise<void> {
  if (fromUser) {
    await sql`
      update conversations
      set last_message_at = now(), last_user_message_at = now()
      where id = ${conversationId}
    `;
  } else {
    await sql`
      update conversations
      set last_message_at = now()
      where id = ${conversationId}
    `;
  }
}

export async function isInsideServiceWindow(
  sql: Sql,
  conversationId: string,
  now: Date,
): Promise<boolean> {
  const rows = await sql<{ last_user_message_at: Date | null }[]>`
    select last_user_message_at from conversations
    where id = ${conversationId}
  `;
  const conv = rows[0];
  if (!conv || !conv.last_user_message_at) return false;

  const diffMs = now.getTime() - new Date(conv.last_user_message_at).getTime();
  return diffMs < 24 * 60 * 60 * 1000;
}
