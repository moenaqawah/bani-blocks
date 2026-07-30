import type { Sql } from "postgres";
import type { Booking, NewBooking } from "../types.js";
import { AppError } from "@bani/shared";

// ─── createBooking (single-row, used by legacy/reschedule paths) ──────

export async function createBooking(
  sql: Sql,
  b: NewBooking,
): Promise<Booking | { conflict: "resource" } | { conflict: "customer" }> {
  try {
    const rows = await sql<Booking[]>`
      insert into bookings (ref, customer_id, conversation_id, customer_name,
                            service_code, resource_code, booking_group_id, bundle_id,
                            starts_at, ends_at, status)
      values (${b.ref}, ${b.customerId}, ${b.conversationId}, ${b.customerName},
              ${b.serviceCode}, ${b.resourceCode}, ${b.bookingGroupId}, ${b.bundleId},
              ${b.startsAt}, ${b.endsAt}, 'confirmed')
      returning *
    `;
    return rows[0]!;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as Record<string, string>).code === "23P01"
    ) {
      const constraint = (err as Record<string, string>).constraint_name ?? "";
      if (constraint.includes("customer")) {
        return { conflict: "customer" };
      }
      return { conflict: "resource" };
    }
    throw new AppError("DB", "Failed to create booking", err);
  }
}

// ─── createBookingBundle — transactional multi-row insert ─────────────

/**
 * Insert a bundle of adjacent booking rows in a single transaction.
 * All rows go in as `confirmed` — there is no longer a `pending` state.
 * The exclusion constraint protects the slot atomically from the moment
 * of INSERT. If Google sync fails later, failBundle releases the slots.
 */
export async function createBookingBundle(
  sql: Sql,
  rows: Array<{
    customerId: string;
    conversationId: string;
    customerName: string;
    serviceCode: string;
    resourceCode: string;
    bookingGroupId: string;
    bundleId: string;
    startsAt: Date;
    endsAt: Date;
    ref: string;
  }>,
): Promise<Booking[] | { conflict: "resource" } | { conflict: "customer" }> {
  try {
    return await sql.begin(async (tx) => {
      const results: Booking[] = [];
      for (const r of rows) {
        const inserted = await tx<Booking[]>`
          insert into bookings (ref, customer_id, conversation_id, customer_name,
                                service_code, resource_code, booking_group_id, bundle_id,
                                starts_at, ends_at, status)
          values (${r.ref}, ${r.customerId}, ${r.conversationId}, ${r.customerName},
                  ${r.serviceCode}, ${r.resourceCode}, ${r.bookingGroupId}, ${r.bundleId},
                  ${r.startsAt}, ${r.endsAt}, 'confirmed')
          returning *
        `;
        results.push(inserted[0]!);
      }
      return results;
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as Record<string, string>).code === "23P01"
    ) {
      const constraint = (err as Record<string, string>).constraint_name ?? "";
      if (constraint.includes("customer")) {
        return { conflict: "customer" };
      }
      return { conflict: "resource" };
    }
    throw new AppError("DB", "Failed to create booking bundle", err);
  }
}

// ─── gcal event id update ─────────────────────────────────────────────

/**
 * Set the Google Calendar event id on a single already-confirmed booking.
 * Kept for script backward compatibility — use setBundleGcalEventId for new code.
 */
export async function confirmBooking(
  sql: Sql,
  bookingId: string,
  gcalEventId: string,
): Promise<Booking> {
  const rows = await sql<Booking[]>`
    update bookings
    set gcal_event_id = ${gcalEventId}, updated_at = now()
    where id = ${bookingId} and status = 'confirmed'
    returning *
  `;
  const row = rows[0];
  if (!row) throw new AppError("DB", "confirmBooking: booking not found or not confirmed");
  return row;
}

/**
 * Set the Google Calendar event id on already-confirmed bundle rows.
 * Replaces the old `confirmBundle` — rows are already confirmed at INSERT
 * time; this just links the Google Calendar event after creation.
 */
export async function setBundleGcalEventId(
  sql: Sql,
  bundleId: string,
  gcalEventId: string,
): Promise<Booking[]> {
  const rows = await sql<Booking[]>`
    update bookings
    set gcal_event_id = ${gcalEventId}, updated_at = now()
    where bundle_id = ${bundleId} and status = 'confirmed'
    returning *
  `;
  return rows;
}

// ─── fail / cancel by bundle ──────────────────────────────────────────

/**
 * Mark a bundle as failed (releases the slot immediately).
 * Rows move from `confirmed` → `failed` so the exclusion constraint
 * no longer blocks the time window.
 */
export async function failBundle(
  sql: Sql,
  bundleId: string,
): Promise<void> {
  await sql`
    update bookings
    set status = 'failed', updated_at = now()
    where bundle_id = ${bundleId} and status = 'confirmed'
  `;
}

export async function cancelBundle(
  sql: Sql,
  bundleId: string,
): Promise<Booking[]> {
  const rows = await sql<Booking[]>`
    update bookings
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where bundle_id = ${bundleId} and status = 'confirmed'
    returning *
  `;
  return rows;
}

export async function cancelBookingGroup(
  sql: Sql,
  bookingGroupId: string,
): Promise<Booking[]> {
  const rows = await sql<Booking[]>`
    update bookings
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where booking_group_id = ${bookingGroupId} and status = 'confirmed'
    returning *
  `;
  return rows;
}

// ─── lookup functions ─────────────────────────────────────────────────

export async function findBookingByRef(
  sql: Sql,
  ref: string,
): Promise<Booking | null> {
  const rows = await sql<Booking[]>`
    select * from bookings
    where upper(ref) = upper(${ref})
    limit 1
  `;
  return rows[0] ?? null;
}

export async function findBookingsByBundleId(
  sql: Sql,
  bundleId: string,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where bundle_id = ${bundleId}
    order by starts_at
  `;
}

export async function findLiveBookingsInGroup(
  sql: Sql,
  bookingGroupId: string,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where booking_group_id = ${bookingGroupId}
      and status = 'confirmed'
    order by starts_at
  `;
}

export async function findLiveBookingsForDay(
  sql: Sql,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where status = 'confirmed'
      and starts_at >= ${dayStartUtc}
      and starts_at < ${dayEndUtc}
    order by starts_at
  `;
}

export async function findLiveBookingsForDayGroupedByResource(
  sql: Sql,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<Record<string, Booking[]>> {
  const rows = await sql<Booking[]>`
    select * from bookings
    where status = 'confirmed'
      and starts_at >= ${dayStartUtc}
      and starts_at < ${dayEndUtc}
    order by starts_at
  `;
  const grouped: Record<string, Booking[]> = {};
  for (const r of rows) {
    const key = r.resource_code;
    if (!grouped[key]) grouped[key] = [];
    grouped[key]!.push(r);
  }
  return grouped;
}

export async function findLiveBookingForCustomerAt(
  sql: Sql,
  customerId: string,
  startsAt: Date,
): Promise<Booking | null> {
  const rows = await sql<Booking[]>`
    select * from bookings
    where customer_id = ${customerId}
      and starts_at = ${startsAt}
      and status = 'confirmed'
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Return all upcoming live bookings for a customer.
 * Used for the per-visit cap check and for injecting current
 * bookings into the system prompt.
 */
export async function findUpcomingLiveBookingsForCustomer(
  sql: Sql,
  customerId: string,
  now: Date,
  excludeGroupId?: string,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where customer_id = ${customerId}
      and starts_at > ${now}
      and status = 'confirmed'
      and (${excludeGroupId ?? null}::uuid is null or booking_group_id != ${excludeGroupId ?? null}::uuid)
    order by starts_at asc
  `;
}

/**
 * Count distinct visits (booking_group_id) with ≥1 upcoming live booking.
 * This is the per-customer cap guard — counts visits, not individual rows.
 */
export async function countUpcomingVisitsForCustomer(
  sql: Sql,
  customerId: string,
  now: Date,
  excludeGroupId?: string,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(distinct booking_group_id)::text as count from bookings
    where customer_id = ${customerId}
      and starts_at > ${now}
      and status = 'confirmed'
      and (${excludeGroupId ?? null}::uuid is null or booking_group_id != ${excludeGroupId ?? null}::uuid)
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Count live bookings on a given day for a specific resource. Used to
 * order candidates by "fewest bookings that day" for assignment.
 */
export async function countLiveBookingsForResourceOnDay(
  sql: Sql,
  resourceCode: string,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from bookings
    where resource_code = ${resourceCode}
      and starts_at >= ${dayStartUtc}
      and starts_at < ${dayEndUtc}
      and status = 'confirmed'
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Near-duplicate guard: check if customer already holds a live booking
 * for the same service on the same local date.
 */
export async function findDuplicateServiceOnDay(
  sql: Sql,
  customerId: string,
  serviceCode: string,
  dateLocal: string,
  excludeGroupId?: string,
): Promise<Booking | null> {
  const startTs = `${dateLocal}T00:00:00+03:00`;
  const endTs = `${dateLocal}T24:00:00+03:00`;
  const rows = await sql<Booking[]>`
    select * from bookings
    where customer_id = ${customerId}
      and service_code = ${serviceCode}
      and starts_at >= ${startTs}::timestamptz
      and starts_at <  ${endTs}::timestamptz
      and status = 'confirmed'
      and (${excludeGroupId ?? null}::uuid is null or booking_group_id != ${excludeGroupId ?? null}::uuid)
    limit 1
  `;
  return rows[0] ?? null;
}

/**
 * Look up confirmed bookings by booking_group_id.
 * Used by extractConfirmations to find bookings created in this turn.
 */
export async function findBookingsByGroupId(
  sql: Sql,
  bookingGroupId: string,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where booking_group_id = ${bookingGroupId}
      and status = 'confirmed'
    order by starts_at asc
  `;
}

// ─── legacy single-row cancel ─────────────────────────────────────────

export async function cancelBooking(
  sql: Sql,
  bookingId: string,
): Promise<void> {
  await sql`
    update bookings
    set status = 'cancelled', cancelled_at = now(), updated_at = now()
    where id = ${bookingId}
  `;
}
