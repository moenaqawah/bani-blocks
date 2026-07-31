/**
 * The post-check guards one thing: the system must not assert something untrue.
 *
 * Invention rejects a reply — a booking reference or a time the payload never
 * contained means a customer holds a plausible code, or turns up at an hour
 * nobody offered. Omission does not: a renderer that says less, or declines a
 * name differently, has said nothing false, and rejecting those shipped the
 * plain fallback for perfectly good replies (production, 2026-07-31).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFacts, normalizeDigits, type FactSet } from "../src/factcheck.js";

const facts = (over: Partial<FactSet> = {}): FactSet => ({
  refs: [],
  times: [],
  days: [],
  required: [],
  ...over,
});

describe("checkFacts rejects invented facts", () => {
  it("catches a time the orchestrator never offered", () => {
    const result = checkFacts("See you at 12:00!", facts({ times: ["11:00"] }));

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("invented time 12:00")));
  });

  it("catches a fabricated booking reference", () => {
    const result = checkFacts("Your ref is BK-ZZZ999", facts({ refs: ["BK-AAA111"] }));

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("invented ref BK-ZZZ999")));
  });
});

describe("checkFacts reports omissions without rejecting them", () => {
  // Saying less than the payload is not saying something untrue, so it ships —
  // but it is logged, because a rise in omissions is how prompt or model drift
  // shows up before anyone complains.
  it("warns about a missing reference but allows the reply", () => {
    const result = checkFacts("All booked!", facts({ refs: ["BK-AAA111"] }));

    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes("dropped ref BK-AAA111")));
    assert.deepEqual(result.problems, []);
  });

  it("warns about a missing time but allows the reply", () => {
    const result = checkFacts("You're all set.", facts({ times: ["11:00"] }));

    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes("dropped time 11:00")));
  });

  it("warns about a dropped employee name but allows the reply", () => {
    const result = checkFacts("Booked at 11:00.", facts({ times: ["11:00"], required: ["Muna"] }));

    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => w.includes('dropped "Muna"')));
  });

  it("summarising a long list of offered times is fine", () => {
    const result = checkFacts(
      "I have 10:00 and a few more through the afternoon — which suits?",
      facts({ times: ["10:00", "10:30", "11:00", "11:30", "12:00"] }),
    );

    assert.equal(result.ok, true, result.problems.join("; "));
    assert.equal(result.warnings.length, 4);
  });
});

describe("checkFacts tolerates harmless rephrasing", () => {
  it("accepts a warm rewrite that keeps every fact", () => {
    const result = checkFacts(
      "يا هلا! حجزتلك مع منى الساعة 11:00 ✨ رقم الحجز BK-AAA111",
      facts({ refs: ["BK-AAA111"], times: ["11:00"], required: ["منى"] }),
    );

    assert.equal(result.ok, true, result.problems.join("; "));
  });

  it("accepts Arabic-Indic digits for an allowed time", () => {
    const result = checkFacts("الساعة ١١:٠٠", facts({ times: ["11:00"] }));
    assert.equal(result.ok, true, result.problems.join("; "));
  });

  it("accepts an unpadded hour", () => {
    const result = checkFacts("See you at 9:30", facts({ times: ["09:30"] }));
    assert.equal(result.ok, true, result.problems.join("; "));
  });

  it("accepts a lowercase reference", () => {
    const result = checkFacts("ref bk-aaa111", facts({ refs: ["BK-AAA111"] }));
    assert.equal(result.ok, true, result.problems.join("; "));
  });

  it("passes a reply that states no facts at all", () => {
    assert.equal(checkFacts("Sorry, I didn't catch that.", facts()).ok, true);
  });
});

describe("Arabic names are matched by meaning, not by byte", () => {
  // Regression, production 2026-07-31: the catalog says "قص شعر" and the model
  // wrote the natural "قص الشعر". The reply was perfectly correct and was
  // rejected, so every Arabic booking shipped the plain fallback instead.
  it("accepts a service written with the definite article", () => {
    const result = checkFacts("حجزتلك قص الشعر", facts({ required: ["قص شعر"] }));
    assert.deepEqual(result.warnings, [], "a correctly-declined name is not an omission");
  });

  it("accepts هبة written as هبه, and a date written without hamza", () => {
    assert.deepEqual(checkFacts("مع هبه", facts({ required: ["هبة"] })).warnings, []);
    assert.deepEqual(
      checkFacts("مع الاثنين 3 اب", facts({ required: ["الاثنين 3 آب"] })).warnings, [],
    );
  });

  it("ignores harakat", () => {
    assert.deepEqual(checkFacts("قصّ شعر", facts({ required: ["قص شعر"] })).warnings, []);
  });

  it("still notices a genuinely different name", () => {
    const result = checkFacts("مع ليان", facts({ required: ["منى"] }));
    assert.ok(result.warnings.some((w) => w.includes("منى")));
  });

  it("leaves English matching intact, case-insensitively", () => {
    assert.deepEqual(checkFacts("with muna", facts({ required: ["Muna"] })).warnings, []);
    assert.ok(checkFacts("with Layan", facts({ required: ["Muna"] })).warnings.length > 0);
  });
});

describe("12-hour and 24-hour are the same instant", () => {
  // The payload is 24-hour but English naturally says "2:30 PM". Treating that
  // as an invented time would send the fallback for a correct reply.
  it("accepts an explicit PM rendering of an afternoon slot", () => {
    const result = checkFacts("See you at 2:30 PM", facts({ times: ["14:30"] }));
    assert.equal(result.ok, true, result.problems.join("; "));
    assert.deepEqual(result.warnings, [], "should not also count as dropped");
  });

  it("accepts lowercase and dotted meridiems", () => {
    for (const text of ["at 2:30pm", "at 2:30 p.m.", "at 2:30 PM."]) {
      assert.equal(checkFacts(text, facts({ times: ["14:30"] })).ok, true, text);
    }
  });

  it("accepts an AM rendering of a morning slot", () => {
    assert.equal(checkFacts("at 10:00 AM", facts({ times: ["10:00"] })).ok, true);
  });

  it("accepts a bare 12-hour time, since business hours make it unambiguous", () => {
    assert.equal(checkFacts("see you at 2:30", facts({ times: ["14:30"] })).ok, true);
  });

  it("still rejects a genuinely wrong time in either notation", () => {
    assert.equal(checkFacts("at 3:30 PM", facts({ times: ["14:30"] })).ok, false);
    assert.equal(checkFacts("at 15:30", facts({ times: ["14:30"] })).ok, false);
  });

  it("rejects a PM time when only the morning slot was offered", () => {
    // 10:00 was offered; "10:00 PM" is 22:00 — a different, unoffered instant.
    const result = checkFacts("at 10:00 PM", facts({ times: ["10:00"] }));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("invented time")));
  });

  it("handles noon and midnight correctly", () => {
    assert.equal(checkFacts("at 12:00 PM", facts({ times: ["12:00"] })).ok, true);
    assert.equal(checkFacts("at 12:30 AM", facts({ times: ["00:30"] })).ok, true);
  });
});

describe("the weekday is guarded like a time", () => {
  // A wrong weekday sends someone on the wrong day. Since omissions became
  // warnings, `required` alone would let an invented date ship.
  it("rejects a weekday the payload never mentioned", () => {
    const result = checkFacts(
      "Booked for Sunday 2 August",
      facts({ days: ["Saturday 1 August"], required: ["Saturday 1 August"] }),
    );

    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("invented day Sunday")));
  });

  it("rejects an invented weekday in Arabic", () => {
    const result = checkFacts("يوم الأحد", facts({ days: ["السبت 1 آب"] }));
    assert.equal(result.ok, false);
  });

  it("accepts the weekday it was given, in either script", () => {
    assert.equal(checkFacts("See you Saturday!", facts({ days: ["Saturday 1 August"] })).ok, true);
    assert.equal(checkFacts("بشوفك السبت", facts({ days: ["السبت 1 آب"] })).ok, true);
  });

  it("allows a relative phrasing that names no weekday at all", () => {
    // "tomorrow" drops the label — an omission, not an untruth.
    const result = checkFacts(
      "Booked for tomorrow at 11:00",
      facts({ days: ["Saturday 1 August"], required: ["Saturday 1 August"], times: ["11:00"] }),
    );

    assert.equal(result.ok, true, result.problems.join("; "));
    assert.ok(result.warnings.some((w) => w.includes("Saturday 1 August")));
  });

  it("allows two weekdays when the payload carries two dates", () => {
    const result = checkFacts(
      "We're closed Friday 7 August — how about Saturday 8 August?",
      facts({ days: ["Friday 7 August", "Saturday 8 August"] }),
    );

    assert.equal(result.ok, true, result.problems.join("; "));
  });
});

describe("normalizeDigits", () => {
  it("folds Arabic-Indic and extended Arabic-Indic digits to ASCII", () => {
    assert.equal(normalizeDigits("١٢:٣٠"), "12:30");
    assert.equal(normalizeDigits("۱۲:۳۰"), "12:30");
  });

  it("leaves other text alone", () => {
    assert.equal(normalizeDigits("مع منى 11:00"), "مع منى 11:00");
  });
});
