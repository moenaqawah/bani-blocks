/**
 * Business configuration — product facts, not secrets.
 * Reproduced verbatim from DESIGN §1.5, extended for multi-resource.
 */

export const BUSINESS = {
  name: { en: "Layali Salon", ar: "صالون ليالي" },
  timezone: "Asia/Amman",
  utcOffsetMinutes: 180, // Jordan is UTC+3 year-round; no DST
  openHour: 10, // 10:00 local
  closeHour: 20, // 20:00 local
  slotMinutes: 30,
  closedWeekdays: [5], // 5 = Friday (JS getUTCDay convention)
  leadTimeMinutes: 60,
  horizonDays: 60,
  maxSlotsOffered: 5, // never list more than 5 slots in one message
} as const;

export const SERVICES = [
  { code: "haircut",  en: "Haircut",             ar: "قص شعر",            durationMinutes: 30 },
  { code: "blowdry",  en: "Blow-dry & styling",  ar: "سشوار وتصفيف",       durationMinutes: 30 },
  { code: "color",    en: "Hair colour",          ar: "صبغة شعر",           durationMinutes: 90 },
  { code: "keratin",  en: "Keratin treatment",    ar: "بروتين/كيراتين",     durationMinutes: 180 },
  { code: "manicure", en: "Manicure",             ar: "مانيكير",            durationMinutes: 30 },
  { code: "facial",   en: "Facial",               ar: "تنظيف بشرة",         durationMinutes: 60 },
  { code: "skincare", en: "Skin care treatment",  ar: "عناية بالبشرة",      durationMinutes: 60 },
] as const;

export type ServiceCode = (typeof SERVICES)[number]["code"];

// ─── Resources (employees) ──────────────────────────────────────────────

export const RESOURCES = [
  { code: "muna",  en: "Muna",  ar: "منى",
    aliases: ["muna", "mona", "منى", "مونا"],
    services: ["haircut", "blowdry", "color"] as readonly string[],
    active: true },
  { code: "hiba",  en: "Hiba",  ar: "هبة",
    aliases: ["hiba", "heba", "هبة", "هبه"],
    services: ["haircut", "keratin", "color"] as readonly string[],
    active: true },
  { code: "layan", en: "Layan", ar: "ليان",
    aliases: ["layan", "layane", "ليان"],
    services: ["manicure"] as readonly string[],
    active: true },
  { code: "rana",  en: "Rana",  ar: "رنا",
    aliases: ["rana", "رنا"],
    services: ["facial", "skincare"] as readonly string[],
    active: true },
] as const;

export type ResourceCode = (typeof RESOURCES)[number]["code"];

export const RESOURCE_POLICY = {
  assignment: "least_loaded",          // "least_loaded" | "config_order"
} as const;

// Replaces the deleted one-booking-per-customer gate's anti-hoarding job.
export const BOOKING_LIMITS = {
  maxUpcomingVisits: 3,       // distinct booking_group_ids with a live upcoming booking
  maxServicesPerVisit: 3,     // = the create_bookings `bundles` array cap
} as const;

// ─── Derived helpers (not exported — use the arrays above) ──────────────

export const SERVICE_CODES = SERVICES.map((s) => s.code) as [string, ...string[]];
export const RESOURCE_CODES = RESOURCES.filter(r => r.active).map((r) => r.code) as [string, ...string[]];

export function getServiceDuration(code: string): number {
  return SERVICES.find((s) => s.code === code)?.durationMinutes ?? BUSINESS.slotMinutes;
}

export function getTotalDuration(codes: string[]): number {
  return codes.reduce((sum, c) => sum + getServiceDuration(c), 0);
}

/**
 * Check if a resource can perform EVERY service in the given list.
 */
export function resourceCanDo(resourceCode: string, serviceCodes: string[]): boolean {
  const r = RESOURCES.find((x) => x.code === resourceCode);
  if (!r || !r.active) return false;
  const svcs = r.services;
  // When services is the literal string "all", employee does everything
  if (typeof svcs === "string") return true;
  return serviceCodes.every((sc) => svcs.includes(sc));
}

/** Return the list of service codes a resource can perform. */
export function resourceServices(resourceCode: string): readonly string[] {
  const r = RESOURCES.find((x) => x.code === resourceCode);
  if (!r) return [];
  const svcs = r.services;
  if (typeof svcs === "string") return SERVICES.map((s) => s.code);
  return svcs;
}

/**
 * Return all active resource codes capable of EVERY given service.
 */
export function capableResources(serviceCodes: string[]): string[] {
  return RESOURCES.filter((r) => r.active && resourceCanDo(r.code, serviceCodes)).map((r) => r.code);
}
