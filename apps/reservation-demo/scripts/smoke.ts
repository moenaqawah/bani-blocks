#!/usr/bin/env tsx
/**
 * Smoke suite — does the DEPLOYED system work end to end?
 *
 * Usage:
 *   pnpm run smoke -- --url https://bani.baniai.workers.dev
 *
 * This is the deployment gate, and it is deliberately a different job from
 * `pnpm run test`: that suite proves the flow is correct with no network at
 * all, so nothing here re-checks booking logic. What is checked here is only
 * what a deploy can break — wiring, credentials, schema drift, and the two
 * silent failures this system is prone to:
 *
 *   - a Google calendar not shared with the service account, which reads as
 *     "fully busy" and offers zero slots with no error anywhere (the safe
 *     direction, but indistinguishable from a quiet day);
 *   - `pnpm run deploy` without `pnpm run migrate`, so the Worker expects
 *     tables that are not there.
 *
 * Reads .env for WHATSAPP_APP_SECRET, DATABASE_URL, GCAL_* etc.
 * A green smoke run is the definition of "deployed".
 */

import { config } from "dotenv";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import {
  createDb,
  createBooking,
  cancelBooking,
  getOrCreateOpenConversation,
} from "@bani/db";
import { createGcalClient } from "@bani/gcal-tool";
import { capableEmployees, suggestOffers, type Interval } from "@bani/availability";
import { localToUtc, utcToLocalParts, generateRef } from "@bani/shared";
import { BUSINESS, RESOURCES } from "../src/config.js";
import { ORCHESTRATOR_CONFIG } from "../src/salon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..", "..");
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
const GCAL_SA_EMAIL = process.env.GCAL_SA_EMAIL ?? "";
const GCAL_SA_PRIVATE_KEY = process.env.GCAL_SA_PRIVATE_KEY?.replace(/\\n/g, "\n") ?? "";

/**
 * Multi-calendar is the deployed shape; the single-calendar var is only a
 * fallback for a client that never moved off one chair.
 */
function loadCalendars(): Record<string, string> {
  if (process.env.GCAL_CALENDARS) {
    try {
      return JSON.parse(process.env.GCAL_CALENDARS) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const single = process.env.GCAL_CALENDAR_ID;
  const first = RESOURCES.find((r) => r.active);
  return single && first ? { [first.code]: single } : {};
}

const CALENDARS = loadCalendars();
const HAVE_GCAL = Object.keys(CALENDARS).length > 0 && GCAL_SA_EMAIL !== "" && GCAL_SA_PRIVATE_KEY !== "";

function gcalClient() {
  return createGcalClient({
    calendars: CALENDARS,
    saEmail: GCAL_SA_EMAIL,
    saPrivateKeyPem: GCAL_SA_PRIVATE_KEY,
    openHour: BUSINESS.openHour,
    closeHour: BUSINESS.closeHour,
    slotMinutes: BUSINESS.slotMinutes,
    closedWeekdays: [...BUSINESS.closedWeekdays],
    leadTimeMinutes: BUSINESS.leadTimeMinutes,
    horizonDays: BUSINESS.horizonDays,
  });
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function skip(name: string, why: string) {
  console.log(`  ? ${name} — skipped (${why})`);
  skipped++;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The next open day, honouring the configured closed weekdays. */
function nextOpenDate(): string {
  const d = new Date();
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while ((BUSINESS.closedWeekdays as readonly number[]).includes(utcToLocalParts(d).weekday));
  return utcToLocalParts(d).date;
}

function inboundPayload(wamid: string, from: string, text: string): string {
  return JSON.stringify({
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
              contacts: [{ profile: { name: "Smoke Test" } }],
              messages: [
                {
                  id: wamid,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function postWebhook(payload: string, signed = true): Promise<Response> {
  return fetch(`${BASE_URL}/webhook/whatsapp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signed ? { "X-Hub-Signature-256": sign(payload) } : {}),
    },
    body: payload,
  });
}

const SMOKE_PHONE = "962790000099";

async function main() {
  console.log("Bani reservation demo — smoke test");
  console.log(`Target: ${BASE_URL}\n`);

  await transportChecks();
  const wamid = await webhookChecks();
  await pipelineChecks(wamid);
  await schemaChecks();
  await calendarChecks();
  await bookingCycleCheck();

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── 1–4: transport and auth ────────────────────────────────────────────

async function transportChecks() {
  console.log("Transport and auth");

  const res = await fetch(`${BASE_URL}/health`);
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; db?: boolean };
  check(
    "1. GET /health — Worker up and database reachable",
    res.status === 200 && body.ok === true && body.db === true,
    body.db === false ? "db unreachable: check Hyperdrive/Supabase" : undefined,
  );

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "bani-demo-verify-8213";
  const ok = await fetch(
    `${BASE_URL}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42`,
  );
  check(
    "2. Webhook verify with the correct token returns the challenge",
    ok.status === 200 && (await ok.text()).trim() === "42",
  );

  const bad = await fetch(
    `${BASE_URL}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`,
  );
  check("3. Webhook verify with a wrong token is rejected", bad.status === 403);

  const unsigned = await postWebhook(
    JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    false,
  );
  check("4. Unsigned POST is rejected", unsigned.status === 403);
}

// ─── 5–6: webhook intake ────────────────────────────────────────────────

async function webhookChecks(): Promise<string> {
  console.log("\nWebhook intake");

  const wamid = `wamid.SMOKE-${Date.now()}`;
  const payload = inboundPayload(wamid, SMOKE_PHONE, "Hello — smoke test");

  const started = Date.now();
  const res = await postWebhook(payload);
  const elapsed = Date.now() - started;

  // Meta retries anything that is not a fast 200, so this is a real constraint,
  // not a nicety: the agent run is deferred behind ctx.waitUntil for this reason.
  check(
    "5. Signed POST acknowledged in under 2s",
    res.status === 200 && elapsed < 2000,
    `${elapsed}ms`,
  );

  await postWebhook(inboundPayload(wamid, SMOKE_PHONE, "Hello — duplicate"));

  if (!DATABASE_URL) {
    skip("6. Duplicate wamid persisted once", "no DATABASE_URL");
    return wamid;
  }

  await sleep(3000);
  const sql = createDb(DATABASE_URL);
  try {
    const rows = await sql<{ count: string }[]>`
      select count(*)::text from messages
      where wa_message_id = ${wamid} and wa_direction = 'in'
    `;
    check("6. A repeated wamid is stored only once", Number(rows[0]?.count ?? "0") === 1);
  } finally {
    await sql.end();
  }

  return wamid;
}

// ─── 7–9: the three-layer pipeline ──────────────────────────────────────

async function pipelineChecks(_wamid: string) {
  console.log("\nPipeline (ADR-004: translator → orchestrator → renderer)");

  if (!DATABASE_URL) {
    skip("7–9. Pipeline checks", "no DATABASE_URL");
    return;
  }

  const sql = createDb(DATABASE_URL);
  try {
    let reply: string | null = null;
    for (let i = 0; i < 30 && reply === null; i++) {
      await sleep(1000);
      const rows = await sql<{ content: string }[]>`
        select content from messages
        where customer_id = (select id from customers where wa_phone = ${SMOKE_PHONE} limit 1)
          and wa_direction = 'out'
        order by created_at desc
        limit 1
      `;
      reply = rows[0]?.content ?? null;
    }

    check(
      "7. A reply was produced and sent within 30s",
      reply !== null && reply.trim().length > 0,
      reply?.slice(0, 60).replace(/\n/g, " "),
    );

    // The turn row is written by handleMessage with the labelled intents. Its
    // presence proves all three layers ran, not merely that text came back.
    const turns = await sql<{ payload: { input?: unknown } }[]>`
      select tool_payload as payload from messages
      where customer_id = (select id from customers where wa_phone = ${SMOKE_PHONE} limit 1)
        and tool_name = 'turn'
      order by created_at desc
      limit 1
    `;
    const intents = turns[0]?.payload?.input;
    check(
      "8. The turn was labelled and logged (translator + orchestrator ran)",
      Array.isArray(intents) && intents.length > 0,
      Array.isArray(intents)
        ? (intents as Array<{ kind?: string }>).map((i) => i.kind).join(", ")
        : "no turn row — is this an old deployment?",
    );

    // The resolver exists so codes and ISO dates never reach a customer. If one
    // does, either a block field was missed or the model was handed raw JSON.
    const leaks: string[] = [];
    if (reply) {
      if (/\d{4}-\d{2}-\d{2}/.test(reply)) leaks.push("raw ISO date");
      if (/"verdict"|"act"\s*:/.test(reply)) leaks.push("payload JSON");
      if (/^\s*[[{]/.test(reply)) leaks.push("reply begins as JSON");
      if (/\b[a-z]+\+[a-z]+\b/.test(reply)) leaks.push("group key");
    }
    check("9. The reply leaks no internal identifiers", leaks.length === 0, leaks.join("; "));
  } finally {
    await sql.end();
  }
}

// ─── 10–11: schema and state ────────────────────────────────────────────

async function schemaChecks() {
  console.log("\nSchema and state");

  if (!DATABASE_URL) {
    skip("10–11. Schema checks", "no DATABASE_URL");
    return;
  }

  const sql = createDb(DATABASE_URL);
  try {
    // Deploying without migrating is the easy mistake: secrets and code ship
    // independently of `pnpm run migrate`, and the failure surfaces only when a
    // customer messages.
    const [table] = await sql<{ present: boolean }[]>`
      select to_regclass('public.visit_drafts') is not null as present
    `;
    const [index] = await sql<{ present: boolean }[]>`
      select exists (
        select 1 from pg_indexes
        where tablename = 'visit_drafts' and indexname = 'visit_drafts_one_open'
      ) as present
    `;
    check(
      "10. Migration 0005 applied — visit_drafts and its one-open-draft index exist",
      table?.present === true && index?.present === true,
      table?.present !== true ? "run `pnpm run migrate`" : undefined,
    );

    // Replaces the old "no stale pending bookings" check, which has been
    // vacuously true since migration 0004 removed the pending status. The
    // equivalent "nothing is stuck" question is now about drafts, and a
    // non-zero count means the expiry cron is not firing.
    const [stale] = await sql<{ count: string }[]>`
      select count(*)::text from visit_drafts
      where status in ('gathering','active')
        and expires_at < now() - interval '30 minutes'
    `;
    check(
      "11. No open drafts past their TTL — the expiry cron is running",
      Number(stale?.count ?? "0") === 0,
      Number(stale?.count ?? "0") > 0 ? `${stale?.count} stale — check [triggers] crons` : undefined,
    );
  } catch (err) {
    check("10–11. Schema checks", false, err instanceof Error ? err.message : String(err));
  } finally {
    await sql.end();
  }
}

// ─── 12–13: calendars and availability ──────────────────────────────────

async function calendarChecks() {
  console.log("\nGoogle Calendar");

  if (!HAVE_GCAL) {
    skip("12–13. Calendar checks", "no GCAL credentials");
    return;
  }

  const gcal = gcalClient();
  const date = nextOpenDate();
  const dayStart = localToUtc(`${date}T00:00`);
  const dayEnd = localToUtc(`${date}T24:00`);

  let busy: Record<string, Interval[]> = {};
  try {
    // An unreadable calendar is reported as fully busy rather than erroring —
    // safe, but silent. This is the check that makes it loud.
    const result = await gcal.freeBusyMulti(dayStart, dayEnd);
    busy = result.busy;
    const unreadable = Object.keys(result.errors);
    check(
      `12. All ${Object.keys(CALENDARS).length} employee calendars are readable`,
      unreadable.length === 0,
      unreadable.length > 0
        ? `not shared with the service account: ${unreadable.join(", ")} — these offer zero slots`
        : Object.keys(CALENDARS).join(", "),
    );
  } catch (err) {
    check("12. All employee calendars are readable", false,
      err instanceof Error ? err.message : String(err));
    return;
  }

  // Runs the real suggestion engine against the real calendar. Zero offers on
  // an open day is not proof of a bug, but it is always worth a human look.
  const service = "haircut";
  const capable = capableEmployees([service], ORCHESTRATOR_CONFIG.employees);
  const { offers } = suggestOffers({
    date,
    durationMin: 30,
    capable,
    busyByEmployee: Object.fromEntries(capable.map((e) => [e, busy[e] ?? []])),
    customerBusy: [],
    hours: {
      openHour: BUSINESS.openHour,
      closeHour: BUSINESS.closeHour,
      slotMinutes: BUSINESS.slotMinutes,
    },
    leadCutoff: new Date(Date.now() + BUSINESS.leadTimeMinutes * 60_000),
    cap: ORCHESTRATOR_CONFIG.maxSlotsOffered,
    maxEmployees: ORCHESTRATOR_CONFIG.maxEmployeesOffered,
  });

  const total = offers.reduce((sum, o) => sum + o.times.length, 0);
  check(
    `13. The availability engine finds bookable slots on ${date}`,
    total > 0,
    total > 0
      ? `${total} across ${offers.map((o) => o.employee).join(", ")}`
      : "zero — genuinely full, or every calendar is unreadable",
  );
}

// ─── 14: the write path ─────────────────────────────────────────────────

async function bookingCycleCheck() {
  console.log("\nWrite path");

  if (!DATABASE_URL || !HAVE_GCAL) {
    skip("14. Booking create/cancel cycle", "no DATABASE_URL or GCAL credentials");
    return;
  }

  const sql = createDb(DATABASE_URL);
  const gcal = gcalClient();
  const employee = RESOURCES.find((r) => r.active && CALENDARS[r.code])?.code;
  let customerId: string | null = null;

  try {
    if (!employee) throw new Error("no active resource has a calendar id");

    const date = nextOpenDate();
    const [customer] = await sql<{ id: string }[]>`
      insert into customers (wa_phone, display_name, locale)
      values (${SMOKE_PHONE}, 'Smoke Test', 'en')
      on conflict (wa_phone) do update set updated_at = now()
      returning id
    `;
    if (!customer) throw new Error("failed to create the smoke customer");
    customerId = customer.id;

    const conv = await getOrCreateOpenConversation(sql, customer.id, new Date());

    // The last slot of the day: least likely to collide with a real booking.
    const startTime = `${BUSINESS.closeHour - 1}:30`;
    const startsAt = localToUtc(`${date}T${startTime}`);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    const ref = generateRef();
    const bundleId = crypto.randomUUID();

    const booking = await createBooking(sql, {
      customerId: customer.id,
      conversationId: conv.id,
      customerName: "Smoke Test",
      serviceCode: "haircut",
      resourceCode: employee,
      bookingGroupId: crypto.randomUUID(),
      bundleId,
      startsAt,
      endsAt,
      ref,
    });
    if ("conflict" in booking) throw new Error(`slot already taken (${booking.conflict})`);

    const eventId = bundleId.replace(/-/g, "").toLowerCase();
    const endParts = utcToLocalParts(endsAt);
    await gcal.insertEvent(employee, {
      eventId,
      summary: "Haircut — Smoke Test",
      description: `Booked via smoke test. Ref ${ref}.`,
      startLocal: `${date}T${startTime.padStart(5, "0")}:00`,
      endLocal: `${endParts.date}T${endParts.time}:00`,
    });

    await gcal.deleteEvent(employee, eventId);
    await cancelBooking(sql, booking.id);

    check("14. Booking write path — insert, Calendar event, cancel", true, `${ref} on ${employee}`);
  } catch (err) {
    check("14. Booking write path — insert, Calendar event, cancel", false,
      err instanceof Error ? err.message : String(err));
  } finally {
    // Teardown runs even on failure — a booking created mid-check must not
    // survive to block the next run's slot (confirmed 2026-07-28: a failed run
    // left a stale row that broke the following one). visit_drafts is included
    // because the pipeline checks above create one for the smoke customer.
    if (customerId) {
      try {
        await sql`delete from visit_drafts where customer_id = ${customerId}`;
        await sql`delete from bookings where customer_id = ${customerId}`;
        await sql`delete from conversations where customer_id = ${customerId}`;
        await sql`delete from customers where id = ${customerId}`;
      } catch {
        // best effort
      }
    }
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
