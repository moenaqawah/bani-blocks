/**
 * A message in the AI SDK's format for conversation history.
 */
export interface ModelMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Lightweight row from DB for memory loading. */
export interface MemoryRow {
  role: "user" | "assistant" | "tool";
  content: string;
}
