/**
 * A small accumulator so the handlers in `handle-intent.ts` and
 * `handle-effect.ts` stay declarative: they describe what changes and what
 * the customer is told, and never assemble the result object by hand.
 *
 * `Turn` owns no logic of its own beyond `advance`, which delegates to the
 * flow rule in `advance.ts`.
 */

import type { HHMM } from "@bani/availability";
import { advanceDraft } from "./advance.js";
import type {
  Effect,
  OrchestratorConfig,
  PendingQuestion,
  ReplyBlock,
  Transition,
  VisitDraft,
  VisitState,
} from "./types.js";

export class Turn {
  readonly effects: Effect[] = [];
  readonly blocks: ReplyBlock[] = [];

  constructor(public state: VisitState) {}

  say(...blocks: ReplyBlock[]): this {
    this.blocks.push(...blocks);
    return this;
  }

  run(...effects: Effect[]): this {
    this.effects.push(...effects);
    return this;
  }

  setDraft(draft: VisitDraft | null): this {
    this.state = { ...this.state, draft };
    return this;
  }

  /** Record (or clear) what an unqualified "yes" will refer to next turn. */
  ask(question: PendingQuestion | null): this {
    this.state = { ...this.state, pendingQuestion: question };
    return this;
  }

  /** Hand control back to the flow: offer the next group, or close the visit. */
  advance(config: OrchestratorConfig, near?: HHMM): this {
    const draft = this.state.draft;
    if (!draft || (draft.status !== "active" && draft.status !== "gathering")) return this;

    const outcome = advanceDraft(draft, config, near);
    this.setDraft(outcome.draft);
    this.blocks.push(...outcome.blocks);
    this.effects.push(...outcome.effects);
    return this;
  }

  done(): Transition {
    return { state: this.state, effects: this.effects, reply: { blocks: this.blocks } };
  }
}
