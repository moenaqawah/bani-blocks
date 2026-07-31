/**
 * ADR-004 Layer 1 — the translator.
 *
 * One constrained `generateObject` call turns (state, message) into labelled
 * intents. No tools, no decisions, no prose. The zod schema is the entire
 * interface: the model cannot emit an action the orchestrator has no handler
 * for, and anything that fails to parse becomes `unclear` rather than a guess.
 */

import { Output, generateText } from "ai";
import type { z } from "zod";
import { AppError } from "@bani/shared";
import type { ModelMessage } from "./types.js";
import { isRateLimitError } from "./errors.js";

export interface TranslateArgs<TIntent> {
  model: unknown;
  /** Static per-client rules: catalog, roster, per-kind definitions, few-shots. */
  systemPrompt: string;
  /** This turn's rendered state block — how "11" and "yes" get their referent. */
  stateBlock: string;
  /** A few recent turns, for pronouns and mid-sentence continuations. */
  history: ModelMessage[];
  userText: string;
  /** `z.object({ intents: z.array(<intent union>) })` built from client config. */
  schema: z.ZodType<{ intents: TIntent[] }>;
}

export interface TranslateResult<TIntent> {
  intents: TIntent[];
  /** True when the model failed or produced nothing usable. */
  degraded: boolean;
}

/**
 * Label one inbound message.
 *
 * Never throws for bad output — an unparseable or empty response is reported
 * as a degraded result so the caller can ask a clarifying question. Rate
 * limits DO throw, because retrying later is the right response to those.
 */
export async function translate<TIntent>(
  args: TranslateArgs<TIntent>,
): Promise<TranslateResult<TIntent>> {
  try {
    const result = await generateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: args.model as any,
      output: Output.object({ schema: args.schema, name: "intents" }),
      system: `${args.systemPrompt}\n\n## Current state\n\n${args.stateBlock}`,
      messages: [...args.history, { role: "user" as const, content: args.userText }],
      temperature: 0,
    });

    const intents = result.output?.intents ?? [];
    return intents.length > 0
      ? { intents, degraded: false }
      : { intents: [], degraded: true };
  } catch (err) {
    if (isRateLimitError(err)) throw new AppError("LLM_RATE", "Translator rate limited", err, true);
    return { intents: [], degraded: true };
  }
}
