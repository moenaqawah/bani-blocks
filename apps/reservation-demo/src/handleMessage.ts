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
} from "@bani/shared";
import { buildSystemPrompt } from "./prompt.js";
import { buildTools, type ToolContext } from "./tools.js";
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

/**
 * Send text via WhatsApp and persist an outbound row for every part.
 * This single helper replaces 5 copies of the same ~15-line block.
 */
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

/**
 * Prepend the consent line if this is the first message in a conversation.
 */
function withConsentPrefix(body: string, isNewConv: boolean): string {
  return isNewConv ? CONSENT_LINE + "\n" + body : body;
}

/**
 * Mark consent on a new conversation. Best-effort — failures are ignored.
 */
async function markConsentIfNew(sql: Sql, customerId: string, isNewConv: boolean): Promise<void> {
  if (isNewConv) {
    await markConsent(sql, customerId).catch(() => {});
  }
}

// ─── media fallback ──────────────────────────────────────────────────

/**
 * Handle non-text messages (images, audio, etc.) — send a MEDIA fallback
 * and return. This is a fast path that never calls the LLM.
 */
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

/**
 * Send a canned BUSY or ERROR message (with consent prefix on new convs)
 * and persist. Used by the error handler and LOCK_TIMEOUT path.
 */
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

/**
 * Run the full agent pipeline inside the conversation lock:
 * load history → acquire LLM slot → run agent → persist steps → send reply.
 *
 * On failure, sends a canned BUSY or ERROR reply and logs.
 */
async function runAgentPipeline(params: PipelineParams): Promise<void> {
  const { sql, gcal, ctx, env, customerId, conversationId, locale, isNewConv, inboundId, phoneHash } = params;

  // Load history — bounded by both message count and recency
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
  const systemPrompt = buildSystemPrompt(new Date(), locale);
  const userText = (ctx.text ?? "").slice(0, 4000);

  // Run the agent
  const result = await runAgent({
    systemPrompt,
    history: memory,
    userText,
    tools,
    model,
    maxSteps: 6,
  });

  // Persist tool steps
  for (const step of result.steps) {
    await insertToolRow(sql, {
      conversationId,
      customerId,
      toolName: step.toolName,
      payload: { input: step.input, output: step.output },
    });
  }

  // Send reply
  const reply = withConsentPrefix(result.text, isNewConv);
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
