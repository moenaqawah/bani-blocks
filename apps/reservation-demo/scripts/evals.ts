#!/usr/bin/env tsx
/**
 * Eval suite — 10 scripted conversations from DESIGN §8.3.
 *
 * Usage:
 *   pnpm run evals -- --url https://bani-reservation-demo.<subdomain>.workers.dev
 *
 * Posts synthetic webhook payloads to the deployed Worker, polls the DB
 * for assistant replies, and asserts on tools, text, and state.
 * Requires DATABASE_URL and a deployed Worker.
 */

import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createDb,
  findBookingByRef,
  cancelBooking,
  createBooking,
  confirmBooking,
} from "@bani/db";
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
  console.error("Usage: pnpm run evals -- --url <worker-url>");
  process.exit(1);
}

const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "test-secret";
const DATABASE_URL = process.env.DATABASE_URL;
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID ?? "";
const GCAL_SA_EMAIL = process.env.GCAL_SA_EMAIL ?? "";
const GCAL_SA_PRIVATE_KEY = process.env.GCAL_SA_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";

if (!DATABASE_URL) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

function sign(payload: string): string {
  const hmac = createHmac("sha256", APP_SECRET);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

/** Count open days from today (Sat–Thu only, skip Fridays), return date string */
function openDay(n: number, from?: Date): string {
  const d = from ? new Date(from) : new Date();
  while (true) {
    d.setUTCDate(d.getUTCDate() + (n === 0 && from ? 0 : 1));
    if (n === 0 && from) break; // base date counts as day 0
    if (d.getUTCDay() !== 5) {
      if (n <= 0) break;
      n--;
    }
  }
  return utcToLocalParts(d).date;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface EvalResult {
  case: string;
  pass: boolean;
  detail?: string;
  replies: string[];
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
}

const results: EvalResult[] = [];
let currentCase = "";

function record(ev: EvalResult) {
  results.push(ev);
  const status = ev.pass ? "✓" : "✗";
  console.log(`  ${status} ${ev.case}${ev.detail ? ` — ${ev.detail}` : ""}`);
}

async function sendTurn(
  phone: string,
  text: string | null,
  type: string,
  wamid: string,
): Promise<void> {
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
              metadata: { display_phone_number: "962790000000", phone_number_id: "12345" },
              contacts: [{ profile: { name: `Eval ${phone}` } }],
              messages: [
                {
                  id: wamid,
                  from: phone,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type,
                  ...(type === "text" && text !== null
                    ? { text: { body: text } }
                    : {}),
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
  if (res.status !== 200) {
    console.warn(`    Warning: sendTurn returned ${res.status}`);
  }
}

async function pollReplies(
  phone: string,
  expectedCount: number,
  maxWaitSec: number,
): Promise<Array<{ content: string; toolName: string | null }>> {
  const sql = createDb(DATABASE_URL!);
  for (let i = 0; i < maxWaitSec; i++) {
    await sleep(1000);
    const rows = await sql<{ content: string; tool_name: string | null }[]>`
      select m.content, m.tool_name
      from messages m
      join customers c on m.customer_id = c.id
      where c.wa_phone = ${phone}
        and m.wa_direction = 'out'
      order by m.created_at asc
    `;
    const assistantRows = rows.filter((r) => !r.tool_name || r.tool_name === "fallback_media");
    if (assistantRows.length >= expectedCount) {
      await sql.end();
      return assistantRows.slice(0, expectedCount).map((r) => ({ content: r.content, toolName: r.tool_name }));
    }
  }
  // Return whatever we have
  const rows = await sql<{ content: string; tool_name: string | null }[]>`
    select m.content, m.tool_name
    from messages m
    join customers c on m.customer_id = c.id
    where c.wa_phone = ${phone}
      and m.wa_direction = 'out'
    order by m.created_at asc
  `;
  await sql.end();
  return rows.map((r) => ({ content: r.content, toolName: r.tool_name }));
}

function assertTool(sql: ReturnType<typeof createDb>, phone: string, toolName: string): Promise<Array<{ tool_name: string; tool_payload: unknown }>> {
  return sql<{ tool_name: string; tool_payload: unknown }[]>`
    select m.tool_name, m.tool_payload
    from messages m
    join customers c on m.customer_id = c.id
    where c.wa_phone = ${phone}
      and m.role = 'tool'
      and m.tool_name = ${toolName}
    order by m.created_at asc
  `;
}

async function cleanupCustomer(phone: string) {
  const sql = createDb(DATABASE_URL!);
  const [cust] = await sql<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  if (!cust) { await sql.end(); return; }

  // Cancel live bookings through tool layer (clean up Google)
  const bookings = await sql<{ id: string; gcal_event_id: string | null; status: string }[]>`
    select id, gcal_event_id, status from bookings where customer_id = ${cust.id}
  `;
  for (const b of bookings) {
    if (b.gcal_event_id && (b.status === "confirmed" || b.status === "pending")) {
      if (GCAL_CALENDAR_ID && GCAL_SA_EMAIL && GCAL_SA_PRIVATE_KEY) {
        try {
          const gcal = createGcalClient({
            calendarId: GCAL_CALENDAR_ID,
            saEmail: GCAL_SA_EMAIL,
            saPrivateKeyPem: GCAL_SA_PRIVATE_KEY,
            openHour: 10, closeHour: 20, slotMinutes: 30,
            closedWeekdays: [5], leadTimeMinutes: 60, horizonDays: 60,
          });
          await gcal.deleteEvent(b.gcal_event_id);
        } catch { /* best effort */ }
      }
    }
  }

  // Three-statement cleanup from §2.3
  await sql`delete from bookings where customer_id = ${cust.id}`;
  await sql`delete from conversations where customer_id = ${cust.id}`;
  await sql`delete from customers where id = ${cust.id}`;
  await sql.end();
}

// ─── Eval cases ──────────────────────────────────────────────────────

async function runCase(
  id: string,
  phone: string,
  fn: () => Promise<boolean>,
) {
  currentCase = id;
  const replies: string[] = [];
  const toolCalls: Array<{ name: string; input: unknown; output: unknown }> = [];
  let pass = false;
  try {
    pass = await fn();
  } catch (err) {
    record({ case: id, pass: false, detail: String(err), replies, toolCalls });
    return;
  }
  // Get actual data from DB
  try {
    const sql = createDb(DATABASE_URL!);
    const msgRows = await sql<{ content: string; tool_name: string | null; tool_payload: unknown }[]>`
      select m.content, m.tool_name, m.tool_payload
      from messages m join customers c on m.customer_id = c.id
      where c.wa_phone = ${phone} and m.wa_direction = 'out'
      order by m.created_at asc
    `;
    for (const r of msgRows) {
      replies.push(r.content);
      if (r.tool_name) {
        toolCalls.push({ name: r.tool_name, input: null, output: null });
      }
    }
    const toolRows = await sql<{ tool_name: string; tool_payload: unknown }[]>`
      select m.tool_name, m.tool_payload
      from messages m join customers c on m.customer_id = c.id
      where c.wa_phone = ${phone} and m.role = 'tool'
      order by m.created_at asc
    `;
    for (const t of toolRows) {
      const payload = t.tool_payload as { input: unknown; output: unknown } | null;
      toolCalls.push({ name: t.tool_name, input: payload?.input ?? null, output: payload?.output ?? null });
    }
    await sql.end();
  } catch {}
  record({ case: id, pass, replies, toolCalls });
  await cleanupCustomer(phone);
}

// ─── E1 — Arabic happy path (day +1) ────────────────────────────────
async function e1() {
  const phone = "962790000001";
  const d1 = openDay(1);
  const turns = [
    "مرحبا",
    `بدي احجز قص شعر يوم ${d1}`,
    "الساعة ٥ المسا",
    "سارة",
    "اي أكد",
  ];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E1-${i}-${Date.now()}`);
    await sleep(3000);
  }
  // Poll for final reply
  const replies = await pollReplies(phone, 5, 45);
  const allText = replies.map((r) => r.content).join(" ");
  const hasArabic = replies.some((r) => isArabic(r.content));
  const hasRef = allText.includes("BK-");

  // Check tool calls
  const sql = createDb(DATABASE_URL!);
  const checkAvailCalls = await assertTool(sql, phone, "check_availability");
  const createBookingCalls = await assertTool(sql, phone, "create_booking");
  const [cust] = await sql<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  const bookingCount = cust
    ? (await sql<{ count: string }[]>`
        select count(*)::text from bookings
        where customer_id = ${cust.id} and status = 'confirmed'
      `)[0]
    : null;
  await sql.end();

  const createOk = createBookingCalls.length === 1 && createBookingCalls[0]?.tool_payload
    ? (createBookingCalls[0].tool_payload as { output: { ok: boolean } }).output?.ok === true
    : false;

  return (
    hasArabic &&
    hasRef &&
    checkAvailCalls.length >= 1 &&
    createBookingCalls.length === 1 &&
    createOk &&
    bookingCount !== null &&
    Number(bookingCount?.count ?? "0") === 1
  );
}

// ─── E2 — English happy path (day +2) ───────────────────────────────
async function e2() {
  const phone = "962790000002";
  const d2 = openDay(2);
  const turns = [
    `Hi, do you have anything on ${d2} in the afternoon?`,
    "Blow dry please",
    "Layla",
    "yes confirm",
  ];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E2-${i}-${Date.now()}`);
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 4, 45);
  const allText = replies.map((r) => r.content).join(" ");
  const noArabic = replies.every((r) => !isArabic(r.content));

  const sql = createDb(DATABASE_URL!);
  const createCalls = await assertTool(sql, phone, "create_booking");
  const [cust] = await sql<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  const bookingCount = cust
    ? (await sql<{ count: string }[]>`
        select count(*)::text from bookings
        where customer_id = ${cust.id} and status = 'confirmed'
      `)[0]
    : null;
  await sql.end();

  return noArabic && createCalls.length === 1 && Number(bookingCount?.count ?? "0") === 1;
}

// ─── E3 — Friday refusal ────────────────────────────────────────────
async function e3() {
  const phone = "962790000003";
  // Find next Friday
  const now = new Date();
  while (now.getUTCDay() !== 5) now.setUTCDate(now.getUTCDate() + 1);
  const friday = utcToLocalParts(now).date;
  await sendTurn(phone, `بدي موعد يوم ${friday}`, "text", `wamid.E3-${Date.now()}`);
  const replies = await pollReplies(phone, 1, 30);

  const sql = createDb(DATABASE_URL!);
  const createCalls = await assertTool(sql, phone, "create_booking");
  await sql.end();

  const allText = replies.map((r) => r.content).join(" ");
  const mentionsFriday = allText.includes("الجمعة") || allText.includes("Friday");
  const offersOther = allText.includes("السبت") || allText.includes("Saturday") || /[0-9]/.test(allText);
  return createCalls.length === 0 && (mentionsFriday || offersOther);
}

// ─── E4 — Outside working hours (day +3) ────────────────────────────
async function e4() {
  const phone = "962790000004";
  const d3 = openDay(3);
  await sendTurn(phone, `can I come at 9pm on ${d3}?`, "text", `wamid.E4-${Date.now()}`);
  const replies = await pollReplies(phone, 1, 30);

  const sql = createDb(DATABASE_URL!);
  const createCalls = await assertTool(sql, phone, "create_booking");
  const [cust] = await sql<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  const bookingCount = cust
    ? (await sql<{ count: string }[]>`
        select count(*)::text from bookings where customer_id = ${cust.id}
      `)[0]
    : null;
  await sql.end();

  return createCalls.length === 0 && Number(bookingCount?.count ?? "0") === 0;
}

// ─── E5 — Books without confirming (no booking) ─────────────────────
async function e5() {
  const phone = "962790000005";
  const d3 = openDay(3);
  const turns = [`احجزلي قص شعر يوم ${d3} الساعة ١١`, "ممكن اشوف اوقات تانية؟"];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E5-${i}-${Date.now()}`);
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 2, 45);

  const sql = createDb(DATABASE_URL!);
  const createCalls = await assertTool(sql, phone, "create_booking");
  await sql.end();

  return createCalls.length === 0;
}

// ─── E6 — Off-topic redirect ────────────────────────────────────────
async function e6() {
  const phone = "962790000006";
  const d3 = openDay(3);
  const turns = [`شو أحسن شامبو لتساقط الشعر؟`, `طيب بدي أشوف مواعيد يوم ${d3}`];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E6-${i}-${Date.now()}`);
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 2, 45);
  const firstReply = replies[0]?.content ?? "";
  const noAdvice = !firstReply.includes("مينوكسيديل") && !firstReply.includes("vitamin");

  const sql = createDb(DATABASE_URL!);
  const checkCalls = await assertTool(sql, phone, "check_availability");
  const createCalls = await assertTool(sql, phone, "create_booking");
  await sql.end();

  return noAdvice && checkCalls.length >= 1 && createCalls.length === 0;
}

// ─── E7 — Slot taken mid-conversation (day +4) ──────────────────────
async function e7() {
  const phone = "962790000007";
  const blockerPhone = "962790000011";
  const d4 = openDay(4);

  // Determine a 17:00 slot on d4
  const startsAt = localToUtc(`${d4}T17:00`);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

  // Create blocker customer
  const sql = createDb(DATABASE_URL!);
  const [blocker] = await sql<{ id: string }[]>`
    insert into customers (wa_phone, locale) values (${blockerPhone}, 'ar')
    on conflict (wa_phone) do update set updated_at = now()
    returning id
  `;
  const blockerId = blocker!.id;

  // Create a confirmed booking for blocker at 17:00
  const blockerRef = generateRef();
  const b = await createBooking(sql, {
    customerId: blockerId,
    conversationId: blockerId,
    customerName: "Blocker",
    serviceCode: "haircut",
    startsAt,
    endsAt,
    ref: blockerRef,
  });
  if (!("conflict" in b)) {
    await confirmBooking(sql, b.id, "blocker-event-id");
  }
  await sql.end();

  // Now the eval customer tries to book the same slot
  const turns = [
    `بدي احجز يوم ${d4}`,
    "الساعة ٥",
    "اسمي هدى",
    "أكد",
  ];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E7-${i}-${Date.now()}`);
    if (i === 1) {
      // After bot offers slots but before confirming, blocker already has booking
      // We already inserted it above, so give a moment
      await sleep(2000);
    }
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 4, 45);

  const sql2 = createDb(DATABASE_URL!);
  const createCalls = await assertTool(sql2, phone, "create_booking");
  const [cust] = await sql2<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  const evalBookings = cust
    ? await sql2<{ status: string }[]>`
        select status from bookings where customer_id = ${cust.id} and starts_at = ${startsAt}
      `
    : [];
  await sql2.end();

  const slotTakenReturned = createCalls.some((c) => {
    const payload = c.tool_payload as { output: { ok: boolean; reason?: string } } | null;
    return payload?.output?.ok === false && payload?.output?.reason === "SLOT_TAKEN";
  });
  const evalHasNoBookingAtSlot = evalBookings.filter((b) => b.status === "confirmed").length === 0;

  // Cleanup blocker
  await cleanupCustomer(blockerPhone);

  return slotTakenReturned && evalHasNoBookingAtSlot;
}

// ─── E8 — Cancellation (day +5) ─────────────────────────────────────
async function e8() {
  const phone = "962790000008";
  const d5 = openDay(5);

  // Setup: create a booking for eval customer at 12:00
  const sql = createDb(DATABASE_URL!);
  const [cust] = await sql<{ id: string }[]>`
    insert into customers (wa_phone, locale) values (${phone}, 'ar')
    on conflict (wa_phone) do update set updated_at = now()
    returning id
  `;
  const custId = cust!.id;
  const startsAt = localToUtc(`${d5}T12:00`);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const ref = generateRef();

  const b = await createBooking(sql, {
    customerId: custId,
    conversationId: custId,
    customerName: "Eval 8",
    serviceCode: "haircut",
    startsAt,
    endsAt,
    ref,
  });
  if ("conflict" in b) {
    await sql.end();
    return false;
  }
  await confirmBooking(sql, b.id, "eval8-event-id");
  await sql.end();

  // Turns
  const turns = ["بدي ألغي الحجز", ref];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E8-${i}-${Date.now()}`);
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 2, 45);

  const sql2 = createDb(DATABASE_URL!);
  const cancelCalls = await assertTool(sql2, phone, "cancel_booking");
  const booking = await findBookingByRef(sql2, ref);
  await sql2.end();

  const allText = replies.map((r) => r.content).join(" ");
  const hasArabic = replies.some((r) => isArabic(r.content));
  return cancelCalls.length === 1 && booking?.status === "cancelled" && hasArabic;
}

// ─── E9 — Changes mind, then books (day +6) ─────────────────────────
async function e9() {
  const phone = "962790000009";
  const d6 = openDay(6);
  const turns = [
    `I want a haircut on ${d6} at 11`,
    "actually make it colour instead",
    "and let's do 3pm",
    "Nour",
    "yes",
  ];
  for (let i = 0; i < turns.length; i++) {
    await sendTurn(phone, turns[i]!, "text", `wamid.E9-${i}-${Date.now()}`);
    await sleep(3000);
  }
  const replies = await pollReplies(phone, 5, 45);

  const sql = createDb(DATABASE_URL!);
  const checkCalls = await assertTool(sql, phone, "check_availability");
  const createCalls = await assertTool(sql, phone, "create_booking");
  const [cust] = await sql<{ id: string }[]>`
    select id from customers where wa_phone = ${phone} limit 1
  `;
  const bookings = cust
    ? await sql<{ service_code: string; status: string }[]>`
        select service_code, status from bookings where customer_id = ${cust.id} and status = 'confirmed'
      `
    : [];
  await sql.end();

  return (
    checkCalls.length >= 2 &&
    createCalls.length === 1 &&
    bookings.length === 1 &&
    bookings[0]?.service_code === "color"
  );
}

// ─── E10 — Bad reference + media fallback ───────────────────────────
async function e10() {
  const phone = "962790000010";
  // Part (a): image message
  await sendTurn(phone, null, "image", `wamid.E10a-${Date.now()}`);
  await sleep(3000);
  // Part (b): bad reference
  await sendTurn(phone, "cancel BK-ZZZZZZ", "text", `wamid.E10b-${Date.now()}`);
  const replies = await pollReplies(phone, 2, 45);

  const sql = createDb(DATABASE_URL!);
  // Check that part (a) had tool_name = 'fallback_media'
  const mediaMsgs = await sql<{ tool_name: string | null }[]>`
    select m.tool_name from messages m
    join customers c on m.customer_id = c.id
    where c.wa_phone = ${phone} and m.wa_direction = 'out'
    order by m.created_at asc
  `;
  const cancelCalls = await assertTool(sql, phone, "cancel_booking");
  await sql.end();

  const hasMediaFallback = mediaMsgs.some((m) => m.tool_name === "fallback_media");
  const cancelReturnedNotFound = cancelCalls.some((c) => {
    const p = c.tool_payload as { output: { ok: boolean; reason?: string } } | null;
    return p?.output?.ok === false && (p?.output?.reason === "NOT_FOUND" || p?.output?.reason === "NOT_YOURS");
  });

  return hasMediaFallback && cancelReturnedNotFound;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("Bani reservation demo — eval suite\n");

  // E1
  await runCase("E1 — Arabic happy path", "962790000001", e1);
  // E2
  await runCase("E2 — English happy path", "962790000002", e2);
  // E3
  await runCase("E3 — Friday refusal", "962790000003", e3);
  // E4
  await runCase("E4 — Outside working hours", "962790000004", e4);
  // E5
  await runCase("E5 — Book without confirming", "962790000005", e5);
  // E6
  await runCase("E6 — Off-topic redirect", "962790000006", e6);
  // E7
  await runCase("E7 — Slot taken mid-conversation", "962790000007", e7);
  // E8
  await runCase("E8 — Cancellation", "962790000008", e8);
  // E9
  await runCase("E9 — Changes mind, then books", "962790000009", e9);
  // E10
  await runCase("E10 — Bad reference + media fallback", "962790000010", e10);

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n${passed}/${total} passed`);

  // Write results
  const evalsDir = join(projectRoot, "evals");
  mkdirSync(evalsDir, { recursive: true });
  const date = new Date().toISOString().split("T")[0];
  writeFileSync(
    join(evalsDir, `results-${date}.json`),
    JSON.stringify(results, null, 2),
  );

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error("Evals failed:", err);
  process.exit(1);
});
