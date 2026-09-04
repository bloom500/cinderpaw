#!/usr/bin/env bash
# One arm, one process per game, all at once.
#
#   bash runs-arc/launch-arm.sh <run-stamp> B      full harness
#   bash runs-arc/launch-arm.sh <run-stamp> A      bare (--no-imagination --no-perception)
#
# No action cap: the game ends when it ends or when the per-game spend cap is
# reached. A press cap would decide the score instead of measuring it, and the
# number worth comparing against is NVIDIA AVO's ~265 actions a game.
#
# The arms run one after the other because 50 processes x $0.15 is more than the
# credit on the account; a run that dies on a 402 halfway is not a result.
set -u
cd "D:/Cinderpaw Agent" || exit 1     # bun reads .env from the cwd
ROOT="runs-arc/$1"; ARM="$2"
mkdir -p "$ROOT/$ARM"
date -Is > "$ROOT/$ARM/_started"
EXTRA=""
[ "$ARM" = "A" ] && EXTRA="--no-imagination --no-perception"
for game in $(cat runs-arc/games.txt); do
  bun CinderpawAgent/scripts/arc/run_arc_agi3.mjs \
      --game "$game" --model z-ai/glm-5.3-flash --provider Z.AI \
      --reasoning-effort medium --max-spend 0.15 $EXTRA \
      --tag "run$ARM" --tag "$game" \
      > "$ROOT/$ARM/$game.log" 2>&1 &
  sleep 4
done
wait
date -Is > "$ROOT/$ARM/_done"
