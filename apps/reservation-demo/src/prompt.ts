import { BUSINESS, SERVICES } from "./config.js";
import { formatLocalHuman } from "@bani/shared";
import promptRaw from "./prompt.txt";

/**
 * Load and interpolate the system prompt.
 *
 * The prompt itself lives in `prompt.txt` — plain markdown, editable
 * without touching TypeScript. This file only handles variable
 * interpolation: the time, services list, locale directive, and
 * business config values.
 */
export function buildSystemPrompt(now: Date, currentMessageLocale?: "ar" | "en"): string {
  const nowLocal = formatLocalHuman(now);
  const parts = nowLocal.split(", ");
  const weekdayEn = parts[0] ?? "Unknown";

  const services = SERVICES.map((s) => `${s.en} (${s.ar})`).join("\n");

  // Hard locale directive so the model can't drift toward conversation
  // history language (confirmed needed 2026-07-28).
  const localeDirective =
    currentMessageLocale === "en"
      ? "\n## This turn's language\nThe customer's CURRENT message is in ENGLISH. Reply in ENGLISH for " +
        "this message, even if earlier messages in this conversation were in Arabic. Language can " +
        "switch turn to turn — always follow the current message, never the conversation's overall history.\n"
      : currentMessageLocale === "ar"
        ? "\n## This turn's language\nThe customer's CURRENT message is in ARABIC. Reply in ARABIC (Jordanian " +
          "dialect) for this message, even if earlier messages in this conversation were in English. " +
          "Language can switch turn to turn — always follow the current message, never the conversation's " +
          "overall history.\n"
        : "";

  return promptRaw
    .replace("{{businessNameEn}}", BUSINESS.name.en)
    .replace("{{businessNameAr}}", BUSINESS.name.ar)
    .replace("{{nowLocal}}", nowLocal)
    .replace("{{weekdayEn}}", weekdayEn)
    .replace("{{services}}", services)
    .replace("{{localeDirective}}", localeDirective)
    .replace("{{horizonDays}}", String(BUSINESS.horizonDays))
    .replace("{{maxSlotsOffered}}", String(BUSINESS.maxSlotsOffered));
}
