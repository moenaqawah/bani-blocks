#!/usr/bin/env bash
# Manual testing helper — sends a synthetic, correctly-signed WhatsApp
# webhook message straight to the deployed Worker, then polls the DB for
# the bot's actual reply. Pairs well with watch-logs.sh running in another
# terminal (real-time processing/error visibility while this prints the
# actual reply text once it lands).
#
# Usage:
#   ./test-webhook.sh "بدي احجز قص شعر بكرا"
#   PHONE=962790000098 ./test-webhook.sh "hi, are you open tomorrow?"
#
# Reuses the same phone number across calls in the same shell session by
# default, so a multi-turn conversation just means calling this repeatedly —
# the bot sees it as one ongoing conversation, same as a real WhatsApp thread.
set -euo pipefail
cd "$(dirname "$0")"

WORKER_URL="${WORKER_URL:-https://bani.baniai.workers.dev}"
PHONE="${PHONE:-962790000099}"   # smoke/eval-reserved test number — don't use a real one
TEXT="${1:?Usage: ./test-webhook.sh \"message text\"}"
WAIT_SECONDS="${WAIT_SECONDS:-15}"

if [ ! -f .env ]; then
  echo "No .env found in $(pwd) — run this from bani-blocks/" >&2
  exit 1
fi

APP_SECRET=$(grep '^WHATSAPP_APP_SECRET=' .env | cut -d'=' -f2-)
if [ -z "$APP_SECRET" ]; then
  echo "WHATSAPP_APP_SECRET not found in .env" >&2
  exit 1
fi

# Snapshot how many outbound replies exist for this phone BEFORE sending.
# The previous version checked "is the latest reply < 20s old" instead —
# that's wrong when messages are sent close together: the PREVIOUS reply
# is often still under 20s old when polling starts for the NEW one, so it
# gets reported as if it were the fresh reply (confirmed 2026-07-28, this
# is what made "yes please" appear to just repeat the prior message).
# Counting rows and waiting for the count to increase can't have that bug.
BEFORE_COUNT=$(pnpm --filter @bani/reservation-demo exec tsx -e "
import { config } from 'dotenv';
config({ path: '../../.env' });
import { createDb } from '@bani/db';
async function main() {
  const sql = createDb(process.env.DATABASE_URL);
  const rows = await sql\`
    select count(*)::text as c from messages m
    join customers c on m.customer_id = c.id
    where c.wa_phone = '$PHONE' and m.wa_direction = 'out'
  \`;
  console.log(rows[0].c);
  await sql.end();
}
main();
" 2>/dev/null | tail -1)
BEFORE_COUNT="${BEFORE_COUNT:-0}"

WAMID="wamid.MANUAL-$(date +%s)-$$"
BODY=$(cat <<EOF
{"object":"whatsapp_business_account","entry":[{"id":"12345","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"962790000000","phone_number_id":"12345"},"contacts":[{"profile":{"name":"Manual Test"}}],"messages":[{"id":"$WAMID","from":"$PHONE","timestamp":"$(date +%s)","type":"text","text":{"body":"$TEXT"}}]}}]}]}
EOF
)

SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')"

echo "→ [$PHONE] $TEXT"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$WORKER_URL/webhook/whatsapp" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: $SIG" \
  -d "$BODY")

if [ "$STATUS" != "200" ]; then
  echo "✗ webhook POST returned $STATUS (expected 200) — check watch-logs.sh for details"
  exit 1
fi

echo "  (delivered, waiting up to ${WAIT_SECONDS}s for a new reply — currently $BEFORE_COUNT so far...)"

pnpm --filter @bani/reservation-demo exec tsx -e "
import { config } from 'dotenv';
config({ path: '../../.env' });
import { createDb } from '@bani/db';

const sql = createDb(process.env.DATABASE_URL);
const phone = '$PHONE';
const waitSeconds = $WAIT_SECONDS;
const beforeCount = $BEFORE_COUNT;

async function main() {
  for (let i = 0; i < waitSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await sql\`
      select m.content, m.created_at from messages m
      join customers c on m.customer_id = c.id
      where c.wa_phone = \${phone} and m.wa_direction = 'out'
      order by m.created_at asc
    \`;
    if (rows.length > beforeCount) {
      // Print every reply row that's new since this call started — a
      // single logical reply can be split into up to 3 WhatsApp messages.
      for (const r of rows.slice(beforeCount)) {
        console.log('← ' + r.content);
      }
      await sql.end();
      return;
    }
  }
  console.log('  (no new reply after ' + waitSeconds + 's — it may still be processing; check watch-logs.sh)');
  await sql.end();
}
main();
"
