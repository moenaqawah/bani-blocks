import { generateText, stepCountIs } from "ai";
import type { RunAgentArgs, RunAgentResult, StepRecord } from "./types.js";
import { AppError } from "@bani/shared";

/**
 * True when the failure is a 429 / quota-exhausted response from the
 * provider, possibly wrapped in the AI SDK's RetryError after exhausting
 * its own internal retries. Distinguishing this lets the caller send the
 * BUSY canned message instead of the generic ERROR one — a quota problem
 * is retry-appropriate, not a bug.
 */
function isRateLimitError(err: unknown): boolean {
  const e = err as { statusCode?: number; errors?: unknown[] } | undefined;
  if (e?.statusCode === 429) return true;
  if (Array.isArray(e?.errors)) {
    return e.errors.some(
      (inner) => (inner as { statusCode?: number })?.statusCode === 429,
    );
  }
  return false;
}

/**
 * Run the agent loop using Vercel AI SDK v6 `generateText`.
 *
 * - stopWhen: stepCountIs(maxSteps ?? 6)
 * - temperature: 0.3
 * - Tools execute server-side inside `execute`.
 * - Steps are recorded for persistence (debugging + evals).
 * - If final text is empty, retry once with an appended instruction.
 *   If still empty, throw — the caller sends a canned ERROR message.
 */
export async function runAgent(args: RunAgentArgs): Promise<RunAgentResult> {
  const maxSteps = args.maxSteps ?? 6;
  const recordedSteps: StepRecord[] = [];

  async function attempt(prompt: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await generateText({
      model: args.model as any,
      system: args.systemPrompt,
      messages: [
        ...args.history,
        { role: "user" as const, content: prompt },
      ],
      tools: args.tools as any,
      stopWhen: stepCountIs(maxSteps),
      temperature: 0.3,
    });

    // Extract steps for debugging/evals
    const steps = result?.steps as Array<{
      toolCalls?: Array<{
        toolName: string;
        args?: unknown;
        input?: unknown;
      }>;
      toolResults?: Array<{
        toolName: string;
        result?: unknown;
        output?: unknown;
        error?: unknown;
      }>;
    }> | undefined;

    if (steps) {
      for (const step of steps) {
        if (step.toolCalls) {
          for (const tc of step.toolCalls) {
            recordedSteps.push({
              toolName: tc.toolName,
              input: tc.args ?? tc.input,
              output: "pending",
            });
          }
        }
        if (step.toolResults) {
          for (const tr of step.toolResults) {
            // Match back to the corresponding step entry (search in reverse)
            let matching: StepRecord | undefined;
            for (let i = recordedSteps.length - 1; i >= 0; i--) {
              const s = recordedSteps[i];
              if (s && s.toolName === tr.toolName && s.output === "pending") {
                matching = s;
                break;
              }
            }
            if (matching) {
              matching.output = tr.result ?? tr.output;
              if (tr.error) {
                matching.errorMessage = String(tr.error);
              }
            }
          }
        }
      }
    }

    return (result?.text as string) || "";
  }

  let text = "";
  try {
    text = await attempt(args.userText);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isRateLimitError(err)) {
      throw new AppError("LLM_RATE", "LLM rate limited", err, true);
    }
    throw new AppError("LLM", "Agent run failed", err, true);
  }

  // Empty text fallback: retry once with appended instruction
  if (!text.trim()) {
    try {
      text = await attempt(
        args.userText + "\n\nNow reply to the customer in their language.",
      );
    } catch {
      throw new AppError("LLM", "Agent returned empty text after retry");
    }
  }

  if (!text.trim()) {
    throw new AppError("LLM", "Agent returned empty text after retry");
  }

  return {
    text,
    steps: recordedSteps,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}
