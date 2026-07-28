#!/usr/bin/env bash
# Tail live logs from the deployed Worker. Run this in its own terminal and
# leave it open while you send test messages with test-webhook.sh — it shows
# request status and any logged warnings/errors in real time, but NOT the
# bot's actual reply text (that requires the DB poll test-webhook.sh does
# after sending — wrangler tail alone won't show you what the bot said).
set -euo pipefail
cd "$(dirname "$0")/apps/reservation-demo"

pnpm dlx wrangler tail --format pretty
