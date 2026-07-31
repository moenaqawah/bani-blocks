import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localToUtc, utcToLocalParts } from "@bani/shared";
import {
  buildGrid,
  capableEmployees,
  mergeCalendars,
  normalizeIntervals,
  partitionServices,
  toHHMM,
  windowSuggestions,
  type EmployeeDef,
  type ServiceDef,
} from "../src/index.js";

const CATALOG: ServiceDef[] = [
  { code: "haircut", durationMinutes: 30 },
  { code: "color", durationMinutes: 90 },
  { code: "manicure", durationMinutes: 30 },
  { code: "facial", durationMinutes: 60 },
];

const TEAM: EmployeeDef[] = [
  { code: "muna", services: ["haircut", "color"], active: true },
  { code: "layan", services: ["manicure"], active: true },
  { code: "rana", services: ["facial"], active: false },
];

const DATE = "2026-08-03";
const at = (time: string) => localToUtc(`${DATE}T${time}`);
const span = (from: string, to: string) => ({ start: at(from), end: at(to) });

// ─── partitioning ───────────────────────────────────────────────────────

describe("partitionServices", () => {
  it("groups services one employee can do back to back", () => {
    const groups = partitionServices(["haircut", "color"], CATALOG, TEAM);

    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, "color+haircut");
    assert.equal(groups[0]?.durationMin, 120);
    assert.deepEqual(groups[0]?.capable, ["muna"]);
  });

  it("splits services with no shared employee", () => {
    const groups = partitionServices(["haircut", "manicure"], CATALOG, TEAM);

    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.key).sort(), ["haircut", "manicure"]);
  });

  it("gives a service nobody can do its own group with no capable employee", () => {
    const groups = partitionServices(["facial"], CATALOG, TEAM);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.capable, []);
  });

  it("produces the same key regardless of the order services were asked for", () => {
    const a = partitionServices(["color", "haircut"], CATALOG, TEAM);
    const b = partitionServices(["haircut", "color"], CATALOG, TEAM);

    assert.deepEqual(a.map((g) => g.key), b.map((g) => g.key));
  });

  it("ignores a repeated service", () => {
    const groups = partitionServices(["haircut", "haircut"], CATALOG, TEAM);
    assert.deepEqual(groups[0]?.services, ["haircut"]);
  });

  it("never reports an inactive employee as capable", () => {
    assert.deepEqual(capableEmployees(["facial"], TEAM), []);
  });
});

// ─── calendars ──────────────────────────────────────────────────────────

describe("mergeCalendars", () => {
  it("coalesces overlapping and touching spans", () => {
    const merged = mergeCalendars([span("10:00", "11:00"), span("10:30", "12:00")], [span("12:00", "13:00")]);

    assert.equal(merged.length, 1);
    assert.equal(toHHMM(merged[0]!.start), "10:00");
    assert.equal(toHHMM(merged[0]!.end), "13:00");
  });

  it("keeps disjoint spans apart", () => {
    const merged = mergeCalendars([span("10:00", "11:00")], [span("14:00", "15:00")]);
    assert.equal(merged.length, 2);
  });

  it("drops zero-length spans", () => {
    assert.deepEqual(normalizeIntervals([span("10:00", "10:00")]), []);
  });
});

// ─── the window slide ───────────────────────────────────────────────────

describe("windowSuggestions", () => {
  const grid = buildGrid(DATE, 10, 20, 30);
  const opts = { slotMinutes: 30, cap: 5 };

  it("returns the earliest fitting starts on an empty day", () => {
    const times = windowSuggestions([], 30, grid, opts).map(toHHMM);
    assert.deepEqual(times, ["10:00", "10:30", "11:00", "11:30", "12:00"]);
  });

  it("never offers a block that would run past closing", () => {
    const times = windowSuggestions([], 90, grid, { ...opts, cap: 100 }).map(toHHMM);

    assert.equal(times.at(-1), "18:30"); // 18:30 + 90 min = 20:00 exactly
    const endsAfterClose = times.filter((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + 90 > 20 * 60);
    assert.deepEqual(endsAfterClose, []);
  });

  it("excludes every start whose block touches busy time", () => {
    const times = windowSuggestions([span("11:00", "12:00")], 60, grid, { ...opts, cap: 100 }).map(toHHMM);

    assert.ok(!times.includes("10:30"), "a 60-min block at 10:30 would run into 11:00");
    assert.ok(!times.includes("11:00"));
    assert.ok(!times.includes("11:30"));
    assert.ok(times.includes("10:00"));
    assert.ok(times.includes("12:00"));
  });

  it("requires the whole block to be contiguous in the grid", () => {
    // A grid with 12:00 removed cannot host a 90-minute block at 11:00.
    const gapped = grid.filter((s) => toHHMM(s) !== "12:00");
    const times = windowSuggestions([], 90, gapped, { ...opts, cap: 100 }).map(toHHMM);

    assert.ok(!times.includes("11:00"));
    assert.ok(!times.includes("11:30"));
  });

  it("offers times adjacent to an already-booked group first", () => {
    // Hair booked 10:00–11:00 → nails should lead with 11:00, not 10:00.
    const times = windowSuggestions([], 30, grid, { ...opts, cap: 3, near: "11:00" }).map(toHHMM);

    assert.ok(times.includes("11:00"));
    assert.deepEqual([...times].sort(), times, "results stay in chronological order");
  });

  it("honours an 'earlier' request", () => {
    const times = windowSuggestions([], 30, grid, {
      ...opts, cap: 5, near: "13:00", before: "13:00",
    }).map(toHHMM);

    assert.ok(times.every((t) => t < "13:00"), `got ${times.join(", ")}`);
  });

  it("honours a 'later' request", () => {
    const times = windowSuggestions([], 30, grid, {
      ...opts, cap: 5, near: "13:00", after: "13:00",
    }).map(toHHMM);

    assert.ok(times.every((t) => t > "13:00"), `got ${times.join(", ")}`);
  });

  it("returns nothing when the day is fully busy", () => {
    assert.deepEqual(windowSuggestions([span("00:00", "23:30")], 30, grid, opts), []);
  });

  it("respects the cap", () => {
    assert.equal(windowSuggestions([], 30, grid, { ...opts, cap: 2 }).length, 2);
  });
});

// ─── grid ───────────────────────────────────────────────────────────────

describe("buildGrid", () => {
  it("covers opening hours at the configured granularity", () => {
    const grid = buildGrid(DATE, 10, 20, 30);

    assert.equal(grid.length, 20);
    assert.equal(toHHMM(grid[0]!), "10:00");
    assert.equal(toHHMM(grid.at(-1)!), "19:30");
  });

  it("produces Amman-local times regardless of the host timezone", () => {
    const grid = buildGrid(DATE, 10, 20, 30);
    assert.equal(utcToLocalParts(grid[0]!).date, DATE);
  });
});
