#!/bin/bash
# FLOW Live Comments - Reader (Mac). Double-click to run.
cd "$(dirname "$0")"
clear
echo "============================================"
echo "   FLOW Live Comments - Reader"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed on this computer."
  echo
  echo "    1) Go to https://nodejs.org"
  echo "    2) Download the LTS version and install it."
  echo "    3) Then double-click this file again."
  echo
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First-time setup: installing components. Runs once, ~1 min..."
  npm install
  echo
fi

if [ ! -f feeder-token.txt ]; then
  read -p "  Enter the admin password (the one you use for the admin page): " TOK
  echo "$TOK" > feeder-token.txt
  echo
fi

export FEED_TOKEN="$(cat feeder-token.txt)"
node feeder.js

echo
echo "  The reader has stopped. You can close this window."
read -n 1 -s -r -p "  Press any key to close."
