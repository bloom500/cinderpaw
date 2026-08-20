/**
 * Faza 4 Slice 4 (host half) — the LoRA pipeline orchestrator: one full
 * candidate cycle over fake trainer + fake eval, and the human-resolve
 * seam. Mirrors the rsi-lora-registry test shape.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairedSample } from "../src/rsi/infra/confidence.ts";
import {
  LoraReviewStore,
  applyLoraReview,
  deriveAdapterId,
  runLoraTrainingCycle,
} from "../src/rsi/l2-adapt/lora-pipeline.ts";
import { LoraRegistry, type TrainerBackend } from "../src/rsi/l2-adapt/lora-registry.ts";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lora-pipe-"));
}

/** 12 clearly-better paired samples — passes the confidence gate. */
const WIN_SAMPLES: PairedSample[] = Array.from({ length: 12 }, (_, i) => ({
  candidate: 0.9 + (i % 3) * 0.01,
  baseline: 0.5 + (i % 3) * 0.01,
}));

/** 12 identical pairs — no effect, the gate rejects. */
const FLAT_SAMPLES: PairedSample[] = Array.from({ length: 12 }, () => ({
  candidate: 0.5,
  baseline: 0.5,
}));

function fakeTrainer(overrides: Partial<TrainerBackend> = {}): TrainerBackend & {
  trainCalls: number;
} {
  const t = {
    name: "fake-trainer",
    trainCalls: 0,
    available: async () => true,
    train: async (job: { outputDir: string }) => {
      t.trainCalls++;
      return {
        adapterPath: join(job.outputDir, "adapter.gguf"),
        metrics: { loss: 0.42 },
      };
    },
    ...overrides,
  };
  return t as TrainerBackend & { trainCalls: number };
}

function cycleArgs(
  dir: string,
  trainer: TrainerBackend,
  samples: PairedSample[],
  tier0Passed = true,
) {
  return {
    registry: new LoraRegistry(join(dir, "registry.json")),
    reviews: new LoraReviewStore(join(dir, "reviews.json")),
    trainer,
    domain: "coding" as const,
    baseModel: "Qwen3.5-4B-Q8_0.gguf",
    dataset: { id: "ds-1", path: join(dir, "train.jsonl"), hash: "abc123" },
    hyperparameters: { rank: 16 },
    outputDir: join(dir, "out"),
    runEval: async () => ({
      tier0: { passed: tier0Passed },
      samples,
    }),
  };
}

describe("deriveAdapterId", () => {
  test("deterministic and key-order independent", () => {
    const a = deriveAdapterId("coding", "base.gguf", "h1", { rank: 16, lr: 1e-4 });
    const b = deriveAdapterId("coding", "base.gguf", "h1", { lr: 1e-4, rank: 16 });
    expect(a).toBe(b);
    expect(a).toMatch(/^lora-coding-[0-9a-f]{12}$/);
  });

  test("any input change changes the id", () => {
    const base = deriveAdapterId("coding", "base.gguf", "h1", { rank: 16 });
    expect(deriveAdapterId("coding", "base.gguf", "h2", { rank: 16 })).not.toBe(base);
    expect(deriveAdapterId("coding", "other.gguf", "h1", { rank: 16 })).not.toBe(base);
    expect(deriveAdapterId("coding", "base.gguf", "h1", { rank: 32 })).not.toBe(base);
  });
});

describe("runLoraTrainingCycle", () => {
  test("winning candidate: trained, registered, evaluating, card recommends promote", async () => {
    const dir = tmpDir();
    const args = cycleArgs(dir, fakeTrainer(), WIN_SAMPLES);
    const r = await runLoraTrainingCycle(args);

    if (!r.ok) throw new Error(r.reason);
    expect(r.record.status).toBe("evaluating");
    expect(r.record.adapterPath).toBe(join(dir, "out", "adapter.gguf"));
    expect(r.record.provenance.datasetHash).toBe("abc123");
    // Slice 5: the pipeline stamps measured training time next to the
    // trainer's own metrics.
    expect(r.record.provenance.metrics.loss).toBe(0.42);
    expect(r.record.provenance.metrics.training_ms).toBeGreaterThanOrEqual(0);
    expect(r.card.gate.verdict).toBe("recommend_promote");
    expect(r.card.gate.humanApprovalRequired).toBe(true);
    expect(r.card.status).toBe("pending");
  });

  test("parentId is the current champion of the domain", async () => {
    const dir = tmpDir();
    const args = cycleArgs(dir, fakeTrainer(), WIN_SAMPLES);
    args.registry.add({
      id: "lora-coding-parent",
      domain: "coding",
      adapterPath: "p.gguf",
      baseModel: args.baseModel,
      provenance: { datasetId: "d0", datasetHash: "h0", hyperparameters: {}, metrics: {} },
    });
    args.registry.promote("lora-coding-parent");

    const r = await runLoraTrainingCycle(args);
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.provenance.parentId).toBe("lora-coding-parent");
  });

  test("flat candidate: card is created with a reject verdict", async () => {
    const dir = tmpDir();
    const r = await runLoraTrainingCycle(cycleArgs(dir, fakeTrainer(), FLAT_SAMPLES));
    if (!r.ok) throw new Error(r.reason);
    expect(r.card.gate.verdict).toBe("reject");
  });

  test("Tier 0 failure: reject before statistics", async () => {
    const dir = tmpDir();
    const r = await runLoraTrainingCycle(
      cycleArgs(dir, fakeTrainer(), WIN_SAMPLES, false),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.card.gate.verdict).toBe("reject");
    expect(r.card.gate.reason).toContain("Tier 0");
  });

  test("trainer unavailable → ok:false, nothing registered", async () => {
    const dir = tmpDir();
    const args = cycleArgs(
      dir,
      fakeTrainer({ available: async () => false }),
      WIN_SAMPLES,
    );
    const r = await runLoraTrainingCycle(args);
    expect(r.ok).toBe(false);
    expect(args.registry.list()).toHaveLength(0);
    expect(args.reviews.list()).toHaveLength(0);
  });

  test("train throws → ok:false with the trainer's message", async () => {
    const dir = tmpDir();
    const args = cycleArgs(
      dir,
      fakeTrainer({
        train: async () => {
          throw new Error("cli-trainer failed: OOM");
        },
      }),
      WIN_SAMPLES,
    );
    const r = await runLoraTrainingCycle(args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("OOM");
    expect(args.registry.list()).toHaveLength(0);
  });

  test("eval throws → ok:false, record stays evaluating, no card", async () => {
    const dir = tmpDir();
    const args = {
      ...cycleArgs(dir, fakeTrainer(), WIN_SAMPLES),
      runEval: async () => {
        throw new Error("adapter failed to load");
      },
    };
    const r = await runLoraTrainingCycle(args);
    expect(r.ok).toBe(false);
    expect(args.registry.list()[0]?.status).toBe("evaluating");
    expect(args.reviews.list()).toHaveLength(0);
  });

  test("re-run of the same job is idempotent: no retrain, same card", async () => {
    const dir = tmpDir();
    const trainer = fakeTrainer();
    const args = cycleArgs(dir, trainer, WIN_SAMPLES);
    const first = await runLoraTrainingCycle(args);
    const second = await runLoraTrainingCycle(args);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(trainer.trainCalls).toBe(1);
    expect(second.card.createdAt).toBe(first.card.createdAt);
    expect(args.registry.list()).toHaveLength(1);
  });
});

describe("applyLoraReview — the human gate", () => {
  async function pendingCycle(samples: PairedSample[]) {
    const dir = tmpDir();
    const args = cycleArgs(dir, fakeTrainer(), samples);
    const r = await runLoraTrainingCycle(args);
    if (!r.ok) throw new Error(r.reason);
    return { args, r };
  }

  test("approve promotes to champion", async () => {
    const { args, r } = await pendingCycle(WIN_SAMPLES);
    const out = applyLoraReview(args.registry, args.reviews, r.record.id, "approve");
    expect(out.record.status).toBe("champion");
    expect(out.card.status).toBe("approved");
    expect(args.registry.champion("coding")?.id).toBe(r.record.id);
  });

  test("reject retires the candidate — not in flight, not champion", async () => {
    const { args, r } = await pendingCycle(WIN_SAMPLES);
    const out = applyLoraReview(args.registry, args.reviews, r.record.id, "reject");
    expect(out.record.status).toBe("retired");
    expect(out.card.status).toBe("rejected");
    expect(args.registry.champion("coding")).toBeUndefined();
  });

  test("approve on a reject-verdict card is refused (no forcing past the gate)", async () => {
    const { args, r } = await pendingCycle(FLAT_SAMPLES);
    expect(() =>
      applyLoraReview(args.registry, args.reviews, r.record.id, "approve"),
    ).toThrow(/cannot approve/);
    // Reject still works.
    const out = applyLoraReview(args.registry, args.reviews, r.record.id, "reject");
    expect(out.record.status).toBe("retired");
  });

  test("double resolve throws", async () => {
    const { args, r } = await pendingCycle(WIN_SAMPLES);
    applyLoraReview(args.registry, args.reviews, r.record.id, "approve");
    expect(() =>
      applyLoraReview(args.registry, args.reviews, r.record.id, "reject"),
    ).toThrow(/not pending/);
  });
});

describe("LoraReviewStore — journal discipline", () => {
  test("corrupt file → start empty", () => {
    const dir = tmpDir();
    const file = join(dir, "reviews.json");
    require("node:fs").writeFileSync(file, "{not json");
    const store = new LoraReviewStore(file);
    expect(store.list()).toEqual([]);
  });

  test("persists across reload", async () => {
    const dir = tmpDir();
    const args = cycleArgs(dir, fakeTrainer(), WIN_SAMPLES);
    const r = await runLoraTrainingCycle(args);
    if (!r.ok) throw new Error(r.reason);
    const reloaded = new LoraReviewStore(join(dir, "reviews.json"));
    expect(reloaded.get(r.record.id)?.status).toBe("pending");
  });
});
