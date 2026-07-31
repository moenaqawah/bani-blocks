import type { EmployeeDef, Group, ServiceDef } from "./types.js";

/**
 * Split a requested service list into the minimum number of groups such
 * that every group has at least one employee capable of ALL its services.
 *
 * Greedy in catalog order, which is deterministic and produces the fewest
 * groups for real salon rosters (capability sets are nested or disjoint,
 * never pathologically interleaved). A service nobody can perform is
 * returned as its own group with an empty `capable` list — the orchestrator
 * reports it rather than silently dropping it.
 */
export function partitionServices(
  services: readonly string[],
  catalog: readonly ServiceDef[],
  employees: readonly EmployeeDef[],
): Group[] {
  const active = employees.filter((e) => e.active);
  const unique = dedupePreservingOrder(services);

  const groups: Array<{ services: string[]; capable: string[] }> = [];

  for (const code of unique) {
    const capable = active
      .filter((e) => e.services.includes(code))
      .map((e) => e.code);

    if (capable.length === 0) {
      groups.push({ services: [code], capable: [] });
      continue;
    }

    const home = groups.find((g) => {
      if (g.capable.length === 0) return false;
      return g.capable.some((c) => capable.includes(c));
    });

    if (home) {
      home.services.push(code);
      home.capable = home.capable.filter((c) => capable.includes(c));
    } else {
      groups.push({ services: [code], capable });
    }
  }

  return groups.map((g) => {
    const sorted = [...g.services].sort();
    return {
      key: sorted.join("+"),
      services: sorted,
      durationMin: totalDuration(sorted, catalog),
      capable: g.capable,
    };
  });
}

/** Sum of the configured durations of every service in the list. */
export function totalDuration(
  services: readonly string[],
  catalog: readonly ServiceDef[],
): number {
  return services.reduce((sum, code) => {
    const svc = catalog.find((s) => s.code === code);
    return sum + (svc?.durationMinutes ?? 0);
  }, 0);
}

/** Employees able to perform every service in the list. */
export function capableEmployees(
  services: readonly string[],
  employees: readonly EmployeeDef[],
): string[] {
  return employees
    .filter((e) => e.active && services.every((s) => e.services.includes(s)))
    .map((e) => e.code);
}

function dedupePreservingOrder(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
