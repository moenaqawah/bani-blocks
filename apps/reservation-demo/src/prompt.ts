import { BUSINESS, SERVICES, RESOURCES, BOOKING_LIMITS } from "./config.js";
import { formatLocalHuman, utcToLocalParts } from "@bani/shared";
import type { Booking } from "@bani/db";
import promptRaw from "./prompt.txt";

/**
 * Load and interpolate the system prompt.
 *
 * The prompt itself lives in `prompt.txt` — plain markdown, editable
 * without touching TypeScript. This file handles variable interpolation
 * and injects per-turn facts like locale and current bookings.
 */
export function buildSystemPrompt(
  now: Date,
  currentMessageLocale?: "ar" | "en",
  currentBookings?: Booking[],
): string {
  const nowLocal = formatLocalHuman(now);
  const parts = nowLocal.split(", ");
  const weekdayEn = parts[0] ?? "Unknown";

  const services = SERVICES.map((s) => {
    const dur = s.durationMinutes === 30 ? "" : ` (${s.durationMinutes} min)`;
    return `${s.en}${dur} (${s.ar})`;
  }).join("\n");

  // Team section: each active employee with their services and aliases
  const teamSection = RESOURCES
    .filter((r) => r.active)
    .map((r) => {
      const svcList = typeof r.services === "string"
        ? SERVICES.map((s) => s.en).join(", ")
        : r.services.map((sc) =>
            SERVICES.find((s) => s.code === sc)?.en ?? sc).join(", ");
      const aliases = r.aliases.join(", ");
      return `${r.en} (${r.ar}) — ${svcList}. Aliases: ${aliases}`;
    })
    .join("\n");

  // Inject current bookings into the prompt each turn (tier-4 defense)
  let currentBookingsText = "";
  if (currentBookings && currentBookings.length > 0) {
    const byBundle = new Map<string, Booking[]>();
    for (const b of currentBookings) {
      const key = b.bundle_id;
      if (!byBundle.has(key)) byBundle.set(key, []);
      byBundle.get(key)!.push(b);
    }

    const lines: string[] = [];
    lines.push("## This customer's current bookings");
    for (const [, bundleRows] of byBundle) {
      const first = bundleRows[0]!;
      const parts = utcToLocalParts(new Date(first.starts_at));
      const svcNames = bundleRows.map((r) => r.service_code).join(" + ");
      const rInfo = RESOURCES.find((r) => r.code === first.resource_code);
      const name = rInfo?.en ?? first.resource_code;
      lines.push(`- ${first.ref} — ${svcNames}, ${parts.human}, with ${name}`);
    }
    const visitCount = new Set(currentBookings.map((b) => b.booking_group_id)).size;
    lines.push(`(${visitCount} of ${BOOKING_LIMITS.maxUpcomingVisits} allowed upcoming visits)`);
    currentBookingsText = lines.join("\n");
  }

  // Locale directive
  const localeDirective =
    currentMessageLocale === "en"
      ? "\n## This turn's language\nThe customer's CURRENT message is in ENGLISH. Reply in ENGLISH for " +
        "this message, even if earlier messages in this conversation were in Arabic.\n"
      : currentMessageLocale === "ar"
        ? "\n## This turn's language\nThe customer's CURRENT message is in ARABIC. Reply in ARABIC (Jordanian " +
          "dialect) for this message, even if earlier messages in this conversation were in English.\n"
        : "";

  const maxVisitsSection = `A customer may hold up to ${BOOKING_LIMITS.maxUpcomingVisits} upcoming visits. A single visit can have up to ${BOOKING_LIMITS.maxServicesPerVisit} services booked together.`;

  return promptRaw
    .replace("{{businessNameEn}}", BUSINESS.name.en)
    .replace("{{businessNameAr}}", BUSINESS.name.ar)
    .replace("{{nowLocal}}", nowLocal)
    .replace("{{weekdayEn}}", weekdayEn)
    .replace("{{services}}", services)
    .replace("{{teamSection}}", teamSection)
    .replace("{{currentBookings}}", currentBookingsText)
    .replace("{{localeDirective}}", localeDirective)
    .replace("{{horizonDays}}", String(BUSINESS.horizonDays))
    .replace("{{maxSlotsOffered}}", String(BUSINESS.maxSlotsOffered))
    .replace("{{maxVisits}}", String(BOOKING_LIMITS.maxUpcomingVisits))
    .replace("{{maxVisitsSection}}", maxVisitsSection);
}
