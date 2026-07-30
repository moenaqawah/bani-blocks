/**
 * Internationalisation helpers — locale detection, canned messages,
 * and the consent line. Pure functions with no DB or network dependencies.
 *
 * Extracted from handleMessage.ts to separate the localisation concern
 * from the message-processing pipeline.
 */

// ─── consent line ────────────────────────────────────────────────────

export const CONSENT_LINE =
  "صالون ليالي — مساعد آلي. بنستخدم رقمك وبياناتك فقط لإدارة الحجز.\n" +
  "Layali Salon — automated assistant. We use your number and details only to manage your booking.\n";

// ─── canned messages ─────────────────────────────────────────────────

export const CANNED = {
  BUSY: {
    ar: "عذراً، في ضغط على النظام هلق 🙏 جرب تبعتلي بعد شوي.",
    en: "Sorry, the system is busy right now. Please try again in a moment.",
  },
  ERROR: {
    ar: "صار عندنا خلل تقني بسيط. جرب تبعت رسالتك مرة تانية من فضلك.",
    en: "We hit a technical problem. Please send your message again.",
  },
  MEDIA: {
    ar: "عذراً، أستطيع قراءة الرسائل النصية فقط 🙏 اكتب لي طلبك بالكلمات مثلاً: \"بدي موعد قص شعر بكرا الساعة ٥\".",
    en: 'Sorry, I can only read text messages. Please type your request, for example: "I\'d like a haircut tomorrow at 5pm".',
  },
} as const;

export type CannedKey = keyof typeof CANNED;

/**
 * Return the bilingual message for a given canned message key and locale.
 * If locale is somehow neither "ar" nor "en", falls back to concatenating both.
 */
export function bilingualMsg(key: CannedKey, locale: "ar" | "en"): string {
  const c = CANNED[key];
  if (locale === "ar") return c.ar;
  if (locale === "en") return c.en;
  return c.ar + "\n" + c.en;
}

// ─── locale detection ────────────────────────────────────────────────

/**
 * Determine locale from message text — Arabic character detection.
 * Defaults to English for null/empty text.
 */
export function detectLocale(text: string | null): "ar" | "en" {
  if (!text) return "en";
  return isArabic(text) ? "ar" : "en";
}

/**
 * Check if a string contains Arabic-script characters (U+0600–U+06FF).
 */
export function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}
