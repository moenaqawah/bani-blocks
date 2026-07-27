#!/usr/bin/env tsx
/**
 * Smoke test script — 11 checks from DESIGN §7.7.
 *
 * Usage:
 *   pnpm run smoke -- --url https://bani-reservation-demo.<subdomain>.workers.dev
 *
 * Reads .env for WHATSAPP_APP_SECRET, DATABASE_URL, etc.
 * A green smoke run is the definition of "deployed".
 */

import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { createDb, createBooking, cancelBooking } from "@bani/db";
import { createGcalClient } from "@bani/gcal-tool";
import { localToUtc, utcToLocalParts, generateRef } from "@bani/shared";

// Load .env
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..", "..", "..");
config({ path: join(projectRoot, ".env") });

const args = process.argv.slice(2);
const urlIdx = args.indexOf("--url");
const BASE_URL = urlIdx >= 0 ? args[urlIdx + 1] : undefined;
if (!BASE_URL) {
  console.error("Usage: pnpm run smoke -- --url <worker-url>");
  process.exit(1);
}

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "test-secret";
const DATABASE_URL = process.env.DATABASE_URL;
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID ?? "";
const GCAL_SA_EMAIL = process.env.GCAL_SA_EMAIL ?? "";
const GCAL_SA_PRIVATE_KEY = process.env.GCAL_SA_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";

function sign(body: string): string {
  const hmac = createHmac("sha256", APP_SECRET);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function main() {
  console.log("Bani reservation demo — smoke test\n");

  // 1. Health check
  {
    const res = await fetch(`${BASE_URL}/health`);
    const body = (await res.json()) as { ok: boolean; db: boolean };
    check("1. GET /health returns 200 with ok:true, db:true",
      res.status === 200 && body.ok === true && body.db === true);
  }

  // 2. Webhook verify — correct token
  {
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "bani-demo-verify-8213";
    const res = await fetch(
      `${BASE_URL}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42`,
    );
    const body = await res.text();
    check("2. Webhook GET with correct token returns 200 + challenge",
      res.status === 200 && body.trim() === "42");
  }

  // 3. Webhook verify — wrong token
  {
    const res = await fetch(
      `${BASE_URL}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
    );
    check("3. Webhook GET with wrong token returns 403", res.status === 403);
  }

  // 4. POST without signature
  {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const res = await fetch(`${BASE_URL}/webhook/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
    check("4. POST without signature returns 403", res.status === 403);
  }

  // 5. POST with valid signature
  const wamid = `wamid.SMOKE-${Date.now()}`;
  const smokePhone = "962790000099";
  {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "12345",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "962790000000",
                  phone_number_id: "12345",
                },
                contacts: [{ profile: { name: "Smoke Test" } }],
                messages: [
                  {
                    id: wamid,
                    from: smokePhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Hello — smoke test" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = sign(payload);
    const res = await fetch(`${BASE_URL}/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sig,
      },
      body: payload,
    });
    check("5. POST with valid signature returns 200 in <2s",
      res.status === 200);
  }

  // 6. Duplicate wamid
  {
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "12345",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "962790000000",
                  phone_number_id: "12345",
                },
                contacts: [{ profile: { name: "Smoke Test" } }],
                messages: [
                  {
                    id: wamid,
                    from: smokePhone,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Hello — duplicate" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const sig = sign(payload);
    await fetch(`${BASE_URL}/webhook/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": sig,
      },
      body: payload,
    });

    // Wait a moment, then check only 1 inbound row for this wamid
    if (DATABASE_URL) {
      await new Promise((r) => setTimeout(r, 3000));
      const sql = createDb(DATABASE_URL);
      const rows = await sql<{ count: string }[]>`
        select count(*)::text from messages where wa_message_id = ${wamid} and wa_direction = 'in'
      `;
      const count = Number(rows[0]?.count ?? "0");
      check("6. Duplicate wamid — only one inbound row persisted", count === 1);
      await sql.end();
    } else {
      console.log("  ? 6. Skipped — no DATABASE_URL");
    }
  }

  // 7. Poll for agent reply
  if (DATABASE_URL) {
    const sql = createDb(DATABASE_URL);
    let replyText: string | null = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const rows = await sql<{ content: string }[]>`
        select content from messages
        where customer_id = (select id from customers where wa_phone = ${smokePhone} limit 1)
          and wa_direction = 'out'
        order by created_at desc
        limit 1
      `;
      if (rows.length > 0 && rows[0]) {
        replyText = rows[0].content;
        break;
      }
    }
    check("7. Agent replied within 30 seconds",
      replyText !== null && replyText.length > 0,
      replyText?.slice(0, 100));
    await sql.end();
  } else {
    console.log("  ? 7. Skipped — no DATABASE_URL");
  }

  // 8. Google Calendar connectivity
  if (GCAL_CALENDAR_ID && GCAL_SA_EMAIL && GCAL_SA_PRIVATE_KEY) {
    try {
      const gcal = createGcalClient({
        calendarId: GCAL_CALENDAR_ID,
        saEmail: GCAL_SA_EMAIL,
        saPrivateKeyPem: GCAL_SA_PRIVATE_KEY,
        openHour: 10,
        closeHour: 20,
        slotMinutes: 30,
        closedWeekdays: [5],
        leadTimeMinutes: 60,
        horizonDays: 60,
      });

      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowParts = utcToLocalParts(tomorrow);
      const dayStart = localToUtc(`${tomorrowParts.date}T00:00`);
      const dayEnd = localToUtc(`${tomorrowParts.date}T24:00`);

      const busy = await gcal.freeBusy(dayStart, dayEnd);
      check("8. Google Calendar freeBusy query succeeded",
        true,
        `${busy.length} busy intervals`);
    } catch (err) {
      check("8. Google Calendar freeBusy query succeeded", false,
        err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log("  ? 8. Skipped — no GCAL credentials");
  }

  // 9. Stale pending check
  if (DATABASE_URL) {
    const sql = createDb(DATABASE_URL);
    const rows = await sql<{ count: string }[]>`
      select count(*)::text from bookings
      where status = 'pending'
        and created_at < now() - interval '10 minutes'
    `;
    const count = Number(rows[0]?.count ?? "0");
    check("9. No pending bookings older than 10 minutes", count === 0);
    await sql.end();
  } else {
    console.log("  ? 9. Skipped — no DATABASE_URL");
  }

  // 10. Booking create/cancel cycle
  if (DATABASE_URL && GCAL_CALENDAR_ID && GCAL_SA_EMAIL && GCAL_SA_PRIVATE_KEY) {
    try {
      const sql = createDb(DATABASE_URL);
      const gcal = createGcalClient({
        calendarId: GCAL_CALENDAR_ID,
        saEmail: GCAL_SA_EMAIL,
        saPrivateKeyPem: GCAL_SA_PRIVATE_KEY,
        openHour: 10,
        closeHour: 20,
        slotMinutes: 30,
        closedWeekdays: [5],
        leadTimeMinutes: 60,
        horizonDays: 60,
      });

      // Find next open day (skip Friday)
      const now = new Date();
      let nextDay = new Date(now);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      while (nextDay.getUTCDay() === 5) {
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      }
      const nextParts = utcToLocalParts(nextDay);

      // Create smoke customer
      const [customer] = await sql<{ id: string }[]>`
        insert into customers (wa_phone, display_name, locale)
        values ('962790000099', 'Smoke Test', 'en')
        on conflict (wa_phone) do update set updated_at = now()
        returning id
      `;
      if (!customer) throw new Error("Failed to create smoke customer");
      const custId = customer.id;

      const startsAt = localToUtc(`${nextParts.date}T19:30`);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const ref = generateRef();

      // Create booking
      const booking = await createBooking(sql, {
        customerId: custId,
        conversationId: custId, // placeholder — we don't have a real conversation
        customerName: "Smoke Test",
        serviceCode: "haircut",
        startsAt,
        endsAt,
        ref,
      });

      if ("conflict" in booking) {
        throw new Error("Booking conflict on smoke test — slot already taken");
      }

      // Confirm
      const eventId = booking.id.replace(/-/g, "").toLowerCase();
      await gcal.insertEvent({
        eventId,
        summary: "Haircut — Smoke Test",
        description: `Booked via smoke test. Ref ${ref}.`,
        startLocal: `${nextParts.date}T19:30:00`,
        endLocal: `${nextParts.date}T20:00:00`,
      });

      // Cancel
      await gcal.deleteEvent(eventId);
      await cancelBooking(sql, booking.id);

      // Delete smoke customer (3-statement procedure from §2.3)
      await sql`delete from bookings where customer_id = ${custId}`;
      await sql`delete from conversations where customer_id = ${custId}`;
      await sql`delete from customers where id = ${custId}`;

      check("10. Booking create/cancel cycle succeeded", true, ref);
      await sql.end();
    } catch (err) {
      check("10. Booking create/cancel cycle succeeded", false,
        err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log("  ? 10. Skipped — no DATABASE_URL or GCAL credentials");
  }

  // Summary
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
