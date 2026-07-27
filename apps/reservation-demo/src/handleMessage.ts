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
} from "@bani/shared";
import { buildSystemPrompt } from "./prompt.js";
import { buildTools, type ToolContext } from "./tools.js";

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
  AI_MAX_RPM: number;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
  // Agent
  AGENT_HISTORY_LIMIT: number;
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

// ─── consent line ───────────────────────────────────────────────────

const CONSENT_LINE =
  "صالون ليالي — مساعد آلي. بنستخدم رقمك وبياناتك فقط لإدارة الحجز.\n" +
  "Layali Salon — automated assistant. We use your number and details only to manage your booking.\n";

// ─── canned messages ────────────────────────────────────────────────

const CANNED = {
  BUSY: {
    ar: "عذراً، في ضغط على النظام هلق 🙏 جرب تبعتلي بعد شوي.",
    en: "Sorry, the system is busy right now. Please try again in a moment.",
  },
  ERROR: {
    ar: "صار عندنا خلل تقني بسيط. جرب تبعت رسالتك مرة تانية من فضلك.",
    en: "We hit a technical problem. Please send your message again.",
  },
  MEDIA: {
    ar: "عذراً، أستطيع قراءة الرسائل النصية فقط 🙏 اكتب لي طلبك بالكلمات مثلاً: \"بدي موعد قص شعر بكرا الساعة ٥\".",
    en: 'Sorry, I can only read text messages. Please type your request, for example: "I\'d like a haircut tomorrow at 5pm".',
  },
} as const;

function bilingualMsg(key: keyof typeof CANNED, locale: "ar" | "en"): string {
  const c = CANNED[key];
  if (locale === "ar") return c.ar;
  if (locale === "en") return c.en;
  // Fallback: both
  return c.ar + "\n" + c.en;
}

/**
 * Determine locale from message text — Arabic character detection.
 */
function detectLocale(text: string | null): "ar" | "en" {
  if (!text) return "en";
  return /[؀-ۿ]/.test(text) ? "ar" : "en";
}

/**
 * Check if a message body looks like Arabic.
 */
export function isArabic(text: string): boolean {
  return /[؀-ۿ]/.test(text);
}

// ─── main handler ───────────────────────────────────────────────────

export async function handleMessage(
  ctx: InboundContext,
  env: HandleMessageEnv,
  sql: Sql,
  gcal: GcalClient,
  defer: (p: Promise<unknown>) => void,
): Promise<void> {
  const phoneHash = await hashPhone(ctx.from);

  // 1. Media / non-text → fallback (fast path, no LLM)
  if (
    ctx.text === null &&
    !["button", "interactive"].includes(ctx.type)
  ) {
    logger.info("Non-text message — sending media fallback", {
      waPhoneHash: phoneHash,
      type: ctx.type,
    });
    // Resolve customer
    const customer = await upsertCustomer(sql, ctx.from, ctx.profileName);
    const conv = await getOrCreateOpenConversation(
      sql,
      customer.id,
      new Date(),
    );

    // Persist inbound as a placeholder? No — the design says don't persist media inbound (it was filtered)
    // Actually, the design says: persist the inbound row normally but with type filter at 3.7
    // For media: send fallback, do not call LLM
    const mediaMsg =
      (conv.status === "open" &&
        new Date(conv.last_message_at).getTime() >
          new Date().getTime() - 24 * 60 * 60 * 1000 &&
        conv.last_user_message_at !== null
        ? ""
        : CONSENT_LINE + "\n") +
      bilingualMsg("MEDIA", customer.locale);

    const results = await sendText({
      to: ctx.from,
      body: mediaMsg,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      graphVersion: env.WHATSAPP_GRAPH_VERSION,
    });

    for (const r of results) {
      await insertOutbound(sql, {
        conversationId: conv.id,
        customerId: customer.id,
        content: mediaMsg,
        waMessageId: r.waMessageId,
        toolName: "fallback_media",
        waError: r.error ?? undefined,
      });
    }
    await touchConversation(sql, conv.id, false);

    if (conv.status === "open" && customer.consent_at === null) {
      await markConsent(sql, customer.id);
    }
    return;
  }

  // 2. Resolve customer, conversation
  const customer = await upsertCustomer(sql, ctx.from, ctx.profileName);
  const locale = detectLocale(ctx.text);
  await setCustomerLocale(sql, customer.id, locale);

  const conv = await getOrCreateOpenConversation(
    sql,
    customer.id,
    new Date(),
  );

  // 3. Persist inbound
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

  // 4. Serialise and run agent
  const isNewConv = conv.last_user_message_at === null;

  defer(
    withConversationLock(sql, conv.id, async () => {
      try {
        await touchConversation(sql, conv.id, true);

        // Load history
        const rows = await loadHistory(
          sql,
          conv.id,
          env.AGENT_HISTORY_LIMIT,
          inbound.id,
        );

        const memory = buildMemory(rows);

        const toolCtx: ToolContext = {
          sql,
          gcal,
          customerId: customer.id,
          conversationId: conv.id,
          waPhone: ctx.from,
          now: new Date(),
        };

        const tools = buildTools(toolCtx);
        const model = getModel(env);
        const systemPrompt = buildSystemPrompt(new Date());

        const userText = ctx.text ?? "";

        const result = await runAgent({
          systemPrompt,
          history: memory,
          userText: userText.length > 4000 ? userText.slice(0, 4000) : userText,
          tools,
          model,
          maxSteps: 6,
        });

        // Persist tool steps
        for (const step of result.steps) {
          await insertToolRow(sql, {
            conversationId: conv.id,
            customerId: customer.id,
            toolName: step.toolName,
            payload: { input: step.input, output: step.output },
          });
        }

        // Build reply
        let reply = result.text;

        // Prepend consent line on first message
        if (isNewConv) {
          reply = CONSENT_LINE + "\n" + reply;
          await markConsent(sql, customer.id);
        }

        // Send
        const results = await sendText({
          to: ctx.from,
          body: reply,
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          accessToken: env.WHATSAPP_ACCESS_TOKEN,
          graphVersion: env.WHATSAPP_GRAPH_VERSION,
        });

        for (const r of results) {
          await insertOutbound(sql, {
            conversationId: conv.id,
            customerId: customer.id,
            content: reply,
            waMessageId: r.waMessageId,
            waError: r.error ?? undefined,
          });
        }

        await touchConversation(sql, conv.id, false);
      } catch (err) {
        logger.error("handleMessage failed", {
          waPhoneHash: phoneHash,
          conversationId: conv.id,
          msg: err instanceof Error ? err.message : String(err),
        });

        // Send ERROR canned reply
        try {
          const errorMsg = isNewConv
            ? CONSENT_LINE + "\n" + bilingualMsg("ERROR", locale)
            : bilingualMsg("ERROR", locale);

          const results = await sendText({
            to: ctx.from,
            body: errorMsg,
            phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
            accessToken: env.WHATSAPP_ACCESS_TOKEN,
            graphVersion: env.WHATSAPP_GRAPH_VERSION,
          });

          for (const r of results) {
            await insertOutbound(sql, {
              conversationId: conv.id,
              customerId: customer.id,
              content: errorMsg,
              waMessageId: r.waMessageId,
              waError: r.error ?? undefined,
            });
          }

          if (isNewConv) {
            await markConsent(sql, customer.id).catch(() => {});
          }
        } catch {
          // Best effort — the customer gets silence but we logged
        }
      }
    }).then((lockResult) => {
      if (lockResult === "LOCK_TIMEOUT") {
        // Send BUSY canned message
        defer(
          (async () => {
            const busyMsg = isNewConv
              ? CONSENT_LINE + "\n" + bilingualMsg("BUSY", locale)
              : bilingualMsg("BUSY", locale);
            try {
              const results = await sendText({
                to: ctx.from,
                body: busyMsg,
                phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
                accessToken: env.WHATSAPP_ACCESS_TOKEN,
                graphVersion: env.WHATSAPP_GRAPH_VERSION,
              });
              for (const r of results) {
                await insertOutbound(sql, {
                  conversationId: conv.id,
                  customerId: customer.id,
                  content: busyMsg,
                  waMessageId: r.waMessageId,
                  waError: r.error ?? undefined,
                });
              }
            } catch {
              // Best effort
            }
          })(),
        );
      }
    }),
  );
}
