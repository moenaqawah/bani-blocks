/**
 * Property tests: invariants that must survive ANY sequence of intents and
 * effect results, including nonsense the translator should never emit.
 *
 * This is the guarantee ADR-004 buys — with a probabilistic controller these
 * would be "usually true"; with `step` they are checked exhaustively over a
 * deterministic pseudo-random walk.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runTurn,
  step,
  type Effect,
  type EffectResult,
  type Intent,
  type VisitState,
} from "../src/index.js";
import { CONFIG, awaitingGroup, booking, draftWith, emptyState } from "./fixtures.js";

/** Deterministic PRNG so a failure is always reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const SERVICES = ["haircut", "color", "manicure", "massage"];
const DATES = ["2026-08-03", "2026-08-04", "2026-08-07", "2026-07-01", "not-a-date"];
const TIMES = ["11:00", "11", "13:00", "99:99", "", "17:30"];
const NAMES = ["منى", "hiba", "ليان", "Sara", ""];

function randomIntent(rand: () => number): Intent {
  switch (Math.floor(rand() * 10)) {
    case 0:
      return {
        kind: "new_visit",
        services: [pick(rand, SERVICES)],
        ...(rand() > 0.3 ? { date: pick(rand, DATES) } : {}),
      };
    case 1:
      return { kind: "modify_visit", add: [pick(rand, SERVICES)] };
    case 2:
      return { kind: "modify_visit", remove: [pick(rand, SERVICES)] };
    case 3:
      return {
        kind: "choose_slot",
        time: pick(rand, TIMES),
        ...(rand() > 0.5 ? { employee: pick(rand, NAMES) } : {}),
      };
    case 4:
      return { kind: "other_times", ...(rand() > 0.5 ? { hint: "earlier" as const } : {}) };
    case 5:
      return { kind: "cancel", ...(rand() > 0.5 ? { ref: "BK-AAA111" } : {}) };
    case 6:
      return { kind: "confirm" };
    case 7:
      return { kind: "deny" };
    case 8:
      return { kind: "unclear" };
    default:
      return { kind: "chitchat" };
  }
}

function randomResult(rand: () => number, effect: Effect): EffectResult {
  if (effect.kind === "ComputeSuggestions") {
    // The real executor only ever offers employees capable of the group; a
    // fake that ignored that would be testing a contract nothing upholds.
    const capable = CONFIG.employees
      .filter((e) => e.active && effect.services.every((s) => e.services.includes(s)))
      .map((e) => e.code);

    return rand() > 0.4 && capable.length > 0
      ? {
          kind: "SuggestionsComputed",
          group: effect.group,
          ok: true,
          offers: capable.map((employee) => ({ employee, times: ["11:00", "13:00"] })),
          more: false,
        }
      : { kind: "SuggestionsComputed", group: effect.group, ok: false, reason: "NO_SLOTS" };
  }

  if (effect.kind === "FetchPastBookings") {
    return { kind: "PastBookingsFetched", bookings: [] };
  }

  if (effect.kind === "CreateBooking") {
    return rand() > 0.3
      ? {
          kind: "BookingCreated",
          group: effect.group,
          ok: true,
          ref: `BK-${String(Math.floor(rand() * 1e6)).padStart(6, "0")}`,
          date: effect.date,
          time: effect.time,
          employee: effect.employee,
          services: effect.services,
          durationMin: effect.durationMin,
        }
      : { kind: "BookingCreated", group: effect.group, ok: false, reason: "SLOT_TAKEN" };
  }

  return {
    kind: "BookingCancelled",
    ok: true,
    ref: effect.ref,
    date: "2026-08-03",
    time: "11:00",
    services: ["haircut"],
  };
}

/** Every invariant that must hold after any transition. */
function assertInvariants(state: VisitState, effects: readonly Effect[], seed: number) {
  const where = `seed ${seed}`;

  for (const effect of effects) {
    if (effect.kind !== "CreateBooking") continue;

    // A booking effect may only ever name a time and employee that this group
    // was actually offered — the anti-hallucination lock.
    const group = state.draft?.groups.find((g) => g.key === effect.group);
    const offered = group?.offered ?? previousOffers.get(effect.group) ?? [];
    const match = offered.find(
      (o) => o.employee === effect.employee && o.times.includes(effect.time),
    );
    assert.ok(match, `${where}: booked an unoffered slot ${effect.time}/${effect.employee}`);

    // And only an employee who can actually perform every service in it.
    const employee = CONFIG.employees.find((e) => e.code === effect.employee);
    assert.ok(employee?.active, `${where}: booked an inactive employee`);
    assert.ok(
      effect.services.every((s) => employee.services.includes(s)),
      `${where}: booked an employee who cannot do ${effect.services.join(", ")}`,
    );
  }

  // At most one group may hold an open question at a time.
  const awaiting = state.draft?.groups.filter((g) => g.state === "awaiting_choice") ?? [];
  assert.ok(awaiting.length <= 1, `${where}: ${awaiting.length} groups awaiting a choice`);

  // Offers only exist while a group is awaiting a choice.
  for (const group of state.draft?.groups ?? []) {
    if (group.state !== "awaiting_choice") {
      assert.equal(group.offered, null, `${where}: stale offers on a ${group.state} group`);
    }
    if (group.state === "booked") {
      assert.ok(group.bookingRef, `${where}: booked group without a reference`);
    }
  }

  // No duplicate group keys, and no service in two groups at once.
  const keys = (state.draft?.groups ?? []).map((g) => g.key);
  assert.equal(new Set(keys).size, keys.length, `${where}: duplicate group keys`);
  const services = (state.draft?.groups ?? []).flatMap((g) => g.services);
  assert.equal(new Set(services).size, services.length, `${where}: a service in two groups`);

  // Cancellation is never proposed for a booking the customer does not hold.
  for (const effect of effects) {
    if (effect.kind !== "CancelBooking") continue;
    assert.ok(
      state.bookings.some((b) => b.ref === effect.ref) || cancelledRefs.has(effect.ref),
      `${where}: tried to cancel a booking the customer does not hold`,
    );
  }
}

const previousOffers = new Map<string, Array<{ employee: string; times: string[] }>>();
const cancelledRefs = new Set<string>();

describe("step invariants hold under random input", () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed ${seed}`, async () => {
      const rand = rng(seed);
      previousOffers.clear();
      cancelledRefs.clear();

      let state: VisitState = emptyState({ bookings: [booking("BK-AAA111")] });

      for (let turnIndex = 0; turnIndex < 12; turnIndex++) {
        for (const b of state.bookings) cancelledRefs.add(b.ref);
        for (const group of state.draft?.groups ?? []) {
          if (group.offered) previousOffers.set(group.key, group.offered);
        }

        const result = await runTurn(state, [randomIntent(rand)], CONFIG, async (effect) => {
          assertInvariants(state, [effect], seed);
          return randomResult(rand, effect);
        });

        state = result.state;
        assertInvariants(state, [], seed);
      }
    });
  }
});

describe("the transition budget always terminates a turn", () => {
  it("stops rather than spinning when every booking attempt fails", async () => {
    const state = emptyState({
      draft: draftWith([awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }])]),
    });

    let calls = 0;
    const result = await runTurn(
      state,
      [{ kind: "choose_slot", time: "11:00" }],
      CONFIG,
      async (effect) => {
        calls++;
        return effect.kind === "CreateBooking"
          ? { kind: "BookingCreated", group: effect.group, ok: false, reason: "SLOT_TAKEN" }
          : {
              kind: "SuggestionsComputed",
              group: (effect as Extract<Effect, { kind: "ComputeSuggestions" }>).group,
              ok: true,
              offers: [{ employee: "muna", times: ["11:00"] }],
              more: false,
            };
      },
    );

    assert.ok(calls < 20, `runaway effect loop: ${calls} calls`);
    assert.ok(result.state.draft);
  });
});

describe("a degraded translator cannot move the flow", () => {
  it("leaves state untouched for unclear and chitchat", () => {
    const before = emptyState({
      draft: draftWith([awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }])]),
    });

    for (const intent of [{ kind: "unclear" } as const, { kind: "chitchat" } as const]) {
      const out = step(before, { type: "intent", intent }, CONFIG);
      assert.equal(out.effects.length, 0);
      assert.deepEqual(out.state.draft, before.draft);
      assert.deepEqual(out.state.bookings, before.bookings);
    }
  });
});
