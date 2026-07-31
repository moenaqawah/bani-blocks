/**
 * The client's business config, projected into the shapes the shared blocks
 * expect (ADR-002 tier 1).
 *
 * Everything the orchestrator, the availability engine and the intent schema
 * know about Layali Salon flows through here, so a new client is a new
 * config.ts — not a new state machine.
 */

import type { OrchestratorConfig } from "@bani/orchestrator";
import {
  BOOKING_LIMITS,
  BUSINESS,
  RESOURCES,
  SERVICES,
} from "./config.js";

export type Locale = "ar" | "en";

export const ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  services: SERVICES.map((s) => ({ code: s.code, durationMinutes: s.durationMinutes })),
  employees: RESOURCES.map((r) => ({
    code: r.code,
    services: r.services,
    active: r.active,
    aliases: r.aliases,
  })),
  closedWeekdays: BUSINESS.closedWeekdays,
  horizonDays: BUSINESS.horizonDays,
  maxUpcomingVisits: BOOKING_LIMITS.maxUpcomingVisits,
  maxServicesPerVisit: BOOKING_LIMITS.maxServicesPerVisit,
  maxSlotsOffered: BUSINESS.maxSlotsOffered,
  maxEmployeesOffered: 2,
};

export function serviceName(code: string, locale: Locale): string {
  const svc = SERVICES.find((s) => s.code === code);
  if (!svc) return code;
  return locale === "ar" ? svc.ar : svc.en;
}

export function serviceNames(codes: readonly string[], locale: Locale): string[] {
  return codes.map((c) => serviceName(c, locale));
}

export function employeeName(code: string, locale: Locale): string {
  const emp = RESOURCES.find((r) => r.code === code);
  if (!emp) return code;
  return locale === "ar" ? emp.ar : emp.en;
}

export function serviceDuration(code: string): number {
  return SERVICES.find((s) => s.code === code)?.durationMinutes ?? BUSINESS.slotMinutes;
}
