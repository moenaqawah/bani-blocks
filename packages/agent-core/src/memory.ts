import type { ModelMessage, MemoryRow } from "./types.js";

/**
 * Map DB rows to AI SDK format, applying trimming rules.
 *
 * Rules:
 * 1. role='tool' rows are excluded — stale tool outputs cause hallucination.
 * 2. Trim to 12,000 characters total content, dropping from oldest.
 * 3. Never drop the newest 4 messages.
 *
 * The caller is responsible for loading rows from the DB
 * and passing them here. This keeps the package DB-agnostic.
 */
export function buildMemory(rows: MemoryRow[]): ModelMessage[] {
  // Filter: only user and assistant, exclude tool rows
  // Map to AI SDK format
  const messages: ModelMessage[] = rows
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));

  // Trim: if total content exceeds 12,000 chars, drop from oldest
  // but never drop the newest 4
  const MAX_CHARS = 12_000;
  const MIN_KEEP = 4;

  let totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  while (totalChars > MAX_CHARS && messages.length > MIN_KEEP) {
    const removed = messages.shift();
    if (removed) {
      totalChars -= removed.content.length;
    }
  }

  return messages;
}
