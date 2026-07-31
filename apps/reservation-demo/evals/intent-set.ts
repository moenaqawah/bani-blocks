/**
 * The labelled intent set — the only LLM eval this system needs.
 *
 * Booking correctness is unit-tested against `step()` with no model involved
 * (packages/orchestrator/test). What remains uncertain is labelling, so that
 * is what is measured here.
 *
 * This file and the few-shots in `src/translator-prompt.ts` are the same
 * growing artifact: when a real message is mislabelled in production, add it
 * here AND as a few-shot. Cases are seeded synthetically; replace them with
 * real messages as traffic accumulates (ADR-004 action item 5 targets ≥100).
 *
 * `state` is the state block the translator will see. `expect` lists only the
 * fields that must match — a case asserts on meaning, not on the whole object.
 */

import type { Intent, VisitState } from "@bani/orchestrator";

export interface IntentCase {
  id: string;
  locale: "ar" | "en";
  message: string;
  state: VisitState;
  /** One entry per expected intent, in order. */
  expect: Array<Partial<Intent> & { kind: Intent["kind"] }>;
}

const TODAY = "2026-08-01"; // a Saturday
const TOMORROW = "2026-08-02";

function base(over: Partial<VisitState> = {}): VisitState {
  return {
    draft: null,
    pendingQuestion: null,
    bookings: [],
    today: TODAY,
    nowTime: "10:00",
    customerName: "Lina",
    ...over,
  };
}

function awaiting(times: string[] = ["11:00", "13:00"], employee = "muna"): VisitState {
  return base({
    draft: {
      id: "d1",
      visitDate: TOMORROW,
      status: "active",
      groups: [
        {
          key: "haircut",
          services: ["haircut"],
          durationMin: 30,
          state: "awaiting_choice",
          offered: [{ employee, times }],
          bookingRef: null,
          employeePref: null,
          bookedTime: null,
          bookedEmployee: null,
        },
      ],
    },
  });
}

function gathering(question: "need_date" | "need_services"): VisitState {
  return base({
    draft: {
      id: "d1",
      visitDate: null,
      status: "gathering",
      groups:
        question === "need_date"
          ? [
              {
                key: "color",
                services: ["color"],
                durationMin: 90,
                state: "pending",
                offered: null,
                bookingRef: null,
                employeePref: null,
                bookedTime: null,
                bookedEmployee: null,
              },
            ]
          : [],
    },
    pendingQuestion: { kind: question },
  });
}

const withBooking = base({
  bookings: [
    {
      ref: "BK-7F3K2Q",
      date: TOMORROW,
      time: "11:00",
      services: ["haircut"],
      employee: "muna",
      bundleId: "b1",
      bookingGroupId: "v1",
    },
  ],
});

/** Two upcoming appointments, with "which one?" already asked. */
const whichBooking = base({
  bookings: [
    { ref: "BK-7F3K2Q", date: TOMORROW, time: "11:00", services: ["haircut"],
      employee: "muna", bundleId: "b1", bookingGroupId: "v1" },
    { ref: "BK-9M2P4X", date: TOMORROW, time: "14:00", services: ["manicure"],
      employee: "layan", bundleId: "b2", bookingGroupId: "v2" },
  ],
  pendingQuestion: { kind: "which_booking", refs: ["BK-7F3K2Q", "BK-9M2P4X"] },
});

export const INTENT_CASES: IntentCase[] = [
  // ── starting a visit ──────────────────────────────────────────────
  { id: "T01", locale: "ar", message: "بدي موعد قص شعر بكرا", state: base(),
    expect: [{ kind: "new_visit", services: ["haircut"], date: TOMORROW }] },
  { id: "T02", locale: "en", message: "I'd like a haircut tomorrow", state: base(),
    expect: [{ kind: "new_visit", services: ["haircut"], date: TOMORROW }] },
  { id: "T03", locale: "ar", message: "بدي احجز", state: base(),
    expect: [{ kind: "new_visit", services: [] }] },
  { id: "T04", locale: "en", message: "can I book an appointment?", state: base(),
    expect: [{ kind: "new_visit", services: [] }] },
  { id: "T05", locale: "ar", message: "صبغة وقص", state: base(),
    expect: [{ kind: "new_visit", services: ["color", "haircut"] }] },
  { id: "T06", locale: "ar", message: "بدي مانيكير الأحد", state: base(),
    expect: [{ kind: "new_visit", services: ["manicure"], date: "2026-08-02" }] },
  { id: "T07", locale: "ar", message: "بدي صبغة مع منى الخميس", state: base(),
    expect: [{ kind: "new_visit", services: ["color"], date: "2026-08-06" }] },
  { id: "T08", locale: "en", message: "keratin treatment next Saturday please", state: base(),
    expect: [{ kind: "new_visit", services: ["keratin"], date: "2026-08-08" }] },
  { id: "T09", locale: "ar", message: "تنظيف بشرة اليوم", state: base(),
    expect: [{ kind: "new_visit", services: ["facial"], date: TODAY }] },
  { id: "T10", locale: "en", message: "blow dry", state: base(),
    expect: [{ kind: "new_visit", services: ["blowdry"] }] },
  // Numeric dates are day/month in Jordan — reading 5/8 as 8 May would book
  // the wrong month, or silently fall out of range.
  { id: "T10a", locale: "ar", message: "بدي قص شعر 5/8", state: base(),
    expect: [{ kind: "new_visit", services: ["haircut"], date: "2026-08-05" }] },
  { id: "T10b", locale: "en", message: "haircut on 3/9", state: base(),
    expect: [{ kind: "new_visit", services: ["haircut"], date: "2026-09-03" }] },
  { id: "T10c", locale: "ar", message: "مانيكير 12/8", state: base(),
    expect: [{ kind: "new_visit", services: ["manicure"], date: "2026-08-12" }] },
  { id: "T10d", locale: "ar", message: "بدي موعد بعد بكرا", state: base(),
    expect: [{ kind: "new_visit", services: [], date: "2026-08-03" }] },
  { id: "T10e", locale: "en", message: "a facial on the 10th", state: base(),
    expect: [{ kind: "new_visit", services: ["facial"], date: "2026-08-10" }] },

  // ── answering the gathering questions ─────────────────────────────
  { id: "T11", locale: "ar", message: "بكرا", state: gathering("need_date"),
    expect: [{ kind: "new_visit", date: TOMORROW }] },
  { id: "T12", locale: "en", message: "Monday works", state: gathering("need_date"),
    expect: [{ kind: "new_visit", date: "2026-08-03" }] },
  { id: "T13", locale: "ar", message: "قص شعر", state: gathering("need_services"),
    expect: [{ kind: "new_visit", services: ["haircut"] }] },
  { id: "T14", locale: "en", message: "a manicure please", state: gathering("need_services"),
    expect: [{ kind: "new_visit", services: ["manicure"] }] },

  // ── choosing an offered slot ──────────────────────────────────────
  { id: "T15", locale: "ar", message: "11", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "11:00" }] },
  { id: "T16", locale: "en", message: "11 works", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "11:00" }] },
  { id: "T17", locale: "ar", message: "الساعة ١١", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "11:00" }] },
  { id: "T18", locale: "ar", message: "تمام ١ بعد الضهر", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "13:00" }] },
  { id: "T19", locale: "en", message: "the second one", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "13:00" }] },
  { id: "T20", locale: "ar", message: "١١ مع هبة", state: awaiting(["11:00"], "hiba"),
    expect: [{ kind: "choose_slot", time: "11:00", employee: "هبة" }] },
  // Observed mislabelled as an empty modify_visit in production, 2026-07-31.
  { id: "T20a", locale: "ar", message: "منى الساعة 2", state: awaiting(["14:00", "15:30"]),
    expect: [{ kind: "choose_slot", time: "14:00", employee: "منى" }] },
  { id: "T20b", locale: "en", message: "2:30 with Hiba", state: awaiting(["14:30"], "hiba"),
    expect: [{ kind: "choose_slot", time: "14:30", employee: "Hiba" }] },
  { id: "T21", locale: "en", message: "book 13:00", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "13:00" }] },
  { id: "T21a", locale: "en", message: "1pm please", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "13:00" }] },
  { id: "T21b", locale: "en", message: "11:00 AM works", state: awaiting(["11:00", "13:00"]),
    expect: [{ kind: "choose_slot", time: "11:00" }] },
  { id: "T21c", locale: "en", message: "2:30 in the afternoon", state: awaiting(["14:30", "15:00"]),
    expect: [{ kind: "choose_slot", time: "14:30" }] },
  { id: "T21d", locale: "ar", message: "الساعة ٤ العصر", state: awaiting(["16:00", "17:00"]),
    expect: [{ kind: "choose_slot", time: "16:00" }] },
  { id: "T21e", locale: "ar", message: "٢ ونص", state: awaiting(["14:30", "15:00"]),
    expect: [{ kind: "choose_slot", time: "14:30" }] },

  // ── rejecting the offer ───────────────────────────────────────────
  { id: "T22", locale: "ar", message: "في شي أبكر؟", state: awaiting(),
    expect: [{ kind: "other_times", hint: "earlier" }] },
  { id: "T23", locale: "en", message: "anything later?", state: awaiting(),
    expect: [{ kind: "other_times", hint: "later" }] },
  { id: "T24", locale: "ar", message: "ما بناسبني، يوم تاني", state: awaiting(),
    expect: [{ kind: "other_times", hint: "another_day" }] },
  { id: "T25", locale: "en", message: "none of those work", state: awaiting(),
    expect: [{ kind: "other_times" }] },

  // ── modifying an open visit ───────────────────────────────────────
  { id: "T26", locale: "ar", message: "وكمان بدي مانيكير", state: awaiting(),
    expect: [{ kind: "modify_visit", add: ["manicure"] }] },
  { id: "T27", locale: "en", message: "actually make it Monday instead", state: awaiting(),
    expect: [{ kind: "modify_visit", new_date: "2026-08-03" }] },
  { id: "T28", locale: "ar", message: "خلص ما بدي المانيكير", state: awaiting(),
    expect: [{ kind: "modify_visit", remove: ["manicure"] }] },
  { id: "T29", locale: "ar", message: "بدي منى تعملها", state: awaiting(),
    expect: [{ kind: "modify_visit" }] },

  // ── two requests in one message ───────────────────────────────────
  { id: "T30", locale: "ar", message: "11 وكمان بدي مانيكير", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "11:00" }, { kind: "modify_visit", add: ["manicure"] }] },
  { id: "T31", locale: "en", message: "13:00 please, and can you add a facial?", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "13:00" }, { kind: "modify_visit", add: ["facial"] }] },

  // ── cancelling ────────────────────────────────────────────────────
  { id: "T32", locale: "ar", message: "بدي ألغي الموعد", state: withBooking,
    expect: [{ kind: "cancel" }] },
  { id: "T33", locale: "en", message: "cancel BK-7F3K2Q", state: withBooking,
    expect: [{ kind: "cancel", ref: "BK-7F3K2Q" }] },
  { id: "T34", locale: "ar", message: "ألغي كل شي هداك اليوم", state: withBooking,
    expect: [{ kind: "cancel", scope: "visit" }] },

  // Reported in testing 2026-08-01: "which one?" looped forever because the
  // answer had nothing to resolve against.
  { id: "T34g", locale: "en", message: "cancel all of them", state: withBooking,
    expect: [{ kind: "cancel", scope: "all" }] },
  { id: "T34h", locale: "ar", message: "ألغي كلهم", state: withBooking,
    expect: [{ kind: "cancel", scope: "all" }] },
  { id: "T34i", locale: "ar", message: "الأول", state: whichBooking,
    expect: [{ kind: "cancel", ref: "BK-7F3K2Q" }] },
  { id: "T34j", locale: "en", message: "the first one", state: whichBooking,
    expect: [{ kind: "cancel", ref: "BK-7F3K2Q" }] },
  { id: "T34k", locale: "en", message: "the manicure one", state: whichBooking,
    expect: [{ kind: "cancel", ref: "BK-9M2P4X" }] },

  // ── asking what they have booked ──────────────────────────────────
  // Reported in testing 2026-08-01: these were answered by asking the
  // customer for a reference code, which they should never need.
  { id: "T34a", locale: "ar", message: "شو حجوزاتي؟", state: withBooking,
    expect: [{ kind: "list_bookings" }] },
  { id: "T34b", locale: "en", message: "what appointments do I have?", state: withBooking,
    expect: [{ kind: "list_bookings" }] },
  { id: "T34c", locale: "ar", message: "متى موعدي؟", state: withBooking,
    expect: [{ kind: "list_bookings" }] },
  { id: "T34d", locale: "en", message: "do I have anything booked?", state: base(),
    expect: [{ kind: "list_bookings" }] },
  { id: "T34e", locale: "ar", message: "شو الحجوزات القديمة تبعي؟", state: withBooking,
    expect: [{ kind: "list_bookings", scope: "past" }] },
  { id: "T34f", locale: "en", message: "show me all my bookings, past and upcoming", state: withBooking,
    expect: [{ kind: "list_bookings", scope: "all" }] },

  // ── confirm / deny only when something is pending ─────────────────
  {
    id: "T35", locale: "ar", message: "اه",
    state: base({ pendingQuestion: { kind: "cancel_confirm", refs: ["BK-7F3K2Q"] } }),
    expect: [{ kind: "confirm" }],
  },
  {
    id: "T36", locale: "en", message: "yes go ahead",
    state: base({ pendingQuestion: { kind: "cancel_confirm", refs: ["BK-7F3K2Q"] } }),
    expect: [{ kind: "confirm" }],
  },
  {
    id: "T37", locale: "ar", message: "لأ خليها زي ما هي",
    state: base({ pendingQuestion: { kind: "cancel_confirm", refs: ["BK-7F3K2Q"] } }),
    expect: [{ kind: "deny" }],
  },
  { id: "T38", locale: "ar", message: "اه", state: withBooking, expect: [{ kind: "chitchat" }] },
  { id: "T39", locale: "en", message: "yes", state: base(), expect: [{ kind: "chitchat" }] },

  // ── questions, not availability ───────────────────────────────────
  { id: "T40", locale: "ar", message: "شو أسعاركم؟", state: base(), expect: [{ kind: "question" }] },
  { id: "T41", locale: "en", message: "what time do you close?", state: base(), expect: [{ kind: "question" }] },
  { id: "T42", locale: "ar", message: "وين موقعكم؟", state: base(), expect: [{ kind: "question" }] },
  { id: "T43", locale: "en", message: "how long does keratin take?", state: base(), expect: [{ kind: "question" }] },
  { id: "T44", locale: "ar", message: "بتشتغلوا الجمعة؟", state: base(), expect: [{ kind: "question" }] },

  // ── chitchat ──────────────────────────────────────────────────────
  { id: "T45", locale: "ar", message: "مرحبا", state: base(), expect: [{ kind: "chitchat" }] },
  { id: "T46", locale: "en", message: "hi there", state: base(), expect: [{ kind: "chitchat" }] },
  { id: "T47", locale: "ar", message: "شكرا كتير 🌸", state: base(), expect: [{ kind: "chitchat" }] },
  { id: "T48", locale: "en", message: "thanks!", state: awaiting(), expect: [{ kind: "chitchat" }] },
  // Reported 2026-08-01: a hello after a goodbye was answered as a goodbye.
  // All of these stay one kind — the renderer sees the words and replies.
  { id: "T48a", locale: "ar", message: "مع السلامة", state: base(), expect: [{ kind: "chitchat" }] },
  { id: "T48b", locale: "en", message: "bye, thanks", state: base(), expect: [{ kind: "chitchat" }] },
  { id: "T48c", locale: "ar", message: "يعطيك العافية", state: base(), expect: [{ kind: "chitchat" }] },

  // ── unclear ───────────────────────────────────────────────────────
  { id: "T49", locale: "en", message: "asdkjhasd", state: base(), expect: [{ kind: "unclear" }] },
  { id: "T50", locale: "ar", message: "؟؟؟", state: awaiting(), expect: [{ kind: "unclear" }] },
  { id: "T51", locale: "en", message: "the usual", state: base(), expect: [{ kind: "unclear" }] },

  // ── traps: things that look like other kinds ──────────────────────
  { id: "T52", locale: "en", message: "is 11 free tomorrow?", state: base(),
    expect: [{ kind: "new_visit" }] },
  { id: "T53", locale: "ar", message: "11", state: base(),
    expect: [{ kind: "unclear" }] },
  { id: "T54", locale: "en", message: "15:00", state: awaiting(),
    expect: [{ kind: "choose_slot", time: "15:00" }] },
  { id: "T55", locale: "ar", message: "بدي أأجل موعدي", state: withBooking,
    expect: [{ kind: "cancel" }] },
  { id: "T56", locale: "en", message: "who does colour?", state: base(),
    expect: [{ kind: "question" }] },
  { id: "T57", locale: "ar", message: "بدي موعد يوم الجمعة", state: base(),
    expect: [{ kind: "new_visit", date: "2026-08-07" }] },
  { id: "T58", locale: "en", message: "cancel that, I want Monday instead", state: awaiting(),
    expect: [{ kind: "modify_visit", new_date: "2026-08-03" }] },
];
