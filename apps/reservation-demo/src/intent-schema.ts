/**
 * The translator's zod schema — the entire interface between the LLM and
 * the system (ADR-004 Layer 1).
 *
 * The service enum is GENERATED from client config, never hand-written: that
 * is what permanently kills the duplicated service list the old tools carried.
 * Every variant and field describes when it applies, because the schema is
 * compiled into the request and is the model's primary instruction.
 */

import { z } from "zod/v4";
import type { Intent } from "@bani/orchestrator";
import { SERVICE_CODES } from "./config.js";

const serviceCode = z.enum(SERVICE_CODES);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe(
    "The day the customer means, resolved to an absolute Amman-local date, YYYY-MM-DD. " +
      "Resolve 'tomorrow', 'بكرا', 'بعد بكرا', 'Saturday', 'next week' against TODAY in the " +
      "state block. " +
      // Jordan writes dates little-endian. Reading 1/8 as 8 January is the
      // single most likely way to book someone into the wrong month.
      "NUMERIC DATES ARE DAY/MONTH, never month/day: '1/8' and '1-8' are 1 August, " +
      "'3/9' is 3 September. A two-digit year comes last ('1/8/26'). " +
      "The salon books at most 60 days ahead, so always choose the reading that falls in " +
      "the near future: in August, '5/9' is 5 September of this year, not 9 May. " +
      "If both readings are plausible and in range, emit `unclear` rather than guessing. " +
      "Omit entirely if they did not name a day — never guess one.",
  );

const employeeRaw = z
  .string()
  .describe(
    "The employee EXACTLY as the customer wrote it, in their own words and script " +
      "('سارة', 'muna', 'the one who did my color'). Do not map it to a code or correct " +
      "the spelling — the system resolves it.",
  );

const employeePref = z
  .object({ service: serviceCode, employee: employeeRaw })
  .describe("One 'I want X to do Y' preference, e.g. Muna for the colour.");

const newVisit = z
  .object({
    kind: z.literal("new_visit"),
    date: isoDate.optional(),
    services: z
      .array(serviceCode)
      .describe(
        "Every service the customer asked for in this message. Empty array if they want " +
          "an appointment but have not said what for.",
      ),
    prefs: z.array(employeePref).optional(),
  })
  .describe(
    "The customer is starting a NEW appointment request. Use this when OPEN VISIT is none, " +
      "or when they ask for a different day than the open visit.",
  );

const modifyVisit = z
  .object({
    kind: z.literal("modify_visit"),
    add: z.array(serviceCode).optional().describe("Services to ADD to the open visit."),
    remove: z.array(serviceCode).optional().describe("Services to DROP from the open visit."),
    new_date: isoDate.optional().describe("Move the open visit to this day."),
    prefs: z.array(employeePref).optional(),
  })
  .describe(
    "The customer is changing the visit already in progress — adding or dropping a service, " +
      "moving it to another day, or naming an employee. Requires an OPEN VISIT.",
  );

const chooseSlot = z
  .object({
    kind: z.literal("choose_slot"),
    group: z.string().optional().describe("The group key from the state block, if it is clear which one."),
    employee: employeeRaw.optional(),
    time: z
      .string()
      .describe(
        "The time they picked, ALWAYS as HH:MM in 24-hour form. Convert whatever they wrote: " +
          "'2:30pm' and '2:30 in the afternoon' are both 14:30; '5' or 'خمسة' in the afternoon " +
          "is 17:00; 'الساعة ٤ العصر' is 16:00. The salon opens 10:00–20:00, so a bare hour " +
          "that would fall outside that is the afternoon reading ('2' is 14:00, not 02:00). " +
          "Prefer a time that appears under AWAITING CHOICE, but if they clearly named a " +
          "different one, report what they said — the system checks it.",
      ),
  })
  .describe(
    "The customer is picking one of the times just offered. A bare number, 'the second one', " +
      "'الساعة ١١' or 'تمام ١١ مع منى' while a group is AWAITING CHOICE = choose_slot.",
  );

const otherTimes = z
  .object({
    kind: z.literal("other_times"),
    group: z.string().optional(),
    employee: employeeRaw.optional(),
    hint: z
      .enum(["earlier", "later", "another_day"])
      .optional()
      .describe("Which direction they want to move: earlier, later, or a different day."),
  })
  .describe(
    "The customer does not want any of the offered times and wants different ones — " +
      "'في شي أبكر؟', 'anything later', 'ما بناسبني، يوم تاني'.",
  );

const listBookings = z
  .object({
    kind: z.literal("list_bookings"),
    scope: z
      .enum(["upcoming", "past", "all"])
      .optional()
      .describe(
        "'upcoming' (the default) for what they still have booked, 'past' for appointments " +
          "they have already had, 'all' when they ask for both or say 'all my bookings'.",
      ),
  })
  .describe(
    "They are ASKING WHAT THEY HAVE BOOKED — 'شو حجوزاتي؟', 'what appointments do I have?', " +
      "'متى موعدي؟', 'when is my appointment', 'هل عندي حجز؟', 'did I book anything?'. " +
      "The system looks it up; NEVER ask them for a booking reference, and never treat this " +
      "as a cancel. Use cancel only when they actually want to undo something.",
  );

const cancel = z
  .object({
    kind: z.literal("cancel"),
    ref: z
      .string()
      .optional()
      .describe("The booking reference if they gave one, e.g. BK-7F3K2Q. Omit if they did not."),
    scope: z
      .enum(["visit", "booking", "all"])
      .optional()
      .describe(
        "'all' when they want EVERY upcoming appointment cancelled ('cancel all of them', " +
          "'ألغي كلهم', 'الغي كل حجوزاتي'); 'visit' for everything on one day; 'booking' for " +
          "just one.",
      ),
  })
  .describe(
    "The customer wants to cancel an existing appointment. When PENDING QUESTION is " +
      "'which of the numbered appointments', their answer selects one — resolve an ordinal " +
      "('the first one', 'الأول', 'رقم ٢') or a service name against the numbered UPCOMING " +
      "BOOKINGS list and emit `ref` for that booking.",
  );

const confirm = z
  .object({ kind: z.literal("confirm") })
  .describe(
    "A plain yes/agreement answering the PENDING QUESTION — 'اه', 'تمام', 'yes', 'go ahead'. " +
      "Only use this when PENDING QUESTION is not none.",
  );

const deny = z
  .object({ kind: z.literal("deny") })
  .describe(
    "A plain no/refusal answering the PENDING QUESTION — 'لأ', 'no', 'خليها زي ما هي'. " +
      "Only use this when PENDING QUESTION is not none.",
  );

const question = z
  .object({
    kind: z.literal("question"),
    text: z.string().describe("The question, restated plainly."),
  })
  .describe(
    "Anything about the salon that is not a booking — prices, products, location, policy, " +
      "what a service involves. The system DECLINES these and points the customer at the " +
      "salon, so label them here rather than guessing an answer. " +
      "NOT about whether a specific time is free (that is other_times or new_visit), and NOT " +
      "'what have I booked' (that is list_bookings).",
  );

const chitchat = z
  .object({ kind: z.literal("chitchat") })
  .describe("Greetings, thanks, small talk — nothing to do.");

const unclear = z
  .object({ kind: z.literal("unclear") })
  .describe(
    "Use whenever you are not sure. Guessing produces a wrong booking; 'unclear' just asks " +
      "the customer to repeat themselves.",
  );

const intent = z.discriminatedUnion("kind", [
  newVisit,
  modifyVisit,
  chooseSlot,
  otherTimes,
  listBookings,
  cancel,
  confirm,
  deny,
  question,
  chitchat,
  unclear,
]);

export const IntentEnvelope = z.object({
  intents: z
    .array(intent)
    .min(1)
    .max(3)
    .describe(
      "One label per distinct request in the message, in the order the customer said them. " +
        "'11 with Sara, and can I add a manicure?' is two: choose_slot then modify_visit.",
    ),
});

/**
 * The zod inference and the orchestrator's hand-written union describe the
 * same values; this cast is where the two meet, and the compiler checks the
 * result is assignable to `Intent[]`.
 */
export type ParsedIntents = { intents: Intent[] };

export const INTENT_SCHEMA = IntentEnvelope as unknown as z.ZodType<ParsedIntents>;
