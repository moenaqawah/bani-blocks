/**
 * End-to-end regression scenarios.
 *
 * Each is a whole conversation driven through the real pipeline below the
 * translator: `runTurn` → `step()` → the availability engine → the template
 * pack, with only Google and Postgres faked. They exist so that a later change
 * which breaks a customer-visible behaviour fails HERE, loudly, naming the
 * behaviour — rather than in production.
 *
 * Two invariants are asserted on every single turn, by the harness itself:
 *   - the customer is never shown a time that was not computed as free;
 *   - the template's output never contains a fact it did not declare.
 *
 * If you change the flow deliberately, these are the tests to read first.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localToUtc } from "@bani/shared";
import { FakeSalon } from "./fake-salon.js";

// Friday 2026-08-07 is the closed day; 2026-08-03 is a Monday.
const NOW = localToUtc("2026-08-01T09:00");
const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";
const FRIDAY = "2026-08-07";
const SATURDAY = "2026-08-08";

// ─── 1. the ordinary multi-service visit ────────────────────────────────

describe("Scenario 1 — a two-group visit, booked over several turns", () => {
  it("books colour then nails, offering the second adjacent to the first", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    // "I'd like colour and a manicure on Monday."
    state = await salon.say(state, {
      kind: "new_visit",
      services: ["color", "manicure"],
      date: MONDAY,
    });

    // Colour and manicure need different employees, so this is two groups —
    // and only the first is offered. Never talk over an open question.
    assert.deepEqual(state.draft?.groups.map((g) => g.key), ["color", "manicure"]);
    assert.deepEqual(salon.blockKinds(), ["offer_slots"]);
    assert.equal(state.draft?.groups[0]?.state, "awaiting_choice");
    assert.equal(state.draft?.groups[1]?.state, "pending");

    // "10:00 please." Colour is 90 minutes, so it runs 10:00–11:30.
    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });

    // One turn, two things said: the booking AND the next group's times.
    assert.deepEqual(salon.blockKinds(), ["booked", "offer_slots"]);

    const nailOffer = salon.lastTurn.blocks.find((b) => b.kind === "offer_slots");
    assert.ok(nailOffer?.kind === "offer_slots");
    // Adjacency: nails lead with 11:30, the moment the colour finishes.
    assert.equal(nailOffer.offers[0]?.times[0], "11:30");
    // And never overlap the appointment just made — the no-self-conflict rule.
    for (const time of nailOffer.offers.flatMap((o) => o.times)) {
      assert.ok(time >= "11:30", `nails offered at ${time}, during the colour`);
    }

    state = await salon.say(state, { kind: "choose_slot", time: "11:30" });

    assert.deepEqual(salon.blockKinds(), ["booked", "visit_complete"]);
    assert.equal(state.draft?.status, "completed");

    // Two real appointments, two distinct references, no overlap.
    const booked = salon.ourBookings();
    assert.equal(booked.length, 2);
    assert.equal(new Set(salon.confirmedRefs()).size, 2);
    assert.deepEqual(booked.map((b) => b.time), ["10:00", "11:30"]);
    assert.notEqual(booked[0]!.employee, booked[1]!.employee);
  });
});

// ─── 2. no availability at all ──────────────────────────────────────────

describe("Scenario 2 — the day is fully booked", () => {
  it("says so, asks for another day, and books there without losing the request", async () => {
    const salon = new FakeSalon(NOW);
    for (const employee of ["muna", "hiba"]) salon.occupyDay(employee, MONDAY);

    let state = salon.freshState();
    state = await salon.say(state, { kind: "new_visit", services: ["color"], date: MONDAY });

    // Told plainly, offered nothing, and NOT left in limbo: the orchestrator
    // is now waiting for a date, so a bare day name works next turn.
    assert.deepEqual(salon.blockKinds(), ["no_slots"]);
    assert.equal(state.pendingQuestion?.kind, "need_date");
    assert.equal(state.draft?.groups[0]?.state, "pending");
    // The service survived — the customer does not have to say it again.
    assert.deepEqual(state.draft?.groups[0]?.services, ["color"]);
    assert.equal(salon.offeredTimes().length, 0);

    // "Tuesday then."
    state = await salon.say(state, { kind: "new_visit", services: [], date: TUESDAY });
    assert.deepEqual(salon.blockKinds(), ["offer_slots"]);

    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });
    assert.deepEqual(salon.blockKinds(), ["booked", "visit_complete"]);
    assert.equal(salon.ourBookings()[0]?.date, TUESDAY);
  });

  it("refuses a closed day before touching the calendar", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    state = await salon.say(state, { kind: "new_visit", services: ["haircut"], date: FRIDAY });

    assert.deepEqual(salon.blockKinds(), ["closed_day"]);
    assert.equal(salon.lastTurn.effects.length, 0, "asked the calendar about a closed day");

    const closed = salon.lastTurn.blocks[0];
    assert.ok(closed?.kind === "closed_day");
    assert.equal(closed.nextOpenDate, SATURDAY);
  });
});

// ─── 3. free slots exist, but none of them fit ──────────────────────────

describe("Scenario 3 — the day has gaps, but none big enough", () => {
  it("offers a 30-minute service and refuses a 90-minute one on the same day", async () => {
    // Every second half-hour is taken on both colourists: lots of free slots,
    // no contiguous 90-minute run anywhere.
    const salon = new FakeSalon(NOW);
    for (const employee of ["muna", "hiba"]) {
      for (let hour = 10; hour < 20; hour++) {
        salon.occupy(employee, MONDAY, `${hour}:30`, 30);
      }
    }

    // A 30-minute haircut fits in the gaps.
    let haircut = salon.freshState();
    haircut = await salon.say(haircut, { kind: "new_visit", services: ["haircut"], date: MONDAY });
    assert.deepEqual(salon.blockKinds(), ["offer_slots"]);

    const offer = salon.lastTurn.blocks[0];
    assert.ok(offer?.kind === "offer_slots");
    // Only on-the-hour starts — the half-hours are taken.
    for (const time of offer.offers.flatMap((o) => o.times)) {
      assert.equal(time.slice(3), "00", `offered ${time}, which is busy`);
    }

    // A 90-minute colour does not, and must not be offered a start anyway.
    const colourSalon = new FakeSalon(NOW);
    for (const employee of ["muna", "hiba"]) {
      for (let hour = 10; hour < 20; hour++) {
        colourSalon.occupy(employee, MONDAY, `${hour}:30`, 30);
      }
    }

    let colour = colourSalon.freshState();
    colour = await colourSalon.say(colour, { kind: "new_visit", services: ["color"], date: MONDAY });

    assert.deepEqual(colourSalon.blockKinds(), ["no_slots"]);
    assert.equal(colourSalon.offeredTimes().length, 0);
    assert.equal(colour.pendingQuestion?.kind, "need_date");
  });

  it("never offers a long service a start that would run past closing", async () => {
    // Keratin is 180 minutes; the last legal start is 17:00.
    const salon = new FakeSalon(NOW);
    salon.occupy("hiba", MONDAY, "10:00", 7 * 60); // free from 17:00 only

    let state = salon.freshState();
    state = await salon.say(state, {
      kind: "new_visit", services: ["keratin"], date: MONDAY,
      prefs: [{ service: "keratin", employee: "hiba" }],
    });

    assert.deepEqual(salon.blockKinds(), ["offer_slots"]);
    assert.deepEqual(salon.offeredTimes(), ["17:00"]);

    state = await salon.say(state, { kind: "choose_slot", time: "17:00" });
    assert.deepEqual(salon.blockKinds(), ["booked", "visit_complete"]);

    const booked = salon.ourBookings()[0]!;
    assert.equal(booked.time, "17:00");
    assert.equal(booked.durationMin, 180); // ends exactly at 20:00
  });
});

// ─── 4. someone takes the slot mid-conversation ─────────────────────────

describe("Scenario 4 — the chosen slot is taken between offer and confirmation", () => {
  it("admits it, re-offers fresh times, and never confirms the lost slot", async () => {
    const salon = new FakeSalon(NOW);
    salon.occupyDay("hiba", MONDAY); // force a single colourist, so offers are predictable

    let state = salon.freshState();
    state = await salon.say(state, { kind: "new_visit", services: ["color"], date: MONDAY });
    assert.deepEqual(salon.blockKinds(), ["offer_slots"]);

    // Someone books 10:00 through the salon's front desk a second later.
    salon.steal(MONDAY, "10:00");

    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });

    // Told the truth, given real alternatives, and NOT told they are booked.
    assert.deepEqual(salon.blockKinds(), ["slot_taken", "offer_slots"]);
    assert.equal(salon.confirmedRefs().length, 0, "confirmed a booking that failed");
    assert.equal(salon.ourBookings().length, 0);

    // The fresh offer excludes the slot that was just lost.
    const reoffer = salon.lastTurn.blocks.find((b) => b.kind === "offer_slots");
    assert.ok(reoffer?.kind === "offer_slots");
    const times = reoffer.offers.flatMap((o) => o.times);
    assert.ok(!times.includes("10:00"), "re-offered the slot that was just taken");
    assert.ok(times.length > 0);

    // The customer picks again, and this one sticks.
    state = await salon.say(state, { kind: "choose_slot", time: times[0]! });
    assert.deepEqual(salon.blockKinds(), ["booked", "visit_complete"]);
    assert.equal(salon.ourBookings().length, 1);
    assert.equal(salon.confirmedRefs().length, 1);
  });

  it("refuses a time from the stale offer after the list was refreshed", async () => {
    const salon = new FakeSalon(NOW);
    salon.occupyDay("hiba", MONDAY);

    let state = salon.freshState();
    state = await salon.say(state, { kind: "new_visit", services: ["color"], date: MONDAY });
    salon.steal(MONDAY, "10:00");
    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });

    // The customer, reading the older message, asks for 10:00 again.
    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });

    assert.deepEqual(salon.blockKinds(), ["slot_not_offered"]);
    assert.equal(salon.ourBookings().length, 0);
    assert.equal(salon.lastTurn.effects.length, 0, "attempted a booking for an unoffered slot");
  });
});

// ─── 5. the customer changes their mind mid-flow ────────────────────────

describe("Scenario 5 — an interruption in the middle of a visit", () => {
  it("asks before discarding the open visit, and resumes it intact on 'no'", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    state = await salon.say(state, { kind: "new_visit", services: ["color"], date: MONDAY });
    const originalOffers = salon.offeredTimes();
    assert.ok(originalOffers.length > 0);

    // Mid-flow: "actually, what about Tuesday for a haircut?"
    state = await salon.say(state, { kind: "new_visit", services: ["haircut"], date: TUESDAY });

    assert.deepEqual(salon.blockKinds(), ["ask_replace_draft"]);
    assert.equal(state.pendingQuestion?.kind, "replace_draft");
    // Nothing has changed yet — no booking, no lost draft, no calendar call.
    assert.equal(state.draft?.visitDate, MONDAY);
    assert.equal(salon.lastTurn.effects.length, 0);

    // Garbage in the middle must not move anything either.
    const beforeNoise = JSON.stringify(state.draft);
    state = await salon.say(state, { kind: "unclear" });
    assert.equal(JSON.stringify(state.draft), beforeNoise);
    assert.equal(state.pendingQuestion?.kind, "replace_draft", "lost the open question");

    // "No, finish the colour."
    state = await salon.say(state, { kind: "deny" });
    assert.deepEqual(salon.blockKinds(), ["draft_kept"]);
    assert.equal(state.draft?.visitDate, MONDAY);
    assert.deepEqual(state.draft?.groups.map((g) => g.key), ["color"]);

    // The original offer is still live and still bookable.
    state = await salon.say(state, { kind: "choose_slot", time: originalOffers[0]! });
    assert.deepEqual(salon.blockKinds(), ["booked", "visit_complete"]);
    assert.equal(salon.ourBookings()[0]?.date, MONDAY);
  });

  it("switches days on 'yes' and leaves already-booked groups alone", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    // Book the manicure half of a two-group visit first.
    state = await salon.say(state, {
      kind: "new_visit", services: ["manicure", "color"], date: MONDAY,
    });
    state = await salon.say(state, { kind: "choose_slot", time: salon.offeredTimes()[0]! });
    assert.equal(salon.ourBookings().length, 1);
    const keptRef = salon.confirmedRefs()[0]!;

    // Now change the rest to Tuesday.
    state = await salon.say(state, { kind: "new_visit", services: ["color"], date: TUESDAY });
    assert.deepEqual(salon.blockKinds(), ["ask_replace_draft"]);

    state = await salon.say(state, { kind: "confirm" });
    assert.ok(salon.blockKinds().includes("draft_replaced"));
    assert.equal(state.draft?.visitDate, TUESDAY);

    // The appointment already made survived untouched.
    assert.equal(salon.ourBookings().length, 1);
    assert.equal(salon.ourBookings()[0]?.ref, keptRef);
    assert.equal(salon.ourBookings()[0]?.date, MONDAY);
    assert.ok(state.bookings.some((b) => b.ref === keptRef));
  });
});

// ─── 6. cancelling ──────────────────────────────────────────────────────

describe("Scenario 6 — cancelling an appointment", () => {
  it("never cancels without an explicit yes, and rejects a reference the customer does not hold", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    state = await salon.say(state, { kind: "new_visit", services: ["haircut"], date: MONDAY });
    state = await salon.say(state, { kind: "choose_slot", time: salon.offeredTimes()[0]! });
    const ref = salon.confirmedRefs()[0]!;
    assert.equal(salon.ourBookings().length, 1);

    // A reference belonging to nobody.
    state = await salon.say(state, { kind: "cancel", ref: "BK-ZZZ999" });
    assert.deepEqual(salon.blockKinds(), ["cancel_not_found"]);
    assert.equal(salon.ourBookings().length, 1, "cancelled on an unknown reference");
    assert.equal(salon.lastTurn.effects.length, 0);

    // The real one — asked to confirm, nothing cancelled yet.
    state = await salon.say(state, { kind: "cancel", ref });
    assert.deepEqual(salon.blockKinds(), ["ask_cancel_confirm"]);
    assert.equal(state.pendingQuestion?.kind, "cancel_confirm");
    assert.equal(salon.ourBookings().length, 1, "cancelled before confirmation");

    // Second thoughts.
    state = await salon.say(state, { kind: "deny" });
    assert.deepEqual(salon.blockKinds(), ["cancel_aborted"]);
    assert.equal(salon.ourBookings().length, 1);
    assert.equal(state.pendingQuestion, null);

    // And now for real.
    state = await salon.say(state, { kind: "cancel", ref });
    state = await salon.say(state, { kind: "confirm" });
    assert.deepEqual(salon.blockKinds(), ["cancelled"]);
    assert.equal(salon.ourBookings().length, 0);
    assert.deepEqual(state.bookings, []);
  });

  it('treats a bare "yes" after the gate closes as small talk, not a cancellation', async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    state = await salon.say(state, { kind: "new_visit", services: ["haircut"], date: MONDAY });
    state = await salon.say(state, { kind: "choose_slot", time: salon.offeredTimes()[0]! });

    state = await salon.say(state, { kind: "confirm" });
    assert.deepEqual(salon.blockKinds(), ["chitchat"]);
    assert.equal(salon.ourBookings().length, 1);
  });
});

// ─── 8. asking what you have booked ─────────────────────────────────────

describe("Scenario 8 — 'what are my appointments?'", () => {
  it("answers from state without ever asking for a reference", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    state = await salon.say(state, { kind: "new_visit", services: ["haircut"], date: MONDAY });
    state = await salon.say(state, { kind: "choose_slot", time: salon.offeredTimes()[0]! });
    const ref = salon.confirmedRefs()[0]!;

    state = await salon.say(state, { kind: "list_bookings" });

    assert.deepEqual(salon.blockKinds(), ["current_bookings"]);
    // Answered from state that was already loaded — no lookup, no question.
    assert.equal(salon.lastTurn.effects.length, 0);

    const listed = salon.lastTurn.blocks[0];
    assert.ok(listed?.kind === "current_bookings");
    assert.deepEqual(listed.bookings.map((b) => b.ref), [ref]);
  });

  it("says so plainly when there is nothing booked", async () => {
    const salon = new FakeSalon(NOW);
    const state = await salon.say(salon.freshState(), { kind: "list_bookings" });

    assert.deepEqual(salon.blockKinds(), ["no_bookings"]);
    assert.equal(state.bookings.length, 0);
  });

  it("looks up history only when history is asked for", async () => {
    const salon = new FakeSalon(NOW);
    // An appointment that already happened — the case that used to read as
    // "you have no booking" rather than "that one is over".
    salon.appointments.push({
      ref: "BK-OLD001", employee: "muna", date: "2026-07-20", time: "11:00",
      durationMin: 30, services: ["haircut"], customer: "ours",
    });

    let state = await salon.say(salon.freshState(), { kind: "list_bookings", scope: "past" });
    assert.deepEqual(salon.blockKinds(), ["past_bookings"]);
    assert.deepEqual(salon.lastTurn.effects.map((e) => e.kind), ["FetchPastBookings"]);

    // "all" answers upcoming from state AND fetches history in the same turn.
    state = await salon.say(state, { kind: "list_bookings", scope: "all" });
    assert.deepEqual(salon.blockKinds(), ["no_bookings", "past_bookings"]);
  });
});

// ─── 7. the same customer cannot be in two places ───────────────────────

describe("Scenario 7 — the customer's own time is busy time", () => {
  it("never offers a second visit a slot that overlaps the first", async () => {
    const salon = new FakeSalon(NOW);
    let state = salon.freshState();

    // Book a 90-minute colour at 10:00 with a specific colourist.
    state = await salon.say(state, {
      kind: "new_visit", services: ["color"], date: MONDAY,
      prefs: [{ service: "color", employee: "muna" }],
    });
    state = await salon.say(state, { kind: "choose_slot", time: "10:00" });
    assert.equal(salon.ourBookings().length, 1);

    // A separate request, same day, a different employee entirely.
    state = await salon.say(state, { kind: "new_visit", services: ["manicure"], date: MONDAY });

    const offer = salon.lastTurn.blocks.find((b) => b.kind === "offer_slots");
    assert.ok(offer?.kind === "offer_slots");
    for (const time of offer.offers.flatMap((o) => o.times)) {
      assert.ok(
        time < "10:00" || time >= "11:30",
        `offered ${time}, which overlaps the customer's own 10:00–11:30 colour`,
      );
    }
  });
});
