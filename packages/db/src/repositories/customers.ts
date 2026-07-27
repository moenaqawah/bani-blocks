import type { Sql } from "postgres";
import type { Customer } from "../types.js";
import { AppError } from "@bani/shared";

export async function upsertCustomer(
  sql: Sql,
  waPhone: string,
  profileName: string | null,
): Promise<Customer> {
  const rows = await sql<Customer[]>`
    insert into customers (wa_phone, display_name)
    values (${waPhone}, ${profileName})
    on conflict (wa_phone)
      do update set updated_at = now()
    returning *
  `;
  const row = rows[0];
  if (!row) throw new AppError("DB", "upsertCustomer returned no row");
  return row;
}

export async function setCustomerLocale(
  sql: Sql,
  customerId: string,
  locale: "ar" | "en",
): Promise<void> {
  await sql`
    update customers set locale = ${locale}, updated_at = now()
    where id = ${customerId}
  `;
}

export async function setCustomerName(
  sql: Sql,
  customerId: string,
  displayName: string,
): Promise<void> {
  await sql`
    update customers set display_name = ${displayName}, updated_at = now()
    where id = ${customerId}
  `;
}

export async function markConsent(
  sql: Sql,
  customerId: string,
): Promise<void> {
  await sql`
    update customers set consent_at = now(), updated_at = now()
    where id = ${customerId}
  `;
}
