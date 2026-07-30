import type { Sql } from "postgres";
import type { GcalClient } from "@bani/gcal-tool";
import {
  loadHistory,
  insertInbound,
  insertOutbound,
  insertToolRow,
  touchConversation,
  getOrCreateOpenConversation,
  upsertCustomer,
  setCustomerLocale,
  markConsent,
  withConversationLock,
  findUpcomingLiveBookingsForCustomer,
  findBookingsByGroupId,
  type InboundRow,
} from "@bani/db";
import { sendText } from "@bani/whatsapp-adapter";
import {
  getModel,
  buildMemory,
  runAgent,
} from "@bani/agent-core";
import {
  logger,
  hashPhone,
  AppError,
  formatConfirmation,
  type ConfirmationBooking,
} from "@bani/shared";
import { buildSystemPrompt } from "./prompt.js";
import { buildTools, type ToolContext } from "./tools.js";
import { SERVICES, RESOURCES } from "./config.js";
import {
  CONSENT_LINE,
  bilingualMsg,
  detectLocale,
  type CannedKey,
} from "./i18n.js";

export interface HandleMessageEnv {
  // DB
  DATABASE_URL: string;
  // WhatsApp send
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_GRAPH_VERSION: string;
  // AI
  AI_PROVIDER: string;
  AI_MODEL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
  // Agent
  AGENT_HISTORY_LIMIT: number;
  AGENT_HISTORY_MAX_AGE_HOURS: number;
  // Calendar
  GCAL_CALENDAR_ID: string;
  GCAL_CALENDARS?: string;    // JSON: {"muna":"...","rana":"..."}
  GCAL_SA_EMAIL: string;
  GCAL_SA_PRIVATE_KEY: string;
  // Demo
  DEMO_ALLOWLIST: string[];
}

export interface InboundContext {
  waMessageId: string;
  from: string;
  timestamp: Date;
  type: string;
  text: string | null;
  profileName: string | null;
}

// ─── WhatsApp send + persist helper ──────────────────────────────────

interface SendParams {
  to: string;
  env: HandleMessageEnv;
}

async function sendAndPersist(
  sql: Sql,
  params: SendParams,
  body: string,
  conversationId: string,
  customerId: string,
  toolName?: string,
): Promise<void> {
  const results = await sendText({
    to: params.to,
    body,
    phoneNumberId: params.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: params.env.WHATSAPP_ACCESS_TOKEN,
    graphVersion: params.env.WHATSAPP_GRAPH_VERSION,
  });

  for (const r of results) {
    await insertOutbound(sql, {
      conversationId,
      customerId,
      content: body,
      waMessageId: r.waMessageId,
      ...(toolName !== undefined ? { toolName } : {}),
      waError: r.error ?? undefined,
    });
  }
}

// ─── consent helpers ─────────────────────────────────────────────────

function withConsentPrefix(body: string, isNewConv: boolean): string {
  return isNewConv ? CONSENT_LINE + "\n" + body : body;
}

async function markConsentIfNew(sql: Sql, customerId: string, isNewConv: boolean): Promise<void> {
  if (isNewConv) {
    await markConsent(sql, customerId).catch(() => {});
  }
}

// ─── media fallback ──────────────────────────────────────────────────

async function handleMediaFallback(
  sql: Sql,
  ctx: InboundContext,
  env: HandleMessageEnv,
  phoneHash: string,
): Promise<void> {
  logger.info("Non-text message — sending media fallback", {
    waPhoneHash: phoneHash,
    type: ctx.type,
  });

  const customer = await upsertCustomer(sql, ctx.from, ctx.profileName);
  const conv = await getOrCreateOpenConversation(sql, customer.id, new Date());

  const isNewConv = conv.last_user_message_at === null;
  const mediaMsg = withConsentPrefix(bilingualMsg("MEDIA", customer.locale), isNewConv);

  await sendAndPersist(sql, { to: ctx.from, env }, mediaMsg, conv.id, customer.id, "fallback_media");
  await touchConversation(sql, conv.id, false);
  await markConsentIfNew(sql, customer.id, isNewConv);
}

// ─── canned reply ────────────────────────────────────────────────────

async function sendCannedReply(
  sql: Sql,
  ctx: InboundContext,
  env: HandleMessageEnv,
  conversationId: string,
  customerId: string,
  locale: "ar" | "en",
  isNewConv: boolean,
  cannedKey: CannedKey,
): Promise<void> {
  const body = withConsentPrefix(bilingualMsg(cannedKey, locale), isNewConv);
  await sendAndPersist(sql, { to: ctx.from, env }, body, conversationId, customerId);
  await markConsentIfNew(sql, customerId, isNewConv);
}

// ─── confirmation block helpers ──────────────────────────────────────

/**
 * Extract the bookingGroupId from create_bookings tool output.
 * Returns undefined if no create_bookings call was made or none succeeded.
 */
function extractBookingGroupId(
  steps: Array<{ toolName: string; output: unknown }>,
): string | undefined {
  for (const step of steps) {
    if (step.toolName !== "create_bookings") continue;
    const out = step.output as Record<string, unknown> | undefined;
    if (!out?.bookingGroupId) continue;
    // Check that at least one bundle succeeded
    const results = out.results as Array<{ ok?: boolean }> | undefined;
    if (results?.some((r) => r.ok === true)) {
      return out.bookingGroupId as string;
    }
  }
  return undefined;
}

/**
 * Build the confirmation block from ACTUAL DB booking rows using the
 * bookingGroupId from create_bookings output. This is more reliable than
 * a time-window query — it links exactly to this booking attempt.
 */
async function extractConfirmations(
  sql: Sql,
  bookingGroupId: string,
  customerLocale: "ar" | "en",
): Promise<string> {
  const rows = await findBookingsByGroupId(sql, bookingGroupId);

  if (rows.length === 0) return "";

  // Group by bundle
  const byBundle = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = r.bundle_id;
    if (!byBundle.has(key)) byBundle.set(key, []);
    byBundle.get(key)!.push(r);
  }

  const bookings: ConfirmationBooking[] = [];
  for (const [, bundleRows] of byBundle) {
    const first = bundleRows[0]!;
    const totalDur = bundleRows.reduce((sum, r) => {
      const dur = SERVICES.find((s) => s.code === r.service_code)?.durationMinutes ?? 30;
      return sum + dur;
    }, 0);

    const svcNames = bundleRows.map((r) => {
      const cfg = SERVICES.find((s) => s.code === r.service_code);
      return customerLocale === "ar" ? (cfg?.ar ?? r.service_code) : (cfg?.en ?? r.service_code);
    });

    const rInfo = RESOURCES.find((x) => x.code === first.resource_code);
    const resourceName = customerLocale === "ar"
      ? (rInfo?.ar ?? first.resource_code)
      : (rInfo?.en ?? first.resource_code);

    bookings.push({
      ref: first.ref,
      startsAt: new Date(first.starts_at),
      services: svcNames,
      resourceName,
      durationMinutes: totalDur,
    });
  }

  return formatConfirmation(bookings, customerLocale);
}

// ─── invented-ref guard ──────────────────────────────────────────────

/**
 * Scan the reply for BK- patterns and verify every ref found appears in
 * this turn's tool outputs. An invented ref is logged at error.
 * Returns true if the reply is safe (all refs are genuine or there are none).
 */
function verifyRefsInReply(
  reply: string,
  steps: Array<{ toolName: string; output: unknown }>,
): boolean {
  const refsInReply = reply.match(/BK-[A-Z0-9]{6}/gi) ?? [];
  if (refsInReply.length === 0) return true;

  // Collect every legitimate ref from this turn's tool outputs
  const legitRefs = new Set<string>();
  for (const step of steps) {
    const output = step.output as Record<string, unknown> | undefined;
    if (!output) continue;

    const collectRef = (val: unknown) => {
      if (typeof val === "string" && /^BK-[A-Z0-9]{6}$/i.test(val)) {
        legitRefs.add(val.toUpperCase());
      }
    };

    // create_bookings: results[{ref}]
    if (Array.isArray((output as { results?: unknown[] }).results)) {
      for (const r of (output as { results: Array<{ ref?: string }> }).results) {
        if (r.ref) collectRef(r.ref);
      }
    }
    // Various single-ref shapes
    if ((output as { ref?: string }).ref) collectRef((output as { ref: string }).ref);
    if ((output as { oldRef?: string }).oldRef) collectRef((output as { oldRef: string }).oldRef);
    if ((output as { newRef?: string }).newRef) collectRef((output as { newRef: string }).newRef);
    // get_my_bookings: bookings[{ref}]
    if (Array.isArray((output as { bookings?: Array<{ ref: string }> }).bookings)) {
      for (const b of (output as { bookings: Array<{ ref: string }> }).bookings) {
        if (b.ref) collectRef(b.ref);
      }
    }
  }

  for (const ref of refsInReply) {
    if (!legitRefs.has(ref.toUpperCase())) {
      logger.error("INVENTED REF DETECTED in agent reply", {
        fabricatedRef: ref,
      });
      return false;
    }
  }

  return true;
}

// ─── integrity gate ──────────────────────────────────────────────────

/**
 * Hard post-agent validation: if the model claims booking success but no
 * confirmations were actually written to the DB, replace the reply with
 * an honest error message. This is code-level enforcement — not a prompt
 * tweak — because LLMs sometimes ignore soft rules after tool errors.
 */
function validateReplyIntegrity(
  reply: string,
  steps: Array<{ toolName: string; output: unknown; errorMessage?: string }>,
  confirmationBlock: string,
  locale: "ar" | "en",
): string {
  // If confirmation block has content, real bookings exist — reply is valid
  if (confirmationBlock.length > 0) return reply;

  // Find all create_bookings calls
  const bookingCalls = steps.filter((s) => s.toolName === "create_bookings");
  if (bookingCalls.length === 0) return reply; // No booking attempted

  // Did ANY create_bookings call return at least one ok:true?
  const anySuccess = bookingCalls.some((step) => {
    const out = step.output as Record<string, unknown> | undefined;
    const results = out?.results as Array<{ ok?: boolean }> | undefined;
    return results?.some((r) => r.ok === true) ?? false;
  });
  if (anySuccess) return reply;

  // All create_bookings calls failed entirely and confirmation is empty.
  // Scan the reply for success-claim language.
  const successPatterns = locale === "ar"
    ? /تم (الحجز|حجز|حجزت|تأكيد)|حجزتك|حجزنا|موعدك (?:صار |تمام|أكدنا|محجوز)|بشوفك|أكدنا|ثبّت|حجزتلك/
    : /\b(?:confirmed|booked|all set|see you|secured|locked in)\b/i;

  if (successPatterns.test(reply)) {
    logger.warn("Model claimed booking success but no rows confirmed — replacing reply", {
      replyPreview: reply.slice(0, 100),
    });
    return locale === "ar"
      ? "آسفين، صار في مشكلة تقنية وما قدرنا نأكد الحجز. ممكن تجرب مرة تانية؟"
      : "Sorry, there was a technical issue and we couldn't confirm your booking. Could you try again?";
  }

  return reply;
}

// ─── agent pipeline ──────────────────────────────────────────────────

interface PipelineParams {
  sql: Sql;
  gcal: GcalClient;
  ctx: InboundContext;
  env: HandleMessageEnv;
  customerId: string;
  conversationId: string;
  locale: "ar" | "en";
  isNewConv: boolean;
  inboundId: string;
  phoneHash: string;
}

async function runAgentPipeline(params: PipelineParams): Promise<void> {
  const { sql, gcal, ctx, env, customerId, conversationId, locale, isNewConv, inboundId, phoneHash } = params;

  // Load history
  const historyCutoff = new Date(
    Date.now() - env.AGENT_HISTORY_MAX_AGE_HOURS * 60 * 60 * 1000,
  );
  const rows = await loadHistory(
    sql,
    conversationId,
    env.AGENT_HISTORY_LIMIT,
    inboundId,
    historyCutoff,
  );
  const memory = buildMemory(rows);

  // Fetch current bookings for injection
  const currentBookings = await findUpcomingLiveBookingsForCustomer(
    sql, customerId, new Date(),
  );

  // Build tools and model
  const toolCtx: ToolContext = {
    sql,
    gcal,
    customerId,
    conversationId,
    waPhone: ctx.from,
    now: new Date(),
  };
  const tools = buildTools(toolCtx);
  const model = getModel(env);
  const systemPrompt = buildSystemPrompt(new Date(), locale, currentBookings);
  const userText = (ctx.text ?? "").slice(0, 4000);

  // Run the agent
  const result = await runAgent({
    systemPrompt,
    history: memory,
    userText,
    tools,
    model,
    maxSteps: 10,
  });

  // Persist tool steps (include errorMessage so we can debug failures)
  for (const step of result.steps) {
    await insertToolRow(sql, {
      conversationId,
      customerId,
      toolName: step.toolName,
      payload: {
        input: step.input,
        output: step.output,
        ...(step.errorMessage ? { error: step.errorMessage } : {}),
      },
    });
  }

  // Invented-ref guard
  if (!verifyRefsInReply(result.text, result.steps)) {
    logger.warn("Agent reply contained invented ref — will trigger integrity gate", {
      waPhoneHash: phoneHash,
    });
  }

  // Build confirmation block using bookingGroupId from tool output
  let confirmationBlock = "";
  const bookingGroupId = extractBookingGroupId(result.steps);
  if (bookingGroupId) {
    confirmationBlock = await extractConfirmations(sql, bookingGroupId, locale);
  }

  // Integrity gate: if model claims success but nothing was confirmed, veto
  result.text = validateReplyIntegrity(result.text, result.steps, confirmationBlock, locale);

  // Send reply
  const reply = withConsentPrefix(result.text + confirmationBlock, isNewConv);
  await sendAndPersist(sql, { to: ctx.from, env }, reply, conversationId, customerId);
  await markConsentIfNew(sql, customerId, isNewConv);
  await touchConversation(sql, conversationId, true);
}

// ─── main handler ────────────────────────────────────────────────────

export async function handleMessage(
  ctx: InboundContext,
  env: HandleMessageEnv,
  sql: Sql,
  gcal: GcalClient,
  defer: (p: Promise<unknown>) => void,
): Promise<void> {
  const phoneHash = await hashPhone(ctx.from);

  // 1. Media / non-text → fast path, no LLM
  if (ctx.text === null && !["button", "interactive"].includes(ctx.type)) {
    await handleMediaFallback(sql, ctx, env, phoneHash);
    return;
  }

  // 2. Resolve customer and conversation
  const customer = await upsertCustomer(sql, ctx.from, ctx.profileName);
  const locale = detectLocale(ctx.text);
  await setCustomerLocale(sql, customer.id, locale);

  const conv = await getOrCreateOpenConversation(sql, customer.id, new Date());

  // 3. Persist inbound (skip if duplicate)
  const inboundRow: InboundRow = {
    conversationId: conv.id,
    customerId: customer.id,
    content: ctx.text ?? "",
    waMessageId: ctx.waMessageId,
  };
  const inbound = await insertInbound(sql, inboundRow);
  if (!inbound) {
    logger.debug("Duplicate message — skipping", {
      waPhoneHash: phoneHash,
      wamid: ctx.waMessageId,
    });
    return;
  }

  // 4. Run agent pipeline inside conversation lock, deferred
  const isNewConv = conv.last_user_message_at === null;

  const pipelineParams: PipelineParams = {
    sql, gcal, ctx, env,
    customerId: customer.id,
    conversationId: conv.id,
    locale,
    isNewConv,
    inboundId: inbound.id,
    phoneHash,
  };

  defer(
    withConversationLock(sql, conv.id, async () => {
      try {
        await runAgentPipeline(pipelineParams);
      } catch (err) {
        logger.error("handleMessage failed", {
          waPhoneHash: phoneHash,
          conversationId: conv.id,
          msg: err instanceof Error ? err.message : String(err),
        });

        const cannedKey = err instanceof AppError && err.kind === "LLM_RATE" ? "BUSY" : "ERROR";

        try {
          await sendCannedReply(sql, ctx, env, conv.id, customer.id, locale, isNewConv, cannedKey);
        } catch (sendErr) {
          logger.error("Failed to send canned error message", {
            waPhoneHash: phoneHash,
            msg: sendErr instanceof Error ? sendErr.message : String(sendErr),
          });
        }
      }
    }).then((lockResult) => {
      if (lockResult === "LOCK_TIMEOUT") {
        defer(
          (async () => {
            try {
              await sendCannedReply(sql, ctx, env, conv.id, customer.id, locale, isNewConv, "BUSY");
            } catch (sendErr) {
              logger.error("Failed to send BUSY message for LOCK_TIMEOUT", {
                waPhoneHash: phoneHash,
                msg: sendErr instanceof Error ? sendErr.message : String(sendErr),
              });
            }
          })(),
        );
      }
    }),
  );
}
