/**
 * Bani Reservation Demo — Hono Worker entry point.
 *
 * This is the ONLY file in the entire codebase that references
 * Cloudflare-specific APIs (ExecutionContext, env bindings, ctx.waitUntil).
 * Every other package receives what it needs through plain function arguments.
 *
 * Multi-calendar: GCAL_CALENDARS (JSON map keyed by resource code) is the
 * new secret for multi-resource deployments. Falls back to GCAL_CALENDAR_ID
 * for single-calendar clients.
 */

import { Hono } from "hono";
import { createDb } from "@bani/db";
import { createGcalClient } from "@bani/gcal-tool";
import {
  verifyWebhookGet,
  verifyWebhookPost,
  parseWebhook,
  type InboundMessage,
} from "@bani/whatsapp-adapter";
import { AppError, logger, setLogLevel } from "@bani/shared";
import { handleMessage, type HandleMessageEnv } from "./handleMessage.js";
import { RESOURCES, RESOURCE_CODES, SERVICES } from "./config.js";

// ─── env loading ────────────────────────────────────────────────────

interface WorkerEnv {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_GRAPH_VERSION?: string;
  AI_PROVIDER?: string;
  AI_MODEL?: string;
  GOOGLE_GENERATIVE_AI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
  GCAL_CALENDAR_ID?: string;
  GCAL_CALENDARS?: string;    // JSON: {"muna":"...","rana":"..."}
  GCAL_SA_EMAIL?: string;
  GCAL_SA_PRIVATE_KEY?: string;
  DEMO_ALLOWLIST?: string;
  AGENT_HISTORY_LIMIT?: string;
  AGENT_HISTORY_MAX_AGE_HOURS?: string;
  LOG_LEVEL?: string;
}

function loadConfig(raw: WorkerEnv): HandleMessageEnv {
  function assert(name: string, value: string | undefined): string {
    if (!value || value.trim() === "") {
      throw new AppError("CONFIG", `Missing required env var: ${name}`);
    }
    return value;
  }

  // Required secrets
  const DATABASE_URL = assert("DATABASE_URL", raw.DATABASE_URL);
  const WHATSAPP_VERIFY_TOKEN = assert("WHATSAPP_VERIFY_TOKEN", raw.WHATSAPP_VERIFY_TOKEN);
  const WHATSAPP_ACCESS_TOKEN = assert("WHATSAPP_ACCESS_TOKEN", raw.WHATSAPP_ACCESS_TOKEN);
  const WHATSAPP_PHONE_NUMBER_ID = assert("WHATSAPP_PHONE_NUMBER_ID", raw.WHATSAPP_PHONE_NUMBER_ID);
  const WHATSAPP_APP_SECRET = assert("WHATSAPP_APP_SECRET", raw.WHATSAPP_APP_SECRET);
  const GOOGLE_GENERATIVE_AI_API_KEY = assert("GOOGLE_GENERATIVE_AI_API_KEY", raw.GOOGLE_GENERATIVE_AI_API_KEY);
  const GCAL_SA_EMAIL = assert("GCAL_SA_EMAIL", raw.GCAL_SA_EMAIL);
  const GCAL_SA_PRIVATE_KEY = assert("GCAL_SA_PRIVATE_KEY", raw.GCAL_SA_PRIVATE_KEY);

  // Calendar config: prefer GCAL_CALENDARS (multi-resource), fall back to
  // GCAL_CALENDAR_ID (single-resource).
  const GCAL_CALENDAR_ID = raw.GCAL_CALENDAR_ID;
  const GCAL_CALENDARS = raw.GCAL_CALENDARS;

  // Parse calendar map
  let calendars: Record<string, string>;
  if (GCAL_CALENDARS) {
    try {
      calendars = JSON.parse(GCAL_CALENDARS) as Record<string, string>;
    } catch (err) {
      throw new AppError("CONFIG", "GCAL_CALENDARS is not valid JSON");
    }
  } else if (GCAL_CALENDAR_ID) {
    // Fallback: map the first active resource to the single calendar
    const first = RESOURCES.find((r) => r.active);
    if (first) {
      calendars = { [first.code]: GCAL_CALENDAR_ID };
    } else {
      throw new AppError("CONFIG", "No active resources configured");
    }
  } else {
    throw new AppError("CONFIG", "Either GCAL_CALENDARS or GCAL_CALENDAR_ID is required");
  }

  // Boot-time validation (fail fast)
  validateCalendarConfig(calendars);

  // Vars with defaults
  const WHATSAPP_GRAPH_VERSION = raw.WHATSAPP_GRAPH_VERSION ?? "v25.0";
  const AI_PROVIDER = raw.AI_PROVIDER ?? "google";
  const AI_MODEL = raw.AI_MODEL ?? "gemini-flash-latest";

  // Numeric vars
  const AGENT_HISTORY_LIMIT = Number(raw.AGENT_HISTORY_LIMIT ?? "20");
  if (!Number.isInteger(AGENT_HISTORY_LIMIT) || AGENT_HISTORY_LIMIT <= 0) {
    throw new AppError("CONFIG", "AGENT_HISTORY_LIMIT must be a positive integer");
  }
  const AGENT_HISTORY_MAX_AGE_HOURS = Number(raw.AGENT_HISTORY_MAX_AGE_HOURS ?? "6");
  if (!Number.isInteger(AGENT_HISTORY_MAX_AGE_HOURS) || AGENT_HISTORY_MAX_AGE_HOURS <= 0) {
    throw new AppError("CONFIG", "AGENT_HISTORY_MAX_AGE_HOURS must be a positive integer");
  }

  // Allowlist
  const DEMO_ALLOWLIST = (raw.DEMO_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Log level
  const LOG_LEVEL = raw.LOG_LEVEL ?? "info";
  setLogLevel(LOG_LEVEL as "debug" | "info" | "warn" | "error");

  // Fix GCAL_SA_PRIVATE_KEY newlines
  const fixedKey = GCAL_SA_PRIVATE_KEY.replace(/\\n/g, "\n");

  // Hyperdrive
  const useHyperdrive = raw.HYPERDRIVE !== undefined;
  const effectiveDatabaseUrl = raw.HYPERDRIVE?.connectionString ?? DATABASE_URL;

  return {
    DATABASE_URL: effectiveDatabaseUrl,
    _useHyperdrive: useHyperdrive,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_GRAPH_VERSION,
    AI_PROVIDER,
    AI_MODEL,
    GOOGLE_GENERATIVE_AI_API_KEY,
    OPENAI_API_KEY: raw.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: raw.ANTHROPIC_API_KEY,
    GROQ_API_KEY: raw.GROQ_API_KEY,
    AGENT_HISTORY_LIMIT,
    AGENT_HISTORY_MAX_AGE_HOURS,
    GCAL_CALENDAR_ID: GCAL_CALENDAR_ID ?? "",
    GCAL_CALENDARS,
    GCAL_SA_EMAIL,
    GCAL_SA_PRIVATE_KEY: fixedKey,
    DEMO_ALLOWLIST,
    _calendars: calendars,
    // Store these for the GET handler
    _verifyToken: WHATSAPP_VERIFY_TOKEN,
    _appSecret: WHATSAPP_APP_SECRET,
  } as HandleMessageEnv & {
    _verifyToken: string;
    _appSecret: string;
    _useHyperdrive: boolean;
    _calendars: Record<string, string>;
  };
}

/**
 * Boot-time validation of the calendar configuration.
 * Fails fast with AppError("CONFIG", …) on misconfiguration.
 */
function validateCalendarConfig(calendars: Record<string, string>): void {
  const activeResources = RESOURCES.filter((r) => r.active);
  const resourceCodes: Set<string> = new Set(activeResources.map((r) => r.code as string));

  // 1. Every active resource has a calendar id
  for (const r of activeResources) {
    if (!calendars[r.code]) {
      throw new AppError(
        "CONFIG",
        `Resource "${r.code}" (${r.en}) has no calendar id in GCAL_CALENDARS`,
      );
    }
  }

  // 2. Every key in calendars matches a known resource code
  for (const key of Object.keys(calendars)) {
    if (!resourceCodes.has(key)) {
      throw new AppError(
        "CONFIG",
        `GCAL_CALENDARS key "${key}" does not match any active resource code. Known codes: ${Array.from(resourceCodes).join(", ")}`,
      );
    }
  }

  // 3. No calendar id appears twice
  const seenCalendarIds = new Map<string, string>();
  for (const [rc, calId] of Object.entries(calendars)) {
    const existing = seenCalendarIds.get(calId);
    if (existing) {
      throw new AppError(
        "CONFIG",
        `Calendar id "${calId}" is shared by resources "${existing}" and "${rc}". Each resource must have its own calendar.`,
      );
    }
    seenCalendarIds.set(calId, rc);
  }

  // 4. Every service in any resource's services exists in SERVICES
  const serviceCodeSet: Set<string> = new Set(SERVICES.map((s) => s.code as string));
  for (const r of activeResources) {
    if (typeof r.services === "string") continue;
    for (const sc of r.services as readonly string[]) {
      if (!serviceCodeSet.has(sc)) {
        throw new AppError(
          "CONFIG",
          `Resource "${r.code}" references unknown service "${sc}"`,
        );
      }
    }
  }

  // 5. Every service in SERVICES is covered by ≥1 active resource
  for (const s of SERVICES) {
    const covered = activeResources.some(
      (r) => typeof r.services === "string" || (r.services as readonly string[]).includes(s.code),
    );
    if (!covered) {
      throw new AppError(
        "CONFIG",
        `Service "${s.code}" (${s.en}) is not covered by any active resource — it would never have slots`,
      );
    }
  }
}

// ─── app ─────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: WorkerEnv }>();

app.get("/health", async (c) => {
  try {
    const env = c.env;
    const useHyperdrive = env.HYPERDRIVE !== undefined;
    const dbUrl = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? "";
    const sql = createDb(dbUrl, useHyperdrive ? { ssl: false } : undefined);
    await sql`select 1`;
    await sql.end();
    return c.json({ ok: true, db: true });
  } catch (err) {
    return c.json(
      { ok: false, db: false, error: err instanceof Error ? err.message : "unknown" },
      500,
    );
  }
});

app.get("/webhook/whatsapp", (c) => {
  const mode = c.req.query("hub.mode");
  const verifyToken = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  try {
    const config = loadConfig(c.env as unknown as WorkerEnv);
    const expected = (config as unknown as { _verifyToken: string })._verifyToken;

    const result = verifyWebhookGet(mode ?? null, verifyToken ?? null, expected);
    if (result !== null && challenge) {
      return new Response(challenge, {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response(null, { status: 403 });
  } catch (err) {
    logger.error("Config error during webhook verification", {
      msg: err instanceof Error ? err.message : String(err),
    });
    return new Response(null, { status: 500 });
  }
});

app.post("/webhook/whatsapp", async (c) => {
  let config: HandleMessageEnv & { _appSecret: string; _calendars: Record<string, string> };
  try {
    config = loadConfig(c.env as unknown as WorkerEnv) as HandleMessageEnv & {
      _appSecret: string;
      _calendars: Record<string, string>;
    };
  } catch (err) {
    logger.error("Config error", {
      msg: err instanceof Error ? err.message : String(err),
    });
    return new Response(null, { status: 500 });
  }

  // Read body once, as text
  const rawBody = await c.req.text();

  // Verify signature
  const signatureHeader = c.req.header("X-Hub-Signature-256");
  const valid = await verifyWebhookPost(
    rawBody,
    signatureHeader ?? null,
    config._appSecret,
  );
  if (!valid) {
    const digest = signatureHeader?.slice(0, 15) ?? "missing";
    logger.warn("Signature verification failed", {
      msg: `Expected digest starts: ${digest}`,
    });
    return new Response(null, { status: 403 });
  }

  // Parse
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    logger.warn("Failed to parse webhook body as JSON", {
      msg: err instanceof Error ? err.message : String(err),
    });
    return new Response(null, { status: 200 });
  }

  const parsed = parseWebhook(body);

  // Handle status updates
  for (const status of parsed.statuses) {
    if (status.status === "failed") {
      logger.warn("WhatsApp message delivery failed", {
        msg: `wamid=${status.waMessageId} errors=${JSON.stringify(status.errors)}`,
      });
    }
  }

  // Handle messages
  for (const msg of parsed.messages) {
    try {
      await processMessage(msg, config, c.executionCtx);
    } catch (err) {
      logger.error("Unhandled error processing message", {
        msg: err instanceof Error ? err.message : String(err),
      });
      // Always return 200 — Meta must not retry
    }
  }

  return new Response(null, { status: 200 });
});

app.all("*", (_c) => {
  return new Response(null, { status: 404 });
});

// ─── message processing pipeline ─────────────────────────────────────

async function processMessage(
  msg: InboundMessage,
  config: HandleMessageEnv & { _useHyperdrive?: boolean; _calendars: Record<string, string> },
  execCtx: { waitUntil: (p: Promise<unknown>) => void },
): Promise<void> {
  // DEMO_ALLOWLIST filter
  if (
    config.DEMO_ALLOWLIST.length > 0 &&
    !config.DEMO_ALLOWLIST.includes(msg.from)
  ) {
    logger.info("Message from non-allowlisted number — dropping", {
      msg: `from=${msg.from}`,
    });
    return;
  }

  // Empty / whitespace-only text filter
  if (msg.type === "text" && msg.text !== null && msg.text.trim() === "") {
    return;
  }

  // Create DB and multi-calendar Gcal clients
  const sql = createDb(
    config.DATABASE_URL,
    config._useHyperdrive ? { ssl: false } : undefined,
  );
  const gcal = createGcalClient({
    calendars: config._calendars,
    saEmail: config.GCAL_SA_EMAIL,
    saPrivateKeyPem: config.GCAL_SA_PRIVATE_KEY,
    openHour: 10,
    closeHour: 20,
    slotMinutes: 30,
    closedWeekdays: [5],
    leadTimeMinutes: 60,
    horizonDays: 60,
  });

  // Defer — wraps ctx.waitUntil for the agent run
  const defer = (p: Promise<unknown>) => execCtx.waitUntil(p);

  await handleMessage(
    {
      waMessageId: msg.waMessageId,
      from: msg.from,
      timestamp: msg.timestamp,
      type: msg.type,
      text: msg.text,
      profileName: msg.profileName,
    },
    config,
    sql,
    gcal,
    defer,
  );
}

export default app;
