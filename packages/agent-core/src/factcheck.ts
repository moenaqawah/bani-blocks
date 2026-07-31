/**
 * The guarantee behind ADR-004 Layer 3.
 *
 * The renderer may only rephrase; it may not add, drop or alter a fact. This
 * module checks that mechanically. Everything it compares — booking refs,
 * times, dates, names — is drawn from the orchestrator's payload, so a
 * misquoted time cannot survive to the customer: on failure the caller sends
 * the plain template instead.
 */

import { WEEKDAY_AR, WEEKDAY_EN } from "@bani/shared";

const REF_RE = /\bBK-[A-Z0-9]{6}\b/gi;

/** A clock time, with an optional Latin meridiem: "14:30", "2:30 PM", "9:00am". */
const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\s*([ap])\.?m\.?/gi;
const BARE_TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

/** Facts the renderer is allowed to mention, gathered from the reply payload. */
export interface FactSet {
  refs: string[];
  times: string[];
  /**
   * Resolved day labels ("Saturday 1 August", "السبت 1 آب"). Guarded like refs
   * and times: naming a different weekday sends someone on the wrong day, which
   * is the same class of harm as a wrong time and needs the same guard.
   */
  days: string[];
  /** Names and service labels that must survive rephrasing, in both locales. */
  required: string[];
}

export interface FactCheckResult {
  /** False only when something was INVENTED. Omissions do not reject a reply. */
  ok: boolean;
  /** Inventions — these reject the reply. Logged, never shown to the customer. */
  problems: string[];
  /** Omissions and rewordings — logged so drift stays visible, but allowed. */
  warnings: string[];
}

/**
 * Fold the ways the same name is legitimately written, so a label check
 * fails on a WRONG name rather than on a differently-inflected one.
 *
 * Arabic writes a service into a sentence with the definite article and
 * without diacritics: the catalog says "قص شعر" and a natural reply says
 * "قص الشعر". Rejecting that sends the plain fallback for a reply that was
 * perfectly correct — observed in production 2026-07-31, and the reason this
 * exists. The roster resolver is already this lenient about how customers
 * spell a name; the renderer deserves the same latitude.
 */
export function normalizeLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰ]/g, "") // harakat
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/(^|\s)ال/g, "$1") // definite article, per word
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Arabic-Indic and extended Arabic-Indic digits fold to ASCII so a reply
 * written as "الساعة ١١:٠٠" still matches the payload's "11:00".
 */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * The check guards against the system asserting something that is not true.
 *
 * Only INVENTION rejects a reply: a booking reference or a time that appears
 * in the message but not in the payload is the system telling a customer
 * something false, and it is the failure this whole layer exists to prevent —
 * they hold a plausible code, or turn up at an hour nobody offered.
 *
 * OMISSION is deliberately allowed. A renderer that summarises "I have times
 * from 1:30 onwards" instead of listing ten, or writes a service name in a
 * different inflection, has said nothing untrue. Rejecting those shipped the
 * plain fallback for replies that were perfectly good (production, 2026-07-31).
 * They are still reported as warnings so drift stays visible in the logs.
 */
export function checkFacts(output: string, facts: FactSet): FactCheckResult {
  const text = normalizeDigits(output);
  const problems: string[] = [];
  const warnings: string[] = [];

  const allowedRefs = new Set(facts.refs.map((r) => r.toUpperCase()));
  for (const found of text.match(REF_RE) ?? []) {
    if (!allowedRefs.has(found.toUpperCase())) problems.push(`invented ref ${found}`);
  }

  const allowedTimes = new Set(facts.times.map(padTime));
  for (const { raw, candidates } of findTimes(text)) {
    if (!candidates.some((c) => allowedTimes.has(c))) problems.push(`invented time ${raw}`);
  }

  problems.push(...findInventedDays(output, facts.days));

  for (const ref of facts.refs) {
    if (!text.toUpperCase().includes(ref.toUpperCase())) warnings.push(`dropped ref ${ref}`);
  }

  for (const time of facts.times) {
    if (!containsTime(text, time)) warnings.push(`dropped time ${time}`);
  }

  // Compared leniently — Arabic declines a name without changing which name
  // it is, so this catches a WRONG name, not a differently-written one.
  const normalizedText = normalizeLabel(text);
  for (const value of facts.required) {
    if (value.trim() === "") continue;
    if (!normalizedText.includes(normalizeLabel(value))) warnings.push(`dropped "${value}"`);
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Weekday names the reply mentions that no resolved day contains.
 *
 * The weekday is the load-bearing part of a date — customers read "Saturday",
 * not "the 1st" — and it is the part a model is most likely to get wrong,
 * because the payload gives it a finished label it might paraphrase. Saying
 * Sunday when the booking is Saturday is exactly as harmful as a wrong time.
 *
 * Only weekdays are scanned. Day-of-month and month names ride along inside
 * the same label, and a reply that keeps the weekday but mangles the number is
 * both far less likely and self-evidently odd to the reader.
 */
function findInventedDays(output: string, days: readonly string[]): string[] {
  const allowed = normalizeLabel(days.join(" | "));
  const problems: string[] = [];

  for (const weekday of [...WEEKDAY_EN, ...WEEKDAY_AR]) {
    const token = normalizeLabel(weekday);
    if (!normalizeLabel(output).includes(token)) continue;
    if (allowed.includes(token)) continue;
    problems.push(`invented day ${weekday}`);
  }

  return problems;
}

/**
 * Every clock time in the text, with the 24-hour readings each could mean.
 *
 * The payload is 24-hour, but "14:30" is naturally written "2:30 PM" in
 * English — a correct rendering, not an invention. An explicit meridiem
 * resolves exactly; a bare "2:30" is ambiguous, so both readings are allowed.
 * That leniency is safe here: the business opens 10:00–20:00, so the morning
 * reading of an afternoon slot is not a time anyone could be offered anyway,
 * and a genuinely wrong time ("3:30" when only 14:30 was offered) still fails
 * on both readings.
 */
function findTimes(text: string): Array<{ raw: string; candidates: string[] }> {
  const found: Array<{ raw: string; candidates: string[] }> = [];
  const consumed: Array<[number, number]> = [];

  for (const m of text.matchAll(TIME_RE)) {
    const hour = Number(m[1]);
    const minute = m[2]!;
    const pm = m[3]!.toLowerCase() === "p";
    const h24 = pm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
    found.push({ raw: m[0], candidates: [`${String(h24).padStart(2, "0")}:${minute}`] });
    consumed.push([m.index, m.index + m[0].length]);
  }

  for (const m of text.matchAll(BARE_TIME_RE)) {
    // Skip the numeric part of a time already matched with its meridiem.
    if (consumed.some(([start, end]) => m.index >= start && m.index < end)) continue;
    const hour = Number(m[1]);
    const minute = m[2]!;
    const candidates = [`${String(hour).padStart(2, "0")}:${minute}`];
    if (hour < 12) candidates.push(`${String(hour + 12).padStart(2, "0")}:${minute}`);
    found.push({ raw: m[0], candidates });
  }

  return found;
}

/** Accept "09:30", "9:30" and "9:30 AM" as renderings of the same slot. */
function containsTime(text: string, time: string): boolean {
  const padded = padTime(time);
  const unpadded = padded.replace(/^0/, "");
  if (text.includes(padded) || text.includes(unpadded)) return true;

  // The 12-hour rendering of the same slot.
  const [h, m] = padded.split(":");
  const hour = Number(h);
  const twelve = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return new RegExp(`\\b0?${twelve}:${m}\\s*[ap]\\.?m\\.?`, "i").test(text);
}

function padTime(time: string): string {
  const [h = "", m = ""] = time.split(":");
  return `${h.padStart(2, "0")}:${m}`;
}
