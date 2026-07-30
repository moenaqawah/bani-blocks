import { generateText, stepCountIs } from "ai";
import type { RunAgentArgs, RunAgentResult, StepRecord } from "./types.js";
import { AppError } from "@bani/shared";

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
 * AI SDK v6 StepResult: each step has a `content` array whose items
 * have a `type` field: "tool-call", "tool-result", "tool-error", "text".
 * This is the observed shape from Google Gemini via the AI SDK.
 */
type SDKContent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  output?: unknown;
  error?: unknown;
};

type SDKStep = {
  stepNumber?: number;
  content?: SDKContent[];
};

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

    const steps = result?.steps as SDKStep[] | undefined;

    if (steps) {
      for (const step of steps) {
        const content = step.content;
        if (!content) continue;

        for (const item of content) {
          if (item.type === "tool-call") {
            // New tool call — record as pending
            const rec: StepRecord = {
              toolName: item.toolName!,
              input: item.args ?? item.input,
              output: "pending",
            };
            if (item.toolCallId) rec.toolCallId = item.toolCallId;
            recordedSteps.push(rec);
          } else if (item.type === "tool-result" || item.type === "tool-error") {
            // Resolve the pending call — match by toolCallId first, then by toolName
            const matched = item.toolCallId
              ? recordedSteps.find(
                  (s) => s.output === "pending" && s.toolCallId === item.toolCallId,
                )
              : undefined;
            const fallback = !matched
              ? recordedSteps.find(
                  (s) => s.output === "pending" && s.toolName === item.toolName,
                )
              : undefined;
            const target = matched ?? fallback;

            if (target) {
              target.output = item.result ?? item.output ?? item.error ?? target.output;
              if (item.error) {
                target.errorMessage =
                  typeof item.error === "string"
                    ? item.error
                    : JSON.stringify(item.error);
              }
            } else {
              // Orphaned result — no matching call found
              recordedSteps.push({
                toolName: item.toolName!,
                input: item.input,
                output: item.result ?? item.output ?? item.error,
                ...(item.error
                  ? {
                      errorMessage:
                        typeof item.error === "string"
                          ? item.error
                          : JSON.stringify(item.error),
                    }
                  : {}),
              });
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

  // Empty text fallback: retry once
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
