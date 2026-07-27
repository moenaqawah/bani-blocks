# Bani Blocks — WhatsApp Reservation Agent Demo

A WhatsApp bot for **Layali Salon** (صالون ليالي), a fictional hair salon in Amman, Jordan. Customers message the salon's WhatsApp number in Arabic or English, have a natural conversation, and walk away with a confirmed 30-minute appointment in Google Calendar.

Built with TypeScript on Cloudflare Workers, Vercel AI SDK v6, Gemini Flash, Supabase Postgres, and the Meta Cloud API.

## Architecture

```
WhatsApp user → Meta Cloud API → Cloudflare Worker (Hono) → agent-core (Vercel AI SDK)
                                                              ├── Gemini Flash
                                                              └── Google Calendar API
                                    Supabase Postgres ←── agent loop
```

This is a pnpm monorepo of reusable blocks:

| Package | Purpose |
|---------|---------|
| `@bani/shared` | Time helpers, logger, errors, booking refs |
| `@bani/db` | Postgres schema, client, repositories |
| `@bani/gcal-tool` | Google Calendar integration (service account + WebCrypto) |
| `@bani/whatsapp-adapter` | WhatsApp webhook verify, parse, send |
| `@bani/agent-core` | LLM model setup, memory, agent loop |
| `@bani/reservation-demo` | Hono Worker app composing all blocks |

## Quick Start

### Prerequisites
- Node.js ≥ 20, pnpm ≥ 9
- A Cloudflare account (free tier)
- A Supabase project (free tier)
- A Meta developer app with a WhatsApp test number
- A Google Cloud project with Calendar API enabled
- A Google AI Studio API key (Gemini free tier)

### Setup

```bash
pnpm install
cp .env.example .env
# Fill in .env with your credentials
pnpm run migrate
pnpm run deploy
```

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm run typecheck` | Type-check all packages (no emit) |
| `pnpm run migrate` | Apply pending DB migrations |
| `pnpm run migrate --reset` | Apply migrations + demo reset |
| `pnpm run dev` | Start wrangler dev server |
| `pnpm run deploy` | Deploy to Cloudflare Workers |
| `pnpm run smoke` | Run 10 smoke test checks |
| `pnpm run evals` | Run 10 eval conversation cases |

### Pre-Demo Checklist

1. Open the Supabase dashboard to wake the project
2. `pnpm run migrate --reset` — clears transcripts and recent bookings
3. Delete demo events from Google Calendar (keep the daily "Blocked" at 13:00)
4. `pnpm run smoke -- --url <worker-url>` — must be all green
5. `pnpm run evals -- --url <worker-url>` — must be 10/10
6. Confirm demo handset is in Meta allowed-number list

## Dependency Versions

| Package | Version | Purpose |
|---------|---------|---------|
| `hono` | 4.12.32 | HTTP router |
| `ai` | 6.0.235 | AI SDK core |
| `@ai-sdk/google` | 2.0.85 | Gemini provider |
| `@ai-sdk/openai` | 2.0.115 | OpenAI provider (optional) |
| `@ai-sdk/anthropic` | 2.0.91 | Anthropic provider (optional) |
| `@ai-sdk/groq` | 2.0.45 | Groq provider (optional) |
| `zod` | 4.4.3 | Tool input schemas |
| `postgres` | 3.4.9 | Postgres driver |
| `typescript` | 5.9.3 | Type checker |
| `wrangler` | 4.114.0 | Cloudflare Workers CLI |
| `tsx` | 4.23.1 | TS script runner |

## Environment Variables

See `.env.example` for the full list with descriptions. All are Worker secrets except where noted as plain vars in `wrangler.toml` `[vars]`.

## License

Private — Bani AI Agency.
