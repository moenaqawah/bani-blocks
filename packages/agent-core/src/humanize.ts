/**
 * ADR-004 Layer 3 — the renderer.
 *
 * The orchestrator has already decided what to say, and every value in the
 * payload has already been computed in code and resolved into the customer's
 * language. This layer writes the sentences between those values — nothing
 * more. It chooses tone, never content.
 *
 * Two guards stand behind it, and on either failure the plain fallback goes
 * out unchanged so the customer always receives a correct reply:
 *   - the fact post-check: no invented or dropped ref, time or name;
 *   - the speech-act check: a question may not be delivered as a statement,
 *     which is the one distinction facts alone cannot make ("shall I cancel
 *     BK-123?" and "BK-123 is cancelled" carry identical facts).
 */

import { generateText } from "ai";
import { logger } from "@bani/shared";
import { checkFacts, type FactSet } from "./factcheck.js";

/** One decision, with every value already finished and locale-correct. */
export interface RenderableBlock {
  verdict: string;
  act: "done" | "failed" | "question" | "info";
  [field: string]: unknown;
}

export interface HumanizeArgs {
  model: unknown;
  blocks: readonly RenderableBlock[];
  facts: FactSet;
  /** Correct, unlovely text to send if polishing is unsafe. */
  fallbackText: string;
  locale: "ar" | "en";
  /** Client-specific voice guidance — dialect, warmth, forbidden phrasings. */
  stylePrompt: string;
  /** What each verdict means, rendered from the client's catalog. */
  verdictGuide: string;
  /**
   * What the customer actually said — supplied ONLY when the turn carries no
   * facts and nothing happened, i.e. pure conversation.
   *
   * A `chitchat` payload says "nothing to act on" and nothing more, so the
   * renderer had to guess whether it was a hello, a thank-you or a goodbye —
   * and answered a hello as a goodbye (reported 2026-08-01). The fix is not a
   * taxonomy of small talk; it is letting the model see the message and reply
   * like a person. Withheld on every other turn, where the decision is the
   * orchestrator's and the words would only tempt it to re-answer.
   */
  customerSaid?: string;
  /**
   * The customer's name as WhatsApp reports it, if any.
   *
   * Passed for GRAMMATICAL AGREEMENT, not as a fact to state: Arabic inflects
   * the second person by gender, so "بدك" and "بدكِ" are different words and one
   * of them is wrong. Choosing between them from a name is a linguistic
   * judgement — the kind of thing the model does better than a lookup table,
   * and one of the few places it is right to let it decide.
   */
  customerName: string | null;
  /**
   * False on the very first message of a conversation, true thereafter.
   *
   * The renderer sees the payload and nothing else, so without this it cannot
   * tell turn 1 from turn 10 and opens every single message with a welcome.
   * Deliberately a boolean rather than the history itself: the renderer must
   * not be able to paraphrase, contradict, or re-answer what was said before.
   */
  continuing: boolean;
}

export interface HumanizeResult {
  text: string;
  fellBack: boolean;
}

const ACT_RULES = `
Every item has an "act" telling you what kind of thing it is. This is the most
important field — getting it wrong tells the customer something untrue:

- "done"     — it HAS happened. Say so in the past tense. It is real and final.
- "failed"   — it did NOT happen. Never imply success. Say plainly that it did
               not work, then offer whatever next step is included.
- "question" — you are ASKING. Nothing has happened yet, and nothing will until
               they answer. It must read as a question.
- "info"     — you are stating a fact. No action was taken either way.
`.trim();

/**
 * The renderer sees the payload and nothing else — no customer message, no
 * history. It therefore cannot infer which language to answer in, and left to
 * guess it follows the priors in the style prompt. Stating the language is not
 * optional: a reply in the wrong language drops every resolved value, fails the
 * fact check, and ships the fallback. Observed in production 2026-07-31, where
 * every English conversation degraded this way.
 */
const LANGUAGE: Record<"ar" | "en", string> = {
  ar: "Write the message in ARABIC, in natural Jordanian dialect. No English words except the booking reference.",
  en: "Write the message in ENGLISH. No Arabic at all.",
};

const INSTRUCTION = `
Write the WhatsApp message a customer should receive for the items below.

Use the values exactly as given — every time, date, name, service and booking
reference is already correct and already in the customer's language. Copy them
character for character. Do not reformat dates, do not convert digits, do not
translate names, do not add a value that is not there, and never invent
availability. If several items are given, write one natural message covering
all of them in order.

Times are 24-hour: "14:30" means half past two in the afternoon. Write them in
24-hour form exactly as given. If you ever do write a 12-hour time, it must be
the same instant — "14:30" is "2:30 PM", never "2:30 AM".

Reply with the message text only.
`.trim();

const OPENING =
  "This is the customer's FIRST message in this conversation. A brief welcome is appropriate.";

const CONTINUING = [
  "This conversation is ALREADY IN PROGRESS — the customer has messaged before.",
  "Do NOT greet them, do NOT welcome them, do NOT introduce yourself or the salon.",
  "Continue naturally, as the next message in a thread you are already part of.",
].join(" ");

/**
 * How to address this particular customer.
 *
 * WhatsApp profile names are unreliable — nicknames, initials, emoji, a shop
 * name. When the name does not clearly indicate gender the salon's own
 * clientele is the better prior than a coin flip.
 */
function addressing(name: string | null): string {
  const known = name?.trim();
  return [
    known
      ? `The customer's name is "${known}". If it clearly indicates gender, address them with the matching Arabic forms.`
      : "The customer's name is unknown.",
    "If the name is ambiguous, a nickname, or missing, use feminine forms —",
    "most of this salon's customers are women.",
  ].join(" ");
}

/**
 * Small talk stays within the job. The receptionist can be human about a
 * hello or a goodbye, but she is not a general assistant: anything that needs
 * a decision belongs to the orchestrator, and it will arrive as its own turn.
 */
function conversational(said: string): string {
  return [
    `The customer said: "${said}"`,
    "Reply to that, naturally, the way a friendly receptionist would — match a hello with a",
    "hello, a goodbye with a goodbye, a thank-you with a you're-welcome.",
    "Stay inside your job: do not answer questions about the salon, prices, products or policy;",
    "do not mention, offer, confirm or change any appointment or time.",
    "If they want something done, they will say so and the system will handle it — not you.",
  ].join(" ");
}

export async function humanize(args: HumanizeArgs): Promise<HumanizeResult> {
  const fallback: HumanizeResult = { text: args.fallbackText, fellBack: true };
  if (args.blocks.length === 0) return { text: args.fallbackText, fellBack: false };

  let candidate: string;
  try {
    const result = await generateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: args.model as any,
      system: [
        args.stylePrompt,
        ACT_RULES,
        args.verdictGuide,
        INSTRUCTION,
        LANGUAGE[args.locale],
        args.continuing ? CONTINUING : OPENING,
        addressing(args.customerName),
        ...(args.customerSaid ? [conversational(args.customerSaid)] : []),
      ].join("\n\n"),
      prompt: JSON.stringify(args.blocks, null, 2),
      temperature: 0.4,
    });
    candidate = (result.text ?? "").trim();
  } catch (err) {
    // Including rate limits: a plain but correct reply beats no reply.
    logger.warn("humanize failed — sending fallback", { msg: String(err) });
    return fallback;
  }

  if (candidate === "") return fallback;

  const facts = checkFacts(candidate, args.facts);
  const problems = [...facts.problems, ...checkSpeechActs(candidate, args.blocks)];

  if (problems.length > 0) {
    logger.warn("humanize output rejected — sending fallback", { msg: problems.join("; ") });
    return fallback;
  }

  // Omissions and rewordings ship, but stay visible: a rise here is how a
  // drifting prompt or a weaker model shows up before anyone complains.
  if (facts.warnings.length > 0) {
    logger.info("humanize output accepted with omissions", { msg: facts.warnings.join("; ") });
  }

  return { text: candidate, fellBack: false };
}

/**
 * Guards the one distinction the fact check cannot make: proposing an action
 * on an existing appointment versus reporting that it happened. "Shall I
 * cancel BK-123 on Monday at 11:00?" and "BK-123 on Monday at 11:00 is
 * cancelled" carry identical facts, and only one of them is true.
 *
 * Scoped deliberately to questions ABOUT AN EXISTING BOOKING. Applying it to
 * every question rejected good writing — "Let me know which time works for
 * you" is a perfectly ordinary way to ask, and demanding a literal question
 * mark sent the plain fallback instead (production, 2026-07-31). Being
 * declarative about a list of free times misleads nobody; being declarative
 * about a cancellation does.
 */
export function checkSpeechActs(
  output: string,
  blocks: readonly RenderableBlock[],
): string[] {
  const aboutABooking = blocks.filter(
    (b) => b.act === "question" && (b.ref !== undefined || b.bookings !== undefined),
  );
  if (aboutABooking.length === 0 || /[?؟]/.test(output)) return [];

  return [
    `stated an appointment change as done when it was only proposed (${aboutABooking
      .map((b) => b.verdict)
      .join(", ")})`,
  ];
}
