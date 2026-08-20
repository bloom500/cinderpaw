/**
 * Faza 4 — the spec §Testare smoke: ONE full dummy-adapter cycle,
 * candidate → eval → review → champion → rollback, through the REAL
 * modules composed exactly as index.ts composes them. Only the process
 * boundaries are faked, at the same seams production injects:
 *
 *   - `ExecFn` (the CliTrainer's child process) — writes a real dummy
 *     `adapter.gguf` file on disk, like a trainer binary would;
 *   - `setLora` (Rust model reload) — records the active adapter;
 *   - `invokeAgent` (the model) — answers correctly only when the
 *     candidate adapter is "loaded", so the candidate genuinely beats
 *     the baseline through the real validateOutcome → confidence path.
 *
 * Everything else — dataset builder, deterministic ids, registry,
 * eval-gate statistics, review store, promote/retire/rollback — is the
 * production code end to end.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDataset, type EpisodicRow } from "../src/rsi/l2-adapt/dataset-builder.ts";
import type { EvalSpec } from "../src/rsi/infra/eval-spec.ts";
import { makeLoraEvalRunner } from "../src/rsi/l2-adapt/lora-eval-runner.ts";
import {
  LoraReviewStore,
  applyLoraReview,
  deriveAdapterId,
  runLoraTrainingCycle,
} from "../src/rsi/l2-adapt/lora-pipeline.ts";
import { LoraRegistry } from "../src/rsi/l2-adapt/lora-registry.ts";
import { makeRunEval } from "../src/rsi/infra/run-eval.ts";
import { CliTrainer } from "../src/rsi/l2-adapt/trainers/cli-trainer.ts";
import type { ExecFn } from "../src/rsi/l3-code/code-sandbox.ts";
import type { GenomeSpec } from "../src/rsi/l1-config/population-manager.ts";

/** 12 fact-lookup tasks — enough samples for the confidence gate
 *  (MIN_SAMPLES = 10). The model under the adapter answers all of them;
 *  the bare model answers only the two "easy" ones. */
const SPECS: EvalSpec[] = Array.from({ length: 12 }, (_, i) => ({
  id: `task-${String(i).padStart(2, "0")}`,
  tier: i < 3 ? 0 : 1, // first three are the Tier 0 safety floor
  name: `task ${i}`,
  description: "smoke",
  prompt: `What is fact #${i}?`,
  kind: "fact_lookup",
  expected: { type: "fact_lookup", answer: `fact-${i}` },
}));

const GENOME: GenomeSpec = {
  id: "lora-eval-identity",
  generation: 0,
  lineage: [],
  config: {
    promptTemplateId: 0,
    temperature: 0.2,
    systemPromptId: 0,
    retrievalStrategy: "episodic",
    contextWindowUsage: 0.4,
    toolPreferenceWeights: [],
    decompositionDepth: 0,
  },
};

/** Conversation history the dataset builder mines. */
function episodicRows(): EpisodicRow[] {
  return Array.from({ length: 30 }, (_, i) => [
    { sessionId: `s${i % 3}`, timestamp: i * 10, role: "user", content: `How do I do thing number ${i} in my project?` },
    { sessionId: `s${i % 3}`, timestamp: i * 10 + 1, role: "assistant", content: `You do thing number ${i} by running the standard procedure.` },
  ]).flat();
}

test("dummy-adapter cycle: candidate → eval → review → champion → rollback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lora-smoke-"));

  // ── Slice 2: mine the conversation record into a pinned dataset ──────
  const dataset = writeDataset(episodicRows(), join(dir, "datasets", "ds-1.jsonl"));
  expect(dataset.pairs.length).toBeGreaterThanOrEqual(10);
  expect(readFileSync(dataset.path, "utf8")).toBe(dataset.jsonl);

  // ── Slice 4 leaf: CliTrainer over a fake process that writes a REAL
  //    dummy adapter file (what llama.cpp-finetune would produce) ───────
  const trainerCalls: string[][] = [];
  const fakeProcess: ExecFn = async (cmd, opts) => {
    trainerCalls.push(cmd);
    if (cmd[1] === "finetune") {
      writeFileSync(join(opts.cwd, "adapter.gguf"), "GGUF-dummy-adapter");
      return { exitCode: 0, stdout: "metric:loss=0.31\n", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "dummy-trainer 1.0", stderr: "", timedOut: false }; // --version
  };
  const trainer = new CliTrainer({ binPath: "/bin/dummy-trainer", exec: fakeProcess });

  // ── The live eval runner over a fake model boundary ──────────────────
  let activeAdapter: string | null = null;
  const setLoraLog: Array<string | null> = [];
  const runEval = makeLoraEvalRunner({
    setLora: async (p) => {
      setLoraLog.push(p);
      activeAdapter = p;
    },
    runEval: makeRunEval({
      getSpecs: async () => SPECS,
      // The model: with the adapter it knows every fact; bare, only two.
      invokeAgent: async (prompt) => {
        const i = Number(/#(\d+)\?/.exec(prompt)?.[1]);
        const knows = activeAdapter !== null || i < 2;
        return { response: knows ? `The answer is fact-${i}.` : "I do not know.", tokens: 8 };
      },
    }),
    genome: GENOME,
    baselineAdapterPath: () => registry.champion("general")?.adapterPath ?? null,
  });

  // ── The cycle, composed exactly as index.ts composes it ──────────────
  const registry = new LoraRegistry(join(dir, "lora-registry.json"));
  const reviews = new LoraReviewStore(join(dir, "lora-reviews.json"));
  const baseModel = "Qwen3.5-4B-Q8_0.gguf";
  const adapterId = deriveAdapterId("general", baseModel, dataset.hash, {});

  const result = await runLoraTrainingCycle({
    registry,
    reviews,
    trainer,
    domain: "general",
    baseModel,
    dataset: { id: "ds-1", path: dataset.path, hash: dataset.hash },
    hyperparameters: {},
    outputDir: join(dir, "adapters", adapterId),
    runEval,
  });

  if (!result.ok) throw new Error(result.reason);
  // The trainer ran: --version probe + one finetune, and the adapter file
  // is really on disk where the record points.
  expect(trainerCalls.some((c) => c[1] === "finetune")).toBe(true);
  expect(existsSync(result.record.adapterPath)).toBe(true);
  expect(result.record.provenance.metrics.loss).toBe(0.31);
  expect(result.record.provenance.metrics.training_ms).toBeGreaterThanOrEqual(0);
  // Adapter swap discipline: baseline (none) → candidate → restored.
  expect(setLoraLog).toEqual([null, result.record.adapterPath, null]);
  // The candidate demonstrably beat the bare model through the real gate.
  expect(result.card.gate.verdict).toBe("recommend_promote");
  expect(result.card.gate.humanApprovalRequired).toBe(true);

  // ── Human gate: approve → champion ────────────────────────────────────
  const approved = applyLoraReview(registry, reviews, result.record.id, "approve");
  expect(approved.record.status).toBe("champion");
  expect(registry.champion("general")?.id).toBe(result.record.id);

  // ── Everything persisted: a fresh process sees the same state ────────
  const registry2 = new LoraRegistry(join(dir, "lora-registry.json"));
  expect(registry2.champion("general")?.id).toBe(result.record.id);
  expect(new LoraReviewStore(join(dir, "lora-reviews.json")).get(result.record.id)?.status).toBe("approved");

  // ── Regression rollback: no ancestor → domain reverts to foundation ──
  const rolledBackTo = registry2.rollback("general");
  expect(rolledBackTo).toBeUndefined();
  expect(registry2.champion("general")).toBeUndefined();
  expect(registry2.get(result.record.id)?.status).toBe("rolled_back");

  // Idempotence guard: re-running the same job after the cycle returns the
  // SAME resolved card instead of retraining.
  const rerun = await runLoraTrainingCycle({
    registry: registry2,
    reviews: new LoraReviewStore(join(dir, "lora-reviews.json")),
    trainer,
    domain: "general",
    baseModel,
    dataset: { id: "ds-1", path: dataset.path, hash: dataset.hash },
    hyperparameters: {},
    outputDir: join(dir, "adapters", adapterId),
    runEval,
  });
  if (!rerun.ok) throw new Error(rerun.reason);
  expect(rerun.card.status).toBe("approved");
  expect(trainerCalls.filter((c) => c[1] === "finetune")).toHaveLength(1);
});

describe("smoke — the gate holds when the adapter is NOT better", () => {
  test("flat candidate is rejected by statistics, not by opinion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lora-smoke-flat-"));
    const registry = new LoraRegistry(join(dir, "r.json"));
    const reviews = new LoraReviewStore(join(dir, "v.json"));
    const dataset = writeDataset(episodicRows(), join(dir, "ds.jsonl"));

    const fakeProcess: ExecFn = async (cmd, opts) => {
      if (cmd[1] === "finetune") {
        writeFileSync(join(opts.cwd, "adapter.gguf"), "GGUF-dummy");
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: "v1", stderr: "", timedOut: false };
    };

    const runEval = makeLoraEvalRunner({
      setLora: async () => {},
      runEval: makeRunEval({
        getSpecs: async () => SPECS,
        // Same answers with or without the adapter — no gain to detect.
        invokeAgent: async (prompt) => {
          const i = Number(/#(\d+)\?/.exec(prompt)?.[1]);
          return { response: `The answer is fact-${i}.`, tokens: 8 };
        },
      }),
      genome: GENOME,
      baselineAdapterPath: () => null,
    });

    const result = await runLoraTrainingCycle({
      registry,
      reviews,
      trainer: new CliTrainer({ binPath: "/bin/t", exec: fakeProcess }),
      domain: "general",
      baseModel: "base.gguf",
      dataset: { id: "d", path: dataset.path, hash: dataset.hash },
      hyperparameters: {},
      outputDir: join(dir, "out"),
      runEval,
    });

    if (!result.ok) throw new Error(result.reason);
    expect(result.card.gate.verdict).toBe("reject");
    // And the human cannot force it past the gate.
    expect(() => applyLoraReview(registry, reviews, result.record.id, "approve"))
      .toThrow(/cannot approve/);
  });
});
