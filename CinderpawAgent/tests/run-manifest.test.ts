/**
 * run-manifest.test.ts — INVARIANT G: a result carries its receipt.
 * Runner-agnostic (bun:test → vitest fallback).
 */

interface RunnerLike {
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => void | Promise<void>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: structural runner typing
  expect: any;
}

async function loadRunner(): Promise<RunnerLike> {
  try {
    const mod = await import("bun:test");
    return { describe: mod.describe, test: mod.test, expect: mod.expect };
  } catch {
    const mod = await import("./_runner-vitest.ts");
    return { describe: mod.describe, test: mod.test ?? mod.it, expect: mod.expect };
  }
}

const { describe, test, expect } = await loadRunner();

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MANIFEST_FILENAME,
  REDACTED,
  REDACTED_UNSET,
  assertReportable,
  captureEnv,
  createRunManifest,
  hashConfig,
  probeGit,
  reportabilityProblems,
  writeRunManifest,
  type RunManifest,
} from "../src/core/run-manifest.ts";

const HARNESS = { name: "test-harness", version: "1.0.0" };

function completeManifest(over: Partial<RunManifest> = {}): RunManifest {
  const base = createRunManifest({
    runId: "unit-run",
    harness: HARNESS,
    models: { policy: "oracle-bfs" },
    seed: 42,
    env: {},
  });
  return {
    ...base,
    code: { commit: "a".repeat(40), branch: "main", dirty: false },
    ...over,
  };
}

describe("hashConfig", () => {
  test("is stable under key order — the same config always hashes the same", () => {
    expect(hashConfig({ a: 1, b: { c: 2, d: 3 } })).toBe(hashConfig({ b: { d: 3, c: 2 }, a: 1 }));
  });

  test("distinguishes configs that differ", () => {
    expect(hashConfig({ temperature: 0.7 })).not.toBe(hashConfig({ temperature: 0.8 }));
  });
});

describe("captureEnv", () => {
  test("NEVER records a credential value, only whether it is set", () => {
    const captured = captureEnv({ FERAL_DB_KEY: "super-secret-base64-key" });
    expect(captured.FERAL_DB_KEY).toBe(REDACTED);
    // The whole point: a manifest is published next to a scorecard.
    expect(JSON.stringify(captured)).not.toContain("super-secret-base64-key");
  });

  test("records credentials as unset rather than omitting them — presence changes behaviour", () => {
    expect(captureEnv({}).FERAL_DB_KEY).toBe(REDACTED_UNSET);
  });

  test("captures only documented CONFIG_SCHEMA names, never the whole environment", () => {
    const captured = captureEnv({
      SOME_UNRELATED_API_KEY: "leak-me",
      AWS_SECRET_ACCESS_KEY: "leak-me-too",
    });
    expect(JSON.stringify(captured)).not.toContain("leak-me");
    expect(captured.SOME_UNRELATED_API_KEY).toBe(undefined);
  });

  test("keeps the value of a non-credential setting — that IS the reproducibility info", () => {
    const captured = captureEnv({ FERAL_EMBED_GPU_LAYERS: "0" });
    expect(captured.FERAL_EMBED_GPU_LAYERS).toBe("0");
  });
});

describe("probeGit", () => {
  test("returns nulls instead of throwing outside a repository", () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
    const code = probeGit(notARepo);
    expect(code.commit).toBe(null);
    expect(code.branch).toBe(null);
    // Not `false`: "could not check" and "checked, clean" are different facts.
    expect(code.dirty).toBe(null);
  });
});

describe("createRunManifest", () => {
  test("records the run's identity, harness and runtime", () => {
    const m = createRunManifest({
      runId: "ep-1",
      harness: HARNESS,
      models: { policy: "claude-opus-5" },
      seed: 7,
      budgets: { maxActions: 200 },
      tools: ["read_file"],
      config: { temperature: 0.2 },
      notes: ["proxy score"],
      now: new Date("2026-08-26T00:00:00Z"),
      env: {},
    });
    expect(m.manifestVersion).toBe(1);
    expect(m.runId).toBe("ep-1");
    expect(m.createdAt).toBe("2026-08-26T00:00:00.000Z");
    expect(m.harness).toEqual(HARNESS);
    expect(m.models).toEqual({ policy: "claude-opus-5" });
    expect(m.seed).toBe(7);
    expect(m.budgets).toEqual({ maxActions: 200 });
    expect(m.tools).toEqual(["read_file"]);
    expect(m.notes).toEqual(["proxy score"]);
    expect(m.config.hash).toBe(hashConfig({ temperature: 0.2 }));
    expect(typeof m.runtime.platform).toBe("string");
  });

  test("loud without a runId or a harness", () => {
    // @ts-expect-error missing runId
    expect(() => createRunManifest({ harness: HARNESS })).toThrow(/runId/);
    // @ts-expect-error missing harness
    expect(() => createRunManifest({ runId: "ep-1" })).toThrow(/harness\.name/);
    expect(() =>
      createRunManifest({ runId: "ep-1", harness: { name: "h", version: "" } }),
    ).toThrow(/harness\.version/);
  });

  test("copies caller collections — later mutation cannot rewrite a recorded run", () => {
    const models = { policy: "m1" };
    const m = createRunManifest({ runId: "ep-1", harness: HARNESS, models, seed: 1, env: {} });
    models.policy = "m2";
    expect(m.models.policy).toBe("m1");
  });
});

describe("assertReportable (INVARIANT G)", () => {
  test("a complete manifest is reportable", () => {
    expect(reportabilityProblems(completeManifest())).toEqual([]);
    expect(() => assertReportable(completeManifest())).not.toThrow();
  });

  test("refuses a run whose tree had uncommitted changes", () => {
    const m = completeManifest({ code: { commit: "a".repeat(40), branch: "main", dirty: true } });
    expect(() => assertReportable(m)).toThrow(/uncommitted changes/);
  });

  test("refuses a run whose commit is unknown", () => {
    const m = completeManifest({ code: { commit: null, branch: null, dirty: null } });
    expect(() => assertReportable(m)).toThrow(/commit could not be determined/);
  });

  test("refuses a run with no seed and no model", () => {
    const m = completeManifest({ seed: null, models: {} });
    const problems = reportabilityProblems(m);
    expect(problems.length).toBe(2);
    expect(problems.join(" ")).toMatch(/seed/);
    expect(problems.join(" ")).toMatch(/no model recorded/);
  });

  test("reports EVERY reason at once, not one per run", () => {
    const m = completeManifest({
      code: { commit: null, branch: null, dirty: null },
      seed: null,
      models: {},
    });
    // commit + dirty-unknown + models + seed
    expect(reportabilityProblems(m).length).toBe(4);
    let message = "";
    try {
      assertReportable(m);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("commit could not be determined");
    expect(message).toContain("no seed recorded");
    expect(message).toContain("no model recorded");
  });
});

describe("writeRunManifest", () => {
  test("writes run-manifest.json beside the results, creating the directory", () => {
    const outDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "manifest-")), "nested");
    const written = writeRunManifest(completeManifest(), outDir);
    expect(written).toBe(path.join(outDir, MANIFEST_FILENAME));
    const parsed = JSON.parse(fs.readFileSync(written, "utf8"));
    expect(parsed.runId).toBe("unit-run");
    expect(parsed.manifestVersion).toBe(1);
  });
});
