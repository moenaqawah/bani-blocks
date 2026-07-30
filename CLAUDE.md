# bani-blocks — CLAUDE.md

WhatsApp reservation agent for Layali Salon (fictional Amman hair salon), built as a demo of
the "one template, many isolated deployments" strategy (ADR-001): a shared block library
(`packages/*`) composed into per-client apps (`apps/*`).

Full spec: `../DESIGN-reservation-demo.md` (one directory above this repo). It is prescriptive —
"build exactly what is written, don't substitute libraries or improve flows." Treat it as the
source of truth for intended behavior; treat this file as the source of truth for *current state,
deployment, and things that bit us in practice*.

GitHub: `https://github.com/moenaqawah/bani-blocks` (branch `main`).

## Architecture

```
packages/          reusable blocks, zero Cloudflare-specific code
  shared/           time (fixed UTC+3, no tz lib), ref generator, logger (hashes phone numbers), AppError
  db/               postgres.js client + migrations + repositories (customers, conversations,
                    messages, bookings, ratelimit, locks)
  gcal-tool/        Google Calendar via raw fetch + WebCrypto (no googleapis package)
  whatsapp-adapter/ webhook verify/parse/send (Meta Graph API)
  agent-core/       provider-agnostic LLM orchestration (Vercel AI SDK v6)
apps/
  reservation-demo/ the one deployed app — Hono Worker. src/index.ts is the ONLY file allowed
                    to touch Cloudflare-specific APIs (ExecutionContext, env bindings, ctx.waitUntil)
```

**New app = new folder under `apps/`.** Reuses `packages/*` almost entirely; needs its own
`config.ts` (business hours/services), `prompt.ts` (system prompt), `wrangler.toml` (own Worker,
own URL), and usually its own Supabase project + Meta number + Calendar per ADR-001's isolation
model (each client fully separate — not shared tenancy).

## Deployment

**Platform: Cloudflare Workers.** `wrangler` is just the CLI, not the platform.

- Live Worker: `bani`, at `https://bani.baniai.workers.dev`
- Webhook registered with Meta: `https://bani.baniai.workers.dev/webhook/whatsapp`
- DB: Supabase Postgres, reached via a Cloudflare **Hyperdrive** binding (`[[hyperdrive]]` in
  `wrangler.toml`) — Workers cannot hold a direct Postgres connection without hitting the
  subrequest cap (confirmed in production 2026-07-28). `createDb()` takes `{ ssl: false }` when
  using Hyperdrive since its connection string already encodes `sslmode`.
- Cloudflare account: `motassem.naqawah@gmail.com` (`wrangler` is already authenticated locally)

Commands (run from repo root, always via `pnpm run <script>` — plain `pnpm deploy` collides
with pnpm's own built-in `deploy` command):

| Command | Effect |
|---|---|
| `pnpm run typecheck` | `tsc --noEmit` across all packages/apps — the only build gate, no bundling for internal packages |
| `pnpm run migrate` | applies `packages/db/migrations/*.sql`; `--reset` also re-runs the demo seed |
| `pnpm run dev` | `wrangler dev` locally |
| `pnpm run deploy` | `wrangler deploy` — ships `apps/reservation-demo/src/*` to the live Worker. **Does not touch secrets.** |
| `pnpm run smoke -- --url <url>` | 11-check smoke suite against a live deployment |
| `pnpm run evals -- --url <url>` | 10-case eval suite (E1–E10), synthetic Jordan-format numbers, results → `evals/results-<date>.json` |

**Secrets are separate from deploys** and persist across them:
```
cd apps/reservation-demo
npx wrangler secret put WHATSAPP_ACCESS_TOKEN   # reads value from stdin
npx wrangler secret list                        # names only, no values
npx wrangler deployments list                    # deploy/secret-change history with timestamps
```
Required secrets (see `.env.example` at root for the full list with dummy placeholders):
`DATABASE_URL`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_APP_SECRET`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GCAL_CALENDAR_ID`, `GCAL_SA_EMAIL`,
`GCAL_SA_PRIVATE_KEY`. Non-secret vars live in `wrangler.toml`'s `[vars]` block.

Local `.env` at repo root (gitignored) holds real credentials for local scripts/debugging —
distinct from what's deployed; a change to `.env` does **not** propagate to the Worker until you
run `wrangler secret put`.

## Debugging a "the agent isn't responding" report

Cheapest-to-most-expensive checks, in order:

1. `curl https://bani.baniai.workers.dev/health` → `{"ok":true,"db":true}` confirms Worker is up
   and DB is reachable. If this fails, it's Cloudflare/Hyperdrive/Supabase, not WhatsApp/Meta.
2. `npx wrangler deployments list` (from `apps/reservation-demo/`) — check timestamps against
   when things broke; rule out an accidental recent deploy/secret change.
3. Query the DB directly for recent activity (real credentials are in root `.env`; there's no
   `psql` in this environment — use the `postgres` package straight from `node_modules/.pnpm/`,
   see the `check-*.mjs` pattern used in past sessions). Check `messages` for recent inbound/outbound
   rows and whether outbound rows have a `wa_message_id` (send succeeded) or `wa_error` populated.
   If nothing is arriving at all, the webhook isn't being hit — that's a Meta-side problem, not ours.
4. Test the WhatsApp token directly against Graph API (`GET /{phone_number_id}` with
   `Authorization: Bearer <token>`), bypassing the Worker entirely. `"API access blocked"` /
   `OAuthException code 200` on *every* endpoint (including `/me`, `/debug_token`) is an
   app/WABA-level block, not a token-expiry issue — a freshly regenerated token will fail
   identically if so. **Actually happened 2026-07-29**: root cause was Business Verification not
   completed on a real (non-test) phone number registered to an unpublished/Development-mode app.
   Fixed by completing verification in Business Manager; regenerating the token then worked.
   Check: developers.facebook.com/apps → app dashboard banner + WhatsApp → API Setup; and
   business.facebook.com/settings → Business Info / Security Center for a verification prompt.
   Dev-mode alone (unpublished app) only restricts recipients to a tester allow-list and gives a
   *specific* "recipient not in allowed list" error — it does not produce a blanket block.

`wrangler secret put` takes effect immediately, no redeploy needed — it only updates what the
existing deployed code reads at runtime.

## Behavioral gotchas (things that look like bugs but aren't, and one that was)

- **"One booking at a time" is upcoming-only, not lifetime.** The gate
  (`findUpcomingLiveBookingForCustomer` in `packages/db/src/repositories/bookings.ts`) filters
  `starts_at > now() and status in ('pending','confirmed')`. A booking whose time has already
  passed no longer blocks a new one — this is intentional, not a double-booking hole. Confirmed
  in production 2026-07-29: a customer with an already-past haircut booking was correctly allowed
  to make a new future booking hours later.
- **`get_my_booking` uses the same upcoming-only query**, keyed only by `customer_id` — it does
  *not* search by name or date the customer mentions. When a customer asks about a booking that
  already happened, it currently returns `found: false` and the agent phrases this as if no such
  booking ever existed, which is misleading (it existed, it's just over). Tracked as item 10 in
  `notes/action-items.md` — planned fix: add an optional `mostRecentPast` field to the tool's
  existing `found: false` result (one more fixed query, no new tool, no new params, no date/name
  parsing pushed onto the model). Rejected: a separate `get_past_bookings` tool, and any
  "no upcoming + wants to book → check history" trigger — both add tool-call decision points
  `runAgent`'s `maxSteps: 6` budget doesn't need, and the latter would fire on every ordinary
  first booking from a repeat customer.
- **Customer identity is `wa_phone` only** — no login step. `upsertCustomer` does
  `insert ... on conflict (wa_phone) do update` keyed on the unique `wa_phone` column. The phone
  number *is* the identity; `display_name` is refreshed from WhatsApp's profile name but isn't
  part of the key.
- **Time handling is fixed UTC+3, no timezone library** — Jordan has had no DST since 2022, so
  `packages/shared/src/time.ts` hardcodes the offset rather than pulling in a tz database.

## Open work

Tracked in `notes/action-items.md` (local only, gitignored, not pushed to GitHub — re-create
this file if the repo is ever cloned fresh and this list matters). Current items: cron
reconciliation job for salon-side Calendar cancellations, proactive cancellation WhatsApp
template, waitlist feature, multi-calendar-per-business support, outbound message
dedup/batching, group bookings, richer Calendar event detail, multi-service bookings in one
request, and the `get_my_booking` past-booking fix above.

## Explicitly out of scope for this build (per user decisions)

- No admin dashboard (despite ADR-001 mentioning one) — punted for v1.
- Manual account setup (Meta app, Google Cloud service account, Supabase project, Cloudflare
  account/secrets) is the user's responsibility, not something to automate from here.
- Dependency versions are pinned exactly (no `^`/`~`) for demo reliability — don't loosen this
  without discussing it first.
