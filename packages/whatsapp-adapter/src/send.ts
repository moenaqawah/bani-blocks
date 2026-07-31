import type { SendTextParams, SendResult } from "./types.js";
import { logger } from "@bani/shared";

const MAX_CHARS = 900;
const MAX_PARTS = 3;

/**
 * Split a long message into parts at newline boundaries.
 * Max 3 parts, each max 900 characters. Truncation marker: …
 */
function splitMessage(body: string): string[] {
  if (body.length <= MAX_CHARS) return [body];

  const parts: string[] = [];
  let remaining = body;

  for (let i = 0; i < MAX_PARTS && remaining.length > 0; i++) {
    if (remaining.length <= MAX_CHARS) {
      parts.push(remaining);
      remaining = "";
      break;
    }

    // Find last newline before the limit
    const chunk = remaining.slice(0, MAX_CHARS);
    const lastNewline = chunk.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline : MAX_CHARS;

    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    // Truncate remaining into last part
    const lastIdx = parts.length - 1;
    if (lastIdx >= 0 && parts[lastIdx]) {
      parts[lastIdx] = parts[lastIdx]!.slice(0, MAX_CHARS - 1) + "…";
    }
  }

  return parts.slice(0, MAX_PARTS);
}

/**
 * Send a single text message via Meta Cloud API.
 */
async function sendOne(
  params: SendTextParams,
): Promise<SendResult> {
  const f = params.fetchImpl ?? fetch;
  const url = `https://graph.facebook.com/${params.graphVersion}/${params.phoneNumberId}/messages`;

  const response = await f(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "text",
      text: { preview_url: false, body: params.body },
    }),
  });

  const responseData = (await response.json()) as {
    messages?: Array<{ id: string }>;
    error?: { code: number; message: string; error_data?: unknown };
  };

  if (!response.ok) {
    return {
      waMessageId: null,
      error: responseData,
    };
  }

  return {
    waMessageId: responseData.messages?.[0]?.id ?? null,
  };
}

/**
 * Send a text message to a WhatsApp recipient.
 * Automatically splits messages longer than 900 characters (max 3 parts).
 * Returns the wa_message_id of the first part, or null on failure.
 */
export async function sendText(
  params: SendTextParams,
): Promise<SendResult[]> {
  const parts = splitMessage(params.body);
  const results: SendResult[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const result = await sendOne({ ...params, body: part });
    results.push(result);
    if (result.error) {
      logger.warn("WhatsApp send failed", {
        msg: `Part ${i + 1}/${parts.length} failed`,
      });
    }
  }

  return results;
}

/**
 * Mark the inbound message read and show "typing…" in the customer's chat.
 *
 * A turn takes a few seconds — two model calls plus a Google Calendar read —
 * and silence in a WhatsApp thread reads as "it's broken". WhatsApp clears the
 * indicator as soon as the reply lands, or after 25 seconds, so it can only
 * ever be shown while work is genuinely in flight.
 *
 * Best-effort by design: never let a cosmetic call fail a real reply.
 */
export async function showTyping(params: {
  waMessageId: string;
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const f = params.fetchImpl ?? fetch;
  try {
    await f(
      `https://graph.facebook.com/${params.graphVersion}/${params.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: params.waMessageId,
          typing_indicator: { type: "text" },
        }),
      },
    );
  } catch (err) {
    logger.debug("typing indicator failed", { msg: String(err) });
  }
}
