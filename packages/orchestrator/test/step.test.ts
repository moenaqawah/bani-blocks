/**
 * Booking correctness as unit tests, with zero LLM calls — the whole point of
 * ADR-004. `step` is pure, so every rule below is checked by construction
 * rather than sampled by an eval.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { step, type Effect, type ReplyBlock } from "../src/index.js";
import {
  CONFIG,
  awaitingGroup,
  booking,
  draftWith,
  emptyState,
  pendingGroup,
} from "./fixtures.js";

const kinds = (blocks: readonly ReplyBlock[]) => blocks.map((b) => b.kind);
const effectKinds = (effects: readonly Effect[]) => effects.map((e) => e.kind);

// ─── gathering ──────────────────────────────────────────────────────────

describe("gathering is orchestrated, not prompted", () => {
  it("asks for services when the customer only asks for an appointment", () => {
    const out = step(
      emptyState(),
      { type: "intent", intent: { kind: "new_visit", services: [] } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["ask_services"]);
    assert.equal(out.state.pendingQuestion?.kind, "need_services");
    assert.equal(out.effects.length, 0);
  });

  it("asks for a day once services are known, and keeps them in the draft", () => {
    const out = step(
      emptyState(),
      { type: "intent", intent: { kind: "new_visit", services: ["haircut"] } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["ask_date"]);
    assert.equal(out.state.draft?.status, "gathering");
    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["haircut"]);
  });

  it("skips gathering entirely when the first message is complete", () => {
    const out = step(
      emptyState(),
      { type: "intent", intent: { kind: "new_visit", services: ["haircut"], date: "2026-08-03" } },
      CONFIG,
    );

    assert.equal(out.state.draft?.status, "active");
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
  });

  it("treats a day named in answer to 'which day?' as the answer, not a rival visit", () => {
    // Regression: this used to trigger the open-draft conflict rule, so the
    // orchestrator answered its own question by offering to discard the visit.
    const asked = emptyState({
      draft: draftWith([pendingGroup("color", ["color"])], "2026-08-03"),
      pendingQuestion: { kind: "need_date" },
    });

    const out = step(
      asked,
      { type: "intent", intent: { kind: "new_visit", services: [], date: "2026-08-04" } },
      CONFIG,
    );

    assert.ok(!kinds(out.reply.blocks).includes("ask_replace_draft"));
    assert.equal(out.state.draft?.visitDate, "2026-08-04");
    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["color"]);
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
  });

  it("still asks before replacing when a different day arrives unprompted", () => {
    const open = emptyState({
      draft: draftWith([pendingGroup("color", ["color"])], "2026-08-03"),
    });

    const out = step(
      open,
      { type: "intent", intent: { kind: "new_visit", services: ["haircut"], date: "2026-08-04" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["ask_replace_draft"]);
  });

  it("accumulates across turns — a bare date completes a gathering draft", () => {
    const first = step(
      emptyState(),
      { type: "intent", intent: { kind: "new_visit", services: ["color"] } },
      CONFIG,
    );
    const second = step(
      first.state,
      { type: "intent", intent: { kind: "new_visit", services: [], date: "2026-08-03" } },
      CONFIG,
    );

    assert.equal(second.state.draft?.visitDate, "2026-08-03");
    assert.deepEqual(second.state.draft?.groups.map((g) => g.services), [["color"]]);
    assert.deepEqual(effectKinds(second.effects), ["ComputeSuggestions"]);
  });
});

// ─── date validation ────────────────────────────────────────────────────

describe("date validation happens in the orchestrator", () => {
  const cases: Array<[string, string, ReplyBlock["kind"]]> = [
    ["a closed weekday", "2026-08-07", "closed_day"],
    ["a past date", "2026-07-30", "past_date"],
    ["beyond the horizon", "2027-08-03", "beyond_horizon"],
    ["a nonsense date", "2026-02-31", "unclear"],
  ];

  for (const [label, date, expected] of cases) {
    it(`rejects ${label} without emitting an effect`, () => {
      const out = step(
        emptyState(),
        { type: "intent", intent: { kind: "new_visit", services: ["haircut"], date } },
        CONFIG,
      );

      assert.deepEqual(kinds(out.reply.blocks), [expected]);
      assert.equal(out.effects.length, 0);
    });
  }
});

// ─── the offer lock ─────────────────────────────────────────────────────

describe("a slot can only be chosen if it was offered", () => {
  const offered = [{ employee: "muna", times: ["11:00", "13:00"] }];
  const state = () =>
    emptyState({ draft: draftWith([awaitingGroup("haircut", ["haircut"], offered)]) });

  it("books an offered time", () => {
    const out = step(
      state(),
      { type: "intent", intent: { kind: "choose_slot", time: "11:00" } },
      CONFIG,
    );

    assert.deepEqual(effectKinds(out.effects), ["CreateBooking"]);
    assert.deepEqual(out.effects[0], {
      kind: "CreateBooking",
      group: "haircut",
      date: "2026-08-03",
      time: "11:00",
      employee: "muna",
      services: ["haircut"],
      durationMin: 30,
    });
  });

  it("normalises a bare hour to an offered time", () => {
    const out = step(state(), { type: "intent", intent: { kind: "choose_slot", time: "11" } }, CONFIG);
    assert.deepEqual(effectKinds(out.effects), ["CreateBooking"]);
  });

  it("refuses a time that was never offered", () => {
    const out = step(
      state(),
      { type: "intent", intent: { kind: "choose_slot", time: "12:00" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["slot_not_offered"]);
    assert.equal(out.effects.length, 0);
  });

  it("refuses an employee who was not offered that time", () => {
    const out = step(
      state(),
      { type: "intent", intent: { kind: "choose_slot", time: "11:00", employee: "هبة" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["slot_not_offered"]);
    assert.equal(out.effects.length, 0);
  });

  it("refuses an employee who cannot do the service", () => {
    const out = step(
      state(),
      { type: "intent", intent: { kind: "choose_slot", time: "11:00", employee: "ليان" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["employee_cannot_do"]);
    assert.equal(out.effects.length, 0);
  });

  it("asks again when the name is not on the roster", () => {
    const out = step(
      state(),
      { type: "intent", intent: { kind: "choose_slot", time: "11:00", employee: "Sara" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["unknown_employee"]);
    assert.equal(out.effects.length, 0);
  });

  it("ignores a choice when nothing is awaiting one", () => {
    const out = step(
      emptyState(),
      { type: "intent", intent: { kind: "choose_slot", time: "11:00" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["unclear"]);
    assert.equal(out.effects.length, 0);
  });
});

// ─── closing its own queries ────────────────────────────────────────────

describe("the orchestrator closes its own queries", () => {
  it("offers the next group as soon as the first one is booked", () => {
    const state = emptyState({
      draft: draftWith([
        awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }]),
        pendingGroup("manicure", ["manicure"]),
      ]),
    });

    const out = step(
      state,
      {
        type: "effect_result",
        result: {
          kind: "BookingCreated",
          group: "haircut",
          ok: true,
          ref: "BK-AAA111",
          date: "2026-08-03",
          time: "11:00",
          employee: "muna",
          services: ["haircut"],
          durationMin: 30,
        },
      },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["booked"]);
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
    // The next group is offered adjacent to the one just booked.
    assert.equal(
      (out.effects[0] as Extract<Effect, { kind: "ComputeSuggestions" }>).near,
      "11:30",
    );
  });

  it("completes the visit when the last group is booked", () => {
    const state = emptyState({
      draft: draftWith([awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }])]),
    });

    const out = step(
      state,
      {
        type: "effect_result",
        result: {
          kind: "BookingCreated",
          group: "haircut",
          ok: true,
          ref: "BK-AAA111",
          date: "2026-08-03",
          time: "11:00",
          employee: "muna",
          services: ["haircut"],
          durationMin: 30,
        },
      },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["booked", "visit_complete"]);
    assert.equal(out.state.draft?.status, "completed");
    assert.equal(out.effects.length, 0);
  });

  it("loops back with fresh offers when the slot was taken", () => {
    const state = emptyState({
      draft: draftWith([awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }])]),
    });

    const out = step(
      state,
      {
        type: "effect_result",
        result: { kind: "BookingCreated", group: "haircut", ok: false, reason: "SLOT_TAKEN" },
      },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["slot_taken"]);
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
    assert.equal(out.state.draft?.groups[0]?.state, "pending");
  });

  it("skips a duplicate service and carries on with the rest of the visit", () => {
    const state = emptyState({
      draft: draftWith([
        awaitingGroup("haircut", ["haircut"], [{ employee: "muna", times: ["11:00"] }]),
        pendingGroup("manicure", ["manicure"]),
      ]),
    });

    const out = step(
      state,
      {
        type: "effect_result",
        result: {
          kind: "BookingCreated",
          group: "haircut",
          ok: false,
          reason: "DUPLICATE_SERVICE_SAME_DAY",
          conflictRef: "BK-OLD111",
          conflictService: "haircut",
        },
      },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["duplicate_service"]);
    assert.equal(out.state.draft?.groups[0]?.state, "skipped");
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
  });
});

// ─── open-draft conflict rule ───────────────────────────────────────────

describe("open-draft conflict rule", () => {
  const open = () =>
    emptyState({ draft: draftWith([pendingGroup("manicure", ["manicure"])], "2026-08-03") });

  it("merges a same-day request into the open draft", () => {
    const out = step(
      open(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["haircut"], date: "2026-08-03" },
      },
      CONFIG,
    );

    assert.equal(out.state.pendingQuestion, null);
    assert.deepEqual(
      out.state.draft?.groups.map((g) => g.key).sort(),
      ["haircut", "manicure"],
    );
  });

  it("asks before replacing the draft when the day differs", () => {
    const out = step(
      open(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["color"], date: "2026-08-04" },
      },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["ask_replace_draft"]);
    assert.equal(out.state.pendingQuestion?.kind, "replace_draft");
    assert.equal(out.effects.length, 0);
    // Nothing changed until the customer answers.
    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["manicure"]);
  });

  it('"yes" replaces the draft with the request that was set aside', () => {
    const asked = step(
      open(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["color"], date: "2026-08-04" },
      },
      CONFIG,
    );
    const out = step(asked.state, { type: "intent", intent: { kind: "confirm" } }, CONFIG);

    assert.equal(out.state.draft?.visitDate, "2026-08-04");
    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["color"]);
    assert.equal(out.state.pendingQuestion, null);
    assert.deepEqual(effectKinds(out.effects), ["ComputeSuggestions"]);
  });

  it('"no" keeps the open draft and discards the new request', () => {
    const asked = step(
      open(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["color"], date: "2026-08-04" },
      },
      CONFIG,
    );
    const out = step(asked.state, { type: "intent", intent: { kind: "deny" } }, CONFIG);

    assert.deepEqual(kinds(out.reply.blocks), ["draft_kept"]);
    assert.equal(out.state.draft?.visitDate, "2026-08-03");
    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["manicure"]);
  });

  it("leaves booked groups alone when a draft is replaced", () => {
    const withBooked = emptyState({
      draft: draftWith(
        [
          { ...pendingGroup("haircut", ["haircut"]), state: "booked", bookingRef: "BK-KEEP01" },
          pendingGroup("manicure", ["manicure"]),
        ],
        "2026-08-03",
      ),
      bookings: [booking("BK-KEEP01")],
    });

    const asked = step(
      withBooked,
      { type: "intent", intent: { kind: "new_visit", services: ["color"], date: "2026-08-04" } },
      CONFIG,
    );
    const out = step(asked.state, { type: "intent", intent: { kind: "confirm" } }, CONFIG);

    assert.deepEqual(out.state.bookings.map((b) => b.ref), ["BK-KEEP01"]);
  });
});

// ─── confirm/deny always has a referent ─────────────────────────────────

describe("confirm and deny resolve against the pending question", () => {
  it('treats a bare "yes" with no open question as small talk', () => {
    const out = step(emptyState(), { type: "intent", intent: { kind: "confirm" } }, CONFIG);
    assert.deepEqual(kinds(out.reply.blocks), ["chitchat"]);
    assert.equal(out.effects.length, 0);
  });

  it("gates cancellation behind an explicit confirmation", () => {
    const state = emptyState({ bookings: [booking("BK-AAA111")] });

    const asked = step(state, { type: "intent", intent: { kind: "cancel" } }, CONFIG);
    assert.deepEqual(kinds(asked.reply.blocks), ["ask_cancel_confirm"]);
    assert.equal(asked.effects.length, 0);

    const out = step(asked.state, { type: "intent", intent: { kind: "confirm" } }, CONFIG);
    assert.deepEqual(out.effects, [{ kind: "CancelBooking", ref: "BK-AAA111" }]);
  });

  it('cancels nothing on "no"', () => {
    const state = emptyState({ bookings: [booking("BK-AAA111")] });
    const asked = step(state, { type: "intent", intent: { kind: "cancel" } }, CONFIG);
    const out = step(asked.state, { type: "intent", intent: { kind: "deny" } }, CONFIG);

    assert.deepEqual(kinds(out.reply.blocks), ["cancel_aborted"]);
    assert.equal(out.effects.length, 0);
    assert.equal(out.state.pendingQuestion, null);
  });

  it("asks which booking when the customer has several and gave no ref", () => {
    const state = emptyState({ bookings: [booking("BK-AAA111"), booking("BK-BBB222")] });
    const out = step(state, { type: "intent", intent: { kind: "cancel" } }, CONFIG);

    assert.deepEqual(kinds(out.reply.blocks), ["which_booking"]);
    // Regression, reported 2026-08-01: the question used to be asked without
    // being recorded, so the answer landed on a turn with no referent and the
    // assistant asked again, forever.
    assert.deepEqual(out.state.pendingQuestion, {
      kind: "which_booking",
      refs: ["BK-AAA111", "BK-BBB222"],
    });
  });

  it("cancels everything on an explicit 'all', without making them pick one at a time", () => {
    const state = emptyState({ bookings: [booking("BK-AAA111"), booking("BK-BBB222")] });

    const asked = step(state, { type: "intent", intent: { kind: "cancel", scope: "all" } }, CONFIG);
    assert.deepEqual(kinds(asked.reply.blocks), ["ask_cancel_confirm"]);
    assert.deepEqual(asked.state.pendingQuestion, {
      kind: "cancel_confirm",
      refs: ["BK-AAA111", "BK-BBB222"],
    });

    const out = step(asked.state, { type: "intent", intent: { kind: "confirm" } }, CONFIG);
    assert.deepEqual(out.effects, [
      { kind: "CancelBooking", ref: "BK-AAA111" },
      { kind: "CancelBooking", ref: "BK-BBB222" },
    ]);
  });

  it("re-states the list when the answer to 'which one?' is not a choice", () => {
    const state = emptyState({ bookings: [booking("BK-AAA111"), booking("BK-BBB222")] });
    const asked = step(state, { type: "intent", intent: { kind: "cancel" } }, CONFIG);

    const out = step(asked.state, { type: "intent", intent: { kind: "unclear" } }, CONFIG);
    assert.deepEqual(kinds(out.reply.blocks), ["unclear", "which_booking"]);
    assert.equal(out.effects.length, 0);
  });

  it("cannot cancel a booking the customer does not hold", () => {
    const state = emptyState({ bookings: [booking("BK-AAA111")] });
    const out = step(state, { type: "intent", intent: { kind: "cancel", ref: "BK-ZZZ999" } }, CONFIG);

    assert.deepEqual(kinds(out.reply.blocks), ["cancel_not_found"]);
    assert.equal(out.effects.length, 0);
  });

  it("says so plainly when there is nothing to cancel", () => {
    const out = step(emptyState(), { type: "intent", intent: { kind: "cancel" } }, CONFIG);
    assert.deepEqual(kinds(out.reply.blocks), ["nothing_to_cancel"]);
  });
});

// ─── unbookable requests ────────────────────────────────────────────────

describe("requests nobody can serve", () => {
  it("reports a service with no active employee instead of offering times", () => {
    const out = step(
      emptyState(),
      { type: "intent", intent: { kind: "new_visit", services: ["massage"], date: "2026-08-03" } },
      CONFIG,
    );

    assert.deepEqual(kinds(out.reply.blocks), ["no_capable_employee"]);
    assert.equal(out.effects.length, 0);
  });

  it("caps the number of services in one visit", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: {
          kind: "new_visit",
          services: ["haircut", "color", "manicure", "massage"],
          date: "2026-08-03",
        },
      },
      CONFIG,
    );

    assert.ok(kinds(out.reply.blocks).includes("too_many_services"));
    assert.equal(
      out.state.draft?.groups.flatMap((g) => g.services).length,
      CONFIG.maxServicesPerVisit,
    );
  });
});

// ─── partitioning ───────────────────────────────────────────────────────

describe("service partitioning", () => {
  it("keeps services one employee can do together in a single group", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["haircut", "color"], date: "2026-08-03" },
      },
      CONFIG,
    );

    assert.deepEqual(out.state.draft?.groups.map((g) => g.key), ["color+haircut"]);
    assert.equal(out.state.draft?.groups[0]?.durationMin, 120);
  });

  it("splits services no single employee covers", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: { kind: "new_visit", services: ["haircut", "manicure"], date: "2026-08-03" },
      },
      CONFIG,
    );

    assert.deepEqual(out.state.draft?.groups.map((g) => g.key).sort(), ["haircut", "manicure"]);
    // Only the first group is offered — one open question at a time.
    assert.equal(out.effects.length, 1);
  });
});

// ─── employee preferences ───────────────────────────────────────────────

describe("employee preferences are resolved by the orchestrator", () => {
  it("pins a named employee onto the group and filters suggestions to them", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: {
          kind: "new_visit",
          services: ["color"],
          date: "2026-08-03",
          prefs: [{ service: "color", employee: "منى" }],
        },
      },
      CONFIG,
    );

    assert.equal(out.state.draft?.groups[0]?.employeePref, "muna");
    assert.equal(
      (out.effects[0] as Extract<Effect, { kind: "ComputeSuggestions" }>).employeePref,
      "muna",
    );
  });

  it("says who can do it when the named employee cannot", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: {
          kind: "new_visit",
          services: ["manicure"],
          date: "2026-08-03",
          prefs: [{ service: "manicure", employee: "منى" }],
        },
      },
      CONFIG,
    );

    const block = out.reply.blocks.find((b) => b.kind === "employee_cannot_do");
    assert.ok(block);
    assert.deepEqual(block.capableInstead, ["layan"]);
    // The visit still proceeds, just without the impossible preference.
    assert.equal(out.state.draft?.groups[0]?.employeePref, null);
  });

  it("ignores an inactive employee", () => {
    const out = step(
      emptyState(),
      {
        type: "intent",
        intent: {
          kind: "new_visit",
          services: ["haircut"],
          date: "2026-08-03",
          prefs: [{ service: "haircut", employee: "رنا" }],
        },
      },
      CONFIG,
    );

    assert.ok(kinds(out.reply.blocks).includes("unknown_employee"));
  });
});
