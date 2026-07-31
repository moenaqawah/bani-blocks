/**
 * Draft construction and mutation — the accumulator the LLM never touches.
 *
 * The translator labels one message at a time; everything gathered across
 * turns lives here, so a conversation can pause indefinitely and resume from
 * exactly where it stopped.
 */

import { partitionServices } from "@bani/availability";
import type { GroupKey } from "./intents.js";
import type {
  OrchestratorConfig,
  VisitDraft,
  VisitGroup,
} from "./types.js";

export const OPEN_STATUSES = ["gathering", "active"] as const;

export function isOpen(draft: VisitDraft | null): draft is VisitDraft {
  return draft !== null && (OPEN_STATUSES as readonly string[]).includes(draft.status);
}

/** Groups still waiting for a suggestion round. */
export function pendingGroups(draft: VisitDraft): VisitGroup[] {
  return draft.groups.filter((g) => g.state === "pending");
}

export function awaitingGroups(draft: VisitDraft): VisitGroup[] {
  return draft.groups.filter((g) => g.state === "awaiting_choice");
}

/** Groups that would be discarded if the draft were replaced. */
export function unbookedGroups(draft: VisitDraft): VisitGroup[] {
  return draft.groups.filter((g) => g.state === "pending" || g.state === "awaiting_choice");
}

export function allGroupsSettled(draft: VisitDraft): boolean {
  return draft.groups.length > 0 && unbookedGroups(draft).length === 0;
}

export function findGroup(draft: VisitDraft, key: GroupKey | undefined): VisitGroup | undefined {
  if (!key) return undefined;
  return draft.groups.find((g) => g.key === key);
}

/** Every service the draft currently covers, booked or not. */
export function draftServices(draft: VisitDraft): string[] {
  return draft.groups.flatMap((g) => g.services);
}

/**
 * Build the group list for a set of services.
 *
 * Groups already booked or skipped are carried over untouched — they are
 * independent bookings and must survive any re-planning of the rest.
 */
export function buildGroups(
  services: readonly string[],
  config: OrchestratorConfig,
  carryOver: readonly VisitGroup[] = [],
): VisitGroup[] {
  const settledKeys = new Set(carryOver.map((g) => g.key));
  const settledServices = new Set(carryOver.flatMap((g) => g.services));
  const remaining = services.filter((s) => !settledServices.has(s));

  const partitions = partitionServices(remaining, config.services, config.employees);

  const fresh = partitions
    .filter((p) => !settledKeys.has(p.key))
    .map<VisitGroup>((p) => ({
      key: p.key,
      services: p.services,
      durationMin: p.durationMin,
      state: "pending",
      offered: null,
      bookingRef: null,
      employeePref: null,
      bookedTime: null,
      bookedEmployee: null,
    }));

  return [...carryOver, ...fresh];
}

/**
 * Re-plan the unbooked part of a draft after services changed, preserving
 * any employee preference whose employee still covers the new group.
 */
export function repartition(
  draft: VisitDraft,
  services: readonly string[],
  config: OrchestratorConfig,
): VisitGroup[] {
  const settled = draft.groups.filter((g) => g.state === "booked" || g.state === "skipped");
  const previousPrefs = new Map(
    draft.groups
      .filter((g) => g.employeePref !== null)
      .flatMap((g) => g.services.map((s) => [s, g.employeePref!] as const)),
  );

  const rebuilt = buildGroups(services, config, settled);

  for (const group of rebuilt) {
    if (group.state !== "pending" || group.employeePref !== null) continue;
    const pref = group.services.map((s) => previousPrefs.get(s)).find((p) => p !== undefined);
    if (!pref) continue;
    const emp = config.employees.find((e) => e.code === pref);
    if (emp && group.services.every((s) => emp.services.includes(s))) {
      group.employeePref = pref;
    }
  }

  return rebuilt;
}

/** Reset a group so its next suggestion round starts from scratch. */
export function resetGroup(group: VisitGroup): VisitGroup {
  return { ...group, state: "pending", offered: null };
}

export function replaceGroup(draft: VisitDraft, updated: VisitGroup): VisitDraft {
  return {
    ...draft,
    groups: draft.groups.map((g) => (g.key === updated.key ? updated : g)),
  };
}
