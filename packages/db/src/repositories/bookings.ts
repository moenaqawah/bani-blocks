import type { Sql } from "postgres";
import type { Booking, NewBooking } from "../types.js";
import { AppError } from "@bani/shared";

export async function createBooking(
  sql: Sql,
  b: NewBooking,
): Promise<Booking | { conflict: true }> {
  try {
    const rows = await sql<Booking[]>`
      insert into bookings (ref, customer_id, conversation_id, customer_name,
                            service_code, starts_at, ends_at, status)
      values (${b.ref}, ${b.customerId}, ${b.conversationId}, ${b.customerName},
              ${b.serviceCode}, ${b.startsAt}, ${b.endsAt}, 'pending')
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
      return { conflict: true };
    }
    throw new AppError("DB", "Failed to create booking", err);
  }
}

export async function confirmBooking(
  sql: Sql,
  bookingId: string,
  gcalEventId: string,
): Promise<Booking> {
  const rows = await sql<Booking[]>`
    update bookings
    set status = 'confirmed', gcal_event_id = ${gcalEventId}, updated_at = now()
    where id = ${bookingId}
    returning *
  `;
  const row = rows[0];
  if (!row) throw new AppError("DB", "confirmBooking: booking not found");
  return row;
}

export async function failBooking(
  sql: Sql,
  bookingId: string,
): Promise<void> {
  await sql`
    update bookings
    set status = 'failed', updated_at = now()
    where id = ${bookingId}
  `;
}

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

export async function findLiveBookingsForDay(
  sql: Sql,
  dayStartUtc: Date,
  dayEndUtc: Date,
): Promise<Booking[]> {
  return sql<Booking[]>`
    select * from bookings
    where status in ('pending', 'confirmed')
      and starts_at >= ${dayStartUtc}
      and starts_at < ${dayEndUtc}
    order by starts_at
  `;
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
      and status in ('pending', 'confirmed')
    limit 1
  `;
  return rows[0] ?? null;
}

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
