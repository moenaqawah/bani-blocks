# bani-blocks — CLAUDE.md

WhatsApp reservation agent for Layali Salon (fictional Amman hair salon), built as a demo of
the "one template, many isolated deployments" strategy (ADR-001): a shared block library
(`packages/*`) composed into per-client apps (`apps/*`).

Full spec: `../DESIGN-reservation-demo.md` (one directory above this repo). It is prescriptive —
"build exactly what is written, don't substitute libraries or improve flows." **`../ADR-004-state-driven-agent.md`
supersedes it for the agent pipeline** (and supersedes ADR-003 entirely). Treat this file as the
source of truth for *current state, deployment, and things that bit us in practice*.

GitHub: `https://github.com/moenaqawah/bani-blocks` (branch `main`).

## Architecture — three layers, only the middle one decides (ADR-004)

The LLM does **not** drive the booking flow. It appears twice, at the edges, and never in the
control path:

```
inbound → 1. TRANSLATOR (LLM, one constrained call)  (state, message) → intents. No tools, no prose.
          2. ORCHESTRATOR (pure TypeScript)          (state, intents) → transitions + effects + reply blocks
          3. RENDERER (LLM, guarded)                 resolved payload → text; generated fallback on failure
```

Layer 3's rule: **code computes every value; the LLM writes only the sentences between them.** The
model receives finished, locale-correct values (`"Monday 3 August"`, `"صبغة شعر"`, `"Muna"`) plus a
verdict and a speech act — never codes, ISO dates, or prose to restyle. See ADR-004 revision 1.

If the translator returns garbage the orchestrator rejects it and the customer gets a clarifying
question — the flow itself cannot be derailed. There is no agentic tool loop and no `runAgent`.

```
packages/          reusable blocks, zero Cloudflare-specific code
  shared/           time (fixed UTC+3, no tz lib), ref generator, logger (hashes phone numbers), AppError
  db/               postgres.js client + migrations + repositories (customers, conversations,
                    messages, bookings, drafts, ratelimit, locks)
  availability/     PURE engine: partitionServices, mergeCalendars, buildGrid, windowSuggestions.
                    No I/O — callers pass busy intervals in and get candidate start times back.
  orchestrator/     PURE state machine: the intent catalog, VisitState, `step()`, `runTurn()`,
                    the state block shown to the translator, and each block's speech act.
                    No clock, no DB, no model.
  gcal-tool/        Google Calendar via raw fetch + WebCrypto (no googleapis package)
  whatsapp-adapter/ webhook verify/parse/send (Meta Graph API)
  agent-core/       provider-agnostic model wiring + translate() / humanize() / answerQuestion()
                    + the fact and speech-act post-checks
apps/
  reservation-demo/ the one deployed app — Hono Worker. src/index.ts is the ONLY file allowed
                    to touch Cloudflare-specific APIs (ExecutionContext, env bindings, ctx.waitUntil)
```

The app's own files, in pipeline order: `salon.ts` (config → block shapes) → `intent-schema.ts`
(zod, service enum **generated** from config) → `translator-prompt.ts` → `turn.ts` (the lifecycle)
→ `effects.ts` (the only I/O the orchestrator can ask for) → `state-store.ts` (row ↔ domain)
→ `reply-payload.ts` (codes and ISO dates → finished values + the fact set + the fallback)
→ `verdicts.ts` (what each decision means) → `voice.ts` (tone only — no business facts).

**New app = new folder under `apps/`.** Reuses `packages/*` entirely; needs its own `config.ts`
(hours/services/roster) and `voice.ts` (its tone), `wrangler.toml`, and usually its own Supabase
project + Meta number + Calendar per ADR-001's isolation model (each client fully separate — not
shared tenancy). It does **not** need its own flow logic — that's `packages/orchestrator` — and it
does not need a copy pack: `verdicts.ts` and `reply-payload.ts` are business-shaped, not brand-shaped,
so most clients inherit them unchanged.

### Where to make a change

| You want to… | Change |
|---|---|
| add a booking capability | a member of `Intent` + a handler in `handle-intent.ts` + a `ReplyBlock` + its `SpeechAct` + a line in `verdicts.ts` |
| change the bot's *tone* | `voice.ts` |
| change what a decision *means* | `verdicts.ts` — describe the situation, don't dictate wording |
| change *when* it says it | `packages/orchestrator` — never a prompt |
| add a value the customer reads | `reply-payload.ts` — resolve it in code and record it as a fact, or the post-check can't guard it |
| fix a mislabelled message | a few-shot in `translator-prompt.ts` **and** a case in `evals/intent-set.ts` |
| add a service or employee | `config.ts` only — the intent enum, capability checks, grouping and all customer-facing names derive from it |

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
| `pnpm run test` | `node --test` over `packages/*/test/*.test.ts` via tsx. **Booking correctness lives here** — pure, no LLM, no DB, ~150ms. Run it on every flow change. |
| `pnpm run migrate` | applies `packages/db/migrations/*.sql`; `--reset` also re-runs the demo seed |
| `pnpm run dev` | `wrangler dev` locally |
| `pnpm run deploy` | `wrangler deploy` — ships `apps/reservation-demo/src/*` to the live Worker. **Does not touch secrets.** |
| `pnpm run smoke -- --url <url>` | 14-check suite against a live deployment. Checks only what a deploy can break — wiring, credentials, schema drift — never booking logic, which `pnpm run test` already proves offline. Sends one real WhatsApp message and creates/cancels one real booking. |
| `pnpm run evals` | translator eval: runs `evals/intent-set.ts` through Layer 1 only. No Worker, no DB, no bookings created. `-- --only T15,T30`, `-- --gate 95`. Results → `evals/translator-<date>.json` |

No test runner was added — Node 24's built-in `node:test` plus the existing `tsx` covers it, so the
pinned dependency set is unchanged.

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

0. `pnpm run smoke -- --url https://bani.baniai.workers.dev` answers most of the list below in one
   pass — including the two silent failures worth ruling out early: **a calendar not shared with
   the service account** (check 12; reads as fully busy, so the agent politely offers nothing and
   looks broken) and **a deploy without a migrate** (check 10). It sends one real WhatsApp message.
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

- **A booking's limits are upcoming-only, not lifetime.** `countUpcomingVisitsForCustomer` and
  `findUpcomingLiveBookingsForCustomer` filter `starts_at > now() and status = 'confirmed'`.
  A booking whose time has already passed no longer counts against the cap — intentional, not a
  double-booking hole. Confirmed in production 2026-07-29.
- **There is no `pending` booking status.** Migration 0004 removed it: rows INSERT as `confirmed`
  and the exclusion constraint protects the slot from the moment of insert. ADR-004 Appendix A
  still describes a "pending insert as the hold mechanism" — that part of the ADR describes the
  pre-0004 world; the constraint is the arbiter either way. `failBundle` releases a slot when
  Google sync fails after the row exists.
- **There is no `resources` table.** ADR-004 A.3 proposes `alter table resources …`; the roster
  lives in `config.ts` and calendar ids in the `GCAL_CALENDARS` secret, validated at boot by
  `validateCalendarConfig` in `index.ts`. Config is authoritative, as ADR-002 wants.
- **A "group" is the booking unit, and its key is derived, not stored.** `partitionServices`
  produces `key = services.sort().join("+")` — so `color+haircut`. It is stable across turns,
  which is what lets the translator refer to a group by name in `choose_slot`.
- **When two employees offer the same time and the customer doesn't name one**, the orchestrator
  takes the first in the offer list (sorted by most availability). Deterministic and silent by
  design — asking "which of the two?" costs a round trip for a distinction most customers don't care
  about. If a client wants the question, it's a new `PendingQuestion` kind.
- **This is a booking service, not an information line.** A `question` intent (prices, products,
  policy, location) produces `cannot_answer` — declined, never answered. There is deliberately no
  FAQ responder: it was removed on 2026-08-01 because it was the one path whose output bypassed
  the renderer entirely, and because everything it could answer was config that drifts from what
  the salon actually does. `cannot_answer` carries **no fields** on purpose; handing the renderer
  the question text invites it to answer. Don't add business facts back into `voice.ts`.
- **The post-check rejects only INVENTION. Keep it that way.** `checkFacts` returns `problems`
  (a ref or time in the reply that isn't in the payload — these send the fallback) and `warnings`
  (omissions and rewordings — these ship, and are logged). The first live day of ADR-004 was spent
  discovering that a stricter check is worse than none: it rejected `قص الشعر` against a catalog
  entry of `قص شعر`, and "Let me know which time works for you" for lacking a `?`. Every affected
  reply silently shipped the field-dump fallback. **A post-check that rejects good output is an
  outage with a log line.** If you tighten this, watch the `humanize output rejected` rate first.
- **The renderer cannot see the customer's message.** It gets the payload and nothing else, so it
  cannot infer the reply language — `humanize` states it explicitly per message. Removing that
  directive doesn't cause a wrong-language *warning*; it causes the model to answer in Arabic to
  an English customer, which drops every resolved value and degrades every English reply to the
  fallback. Same applies to anything else the renderer might seem to "just know": it doesn't.
- **A value the resolver prints but doesn't declare goes unguarded.** `reply-payload.ts` builds the
  `FactSet`. A time printed without `keepTime` is one the invention check will happily let the
  model change. Caught twice (`outside_hours` printing the closing time, `cancel_not_found`
  echoing the customer's ref); `test/reply-payload.test.ts` sweeps every block kind in both
  locales to catch a third.
- **`SpeechAct` covers the one thing facts cannot.** "Shall I cancel BK-123 at 11:00?" and
  "BK-123 at 11:00 is cancelled" contain byte-identical refs, times and names. `checkSpeechActs`
  is deliberately scoped to questions **about an existing booking** — applying it to every
  question is what rejected the good offer messages above. `SPEECH_ACTS` is a total record over
  the block union, so a new `ReplyBlock` without a declared act is a compile error — don't reach
  for a cast to silence it.
- **The offer list is the anti-hallucination lock.** `VisitGroup.offered` records exactly what was
  shown; `choose_slot` for anything else returns `slot_not_offered` and emits no effect. This is
  enforced in `validate.ts`, not in a prompt, and is covered by property tests.
- **`bookings.booking_group_id` is the visit draft's id**, which is what makes "cancel the whole
  visit" one query. It is assigned when the draft row is first saved — always at least one turn
  before any booking exists, because a slot must be offered before it can be chosen.
- **Customer identity is `wa_phone` only** — no login step. `upsertCustomer` does
  `insert ... on conflict (wa_phone) do update` keyed on the unique `wa_phone` column. The phone
  number *is* the identity; `display_name` is refreshed from WhatsApp's profile name but isn't
  part of the key.
- **Time handling is fixed UTC+3, no timezone library** — Jordan has had no DST since 2022, so
  `packages/shared/src/time.ts` hardcodes the offset rather than pulling in a tz database.

## Open work

Tracked in `notes/action-items.md` (local only, gitignored, not pushed to GitHub — re-create
this file if the repo is ever cloned fresh and this list matters). Its first section records
which items the ADR-004 refactor closed or obsoleted.

**Not yet done from ADR-004 itself:**

- **Shadow mode (migration step 6) was not built.** The cutover is direct. Nothing has been
  deployed and migration 0005 has not been applied.
- **The labelled intent set is seeded, not real** — 58 synthetic ar/en cases in
  `apps/reservation-demo/evals/intent-set.ts`. The ADR wants ≥100 real messages gating at 95%;
  that needs production traffic. Add every production mislabel to that file *and* as a few-shot.
- **`packages/gcal-tool/src/slots.ts` is now mostly dead** — the old tools' engine, replaced by
  `packages/availability`. Kept only because `scripts/smoke.ts` still imports it.

Still open and unaffected: cron reconciliation for salon-side Calendar cancellations, proactive
cancellation WhatsApp template, waitlist, outbound message dedup/batching, group bookings,
richer Calendar event detail.

## Explicitly out of scope for this build (per user decisions)

- No admin dashboard (despite ADR-001 mentioning one) — punted for v1.
- Manual account setup (Meta app, Google Cloud service account, Supabase project, Cloudflare
  account/secrets) is the user's responsibility, not something to automate from here.
- Dependency versions are pinned exactly (no `^`/`~`) for demo reliability — don't loosen this
  without discussing it first.
