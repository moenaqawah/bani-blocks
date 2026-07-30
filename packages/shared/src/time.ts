/**
 * Amman / Jordan timezone helpers.
 *
 * Jordan sits at UTC+3 year-round (DST abolished in 2022).
 * We exploit this and avoid a timezone library, but isolate the
 * assumption in this one file so a DST-country client needs
 * changes in exactly one place.
 */

export const AMMAN_OFFSET_MIN = 180;

const WEEKDAY_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const WEEKDAY_AR = [
  "الأحد",
  "الاثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
] as const;

/** Levantine (Jordanian) month names — not يناير/فبراير. */
export const MONTHS_AR = [
  "كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران",
  "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول",
] as const;

/**
 * Convert a local Amman ISO string ("2026-07-28T17:00") to a UTC Date.
 */
export function localToUtc(localIso: string): Date {
  // localIso is "YYYY-MM-DDTHH:mm" with no offset
  const d = new Date(localIso + ":00+03:00");
  if (isNaN(d.getTime())) throw new Error(`Invalid local ISO: ${localIso}`);
  return d;
}

export interface LocalParts {
  date: string; // "2026-07-28"
  time: string; // "17:00"
  weekday: number; // 0 = Sunday … 6 = Saturday, Amman local
  weekdayEn: string; // "Tuesday"
  weekdayAr: string; // "الثلاثاء"
  human: string; // "Tuesday 28 July, 17:00"
}

/**
 * Convert a UTC Date to local Amman wall-clock parts.
 */
export function utcToLocalParts(d: Date): LocalParts {
  // Apply the fixed +03:00 offset
  const localMs = d.getTime() + AMMAN_OFFSET_MIN * 60_000;
  const local = new Date(localMs);

  const year = local.getUTCFullYear();
  const month = local.getUTCMonth(); // 0-based
  const day = local.getUTCDate();
  const hours = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const weekdayNum = local.getUTCDay(); // 0=Sun … 6=Sat, same in UTC

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const time = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const weekdayEn = WEEKDAY_EN[weekdayNum]!;
  const weekdayAr = WEEKDAY_AR[weekdayNum]!;
  const human = `${weekdayEn} ${day} ${monthNames[month]}, ${time}`;

  return { date, time, weekday: weekdayNum, weekdayEn, weekdayAr, human };
}

/**
 * Returns the Amman-local weekday for a UTC Date.
 * 0 = Sunday … 6 = Saturday.
 */
export function localWeekday(d: Date): number {
  return utcToLocalParts(d).weekday;
}

/**
 * Generate all 30-minute slot starts for one local date, as UTC Dates.
 * Slots from 10:00 to 19:30 inclusive (20 slots).
 */
export function slotGrid(localDate: string): Date[] {
  const slots: Date[] = [];
  for (let h = 10; h < 20; h++) {
    for (const m of [0, 30]) {
      if (h === 19 && m > 30) continue;
      slots.push(localToUtc(`${localDate}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`));
    }
  }
  return slots;
}

/**
 * Booking confirmation details for formatConfirmation.
 */
export interface ConfirmationBooking {
  ref: string;
  startsAt: Date;
  services: string[];         // service names in the customer's language
  resourceName: string;       // employee name in the customer's language
  durationMinutes: number;
}

/**
 * Format a canonical confirmation block from booking rows.
 * Code-rendered — the model never writes the date or ref.
 * Returns a block suitable for appending after the model's warm text.
 */
export function formatConfirmation(
  bookings: ConfirmationBooking[],
  locale: "ar" | "en",
): string {
  if (bookings.length === 0) return "";

  const lines: string[] = [];
  lines.push(""); // blank line separator from model text

  for (const b of bookings) {
    const parts = utcToLocalParts(b.startsAt);
    const endTime = new Date(b.startsAt.getTime() + b.durationMinutes * 60_000);
    const endParts = utcToLocalParts(endTime);

    if (locale === "ar") {
      const monthAr = MONTHS_AR[new Date(
        b.startsAt.getTime() + AMMAN_OFFSET_MIN * 60_000,
      ).getUTCMonth()];
      lines.push(
        `${parts.weekdayAr} ${new Date(b.startsAt.getTime() + AMMAN_OFFSET_MIN * 60_000).getUTCDate()} ${monthAr} ${new Date(b.startsAt.getTime() + AMMAN_OFFSET_MIN * 60_000).getUTCFullYear()}`,
      );
      lines.push(
        `${parts.time}${" مساءً"}` + (endParts.time !== parts.time ? ` — ${endParts.time} مساءً` : ""),
      );
      const svcText = b.services.join(" + ");
      lines.push(`${svcText}، مع ${b.resourceName}`);
      lines.push(`رقم الحجز ${b.ref}`);
      lines.push("لإلغاء الحجز ابعتلي رقم الحجز");
    } else {
      // English
      lines.push(
        `${parts.weekdayEn} ${parts.human}`,
      );
      const svcText = b.services.join(" + ");
      lines.push(`${svcText} with ${b.resourceName}`);
      lines.push(`Ref ${b.ref}`);
      lines.push("To cancel, send me the booking reference.");
    }

    // Separator between bundles
    if (bookings.length > 1) {
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Format a Date as a local human-readable string using Intl.
 * Example: "Monday 27 July 2026, 14:35"
 */
export function formatLocalHuman(d: Date): string {
  const parts = utcToLocalParts(d);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const localMs = d.getTime() + AMMAN_OFFSET_MIN * 60_000;
  const local = new Date(localMs);
  return `${parts.weekdayEn} ${local.getUTCDate()} ${monthNames[local.getUTCMonth()]!} ${local.getUTCFullYear()}, ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}
