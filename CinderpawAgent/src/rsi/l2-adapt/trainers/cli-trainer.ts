/**
 * Faza 4 Slice 4 — TrainerBackend implementation that shells out to an
 * external CLI trainer (e.g. llama.cpp-finetune, unsloth). The contract
 * itself is fixed and lives in `../lora-registry.ts`; this file only
 * carries the mapping from a `train()` job to one child-process
 * invocation.
 *
 * Leaf module: no shared state, no registry reads/writes, no eval-gate
 * wiring. The host calls `train()`, gets back the adapter path + a
 * metrics bag, and does the rest of the pipeline (registry.add →
 * eval-gate → human card). The trainer knows nothing about LoRA
 * adapters beyond the file the binary writes.
 *
 * Command execution is the injectable `ExecFn` from `code-sandbox.ts` —
 * production uses `bunExec` (Bun.spawn + kill timer); tests inject a
 * fake that records args and returns canned results. We deliberately do
 * NOT add a second exec implementation: reusing the existing one keeps
 * the test seam and the production path in lockstep.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { bunExec, type ExecFn } from "../../l3-code/code-sandbox.ts";
import type { TrainerBackend } from "../lora-registry.ts";

/** Env var that points at the trainer binary when no override is given. */
export const TRAINER_BIN_ENV = "CINDERPAW_LORA_TRAINER_BIN";

/** Env var that overrides the per-job training timeout (ms). */
export const TRAIN_TIMEOUT_ENV = "CINDERPAW_LORA_TRAIN_TIMEOUT_MS";

/** Default per-job training timeout — training is slow on CPU; 1h ceiling. */
export const DEFAULT_TRAIN_TIMEOUT_MS = 3_600_000;

/** Tight probe timeout — `--version` should answer near-instantly. */
export const VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Fixed adapter filename the trainer writes under `outputDir`. Mirrors
 *  the Rust loader's expectation in `src-tauri/src/rsi/`. */
const ADAPTER_FILENAME = "adapter.gguf";

/** Match one `metric:<name>=<float>` line in the trainer's stdout.
 *  Multiline: we scan line-by-line so a stray `=` in the value isn't
 *  accidentally swallowed. Accepts integer + decimal + scientific
 *  notation (common for `lr`, `weight_decay`). */
const METRIC_LINE =
  /^metric:([^=\s]+)=(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*$/;

export interface CliTrainerOptions {
  /** Path to the trainer binary. Defaults to env `CINDERPAW_LORA_TRAINER_BIN`. */
  binPath?: string;
  /** Inject a fake exec in tests; production uses `bunExec`. */
  exec?: ExecFn;
}

/** Convert a hyperparameters key to its CLI flag form (kebab-case).
 *  Exported for tests. `useFlash` → `use-flash`, `learning_rate` →
 *  `learning-rate`, `numEpochs` → `num-epochs`. */
export function toKebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .toLowerCase();
}

/** Build the argv for one training invocation. Pure — exported for tests
 *  so the flag-mapping contract is pinned independently of process
 *  spawning. */
export function buildTrainArgs(
  binPath: string,
  job: {
    baseModel: string;
    datasetPath: string;
    outputDir: string;
    hyperparameters: Record<string, unknown>;
  },
): string[] {
  const args: string[] = [
    binPath,
    "finetune",
    "--base",
    job.baseModel,
    "--data",
    job.datasetPath,
    "--out",
    job.outputDir,
  ];
  for (const [key, value] of Object.entries(job.hyperparameters)) {
    const flag = `--${toKebab(key)}`;
    if (value === false) continue; // brief: false → omits
    if (value === true) {
      args.push(flag);
      continue;
    }
    if (value == null) continue; // null/undefined → omits (defensive)
    args.push(flag, String(value));
  }
  return args;
}

/** Parse `metric:<name>=<float>` lines out of the trainer stdout.
 *  Exported for tests. Unparseable lines are silently skipped — the
 *  trainer is opaque; the eval gate judges quality from the registry,
 *  not from these numbers. */
export function parseMetrics(stdout: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const m = METRIC_LINE.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const value = Number(m[2]);
    if (Number.isFinite(value)) out[name] = value;
  }
  return out;
}

/** First non-empty line of a string. Internal helper exposed for tests. */
export function firstNonEmptyLine(s: string): string {
  for (const line of s.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export class CliTrainer implements TrainerBackend {
  readonly name = "cli-trainer";

  readonly #binPath: string | undefined;
  readonly #exec: ExecFn;

  constructor(opts: CliTrainerOptions = {}) {
    this.#binPath =
      opts.binPath !== undefined && opts.binPath !== ""
        ? opts.binPath
        : process.env[TRAINER_BIN_ENV];
    this.#exec = opts.exec ?? bunExec;
  }

  /** Probe: true iff the binary is configured AND responds to `--version`
   *  with exit 0 inside 5s. NEVER throws — hosts render "training
   *  unavailable" UI from a `false` here. */
  async available(): Promise<boolean> {
    if (!this.#binPath) return false;
    try {
      const r = await this.#exec([this.#binPath, "--version"], {
        cwd: process.cwd(),
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      });
      return r.exitCode === 0;
    } catch {
      // exec implementation raised (spawn failure, ENOENT, etc.).
      // The probe is best-effort — never let a probe error crash the host.
      return false;
    }
  }

  async train(job: {
    baseModel: string;
    datasetPath: string;
    hyperparameters: Record<string, unknown>;
    outputDir: string;
  }): Promise<{ adapterPath: string; metrics: Record<string, number> }> {
    if (!this.#binPath) {
      // Defensive: a backend that says it's available but has no binPath
      // is misconfigured; surfacing this as a normal infra error (not an
      // exception in `available`) means the eval gate sees the failure
      // the same way it sees every other CLI failure.
      throw new Error(
        `${TRAINER_BIN_ENV} is not set and no binPath was provided`,
      );
    }

    const args = buildTrainArgs(this.#binPath, job);
    const timeoutMs = readTrainTimeout();

    // The job's outputDir is also the child's cwd — spawning into a
    // directory that doesn't exist yet fails before the trainer runs.
    mkdirSync(job.outputDir, { recursive: true });

    const result = await this.#exec(args, {
      cwd: job.outputDir,
      timeoutMs,
    });

    if (result.exitCode !== 0) {
      const reason =
        result.timedOut
          ? `timed out after ${timeoutMs}ms`
          : firstNonEmptyLine(result.stderr) ||
            `trainer exited ${result.exitCode}`;
      throw new Error(
        result.timedOut
          ? `cli-trainer timed out after ${timeoutMs}ms`
          : `cli-trainer failed: ${reason}`,
      );
    }

    return {
      adapterPath: join(job.outputDir, ADAPTER_FILENAME),
      metrics: parseMetrics(result.stdout),
    };
  }
}

function readTrainTimeout(): number {
  const raw = process.env[TRAIN_TIMEOUT_ENV];
  if (!raw) return DEFAULT_TRAIN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TRAIN_TIMEOUT_MS;
}