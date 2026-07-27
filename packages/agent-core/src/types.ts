import type { ToolSet } from "ai";

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

export interface RunAgentArgs {
  systemPrompt: string;
  history: ModelMessage[]; // oldest → newest, from memory.ts
  userText: string;
  tools: ToolSet; // built in apps/reservation-demo/src/tools.ts
  model: unknown; // LanguageModel from ai — typed loosely for provider flexibility
  maxSteps?: number; // default 6
}

export interface StepRecord {
  toolName: string;
  input: unknown;
  output: unknown;
  errorMessage?: string;
}

export interface RunAgentResult {
  text: string; // final assistant text, never empty
  steps: StepRecord[]; // for persistence + evals
  usage: { inputTokens: number; outputTokens: number };
}
