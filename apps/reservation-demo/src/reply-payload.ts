/**
 * Resolving the orchestrator's decision into finished, locale-correct values.
 *
 * The rule this file exists to enforce: **code computes every value; the model
 * writes only the sentences between them.** Nothing here decides what to say —
 * it turns codes and ISO dates into the exact strings a customer should read,
 * and records each one as a fact the renderer must reproduce verbatim.
 *
 * That is why dates are formatted here rather than by the model. Weekday-of-date
 * is a computation, models get it wrong at a low but real rate, and "Tuesday"
 * is not a token the fact check would otherwise validate — so a wrong weekday
 * would reach a customer unguarded. Resolved here, it becomes a checked value.
 *
 * Replaces the previous per-block bilingual template pack: one pass over field
 * names instead of forty hand-written strings per client.
 */

import type { FactSet } from "@bani/agent-core";
import { actOf, type ReplyBlock, type SpeechAct } from "@bani/orchestrator";
import { localToUtc, utcToLocalParts } from "@bani/shared";
import { BUSINESS } from "./config.js";
import { employeeName, serviceNames, type Locale } from "./salon.js";

/** One decision, with every value already in the customer's language. */
export interface ResolvedBlock {
  verdict: ReplyBlock["kind"];
  act: SpeechAct;
  [field: string]: unknown;
}

export interface ResolvedReply {
  blocks: ResolvedBlock[];
  facts: FactSet;
  /** Sent verbatim when the renderer is unavailable. Generated, not written. */
  fallbackText: string;
}

export function resolveReply(blocks: readonly ReplyBlock[], locale: Locale): ResolvedReply {
  const facts: FactSet = { refs: [], times: [], days: [], required: [] };
  const resolved = blocks.map((block) => resolveBlock(block, locale, facts));

  return { blocks: resolved, facts, fallbackText: renderFallback(resolved, locale) };
}

// ─── field resolution ───────────────────────────────────────────────────

function resolveBlock(block: ReplyBlock, locale: Locale, facts: FactSet): ResolvedBlock {
  const out: ResolvedBlock = { verdict: block.kind, act: actOf(block) };

  for (const [field, value] of Object.entries(block)) {
    if (field === "kind" || value === undefined || value === null) continue;
    const [key, resolvedValue] = resolveField(field, value, locale, facts);
    out[key] = resolvedValue;
  }

  // Business facts the customer will read, and must therefore be checked.
  if (block.kind === "outside_hours") {
    out.closingTime = keepTime(facts, `${String(BUSINESS.closeHour).padStart(2, "0")}:00`);
  }
  if (block.kind === "too_soon") out.noticeMinutes = BUSINESS.leadTimeMinutes;

  return out;
}

/**
 * Resolve one field by name. The set of field names across `ReplyBlock` is
 * small and closed, so this stays a short, explicit list rather than magic.
 */
function resolveField(
  field: string,
  value: unknown,
  locale: Locale,
  facts: FactSet,
): [string, unknown] {
  switch (field) {
    case "ref":
      return ["ref", keepRef(facts, value as string)];

    case "time":
    case "endTime":
      return [field, keepTime(facts, value as string)];

    case "date":
      return ["day", keepDay(facts, formatDay(value as string, locale))];

    case "nextOpenDate":
      return ["nextOpenDay", keepDay(facts, formatDay(value as string, locale))];

    case "employee":
      return ["employee", keepLabel(facts, employeeName(value as string, locale))];

    case "capableInstead":
      return [
        "employeesWhoCan",
        (value as string[]).map((c) => keepLabel(facts, employeeName(c, locale))),
      ];

    case "service":
      return ["services", serviceNames([value as string], locale).map((n) => keepLabel(facts, n))];

    case "services":
      return ["services", serviceNames(value as string[], locale).map((n) => keepLabel(facts, n))];

    case "offers":
      return ["options", resolveOffers(value as Offers, locale, facts)];

    case "bookings":
      return ["bookings", (value as RawBooking[]).map((b) => resolveBooking(b, locale, facts))];

    case "open":
    case "incoming":
      return [field, resolveVisitSummary(value as VisitSummary, locale, facts)];

    // Structural fields the customer never reads — dropped so the model is
    // not tempted to mention a group key or an internal reason code.
    case "group":
    case "reason":
      return [`_${field}`, value];

    default:
      return [field, value];
  }
}

type Offers = Array<{ employee: string; times: string[] }>;
type RawBooking = { ref: string; date: string; time: string; services: string[]; employee: string };
type VisitSummary = { date?: string | null; services: string[] };

function resolveOffers(offers: Offers, locale: Locale, facts: FactSet) {
  return offers.map((offer) => ({
    employee: keepLabel(facts, employeeName(offer.employee, locale)),
    times: offer.times.map((t) => keepTime(facts, t)),
  }));
}

function resolveBooking(booking: RawBooking, locale: Locale, facts: FactSet) {
  return {
    ref: keepRef(facts, booking.ref),
    day: keepDay(facts, formatDay(booking.date, locale)),
    time: keepTime(facts, booking.time),
    employee: keepLabel(facts, employeeName(booking.employee, locale)),
    services: serviceNames(booking.services, locale).map((n) => keepLabel(facts, n)),
  };
}

function resolveVisitSummary(summary: VisitSummary, locale: Locale, facts: FactSet) {
  return {
    ...(summary.date ? { day: keepDay(facts, formatDay(summary.date, locale)) } : {}),
    services: serviceNames(summary.services, locale).map((n) => keepLabel(facts, n)),
  };
}

// ─── fact recording ─────────────────────────────────────────────────────

function keepRef(facts: FactSet, ref: string): string {
  if (ref !== "" && !facts.refs.includes(ref)) facts.refs.push(ref);
  return ref;
}

function keepTime(facts: FactSet, time: string): string {
  if (!facts.times.includes(time)) facts.times.push(time);
  return time;
}

function keepLabel(facts: FactSet, label: string): string {
  if (label.trim() !== "" && !facts.required.includes(label)) facts.required.push(label);
  return label;
}

/**
 * A resolved day is recorded twice: in `days`, where a WRONG weekday rejects
 * the reply, and in `required`, where omitting it only warns. Rephrasing
 * "Saturday 1 August" as "tomorrow" is fine; calling it Sunday is not.
 */
function keepDay(facts: FactSet, label: string): string {
  if (label.trim() !== "" && !facts.days.includes(label)) facts.days.push(label);
  return keepLabel(facts, label);
}

// ─── date formatting ────────────────────────────────────────────────────

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Levantine month names — the salon says آب, not أغسطس. */
const MONTHS_AR = [
  "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
  "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
];

export function formatDay(date: string, locale: Locale): string {
  const parts = utcToLocalParts(localToUtc(`${date}T12:00`));
  const day = Number(date.slice(8, 10));
  const month = Number(date.slice(5, 7)) - 1;
  return locale === "ar"
    ? `${parts.weekdayAr} ${day} ${MONTHS_AR[month]}`
    : `${parts.weekdayEn} ${day} ${MONTHS_EN[month]}`;
}

// ─── fallback ───────────────────────────────────────────────────────────

/**
 * Short openers for the verdicts most likely to be seen during an outage.
 *
 * This is the only hand-written copy left, and it is deliberately bounded:
 * it exists so a rate-limited reply still reads like a sentence rather than a
 * field dump. Anything not listed falls back to its verdict name, which is
 * ugly but never wrong. Do not grow this into a template pack.
 */
const VERDICT_PREFIX: Partial<Record<ReplyBlock["kind"], { ar: string; en: string }>> = {
  booked: { ar: "تم الحجز ✅", en: "Booked ✅" },
  cancelled: { ar: "تم الإلغاء ✅", en: "Cancelled ✅" },
  ask_cancel_confirm: { ar: "بتأكد إلغاء", en: "Confirm cancelling" },
  offer_slots: { ar: "الأوقات المتاحة", en: "Available times" },
  slot_not_offered: { ar: "هاد الوقت مش متاح — المتاح", en: "Not available — these are" },
  slot_taken: { ar: "الوقت انحجز قبل شوي", en: "That time was just taken" },
  no_slots: { ar: "ما في وقت متاح", en: "No times available" },
  closed_day: { ar: "الصالون مسكّر", en: "We're closed" },
  cannot_answer: {
    ar: "بس بقدر أساعدك بالمواعيد — اتصلي بالصالون لهالسؤال",
    en: "I can only help with appointments — please call the salon for that",
  },
  no_bookings: { ar: "ما عندك مواعيد", en: "No appointments" },
  past_bookings: { ar: "مواعيدك السابقة", en: "Your past appointments" },
  chitchat: { ar: "تكرم عينك", en: "Happy to help" },
  greeting: { ar: "أهلاً وسهلاً في صالون ليالي", en: "Welcome to Layali Salon" },
  unclear: { ar: "ما فهمت عليكِ، ممكن تعيدي", en: "Sorry, could you say that again" },
  visit_complete: { ar: "تم كل شي، بنستناكِ", en: "All set — see you then" },
  calendar_error: { ar: "في خلل تقني، جربي بعد شوي", en: "Technical problem — please try again shortly" },
  customer_busy: { ar: "عندك حجز بنفس الوقت", en: "You already have an appointment then" },
  too_soon: { ar: "لازم وقت أطول قبل الموعد", en: "That's too soon to book" },
  cancel_aborted: { ar: "تمام، ما لغينا إشي", en: "No problem — nothing was cancelled" },
  nothing_to_cancel: { ar: "ما عندك مواعيد للإلغاء", en: "You have no appointments to cancel" },
  draft_replaced: { ar: "تمام، تركنا القديم", en: "Sure — I've set that one aside" },
  no_capable_employee: { ar: "ما عنا حدا بيعمل هالخدمة", en: "Nobody on the team does that service" },
  ask_date: { ar: "أي يوم بناسبك؟", en: "Which day suits you?" },
  ask_services: { ar: "شو الخدمة اللي بدك ياها؟", en: "Which service would you like?" },
  current_bookings: { ar: "حجوزاتك الجاية", en: "Your upcoming appointments" },
  which_booking: { ar: "أي حجز بتقصد", en: "Which appointment do you mean" },
};

/** Rendering hints, not values a customer needs to read. */
const STRUCTURAL_FIELDS = new Set(["more", "remainingGroups"]);

/**
 * The plain reply sent when the model is unavailable or its output fails the
 * post-check. Generated from resolved values in field order — correct and
 * unlovely, with no per-block copy to maintain.
 */
function renderFallback(blocks: readonly ResolvedBlock[], locale: Locale): string {
  return blocks.map((block) => fallbackLine(block, locale)).filter(Boolean).join("\n\n");
}

function fallbackLine(block: ResolvedBlock, locale: Locale): string {
  const prefix = VERDICT_PREFIX[block.verdict]?.[locale] ?? block.verdict.replace(/_/g, " ");
  const parts: string[] = [];

  for (const [field, value] of Object.entries(block)) {
    if (field === "verdict" || field === "act" || field.startsWith("_")) continue;
    if (STRUCTURAL_FIELDS.has(field)) continue;
    const rendered = fallbackValue(value);
    if (rendered) parts.push(rendered);
  }

  const line = parts.length > 0 ? `${prefix} · ${parts.join(" · ")}` : prefix;

  // Even the emergency reply must not deliver a question as a statement.
  return block.act === "question" ? `${line}${locale === "ar" ? " ؟" : " ?"}` : line;
}

function fallbackValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return "";
  if (Array.isArray(value)) return value.map(fallbackValue).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(fallbackValue).filter(Boolean).join(" ");
  }
  return "";
}
