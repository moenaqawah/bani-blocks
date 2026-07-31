/**
 * "The orchestrator closes its own queries."
 *
 * After every transition that could leave a group unserved, `advanceDraft`
 * decides what happens next — request suggestions for the next pending group,
 * or declare the visit finished. No model is consulted; this is the flow.
 */

import type { HHMM } from "@bani/availability";
import { awaitingGroups, pendingGroups, replaceGroup } from "./draft.js";
import { capableFor } from "./roster.js";
import type {
  Effect,
  OrchestratorConfig,
  ReplyBlock,
  VisitDraft,
} from "./types.js";

export interface AdvanceOutcome {
  draft: VisitDraft;
  effects: Effect[];
  blocks: ReplyBlock[];
}

export function advanceDraft(
  input: VisitDraft,
  config: OrchestratorConfig,
  near?: HHMM,
): AdvanceOutcome {
  const effects: Effect[] = [];
  const blocks: ReplyBlock[] = [];
  let draft = input;

  // One group is offered at a time — never talk over an open question.
  if (awaitingGroups(draft).length > 0) return { draft, effects, blocks };

  while (true) {
    const next = pendingGroups(draft)[0];
    if (!next) break;

    const capable = next.employeePref
      ? [next.employeePref].filter((code) =>
          capableFor(next.services, config).includes(code),
        )
      : capableFor(next.services, config);

    if (capable.length === 0) {
      blocks.push({ kind: "no_capable_employee", services: next.services });
      draft = replaceGroup(draft, { ...next, state: "skipped" });
      continue;
    }

    if (!draft.visitDate) break;

    effects.push({
      kind: "ComputeSuggestions",
      group: next.key,
      date: draft.visitDate,
      services: next.services,
      durationMin: next.durationMin,
      employeePref: next.employeePref,
      ...(near ? { near } : {}),
    });
    return { draft, effects, blocks };
  }

  return { draft: settle(draft, blocks), effects, blocks };
}

/** Close the draft once nothing is left to offer. */
function settle(draft: VisitDraft, blocks: ReplyBlock[]): VisitDraft {
  if (draft.status !== "active") return draft;
  if (pendingGroups(draft).length > 0 || awaitingGroups(draft).length > 0) return draft;

  const booked = draft.groups.filter((g) => g.state === "booked");
  if (booked.length > 0) blocks.push({ kind: "visit_complete" });
  return { ...draft, status: booked.length > 0 ? "completed" : "abandoned" };
}
