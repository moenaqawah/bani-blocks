import type { InboundMessage } from "./types.js";
import { logger } from "@bani/shared";

interface MetaEnvelope {
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: Record<string, unknown>;
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          errors?: Array<{ code?: number; title?: string; message?: string; error_data?: unknown }>;
        }>;
      };
    }>;
  }>;
}

export interface StatusUpdate {
  waMessageId: string;
  status: string;
  timestamp: Date;
  recipientId: string;
  errors: Array<{ code: number | undefined; title: string | undefined; message: string | undefined }> | undefined;
}

export interface ParseResult {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

/**
 * Parse the raw Meta webhook JSON into structured InboundMessage[] and StatusUpdate[].
 * Handles the envelope's entry[].changes[].value shape.
 */
export function parseWebhook(body: unknown): ParseResult {
  const result: ParseResult = { messages: [], statuses: [] };

  if (!body || typeof body !== "object") return result;
  const envelope = body as MetaEnvelope;

  if (!envelope.entry) return result;

  for (const entry of envelope.entry) {
    if (!entry.changes) continue;

    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value) continue;

      // Parse statuses
      if (value.statuses) {
        for (const s of value.statuses) {
          if (!s.id) continue;
          result.statuses.push({
            waMessageId: s.id,
            status: s.status ?? "unknown",
            timestamp: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(),
            recipientId: s.recipient_id ?? "",
            errors: s.errors?.map((e) => ({
              code: e.code,
              title: e.title,
              message: e.message,
            })),
          });
        }
      }

      // Parse messages
      if (value.messages) {
        for (const msg of value.messages) {
          if (!msg.id || !msg.from) {
            logger.warn("Malformed inbound message — missing id or from", {});
            continue;
          }

          const profileName = value.contacts?.[0]?.profile?.name ?? null;

          // Extract text from various types
          let text: string | null = null;
          if (msg.type === "text" && msg.text) {
            text = msg.text.body ?? null;
          } else if (msg.type === "button" && msg.button) {
            text = msg.button.text ?? null;
          } else if (msg.type === "interactive" && msg.interactive) {
            // Try to extract title text from interactive message
            const interactive = msg.interactive as Record<string, unknown>;
            text = typeof interactive["title"] === "string"
              ? interactive["title"] as string
              : null;
          }

          result.messages.push({
            waMessageId: msg.id,
            from: msg.from,
            timestamp: msg.timestamp
              ? new Date(Number(msg.timestamp) * 1000)
              : new Date(),
            type: msg.type ?? "unknown",
            text,
            profileName,
          });
        }
      }
    }
  }

  return result;
}
