#!/bin/bash
# TEST MODE (Mac) — proves the reader works by reading a PUBLIC 24/7 live
# stream (Sky News) and forwarding to your Fly hub. Sky News comments will
# appear on your viewer link until you close this window.
# ONLY run this when you are NOT broadcasting.
cd "$(dirname "$0")"
clear
echo "================================================"
echo "   FLOW Live Comments - TEST  (reads Sky News)"
echo "================================================"
echo
echo "  This proves the reader works. While it runs, Sky News comments"
echo "  show up on your viewer link. Only run when you are NOT live."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Get it from https://nodejs.org (LTS), then retry."
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "  First-time setup: installing components (~1 min)..."
  npm install
  echo
fi
if [ ! -f feeder-token.txt ]; then
  read -p "  Enter the admin password (the one for the admin page): " TOK
  echo "$TOK" > feeder-token.txt
  echo
fi
export FEED_TOKEN="$(cat feeder-token.txt)"
export FEED_CHANNELS="https://www.youtube.com/@SkyNews"
node feeder.js
echo
echo "  Test stopped. You can close this window."
read -n 1 -s -r -p "  Press any key to close."
