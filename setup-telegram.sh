#!/bin/bash
set -euo pipefail

echo "=== PingPulse Telegram Setup ==="
echo ""

# Step 1: Get bot token
read -rp "Paste your Telegram Bot Token from @BotFather: " BOT_TOKEN

if [[ -z "$BOT_TOKEN" ]]; then
  echo "Error: Token cannot be empty"
  exit 1
fi

# Step 2: Validate token by calling getMe
echo ""
echo "Validating token..."
ME=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || true)

if [[ -z "$ME" ]] || echo "$ME" | grep -q '"ok":false'; then
  echo "Error: Invalid bot token. Double-check and try again."
  exit 1
fi

BOT_NAME=$(echo "$ME" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
echo "Bot verified: @${BOT_NAME}"

# Step 3: Wait for user to message the bot, then fetch chat ID
echo ""
echo "Now open Telegram and send any message to @${BOT_NAME}"
echo "Waiting for your message..."

CHAT_ID=""
for i in $(seq 1 30); do
  UPDATES=$(curl -sf "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=1&timeout=2" 2>/dev/null || true)
  CHAT_ID=$(echo "$UPDATES" | grep -o '"chat":{"id":[0-9-]*' | head -1 | grep -o '[0-9-]*$' || true)

  if [[ -n "$CHAT_ID" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$CHAT_ID" ]]; then
  echo "Timed out waiting for a message. Send a message to @${BOT_NAME} and re-run."
  exit 1
fi

echo "Chat ID found: ${CHAT_ID}"

# Step 4: Set wrangler secrets
echo ""
echo "Setting Cloudflare Worker secrets..."
cd "$(dirname "$0")/worker"

echo "$BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
echo "$CHAT_ID" | npx wrangler secret put TELEGRAM_CHAT_ID

# Step 5: Send a test message
echo ""
echo "Sending test message..."
TEST=$(curl -sf -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\":\"${CHAT_ID}\",\"text\":\"PingPulse connected! Alerts will be sent here.\"}" 2>/dev/null || true)

if echo "$TEST" | grep -q '"ok":true'; then
  echo "Test message sent! Check your Telegram."
else
  echo "Warning: Test message failed, but secrets are set. Alerts should still work."
fi

echo ""
echo "=== Setup complete ==="
