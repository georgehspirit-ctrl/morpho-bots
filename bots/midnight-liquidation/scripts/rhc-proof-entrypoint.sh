#!/bin/sh
# One-shot: create a short-maturity proof market, then seed a position into it.
#
# Runs as a Railway service, never locally. Exits non-zero on failure so the deployment goes red
# rather than a half-seeded market reading as success.
#
# IDEMPOTENT ON RESTART. The first version created a market unconditionally, so every crash-restart
# minted another one — eight before it was stopped. Railway restarts on any non-zero exit, so a
# script that mutates chain state at startup must be safe to run twice. Set PROOF_MARKET_ID to reuse
# an existing market; the creation step runs only when it is unset.
set -eu

if [ -n "${PROOF_MARKET_ID:-}" ]; then
  MARKET_ID="$PROOF_MARKET_ID"
  echo "--- step 1: skipped, reusing $MARKET_ID ---"
else
  echo "--- step 1: create the proof market ---"
  node dist/scripts/rhc-create-proof-market.js | tee /tmp/create.log
  MARKET_ID=$(grep -oE '^MARKET_ID=0x[0-9a-f]{64}$' /tmp/create.log | tail -1 | cut -d= -f2)
  [ -n "${MARKET_ID:-}" ] || { echo "could not parse MARKET_ID" >&2; exit 1; }
fi
echo "market: $MARKET_ID"

echo "--- step 2: seed a position ---"
# --markets-api: the seed reads the market's own parameters back from the indexer rather than
#   trusting locally-constructed ones, so the offer it signs commits to exactly the struct on chain.
# --yes: there is no TTY here and the script otherwise waits on a prompt forever.
#
# RETRY IN-PROCESS, NEVER BY RESTART. Railway restarts on non-zero exit, and the seed opens with a
# heavy CREATE2 simulation eth_call, so a crash-restart loop turned into an RPC 429 storm that then
# caused the next crash. Retry here with backoff and hold the container either way, so exactly one
# process is ever talking to the RPC.
ATTEMPTS="${PROOF_SEED_ATTEMPTS:-6}"
n=1
while [ "$n" -le "$ATTEMPTS" ]; do
  echo "--- seed attempt $n/$ATTEMPTS ---"
  if node dist/scripts/seed-loan-collateral-position.js \
      --market "$MARKET_ID" \
      --markets-api "${MARKETS_API_URL:-https://api.morpho.org/v0/midnight/markets}" \
      --face-usdc "${PROOF_FACE_USDG:-28}" \
      --max-spend-usdc "${PROOF_MAX_SPEND_USDG:-60}" \
      --yes; then
    echo "SEEDED_MARKET_ID=$MARKET_ID"
    break
  fi
  n=$((n + 1))
  if [ "$n" -le "$ATTEMPTS" ]; then
    back=$((n * 30))
    echo "seed failed, backing off ${back}s before attempt $n" >&2
    sleep "$back"
  else
    echo "SEED_FAILED after $ATTEMPTS attempts" >&2
  fi
done

# Hold the container so logs stay retrievable and Railway does not restart into a re-seed.
while true; do sleep 3600; done
