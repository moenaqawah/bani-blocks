import type { Sql } from "postgres";
import type { GcalClient } from "@bani/gcal-tool";
import {
  getOrCreateOpenConversation,
  insertInbound,
  insertOutbound,
  insertToolRow,
  loadHistory,
  markConsent,
  setCustomerLocale,
  touchConversation,
  upsertCustomer,
  withConversationLock,
  type InboundRow,
} from "@bani/db";
import { sendText, showTyping } from "@bani/whatsapp-adapter";
import { buildMemory, getModel } from "@bani/agent-core";
import { AppError, hashPhone, logger } from "@bani/shared";
import { runConversationTurn } from "./turn.js";
import { CONSENT_LINE, bilingualMsg, detectLocale, type CannedKey } from "./i18n.js";

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
  // Conversation history shown to the translator
  AGENT_HISTORY_LIMIT: number;
  AGENT_HISTORY_MAX_AGE_HOURS: number;
  // Calendar
  GCAL_CALENDAR_ID: string;
  GCAL_CALENDARS?: string; // JSON: {"muna":"...","rana":"..."}
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

async function sendAndPersist(
  sql: Sql,
  to: string,
  env: HandleMessageEnv,
  body: string,
  conversationId: string,
  customerId: string,
  toolName?: string,
): Promise<void> {
  const results = await sendText({
    to,
    body,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
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
  if (isNewConv) await markConsent(sql, customerId).catch(() => {});
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
  const body = withConsentPrefix(bilingualMsg("MEDIA", customer.locale), isNewConv);

  await sendAndPersist(sql, ctx.from, env, body, conv.id, customer.id, "fallback_media");
  await touchConversation(sql, conv.id, false);
  await markConsentIfNew(sql, customer.id, isNewConv);
}

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
  await sendAndPersist(sql, ctx.from, env, body, conversationId, customerId);
  await markConsentIfNew(sql, customerId, isNewConv);
}

// ─── pipeline ────────────────────────────────────────────────────────

interface PipelineParams {
  sql: Sql;
  gcal: GcalClient;
  ctx: InboundContext;
  env: HandleMessageEnv;
  customerId: string;
  customerName: string | null;
  conversationId: string;
  locale: "ar" | "en";
  isNewConv: boolean;
  inboundId: string;
}

async function runPipeline(params: PipelineParams): Promise<void> {
  const { sql, ctx, env, customerId, conversationId, locale, isNewConv } = params;
  const now = new Date();

  // Not awaited: the customer should see "typing…" while the turn runs, but a
  // cosmetic call must never delay — or fail — the reply itself.
  void showTyping({
    waMessageId: ctx.waMessageId,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: env.WHATSAPP_ACCESS_TOKEN,
    graphVersion: env.WHATSAPP_GRAPH_VERSION,
  });

  const historyCutoff = new Date(now.getTime() - env.AGENT_HISTORY_MAX_AGE_HOURS * 60 * 60 * 1000);
  const history = buildMemory(
    await loadHistory(sql, conversationId, env.AGENT_HISTORY_LIMIT, params.inboundId, historyCutoff),
  );

  const outcome = await runConversationTurn({
    sql,
    gcal: params.gcal,
    model: getModel(env),
    customerId,
    conversationId,
    customerName: params.customerName,
    waPhone: ctx.from,
    history,
    userText: (ctx.text ?? "").slice(0, 4000),
    locale,
    now,
  });

  // Intents and transitions are better eval data than tool payloads ever were.
  await insertToolRow(sql, {
    conversationId,
    customerId,
    toolName: "turn",
    payload: { input: outcome.intents, output: outcome.blocks.map((b) => b.kind) },
  }).catch((err) => logger.warn("failed to log turn", { msg: String(err) }));

  await sendAndPersist(
    sql,
    ctx.from,
    env,
    withConsentPrefix(outcome.text, isNewConv),
    conversationId,
    customerId,
  );
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
    logger.debug("Duplicate message — skipping", { waPhoneHash: phoneHash, wamid: ctx.waMessageId });
    return;
  }

  // 4. Run the turn inside the conversation lock, deferred
  const isNewConv = conv.last_user_message_at === null;
  const params: PipelineParams = {
    sql,
    gcal,
    ctx,
    env,
    customerId: customer.id,
    customerName: customer.display_name,
    conversationId: conv.id,
    locale,
    isNewConv,
    inboundId: inbound.id,
  };

  defer(
    withConversationLock(sql, conv.id, async () => {
      try {
        await runPipeline(params);
      } catch (err) {
        logger.error("handleMessage failed", {
          waPhoneHash: phoneHash,
          conversationId: conv.id,
          msg: err instanceof Error ? err.message : String(err),
        });

        const cannedKey: CannedKey =
          err instanceof AppError && err.kind === "LLM_RATE" ? "BUSY" : "ERROR";
        await sendCannedReply(sql, ctx, env, conv.id, customer.id, locale, isNewConv, cannedKey).catch(
          (sendErr) =>
            logger.error("Failed to send canned error message", {
              waPhoneHash: phoneHash,
              msg: sendErr instanceof Error ? sendErr.message : String(sendErr),
            }),
        );
      }
    }).then((lockResult) => {
      if (lockResult !== "LOCK_TIMEOUT") return;
      defer(
        sendCannedReply(sql, ctx, env, conv.id, customer.id, locale, isNewConv, "BUSY").catch(
          (sendErr) =>
            logger.error("Failed to send BUSY message for LOCK_TIMEOUT", {
              waPhoneHash: phoneHash,
              msg: sendErr instanceof Error ? sendErr.message : String(sendErr),
            }),
        ),
      );
    }),
  );
}
