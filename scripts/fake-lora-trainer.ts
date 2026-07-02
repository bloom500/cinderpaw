/**
 * Fake LoRA trainer for the Faza 4 LIVE smoke (spec §Testare).
 *
 * Speaks exactly the CliTrainer contract so the whole pipeline —
 * dataset → train → paired eval → review card → approve → rsi_set_lora —
 * can be exercised in the running app before a real llama.cpp finetune
 * binary exists:
 *
 *   fake-lora-trainer --version
 *     → prints a version, exit 0 (the available() probe)
 *   fake-lora-trainer finetune --base X --data Y --out Z [flags]
 *     → writes Z/adapter.gguf (dummy bytes), prints metric lines, exit 0
 *
 * Build:  bun build scripts/fake-lora-trainer.ts --compile --outfile scripts/fake-lora-trainer
 * Use:    set FERAL_LORA_TRAINER_BIN=D:\FeralLocalAI\scripts\fake-lora-trainer.exe
 *
 * NOTE: the adapter it writes is NOT a real LoRA — approving it will make
 * the model reload FAIL loudly at rsi_set_lora (llama.cpp rejects the
 * file), which is itself part of the smoke: the fail-loud path. For a
 * quiet approve test, point --out at a REAL adapter GGUF via
 * FERAL_FAKE_ADAPTER_SRC to copy instead.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("fake-lora-trainer 1.0.0");
  process.exit(0);
}

if (args[0] === "finetune") {
  const out = args[args.indexOf("--out") + 1];
  if (!out) {
    console.error("finetune: missing --out");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const target = join(out, "adapter.gguf");
  const realSrc = process.env.FERAL_FAKE_ADAPTER_SRC;
  if (realSrc) copyFileSync(realSrc, target);
  else writeFileSync(target, "GGUF-fake-adapter-for-smoke-testing");
  // A couple of plausible metric lines for the card/provenance.
  console.log("metric:loss=0.42");
  console.log("metric:lr=1e-4");
  process.exit(0);
}

console.error(`unknown command: ${args[0] ?? "<none>"}`);
process.exit(2);
