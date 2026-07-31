/**
 * The resolver's contract.
 *
 * Everything the customer reads is computed here, so this is where a silent
 * failure would live: a value the resolver prints but forgets to declare makes
 * the Layer 3 post-check reject the model's output, and every reply of that
 * kind falls back forever with only a log line to show for it.
 *
 * So: every block kind, both locales, checked against its own guards.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFacts, checkSpeechActs } from "@bani/agent-core";
import { SPEECH_ACTS, type ActiveBooking, type Offer, type ReplyBlock } from "@bani/orchestrator";
import { formatDay, resolveReply } from "../src/reply-payload.js";

const OFFERS: Offer[] = [
  { employee: "muna", times: ["10:00", "11:30"] },
  { employee: "hiba", times: ["14:00"] },
];

const BOOKINGS: ActiveBooking[] = [
  {
    ref: "BK-AAA111", date: "2026-08-03", time: "11:00",
    services: ["haircut"], employee: "muna",
    bundleId: "b1", bookingGroupId: "v1",
  },
];

/** One example of every block kind the orchestrator can emit. */
const SAMPLES: ReplyBlock[] = [
  { kind: "greeting" },
  { kind: "chitchat" },
  { kind: "unclear" },
  { kind: "ask_services" },
  { kind: "ask_date", services: ["color"] },
  { kind: "offer_slots", group: "color", services: ["color"], date: "2026-08-03", offers: OFFERS, more: true, remainingGroups: 1 },
  { kind: "no_slots", services: ["color"], date: "2026-08-03", nextOpenDate: "2026-08-04" },
  { kind: "no_slots", services: ["color"], date: "2026-08-03" },
  { kind: "closed_day", date: "2026-08-07", nextOpenDate: "2026-08-08" },
  { kind: "closed_day", date: "2026-08-07" },
  { kind: "past_date", date: "2026-07-01" },
  { kind: "beyond_horizon", date: "2027-01-01", horizonDays: 60 },
  { kind: "no_capable_employee", services: ["keratin"] },
  { kind: "calendar_error" },
  { kind: "booked", ref: "BK-AAA111", date: "2026-08-03", time: "10:00", endTime: "11:30", employee: "muna", services: ["color"] },
  { kind: "visit_complete" },
  { kind: "slot_taken" },
  { kind: "customer_busy" },
  { kind: "too_many_visits", count: 3, max: 3 },
  { kind: "duplicate_service", service: "haircut", ref: "BK-AAA111" },
  { kind: "duplicate_service", service: "haircut", ref: "" },
  { kind: "outside_hours", services: ["keratin"] },
  { kind: "too_soon" },
  { kind: "slot_not_offered", offers: OFFERS, date: "2026-08-03" },
  { kind: "unknown_employee", raw: "Sara" },
  { kind: "employee_cannot_do", employee: "muna", services: ["manicure"], capableInstead: ["layan"] },
  { kind: "employee_cannot_do", employee: "muna", services: ["manicure"], capableInstead: [] },
  { kind: "ask_replace_draft", open: { date: "2026-08-03", services: ["manicure"] }, incoming: { date: "2026-08-04", services: ["color"] } },
  { kind: "ask_replace_draft", open: { date: null, services: ["manicure"] }, incoming: { services: ["color"] } },
  { kind: "draft_replaced" },
  { kind: "draft_kept", date: "2026-08-03", services: ["color"] },
  { kind: "draft_kept", date: null, services: ["color"] },
  { kind: "ask_cancel_confirm", bookings: BOOKINGS },
  { kind: "cancelled", ref: "BK-AAA111", date: "2026-08-03", time: "11:00", services: ["haircut"] },
  { kind: "cancel_aborted" },
  { kind: "cancel_not_found", ref: "BK-ZZZ999" },
  { kind: "cancel_not_found" },
  { kind: "nothing_to_cancel" },
  { kind: "which_booking", bookings: BOOKINGS },
  { kind: "cancel_failed", ref: "BK-AAA111", reason: "CALENDAR_ERROR" },
  { kind: "current_bookings", bookings: BOOKINGS },
  { kind: "past_bookings", bookings: BOOKINGS },
  { kind: "no_bookings", scope: "upcoming" },
  { kind: "no_bookings", scope: "past" },
  { kind: "too_many_services", max: 3 },
  { kind: "cannot_answer" },
];

const LOCALES = ["ar", "en"] as const;

describe("the resolver covers every block the orchestrator can emit", () => {
  it("samples every kind the orchestrator can emit", () => {
    const sampled = new Set(SAMPLES.map((b) => b.kind));
    const expected = Object.keys(SPEECH_ACTS);
    const missing = expected.filter((k) => !sampled.has(k as ReplyBlock["kind"]));
    assert.deepEqual(missing, [], `block kinds with no sample: ${missing.join(", ")}`);
  });

  it("carries no question text on cannot_answer, so it cannot be answered", () => {
    const { blocks } = resolveReply([{ kind: "cannot_answer" }], "en");
    assert.deepEqual(Object.keys(blocks[0]!).sort(), ["act", "verdict"]);
  });
});

describe("every resolved block declares the values it carries", () => {
  for (const block of SAMPLES) {
    for (const locale of LOCALES) {
      it(`${block.kind} [${locale}]`, () => {
        const resolved = resolveReply([block], locale);
        const problems = [
          ...checkFacts(resolved.fallbackText, resolved.facts).problems,
          ...checkSpeechActs(resolved.fallbackText, resolved.blocks),
        ];
        assert.deepEqual(problems, [], `${resolved.fallbackText}`);
      });
    }
  }

  it("holds when many blocks are combined into one reply", () => {
    for (const locale of LOCALES) {
      const resolved = resolveReply(SAMPLES, locale);
      assert.deepEqual(checkFacts(resolved.fallbackText, resolved.facts).problems, []);
    }
  });
});

describe("no internal identifier reaches the renderer", () => {
  it("hides group keys and reason codes behind an underscore", () => {
    const { blocks } = resolveReply(
      [{ kind: "offer_slots", group: "color+haircut", services: ["color"], date: "2026-08-03", offers: OFFERS, more: false, remainingGroups: 0 }],
      "en",
    );
    assert.equal(blocks[0]!.group, undefined);
    assert.equal(blocks[0]!._group, "color+haircut");
  });

  it("resolves service and employee codes to names, never codes", () => {
    const { blocks } = resolveReply(
      [{ kind: "booked", ref: "BK-AAA111", date: "2026-08-03", time: "10:00", endTime: "11:30", employee: "muna", services: ["color"] }],
      "en",
    );

    assert.deepEqual(blocks[0]!.services, ["Hair colour"]);
    assert.equal(blocks[0]!.employee, "Muna");
    assert.equal(JSON.stringify(blocks[0]).includes('"muna"'), false, "leaked an employee code");
  });
});

describe("dates are computed in code, never left to the model", () => {
  it("resolves an ISO date to a weekday label in both locales", () => {
    // 2026-08-03 is a Monday. Getting this wrong sends someone on the wrong day.
    assert.equal(formatDay("2026-08-03", "en"), "Monday 3 August");
    assert.equal(formatDay("2026-08-03", "ar"), "الاثنين 3 آب");
  });

  it("uses Levantine month names, not Gulf ones", () => {
    assert.equal(formatDay("2026-08-03", "ar").includes("آب"), true);
    assert.equal(formatDay("2026-08-03", "ar").includes("أغسطس"), false);
  });

  it("replaces the raw date so an ISO string never reaches the renderer", () => {
    const { blocks, facts } = resolveReply([{ kind: "past_date", date: "2026-07-01" }], "en");

    assert.equal(blocks[0]!.date, undefined);
    assert.equal(blocks[0]!.day, "Wednesday 1 July");
    // And it is a checked value, not merely a formatted one.
    assert.ok(facts.required.includes("Wednesday 1 July"));
  });

  it("labels both dates when a block carries two", () => {
    const { blocks } = resolveReply(
      [{ kind: "closed_day", date: "2026-08-07", nextOpenDate: "2026-08-08" }],
      "en",
    );

    assert.equal(blocks[0]!.day, "Friday 7 August");
    assert.equal(blocks[0]!.nextOpenDay, "Saturday 8 August");
  });
});

describe("the speech act travels with the decision", () => {
  const actOfSample = (kind: ReplyBlock["kind"]) =>
    resolveReply([SAMPLES.find((b) => b.kind === kind)!], "en").blocks[0]!.act;

  it("separates the pair the fact check cannot", () => {
    // Identical facts, opposite meanings.
    assert.equal(actOfSample("ask_cancel_confirm"), "question");
    assert.equal(actOfSample("cancelled"), "done");
  });

  it("marks failures as failures", () => {
    for (const kind of ["slot_taken", "no_slots", "outside_hours", "slot_not_offered"] as const) {
      assert.equal(actOfSample(kind), "failed", kind);
    }
  });

  it("rejects a proposed cancellation stated as a completed one", () => {
    const problems = checkSpeechActs("Your booking is cancelled.", [
      { verdict: "ask_cancel_confirm", act: "question", ref: "BK-AAA111" },
    ]);
    assert.equal(problems.length, 1);
  });

  it("accepts it when phrased as a question, in either script", () => {
    const blocks = [{ verdict: "ask_cancel_confirm", act: "question" as const, ref: "BK-AAA111" }];
    assert.deepEqual(checkSpeechActs("Shall I cancel it?", blocks), []);
    assert.deepEqual(checkSpeechActs("بتأكد الإلغاء؟", blocks), []);
  });

  it("lets an offer of free times be phrased declaratively", () => {
    // "Let me know which time works for you" is an ordinary way to ask, and
    // being declarative about availability misleads nobody.
    assert.deepEqual(
      checkSpeechActs("Here are the times. Let me know which works for you.", [
        { verdict: "offer_slots", act: "question" },
      ]),
      [],
    );
  });
});
