/**
 * The turn lifecycle (ADR-004 §Turn lifecycle).
 *
 *   1. load state              (2 queries)
 *   2. translator → intents    (LLM call #1, constrained, no tools)
 *   3. orchestrator + effects  (no LLM — this is the flow)
 *   4. renderer → text         (LLM call #2, fact-checked, template fallback)
 *
 * The LLM appears twice, at the edges, and never in the control path. If the
 * translator returns garbage the orchestrator rejects it and the customer gets
 * a clarifying question; the flow itself cannot be derailed.
 */

import type { Sql } from "postgres";
import type { GcalClient } from "@bani/gcal-tool";
import { humanize, translate, type ModelMessage } from "@bani/agent-core";
import {
  renderStateBlock,
  runTurn,
  type Intent,
  type ReplyBlock,
  type VisitState,
} from "@bani/orchestrator";
import { logger } from "@bani/shared";
import { createExecutor } from "./effects.js";
import { INTENT_SCHEMA } from "./intent-schema.js";
import { ORCHESTRATOR_CONFIG, type Locale } from "./salon.js";
import { loadState, saveState } from "./state-store.js";
import { resolveReply } from "./reply-payload.js";
import { TRANSLATOR_PROMPT } from "./translator-prompt.js";
import { verdictGuideFor } from "./verdicts.js";
import { STYLE_PROMPT } from "./voice.js";

export interface TurnParams {
  sql: Sql;
  gcal: GcalClient;
  model: unknown;
  customerId: string;
  conversationId: string;
  customerName: string | null;
  waPhone: string;
  history: ModelMessage[];
  userText: string;
  locale: Locale;
  now: Date;
}

export interface TurnOutcome {
  text: string;
  intents: Intent[];
  blocks: ReplyBlock[];
  /** True when the plain template was sent instead of a polished reply. */
  fellBack: boolean;
}

export async function runConversationTurn(params: TurnParams): Promise<TurnOutcome> {
  // Phase timings, so a latency complaint can be answered with numbers rather
  // than a guess about which of the two model calls is slow.
  const mark = timer();

  const state = await loadState(params.sql, params.customerId, params.now, params.customerName);
  const load = mark();

  const intents = await labelMessage(params, state);
  const translate = mark();

  const { state: settled, blocks } = await applyIntents(params, state, intents);
  const orchestrate = mark();

  await saveState(params.sql, settled, params.customerId, params.conversationId, params.now);
  const save = mark();

  const text = await composeReply(params, blocks);
  const render = mark();

  logger.info("turn timing", {
    msg:
      `load=${load}ms translate=${translate}ms orchestrate=${orchestrate}ms ` +
      `save=${save}ms render=${render}ms total=${load + translate + orchestrate + save + render}ms ` +
      `effects=${blocks.length}b`,
  });

  return { ...text, intents, blocks };
}

/** Returns a function that reports ms elapsed since the previous call. */
function timer(): () => number {
  let previous = Date.now();
  return () => {
    const now = Date.now();
    const delta = now - previous;
    previous = now;
    return delta;
  };
}

// ─── layer 1 ────────────────────────────────────────────────────────────

async function labelMessage(params: TurnParams, state: VisitState): Promise<Intent[]> {
  const result = await translate<Intent>({
    model: params.model,
    systemPrompt: TRANSLATOR_PROMPT,
    stateBlock: renderStateBlock(state),
    history: params.history,
    userText: params.userText,
    schema: INTENT_SCHEMA,
  });

  // A degraded translator asks the customer to repeat themselves; it can never
  // move the flow, because `unclear` has no transition of its own.
  if (result.degraded) {
    logger.warn("translator degraded — treating message as unclear", {
      conversationId: params.conversationId,
    });
    return [{ kind: "unclear" }];
  }
  return result.intents;
}

// ─── layer 2 ────────────────────────────────────────────────────────────

async function applyIntents(
  params: TurnParams,
  state: VisitState,
  intents: Intent[],
): Promise<{ state: VisitState; blocks: ReplyBlock[] }> {
  const execute = createExecutor({
    sql: params.sql,
    gcal: params.gcal,
    customerId: params.customerId,
    conversationId: params.conversationId,
    customerName: params.customerName ?? "WhatsApp customer",
    waPhone: params.waPhone,
    // Every group of one visit shares a booking group, so "cancel the whole
    // visit" is one query rather than a guess about which rows belong together.
    bookingGroupId: state.draft?.id || crypto.randomUUID(),
    now: params.now,
  });

  const result = await runTurn(state, intents, ORCHESTRATOR_CONFIG, execute);
  if (result.truncated) {
    logger.warn("turn hit the transition budget", { conversationId: params.conversationId });
  }

  return { state: result.state, blocks: result.blocks };
}

// ─── layer 3 ────────────────────────────────────────────────────────────

async function composeReply(
  params: TurnParams,
  blocks: ReplyBlock[],
): Promise<{ text: string; fellBack: boolean }> {
  // Every value is resolved here, in code — dates formatted, service and
  // employee codes turned into names. The renderer only writes prose around them.
  const resolved = resolveReply(blocks, params.locale);

  if (resolved.blocks.length === 0) {
    const nothing = resolveReply([{ kind: "unclear" }], params.locale);
    return { text: nothing.fallbackText, fellBack: true };
  }

  const polished = await humanize({
    model: params.model,
    blocks: resolved.blocks,
    facts: resolved.facts,
    fallbackText: resolved.fallbackText,
    locale: params.locale,
    stylePrompt: STYLE_PROMPT,
    verdictGuide: verdictGuideFor(resolved.blocks.map((b) => b.verdict)),
    // History is loaded for the translator; the renderer only needs to know
    // that there IS some, so it stops greeting on every turn.
    continuing: params.history.length > 0,
    customerName: params.customerName,
    // Only when the whole turn is conversation: no facts stated, nothing done.
    ...(isPureConversation(resolved.blocks) ? { customerSaid: params.userText } : {}),
  });

  return { text: polished.text, fellBack: polished.fellBack };
}

/**
 * True when the reply carries no facts and reports no action — the only case
 * where showing the renderer the customer's own words helps rather than
 * tempts. On any turn that states a time, a reference or an outcome, the words
 * are withheld: the decision is the orchestrator's, and the renderer's job is
 * to phrase it, not to reconsider it.
 */
function isPureConversation(blocks: readonly { verdict: string }[]): boolean {
  const CONVERSATIONAL = new Set(["chitchat", "greeting", "unclear"]);
  return blocks.length > 0 && blocks.every((b) => CONVERSATIONAL.has(b.verdict));
}
