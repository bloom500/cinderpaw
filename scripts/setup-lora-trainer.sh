#!/usr/bin/env bash
# Set up (or register) a LoRA trainer for Feral's L2 pipeline.
# Contract: docs/LORA_TRAINER.md.
#
# Two modes:
#   ./setup-lora-trainer.sh                  -> INSTALL the bundled NVIDIA
#       trainer into ~/.feral/lora-trainer (venv + torch + unsloth/peft +
#       llama.cpp convert scripts) and register it.
#   ./setup-lora-trainer.sh /path/to/trainer -> register an EXTERNAL trainer.
set -eu

persist_env() {
  RESOLVED="$1"
  PROFILE="${HOME}/.profile"
  case "${SHELL:-}" in
    */zsh) PROFILE="${HOME}/.zshrc" ;;
    */bash) PROFILE="${HOME}/.bashrc" ;;
  esac
  LINE="export FERAL_LORA_TRAINER_BIN=\"$RESOLVED\""
  if ! grep -qsF "FERAL_LORA_TRAINER_BIN" "$PROFILE" 2>/dev/null; then
    printf '\n# Feral LoRA trainer (docs/LORA_TRAINER.md)\n%s\n' "$LINE" >> "$PROFILE"
    echo "[setup-lora-trainer] appended to $PROFILE"
  else
    echo "[setup-lora-trainer] $PROFILE already sets FERAL_LORA_TRAINER_BIN — update it manually if the path changed:"
  fi
  echo "  $LINE"
  echo "Restart Feral (and your shell) to pick it up."
}

probe() {
  echo "[setup-lora-trainer] probing: $1 --version"
  if ! "$1" --version >/dev/null 2>&1; then
    echo "[setup-lora-trainer] FATAL: '$1 --version' must exit 0 (see docs/LORA_TRAINER.md)" >&2
    exit 1
  fi
}

# ---- external-binary mode (original behavior) -------------------------------
if [ "$#" -ge 1 ]; then
  BIN="$1"
  if [ ! -x "$BIN" ]; then
    echo "[setup-lora-trainer] FATAL: not an executable: $BIN" >&2
    exit 1
  fi
  RESOLVED="$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")"
  probe "$RESOLVED"
  persist_env "$RESOLVED"
  exit 0
fi

# ---- install mode: bundled NVIDIA trainer -----------------------------------
echo "[setup-lora-trainer] installing the bundled trainer (NVIDIA/CUDA)"

command -v nvidia-smi >/dev/null 2>&1 || \
  echo "[setup-lora-trainer] WARNING: nvidia-smi not found — training will fall back to CPU and be impractically slow." >&2

PY=""
for cand in python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && \
     "$cand" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)'; then
    PY="$cand"; break
  fi
done
if [ -z "$PY" ]; then
  echo "[setup-lora-trainer] FATAL: Python 3.10-3.12 not found (torch/unsloth wheel coverage)." >&2
  exit 1
fi
echo "[setup-lora-trainer] python: $PY"

DIR="${HOME}/.feral/lora-trainer"
mkdir -p "$DIR"
VENV="$DIR/venv"
VENV_PY="$VENV/bin/python"

if [ ! -x "$VENV_PY" ]; then
  echo "[setup-lora-trainer] creating venv: $VENV"
  "$PY" -m venv "$VENV"
fi

echo "[setup-lora-trainer] installing packages (several GB, one-time)..."
"$VENV_PY" -m pip install --upgrade pip --quiet
# On Linux the default PyPI torch wheel is CUDA-enabled.
"$VENV_PY" -m pip install torch
"$VENV_PY" -m pip install transformers peft datasets accelerate bitsandbytes gguf sentencepiece protobuf
# unsloth is the fast path; best-effort — the trainer falls back to
# transformers+peft without it.
"$VENV_PY" -m pip install unsloth || \
  echo "[setup-lora-trainer] WARNING: unsloth install failed — using transformers+peft fallback." >&2

LLAMACPP="$DIR/llama.cpp"
if [ ! -f "$LLAMACPP/convert_lora_to_gguf.py" ]; then
  echo "[setup-lora-trainer] fetching llama.cpp convert scripts..."
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMACPP"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/lora-trainer/feral_lora_trainer.py" "$DIR/"

LAUNCHER="$DIR/feral-lora-trainer"
printf '#!/usr/bin/env bash\nexec "%s" "%s" "$@"\n' "$VENV_PY" "$DIR/feral_lora_trainer.py" > "$LAUNCHER"
chmod +x "$LAUNCHER"

"$VENV_PY" "$DIR/feral_lora_trainer.py" self-test

probe "$LAUNCHER"
persist_env "$LAUNCHER"
echo ""
echo "NOTE: training resolves the HF base model from the GGUF's metadata."
echo "If your GGUF lacks provenance metadata, set FERAL_LORA_HF_BASE to the"
echo "HF repo id it was converted from (e.g. Qwen/Qwen2.5-7B-Instruct)."
