import type { Sql } from "postgres";
import { logger } from "@bani/shared";

/**
 * Acquire a self-expiring row claim on a conversation by updating
 * its `locked_until` column. This serialises concurrent messages
 * from the same customer without using Postgres advisory locks
 * (which are unreliable behind a transaction pooler).
 *
 * Returns the result of `fn()` on success, or `"LOCK_TIMEOUT"` if
 * the claim could not be acquired within the retry budget.
 */
export async function withConversationLock<T>(
  sql: Sql,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T | "LOCK_TIMEOUT"> {
  const maxAttempts = 10;
  const retryDelayMs = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rows = await sql<{ id: string }[]>`
      update conversations
         set locked_until = now() + interval '90 seconds'
       where id = ${conversationId}
         and (locked_until is null or locked_until < now())
      returning id
    `;

    if (rows.length > 0 && rows[0]) {
      // Claim acquired — run fn and clear lock in finally
      try {
        const result = await fn();
        return result;
      } finally {
        await sql`
          update conversations
          set locked_until = null
          where id = ${conversationId}
        `.catch(() => {
          // best-effort — the lock self-expires anyway
        });
      }
    }

    // Claim not acquired — another run holds it
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  logger.warn("Lock timeout after max attempts", { conversationId });
  return "LOCK_TIMEOUT";
}
