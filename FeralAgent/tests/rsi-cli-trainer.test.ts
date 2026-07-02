/**
 * Faza 4 Slice 4 — `CliTrainer` (leaf) tested over a fake `ExecFn`.
 *
 * No real trainer binary is spawned — every assertion is over the
 * args captured by the fake exec and the canned `ExecResult` it
 * returns. The fake follows the pattern from `rsi-code-sandbox.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CliTrainer,
  TRAIN_TIMEOUT_ENV,
  TRAINER_BIN_ENV,
  buildTrainArgs,
  firstNonEmptyLine,
  parseMetrics,
  toKebab,
} from "../src/rsi/trainers/cli-trainer.ts";
import type { ExecFn, ExecResult } from "../src/rsi/code-sandbox.ts";

const ok = (stdout = "", stderr = ""): ExecResult => ({
  exitCode: 0,
  stdout,
  stderr,
  timedOut: false,
});

const fail = (stderr = "boom", exitCode = 1): ExecResult => ({
  exitCode,
  stdout: "",
  stderr,
  timedOut: false,
});

/** Fake exec that returns canned results in order and records every call. */
function fakeExec(
  answers: ExecResult[],
): { exec: ExecFn; calls: Array<{ cmd: string[]; opts: { cwd: string; timeoutMs: number } }> } {
  const calls: Array<{ cmd: string[]; opts: { cwd: string; timeoutMs: number } }> = [];
  let i = 0;
  const exec: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, opts: { cwd: opts.cwd, timeoutMs: opts.timeoutMs } });
    return answers[i++] ?? ok();
  };
  return { exec, calls };
}

/** Fake exec that throws on call — simulates ENOENT / spawn failure. */
function throwingExec(message: string): { exec: ExecFn; called: { value: boolean } } {
  const called = { value: false };
  const exec: ExecFn = async () => {
    called.value = true;
    throw new Error(message);
  };
  return { exec, called };
}

describe("toKebab — hyperparameter key → CLI flag", () => {
  test("camelCase splits at the capital boundary", () => {
    expect(toKebab("useFlash")).toBe("use-flash");
    expect(toKebab("numEpochs")).toBe("num-epochs");
    expect(toKebab("learningRate")).toBe("learning-rate");
  });

  test("snake_case underscores become dashes", () => {
    expect(toKebab("learning_rate")).toBe("learning-rate");
    expect(toKebab("num_epochs")).toBe("num-epochs");
  });

  test("already-kebab keys pass through unchanged", () => {
    expect(toKebab("rank")).toBe("rank");
    expect(toKebab("lora-alpha")).toBe("lora-alpha");
  });

  test("mixed snake + camel — adjacent uppercase run is preserved", () => {
    // The boundary detector only fires between [a-z0-9] → [A-Z]; an
    // underscore breaks that chain, so the LR run survives intact and
    // the kebab form ends up lowercase on a single dash.
    expect(toKebab("dropout_rateLR")).toBe("dropout-rate-lr");
  });

  test("digits are kept attached to the preceding letter run", () => {
    expect(toKebab("layer12Norm")).toBe("layer12-norm");
  });
});

describe("buildTrainArgs — flag mapping", () => {
  const job = {
    baseModel: "/models/qwen.gguf",
    datasetPath: "/data/train.jsonl",
    outputDir: "/out/run-1",
    hyperparameters: {
      rank: 16,
      learningRate: 1e-4,
      useFlash: true,
      seed: 42,
    },
  };

  test("base/data/out always present, in order, after the subcommand", () => {
    const args = buildTrainArgs("/bin/trainer", job);
    // head, subcommand, then the three positional flags.
    expect(args.slice(0, 6)).toEqual([
      "/bin/trainer",
      "finetune",
      "--base", "/models/qwen.gguf",
      "--data", "/data/train.jsonl",
    ]);
    expect(args).toContain("--out");
    const outIdx = args.indexOf("--out");
    expect(args[outIdx + 1]).toBe("/out/run-1");
  });

  test("numeric hyperparameters produce --<kebab> <value>", () => {
    const args = buildTrainArgs("/bin/trainer", job);
    expect(args).toContain("--rank");
    expect(args[args.indexOf("--rank") + 1]).toBe("16");
    expect(args).toContain("--learning-rate");
    expect(args[args.indexOf("--learning-rate") + 1]).toBe("0.0001");
    expect(args).toContain("--seed");
    expect(args[args.indexOf("--seed") + 1]).toBe("42");
  });

  test("boolean true emits the flag with no value", () => {
    const args = buildTrainArgs("/bin/trainer", job);
    const flashIdx = args.indexOf("--use-flash");
    expect(flashIdx).toBeGreaterThan(-1);
    // The element after the flag is the NEXT flag (not a value).
    expect(args[flashIdx + 1]?.startsWith("--")).toBe(true);
  });

  test("boolean false is omitted", () => {
    const args = buildTrainArgs("/bin/trainer", {
      ...job,
      hyperparameters: { useFlash: false },
    });
    expect(args).not.toContain("--use-flash");
  });

  test("boolean false does not leak even when other flags follow", () => {
    const args = buildTrainArgs("/bin/trainer", {
      ...job,
      hyperparameters: { useFlash: false, rank: 8 },
    });
    expect(args).not.toContain("--use-flash");
    expect(args).toContain("--rank");
  });

  test("null / undefined hyperparameters are skipped", () => {
    const args = buildTrainArgs("/bin/trainer", {
      ...job,
      hyperparameters: { rank: null, seed: undefined, layers: 4 },
    });
    expect(args).not.toContain("--rank");
    expect(args).not.toContain("--seed");
    expect(args).toContain("--layers");
  });
});

describe("parseMetrics — stdout parsing", () => {
  test("single metric line", () => {
    expect(parseMetrics("metric:loss=0.42")).toEqual({ loss: 0.42 });
  });

  test("multiple metric lines", () => {
    expect(
      parseMetrics([
        "starting finetune",
        "metric:loss=0.42",
        "metric:perplexity=12.7",
        "metric:lr=1e-4",
        "done",
      ].join("\n")),
    ).toEqual({ loss: 0.42, perplexity: 12.7, lr: 1e-4 });
  });

  test("empty / garbage stdout → empty metrics", () => {
    expect(parseMetrics("")).toEqual({});
    expect(parseMetrics("hello\nworld\n")).toEqual({});
  });

  test("malformed metric lines are silently skipped (trainer is opaque)", () => {
    expect(
      parseMetrics([
        "metric:loss=0.42",
        "metric:loss=NaN",      // not a number → skip
        "metric:loss=",          // empty value → skip
        "metric:=0.5",           // empty name → skip
        "metric:loss=0.43",
      ].join("\n")),
    ).toEqual({ loss: 0.43 });
  });

  test("negative values are accepted", () => {
    expect(parseMetrics("metric:reward=-1.5")).toEqual({ reward: -1.5 });
  });

  test("CRLF line endings are handled", () => {
    expect(parseMetrics("metric:loss=0.1\r\nmetric:acc=0.9")).toEqual({
      loss: 0.1,
      acc: 0.9,
    });
  });
});

describe("firstNonEmptyLine — error message extraction", () => {
  test("returns first non-blank line, trimmed", () => {
    expect(firstNonEmptyLine("  \n  error: OOM  \n  at line 2")).toBe("error: OOM");
  });
  test("empty string → empty result", () => {
    expect(firstNonEmptyLine("")).toBe("");
    expect(firstNonEmptyLine("   \n  \t  ")).toBe("");
  });
});

describe("CliTrainer.available — binary probe", () => {
  test("false when binPath is not configured", async () => {
    const { exec } = fakeExec([ok()]);
    const trainer = new CliTrainer({ exec });
    // Save and unset the env so the constructor sees no binPath.
    const saved = process.env[TRAINER_BIN_ENV];
    delete process.env[TRAINER_BIN_ENV];
    try {
      expect(await trainer.available()).toBe(false);
    } finally {
      if (saved !== undefined) process.env[TRAINER_BIN_ENV] = saved;
    }
  });

  test("false when --version exits non-zero", async () => {
    const { exec, calls } = fakeExec([fail("not a trainer", 1)]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    expect(await trainer.available()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["/bin/trainer", "--version"]);
  });

  test("false when --version times out", async () => {
    const { exec } = fakeExec([{ exitCode: -2, stdout: "", stderr: "", timedOut: true }]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    expect(await trainer.available()).toBe(false);
  });

  test("false when exec throws (e.g. ENOENT) — never propagates", async () => {
    const { exec, called } = throwingExec("spawn ENOENT");
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    expect(await trainer.available()).toBe(false);
    expect(called.value).toBe(true);
  });

  test("true when --version exits 0", async () => {
    const { exec, calls } = fakeExec([ok("trainer 1.2.3")]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    expect(await trainer.available()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toEqual(["/bin/trainer", "--version"]);
    expect(calls[0]!.opts.timeoutMs).toBe(5_000);
  });
});

describe("CliTrainer.train — happy path + flag shaping", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cli-trainer-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("builds the expected command, uses outputDir as cwd, returns adapterPath", async () => {
    const { exec, calls } = fakeExec([ok("metric:loss=0.42\nmetric:perplexity=12.7")]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    const outputDir = join(tmp, "run-1");

    const r = await trainer.train({
      baseModel: "/models/qwen.gguf",
      datasetPath: "/data/train.jsonl",
      outputDir,
      hyperparameters: { rank: 16, useFlash: true, useDropout: false },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toEqual([
      "/bin/trainer",
      "finetune",
      "--base", "/models/qwen.gguf",
      "--data", "/data/train.jsonl",
      "--out", outputDir,
      "--rank", "16",
      "--use-flash",
    ]);
    // boolean false was omitted.
    expect(call.cmd).not.toContain("--use-dropout");
    // cwd is the output dir — the trainer writes there.
    expect(call.opts.cwd).toBe(outputDir);
    // default timeout is the 1h ceiling (3_600_000).
    expect(call.opts.timeoutMs).toBe(3_600_000);

    // adapter path is <outputDir>/adapter.gguf.
    expect(r.adapterPath).toBe(join(outputDir, "adapter.gguf"));
    // metrics parsed from stdout.
    expect(r.metrics).toEqual({ loss: 0.42, perplexity: 12.7 });
  });

  test("trainer timeout env overrides the default", async () => {
    const saved = process.env[TRAIN_TIMEOUT_ENV];
    process.env[TRAIN_TIMEOUT_ENV] = "120000";
    try {
      const { exec, calls } = fakeExec([ok("")]);
      const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
      await trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      });
      expect(calls[0]!.opts.timeoutMs).toBe(120_000);
    } finally {
      if (saved !== undefined) process.env[TRAIN_TIMEOUT_ENV] = saved;
      else delete process.env[TRAIN_TIMEOUT_ENV];
    }
  });

  test("malformed train-timeout env falls back to the default", async () => {
    const saved = process.env[TRAIN_TIMEOUT_ENV];
    process.env[TRAIN_TIMEOUT_ENV] = "not-a-number";
    try {
      const { exec, calls } = fakeExec([ok("")]);
      const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
      await trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      });
      expect(calls[0]!.opts.timeoutMs).toBe(3_600_000);
    } finally {
      if (saved !== undefined) process.env[TRAIN_TIMEOUT_ENV] = saved;
      else delete process.env[TRAIN_TIMEOUT_ENV];
    }
  });

  test("empty stdout → empty metrics (no parse errors)", async () => {
    const { exec } = fakeExec([ok("")]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    const r = await trainer.train({
      baseModel: "/m.gguf",
      datasetPath: "/d.jsonl",
      outputDir: tmp,
      hyperparameters: {},
    });
    expect(r.metrics).toEqual({});
    expect(r.adapterPath).toBe(join(tmp, "adapter.gguf"));
  });
});

describe("CliTrainer.train — failure paths", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cli-trainer-fail-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("exit != 0 throws with the first non-empty stderr line", async () => {
    const { exec } = fakeExec([
      fail("error: dataset not found\n  at <anonymous>\n  ...", 2),
    ]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    await expect(
      trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      }),
    ).rejects.toThrow(/error: dataset not found/);
  });

  test("timeout (timedOut flag) throws a distinct timeout error", async () => {
    const { exec } = fakeExec([
      { exitCode: -2, stdout: "", stderr: "still running...", timedOut: true },
    ]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    await expect(
      trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      }),
    ).rejects.toThrow(/timed out after/);
  });

  test("exit != 0 with empty stderr still throws with a useful message", async () => {
    const { exec } = fakeExec([{ exitCode: 1, stdout: "", stderr: "", timedOut: false }]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    await expect(
      trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      }),
    ).rejects.toThrow(/exited 1/);
  });

  test("no binPath + env unset → throws before any exec call", async () => {
    const saved = process.env[TRAINER_BIN_ENV];
    delete process.env[TRAINER_BIN_ENV];
    try {
      const { exec, calls } = fakeExec([ok()]);
      const trainer = new CliTrainer({ exec });
      await expect(
        trainer.train({
          baseModel: "/m.gguf",
          datasetPath: "/d.jsonl",
          outputDir: tmp,
          hyperparameters: {},
        }),
      ).rejects.toThrow(/FERAL_LORA_TRAINER_BIN/);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env[TRAINER_BIN_ENV] = saved;
    }
  });

  test("exec throws → propagates (this is an infra failure, not a result)", async () => {
    const { exec } = throwingExec("spawn EACCES");
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    await expect(
      trainer.train({
        baseModel: "/m.gguf",
        datasetPath: "/d.jsonl",
        outputDir: tmp,
        hyperparameters: {},
      }),
    ).rejects.toThrow(/spawn EACCES/);
  });
});

describe("CliTrainer — name + interface conformance", () => {
  test("name is the locked 'cli-trainer'", () => {
    const { exec } = fakeExec([ok()]);
    const trainer = new CliTrainer({ binPath: "/bin/trainer", exec });
    expect(trainer.name).toBe("cli-trainer");
  });
});