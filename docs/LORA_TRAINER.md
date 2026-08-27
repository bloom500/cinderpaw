# LoRA Trainer Contract

Cinderpaw's L2 personal-adaptation pipeline (dataset → train → A/B eval gate →
human review → promote) is fully wired. Training activates the moment you
point `CINDERPAW_LORA_TRAINER_BIN` at any executable that implements the
contract below. This page is the authoritative spec for that contract
(source of truth: `CinderpawAgent/src/rsi/l2-adapt/trainers/cli-trainer.ts`).

## Bundled trainer (NVIDIA)

Cinderpaw ships a reference trainer for NVIDIA machines:
`scripts/lora-trainer/feral_lora_trainer.py` — QLoRA via **unsloth** (falls
back to plain transformers+peft when unsloth won't install), converted to
GGUF with llama.cpp's `convert_lora_to_gguf.py`. One command installs and
registers it:

```powershell
# Windows
.\scripts\setup-lora-trainer.ps1
```
```bash
# Linux
./scripts/setup-lora-trainer.sh
```

Requirements: NVIDIA GPU (8 GB+ VRAM for a 7B base), CUDA driver, Python
3.10–3.12, git, network, and a few GB of disk for the venv
(`~/.cinderpaw/lora-trainer/`).

**Base model resolution**: Cinderpaw passes the loaded GGUF as `--base`, but
training happens on the original Hugging Face weights. The trainer reads
the GGUF's `general.base_model.*` provenance metadata to find the HF repo
id; when the GGUF lacks it, set `CINDERPAW_LORA_HF_BASE` to the repo id the
GGUF was converted from (e.g. `Qwen/Qwen2.5-7B-Instruct`).

## Why it isn't installed by default

- Real LoRA training needs a GPU to be practical. Cinderpaw's default
  install must work on CPU-only machines, where a 7B fine-tune would
  take days — auto-installing a multi-GB CUDA stack that can't
  realistically run would be a worse lie than an honest "training
  unavailable".

The contract keeps the door open: any wrapper (unsloth, peft+transformers,
axolotl, a cloud job that downloads the result) can sit behind it.

## The contract

Cinderpaw invokes the trainer as ONE child process:

```
<bin> finetune \
  --base <model id or path of the CURRENTLY LOADED local model> \
  --data <path to the dataset .jsonl> \
  --out  <output directory> \
  [--<hyperparameter-kebab-case> <value> ...]
```

- `--version` must exit 0 quickly (≤5s) — Cinderpaw probes this to decide
  whether to show training UI at all.
- Dataset: JSONL, one `{"prompt": "...", "response": "..."}` pair per
  line, already redacted and paired by Cinderpaw.
- On success the trainer MUST write the adapter to `<out>/adapter.gguf`
  (GGUF LoRA format — llama.cpp `llama_adapter_lora_init` loads it) and
  exit 0.
- Optional metrics: any stdout line of the form `metric:<name>=<float>`
  (e.g. `metric:loss=0.42`) is captured for the review card.
- Timeout: `CINDERPAW_LORA_TRAIN_TIMEOUT_MS` (default 1h). A timeout or
  non-zero exit fails the cycle cleanly — the registry and eval gate
  never see a half-written adapter.

## Bringing your own trainer

1. Implement or install a wrapper honoring the contract (the bundled
   `scripts/lora-trainer/feral_lora_trainer.py` is the reference
   implementation; GPU strongly recommended).
2. Validate + register it:

   ```powershell
   # Windows
   .\scripts\setup-lora-trainer.ps1 -TrainerBin C:\path\to\trainer.exe
   ```
   ```bash
   # Linux/macOS
   ./scripts/setup-lora-trainer.sh /path/to/trainer
   ```

   The script probes `--version`, then persists
   `CINDERPAW_LORA_TRAINER_BIN` for your shell profile and prints the value
   to set in the desktop app's environment.
3. Restart Cinderpaw. `self_lora` / the Settings → Training card will show
   the trainer as available; trigger a cycle with at least 10 usable
   conversation pairs on a LOCAL primary model. Headless: `feral lora
   train` starts a cycle, `feral lora reviews` shows the resulting card,
   `feral lora approve <id>` promotes it (same gate as the desktop).

## What the eval gate does regardless of trainer quality

The gate A/B-runs the Tier 0 suite with and without the candidate
adapter under an identical config, requires statistical
non-inferiority + domain wins, and a human must approve every
promotion. A garbage trainer can waste your electricity; it cannot
silently degrade the agent.
