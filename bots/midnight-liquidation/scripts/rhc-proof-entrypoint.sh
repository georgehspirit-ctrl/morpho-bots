#!/bin/sh
# One-shot: create a short-maturity proof market, then seed a position into it.
#
# Runs as a Railway service rather than anywhere local. Exits non-zero on any failure so the
# deployment goes red instead of a half-seeded market looking like a success.
set -eu

echo "--- step 1: create the proof market ---"
node dist/scripts/rhc-create-proof-market.js | tee /tmp/create.log

MARKET_ID=$(grep -oE '^MARKET_ID=0x[0-9a-f]{64}$' /tmp/create.log | tail -1 | cut -d= -f2)
if [ -z "${MARKET_ID:-}" ]; then
  echo "could not parse MARKET_ID from the creation output" >&2
  exit 1
fi
echo "market: $MARKET_ID"

echo "--- step 2: seed a position ---"
# --yes because there is no TTY here; the script prompts otherwise and would hang forever.
node dist/scripts/seed-loan-collateral-position.js \
  --market "$MARKET_ID" \
  --face-usdc "${PROOF_FACE_USDG:-28}" \
  --yes

echo "--- seeded. market $MARKET_ID ---"
echo "SEEDED_MARKET_ID=$MARKET_ID"
# Sleep so the logs stay retrievable rather than the service restarting in a loop.
sleep 3600
