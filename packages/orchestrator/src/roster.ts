/**
 * Resolving the customer's raw wording against the roster and the catalog.
 *
 * The translator hands over whatever the customer typed; matching it to a
 * real employee or service code happens here, inside the orchestrator, so an
 * unrecognised name can only ever produce a clarifying question.
 */

import type { OrchestratorConfig, RosterEmployee } from "./types.js";

/** Fold case, strip Arabic diacritics, and normalise alef/ta-marbuta forms. */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ");
}

/** Match raw customer wording to an active employee, or null. */
export function resolveEmployee(
  raw: string,
  config: OrchestratorConfig,
): RosterEmployee | null {
  const needle = normalizeName(raw);
  if (needle === "") return null;

  for (const emp of config.employees) {
    if (!emp.active) continue;
    if (normalizeName(emp.code) === needle) return emp;
    if (emp.aliases.some((a) => normalizeName(a) === needle)) return emp;
  }
  return null;
}

/** Keep only service codes the business actually sells, preserving order. */
export function knownServices(
  services: readonly string[],
  config: OrchestratorConfig,
): string[] {
  const codes = new Set(config.services.map((s) => s.code));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of services) {
    if (!codes.has(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/** Active employees able to perform every service in the list. */
export function capableFor(
  services: readonly string[],
  config: OrchestratorConfig,
): string[] {
  return config.employees
    .filter((e) => e.active && services.every((s) => e.services.includes(s)))
    .map((e) => e.code);
}

export function employeeCanDo(
  employee: RosterEmployee,
  services: readonly string[],
): boolean {
  return services.every((s) => employee.services.includes(s));
}
