#!/usr/bin/env bash
# The official run: ONE scorecard, all 25 games, one configuration.
#
#   bash runs-arc/launch-official.sh <run-stamp> [--practice]
#
# Why one card. Competition mode — which the API turns on by DEFAULT, measured,
# not assumed — scores against every environment whether you played it or not,
# and lets you read one scorecard. Twenty-five separate cards are twenty-five
# results with twenty-four holes each; one card with twenty-five games is a
# result. The card is pinned to a backend by its cookie, so every player is
# handed the same card id and the same cookie.
#
# Retries are LEVEL resets here, not game resets: competition mode converts
# them, so --retries buys another attempt at the level that killed us while
# keeping the levels already cleared. That is the behaviour we want anyway.
set -u
cd "D:/Cinderpaw Agent" || exit 1     # bun reads .env from the cwd
STAMP="$1"
COMPETITION="--competition"
[ "${2:-}" = "--practice" ] && COMPETITION=""
OUT="runs-arc/$STAMP"
mkdir -p "$OUT/B"

set -a; . ./.env; set +a
COMMIT=$(git rev-parse HEAD)
eval "$(bun CinderpawAgent/scripts/arc/arc_card.mjs open $COMPETITION \
          --source-url "https://github.com/cinderpaw/cinderpaw/commit/$COMMIT" \
          --tag "$STAMP" --tag cinderpaw-agent 2>"$OUT/_card-open.log")"
if [ -z "${ARC_CARD_ID:-}" ]; then
  echo "the card was refused — see $OUT/_card-open.log"; cat "$OUT/_card-open.log"; exit 1
fi
echo "$ARC_CARD_ID" > "$OUT/_card_id"
date -Is > "$OUT/_started"
echo "card $ARC_CARD_ID  commit $COMMIT" | tee -a "$OUT/_card-open.log"

# Close the card whatever happens: a card left open shows no results at all, so
# a crash or a Ctrl-C would throw away the whole run rather than part of it.
finish() {
  echo "closing card $ARC_CARD_ID ..."
  bun CinderpawAgent/scripts/arc/arc_card.mjs close --card "$ARC_CARD_ID" --cookie "$ARC_CARD_COOKIE" \
      > "$OUT/scorecard.json" 2>"$OUT/_card-close.log"
  date -Is > "$OUT/_done"
  echo "scorecard written to $OUT/scorecard.json"
}
trap finish EXIT INT TERM

for game in $(cat runs-arc/games.txt); do
  bun CinderpawAgent/scripts/arc/run_arc_agi3.mjs \
      --game "$game" --model z-ai/glm-5.3-flash --provider Z.AI \
      --reasoning-effort medium --retries 3 --max-spend 0.15 \
      --no-imagination \
      --card "$ARC_CARD_ID" --cookie "$ARC_CARD_COOKIE" \
      --tag official --tag "$game" \
      > "$OUT/B/$game.log" 2>&1 &
  sleep 4
done
wait
