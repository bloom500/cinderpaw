#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

run "CinderpawAgent tests" bash -c "cd \"$ROOT/CinderpawAgent\" && bun test --timeout 20000"
run "CinderpawAgent typecheck" bash -c "cd \"$ROOT/CinderpawAgent\" && bunx tsc --noEmit"
# The pool lives in frontend-react/vitest.config.ts now, so it is one answer
# rather than a flag every caller has to remember - CI runs `npm test -- --run`
# and had no such flag, which is how it would have met the forks-worker timeout.
# `--maxWorkers=1` is kept as-is: it predates this change and its reason is not
# recorded, so it is not mine to remove.
run "React tests" bash -c "cd \"$ROOT/frontend-react\" && bunx vitest run --maxWorkers=1"
run "React typecheck" bash -c "cd \"$ROOT/frontend-react\" && bunx tsc --noEmit"
run "Web app tests + typecheck" bash -c "cd \"$ROOT/web-app\" && bun install --frozen-lockfile && bun test && bun run typecheck"
run "Sidecar build" bash -c "cd \"$ROOT/src-tauri\" && node scripts/build-sidecar.mjs"
run "Game export script tests" bash -c "cd \"$ROOT\" && node --test src-tauri/scripts/build-game.test.mjs"
GODOT="${CINDERPAW_GODOT:-$(command -v godot || true)}"
if [ -n "$GODOT" ]; then
  run "Campfire game tests" bash -c "\"$GODOT\" --headless --path \"$ROOT/games/ember\" --import >/dev/null && \"$GODOT\" --headless --path \"$ROOT/games/ember\" -s res://tests/run_tests.gd"
else
  echo "== Campfire game tests: skipped, Godot is not installed (python scripts/fetch-godot.py, then set CINDERPAW_GODOT)"
fi
run "Rust check" bash -c "cd \"$ROOT\" && cargo check"
run "Rust tests (host)" bash -c "cd \"$ROOT\" && cargo test -p cinderpaw"
run "Rust tests (core)" bash -c "cd \"$ROOT\" && cargo test -p cinderpaw-core"
run "TUI tests" bash -c "cd \"$ROOT/tui\" && go test ./..."
run "TUI build" bash -c "cd \"$ROOT/tui\" && go build ./..."

printf '\nVerification passed.\n'
