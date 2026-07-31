/**
 * A miniature salon used by the state-machine tests.
 *
 * Deliberately not Layali's config: the orchestrator must be correct for any
 * roster, and a fixture that mirrors production hides coupling.
 */

import type {
  ActiveBooking,
  Offer,
  OrchestratorConfig,
  VisitDraft,
  VisitState,
} from "../src/index.js";

export const CONFIG: OrchestratorConfig = {
  services: [
    { code: "haircut", durationMinutes: 30 },
    { code: "color", durationMinutes: 90 },
    { code: "manicure", durationMinutes: 30 },
    { code: "massage", durationMinutes: 60 },
  ],
  employees: [
    { code: "muna", services: ["haircut", "color"], active: true, aliases: ["منى", "mona"] },
    { code: "hiba", services: ["haircut", "color"], active: true, aliases: ["هبة"] },
    { code: "layan", services: ["manicure"], active: true, aliases: ["ليان"] },
    { code: "rana", services: ["massage"], active: false, aliases: ["رنا"] },
  ],
  closedWeekdays: [5], // Friday
  horizonDays: 60,
  maxUpcomingVisits: 3,
  maxServicesPerVisit: 3,
  maxSlotsOffered: 5,
  maxEmployeesOffered: 2,
};

/** 2026-08-01 is a Saturday; 2026-08-07 is the following Friday. */
export const TODAY = "2026-08-01";

export function emptyState(overrides: Partial<VisitState> = {}): VisitState {
  return {
    draft: null,
    pendingQuestion: null,
    bookings: [],
    today: TODAY,
    nowTime: "09:00",
    customerName: "Lina",
    ...overrides,
  };
}

export function draftWith(groups: VisitDraft["groups"], visitDate = "2026-08-03"): VisitDraft {
  return { id: "draft-1", visitDate, groups, status: "active" };
}

export function awaitingGroup(key: string, services: string[], offered: Offer[]) {
  return {
    key,
    services,
    durationMin: services.reduce(
      (sum, s) => sum + (CONFIG.services.find((c) => c.code === s)?.durationMinutes ?? 0),
      0,
    ),
    state: "awaiting_choice" as const,
    offered,
    bookingRef: null,
    employeePref: null,
    bookedTime: null,
    bookedEmployee: null,
  };
}

export function pendingGroup(key: string, services: string[]) {
  return { ...awaitingGroup(key, services, []), state: "pending" as const, offered: null };
}

export function booking(ref: string, overrides: Partial<ActiveBooking> = {}): ActiveBooking {
  return {
    ref,
    date: "2026-08-03",
    time: "11:00",
    services: ["haircut"],
    employee: "muna",
    bundleId: `bundle-${ref}`,
    bookingGroupId: `visit-${ref}`,
    ...overrides,
  };
}
