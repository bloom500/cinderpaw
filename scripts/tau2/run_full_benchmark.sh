#!/usr/bin/env bash
# The full 50-task paired benchmark, both arms, unattended.
#
# Runs Cinderpaw over all 50 airline tasks, then the reference llm_agent over
# the same 50, then prints the comparison. One command, because supervising it
# turn by turn is the expensive part — the runs themselves cost OpenRouter
# credit (~$1 per arm), not attention.
#
#   bash scripts/tau2/run_full_benchmark.sh
#
# Expect ~3 hours per arm at concurrency 1 (measured: 221s/task mean over five
# write-heavy tasks, range 153-341s). Both arms land in
# vendor/tau2-bench/data/simulations/ and the last thing printed is the matrix.
#
# Deliberately sequential. Running the arms concurrently would have them
# contend for the same machine and the same OpenRouter rate limit, and the
# per-task timings — one of the things being compared — would stop meaning
# anything.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAU2="${TAU2_ROOT:-$ROOT/vendor/tau2-bench}"
RUNNER="$ROOT/scripts/tau2/run_tau2.py"
USER_LLM="${TAU2_USER_LLM:-openrouter/google/gemini-2.5-flash}"
EVENTS="${CINDERPAW_TAU2_EVENT_DIR:-$ROOT/bench-results/tau2-events}"
LOG_DIR="$ROOT/bench-results"
mkdir -p "$EVENTS" "$LOG_DIR"

STAMP="$(date +%Y%m%d_%H%M%S)"
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8 CINDERPAW_TAU2_EVENT_DIR="$EVENTS"

cd "$TAU2" || { echo "tau2 not found at $TAU2"; exit 2; }

# Each arm's exit status is kept rather than `set -e`: if Cinderpaw's arm dies
# halfway, the baseline is still worth having — and a paired run with one arm
# missing must SAY so, not look like a finished comparison.
echo "=== arm 1/2: cinderpaw, 50 tasks ==="
uv run python "$RUNNER" --user-llm "$USER_LLM" 2>&1 | tee "$LOG_DIR/tau2-cinderpaw-$STAMP.log"
ARM1=${PIPESTATUS[0]}

echo
echo "=== arm 2/2: llm_agent (reference), same 50 tasks ==="
uv run python "$RUNNER" --agent llm_agent --user-llm "$USER_LLM" 2>&1 | tee "$LOG_DIR/tau2-llm_agent-$STAMP.log"
ARM2=${PIPESTATUS[0]}

echo
echo "=== comparison ==="
CP="$(ls -td "$TAU2"/data/simulations/*cinderpaw* 2>/dev/null | head -1)"
BL="$(ls -td "$TAU2"/data/simulations/*llm_agent* 2>/dev/null | head -1)"
if [ -n "$CP" ] && [ -n "$BL" ]; then
  python "$ROOT/scripts/tau2/compare_arms.py" "$CP" "$BL"
else
  echo "one or both run directories are missing — cinderpaw='$CP' llm_agent='$BL'"
fi

echo
echo "arm exit codes: cinderpaw=$ARM1 llm_agent=$ARM2"
[ "$ARM1" -eq 0 ] && [ "$ARM2" -eq 0 ] || echo "AT LEAST ONE ARM DID NOT FINISH CLEANLY — this is not a complete paired result."
