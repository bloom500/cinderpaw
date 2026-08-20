#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

run "FeralAgent tests" bash -c "cd \"$ROOT/FeralAgent\" && bun test --timeout 20000"
run "FeralAgent typecheck" bash -c "cd \"$ROOT/FeralAgent\" && bunx tsc --noEmit"
run "React tests" bash -c "cd \"$ROOT/frontend-react\" && bunx vitest run --pool=threads --maxWorkers=1"
run "React typecheck" bash -c "cd \"$ROOT/frontend-react\" && bunx tsc --noEmit"
run "Rust check" bash -c "cd \"$ROOT\" && cargo check"
run "Rust tests" bash -c "cd \"$ROOT\" && cargo test -p feral"
run "TUI tests" bash -c "cd \"$ROOT/tui\" && go test ./..."
run "TUI build" bash -c "cd \"$ROOT/tui\" && go build ./..."

printf '\nVerification passed.\n'
