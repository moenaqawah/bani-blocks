/**
 * Business configuration — product facts, not secrets.
 * Reproduced verbatim from DESIGN §1.5.
 */
export const BUSINESS = {
  name: { en: "Layali Salon", ar: "صالون ليالي" },
  timezone: "Asia/Amman",
  utcOffsetMinutes: 180, // Jordan is UTC+3 year-round; no DST
  openHour: 10, // 10:00 local
  closeHour: 20, // 20:00 local, last start 19:30
  slotMinutes: 30,
  closedWeekdays: [5], // 5 = Friday (JS getUTCDay convention)
  leadTimeMinutes: 60,
  horizonDays: 60,
  maxSlotsOffered: 5, // never list more than 5 slots in one message
} as const;

export const SERVICES = [
  { code: "haircut", en: "Haircut", ar: "قص شعر" },
  { code: "blowdry", en: "Blow-dry & styling", ar: "سشوار وتصفيف" },
  { code: "color", en: "Hair colour", ar: "صبغة شعر" },
  { code: "keratin", en: "Keratin treatment", ar: "بروتين/كيراتين" },
  { code: "manicure", en: "Manicure", ar: "مانيكير" },
] as const;

export type ServiceCode = (typeof SERVICES)[number]["code"];
