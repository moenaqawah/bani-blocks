/**
 * ADR-004 Layer 2 — the deterministic controller.
 *
 * `step` is a pure function over (state × input). Booking correctness is
 * therefore a unit-test property, not an eval: no model, no clock, no I/O
 * appears anywhere below this line.
 */

import { handleEffectResult } from "./handle-effect.js";
import { handleIntent } from "./handle-intent.js";
import type { Intent } from "./intents.js";
import type {
  Effect,
  EffectResult,
  OrchestratorConfig,
  ReplyBlock,
  StepInput,
  Transition,
  VisitState,
} from "./types.js";

export function step(
  state: VisitState,
  input: StepInput,
  config: OrchestratorConfig,
): Transition {
  return input.type === "intent"
    ? handleIntent(state, input.intent, config)
    : handleEffectResult(state, input.result, config);
}

/**
 * Hard ceiling on transitions per turn. A normal booking turn uses three
 * (choose → book → offer next group); the limit exists so a pathological
 * effect/result cycle can never spin.
 */
export const MAX_TRANSITIONS_PER_TURN = 8;

/** Runs one effect and reports what happened. Supplied by the app. */
export type EffectExecutor = (effect: Effect) => Promise<EffectResult>;

export interface TurnResult {
  state: VisitState;
  blocks: ReplyBlock[];
  /** True when the transition budget was hit — the turn was cut short. */
  truncated: boolean;
}

/**
 * Drive one inbound message to a settled state.
 *
 * Intents are applied in order, and every effect they produce is executed and
 * fed back in until nothing is left to do. The reply payload is whatever the
 * whole cascade accumulated.
 */
export async function runTurn(
  initial: VisitState,
  intents: readonly Intent[],
  config: OrchestratorConfig,
  execute: EffectExecutor,
): Promise<TurnResult> {
  let state = initial;
  const blocks: ReplyBlock[] = [];
  let budget = MAX_TRANSITIONS_PER_TURN;
  let truncated = false;

  const queue: StepInput[] = intents.map((intent) => ({ type: "intent", intent }));

  while (queue.length > 0) {
    if (budget-- <= 0) {
      truncated = true;
      break;
    }

    const transition = step(state, queue.shift()!, config);
    state = transition.state;
    blocks.push(...transition.reply.blocks);

    for (const effect of transition.effects) {
      queue.push({ type: "effect_result", result: await execute(effect) });
    }
  }

  return { state, blocks, truncated };
}
