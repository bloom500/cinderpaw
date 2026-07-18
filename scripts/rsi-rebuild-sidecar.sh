#!/usr/bin/env bash
# Rebuild the Feral Agent sidecar after a code-RSI patch is applied —
# the POSIX half of scripts/rsi-rebuild-sidecar.ps1 (same contract):
#
#   1. repo root = $1, or this script's parent directory.
#   2. `bun` missing → exit 2 ("rebuild unavailable", not fatal).
#   3. `bun run build` in <root>/FeralAgent; failure → exit 1.
#   4. copy dist/feral-agent over every Tauri externalBin target
#      (src-tauri/binaries/feral-agent-<triple>) already present — the
#      dev machine's existing file names the triple, so no rustc probe.
#   5. exit 0, printing the target(s) written.
set -u

REPO_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
AGENT_DIR="$REPO_ROOT/FeralAgent"
DIST_BIN="$AGENT_DIR/dist/feral-agent"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"

status() { echo "[rsi-rebuild-sidecar] $1" >&2; }

if ! command -v bun >/dev/null 2>&1; then
  status "FATAL: 'bun' is not on PATH. Install Bun (https://bun.sh) and retry (exit 2 = rebuild unavailable)."
  exit 2
fi
if [ ! -d "$AGENT_DIR" ]; then
  status "FATAL: FeralAgent/ not found at $AGENT_DIR. Repo root looks wrong."
  exit 1
fi

status "running: bun run build (cwd=$AGENT_DIR)"
if ! (cd "$AGENT_DIR" && bun run build); then
  status "FATAL: 'bun run build' failed"
  exit 1
fi
if [ ! -f "$DIST_BIN" ]; then
  status "FATAL: expected dist binary at $DIST_BIN after build."
  exit 1
fi

wrote=0
for target in "$BIN_DIR"/feral-agent-*; do
  [ -e "$target" ] || continue
  case "$target" in *.exe) continue ;; esac # never clobber the Windows binary from a POSIX build
  cp -f "$DIST_BIN" "$target" && chmod +x "$target" && echo "$target" && wrote=1
done
if [ "$wrote" -eq 0 ]; then
  # Provisioned self-src layout (~/.feral/self-src) has no src-tauri/binaries
  # yet — create the triple-named target so the host's refresh_spawn_binary
  # can copy it over the live sidecar path.
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux-aarch64)  TRIPLE="aarch64-unknown-linux-gnu" ;;
    Darwin-arm64)   TRIPLE="aarch64-apple-darwin" ;;
    Darwin-x86_64)  TRIPLE="x86_64-apple-darwin" ;;
    *) status "FATAL: unsupported platform $(uname -s)-$(uname -m)"; exit 1 ;;
  esac
  mkdir -p "$BIN_DIR"
  target="$BIN_DIR/feral-agent-$TRIPLE"
  cp -f "$DIST_BIN" "$target" && chmod +x "$target" && echo "$target"
fi
exit 0
