/**
 * maze-selftest-runner.test.ts - synthetic maze self-test harness.
 *
 * Covers the exported simulation helpers AND the CLI contract (writes the
 * JSON log, exit code 0 on completion). Runner-agnostic (bun:test →
 * vitest fallback).
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  bfsDistances,
  computeScore,
  createEnvironment,
  makeGreedyPolicy,
  runBaseline,
  step,
} from "../scripts/arc/run_maze_selftest.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("createEnvironment", () => {
  test("same seed → identical layout; target always reachable", () => {
    const a = createEnvironment(mulberry32(1234), 16);
    const b = createEnvironment(mulberry32(1234), 16);
    expect([...a.walls].sort()).toEqual([...b.walls].sort());
    // bfsDistances is seeded at the target, so the agent's cell carries the
    // spawn→target optimal distance.
    const dist = bfsDistances(a);
    expect(dist[a.agent.row][a.agent.col]).toBeGreaterThan(0);
    expect(a.optimalActions).toBe(dist[a.agent.row][a.agent.col]);
  });

  test("different seeds produce different walls (rng actually varies)", () => {
    const a = createEnvironment(mulberry32(1), 16);
    const b = createEnvironment(mulberry32(2), 16);
    expect([...a.walls].join("|")).not.toBe([...b.walls].join("|"));
  });

  test("loud on invalid size", () => {
    expect(() => createEnvironment(mulberry32(0), 2)).toThrow(/size must be an integer ≥ 4/);
  });
});

describe("step + greedy policy", () => {
  test("unknown action throws loudly", () => {
    const env = createEnvironment(mulberry32(7), 8);
    expect(() => step(env, "ACTION99")).toThrow(/unknown action/);
  });

  test("greedy BFS policy completes the level in exactly the optimal number of actions", () => {
    const env = createEnvironment(mulberry32(42), 16);
    const policy = makeGreedyPolicy(env);
    let actionsTaken = 0;
    for (; actionsTaken < 500; actionsTaken++) {
      if (env.agent.row === env.target.row && env.agent.col === env.target.col) break;
      const action = policy();
      expect(action).not.toBe(null);
      step(env, action);
    }
    expect(env.agent.row).toBe(env.target.row);
    expect(env.agent.col).toBe(env.target.col);
    expect(actionsTaken).toBe(env.optimalActions);
  });
});

describe("runBaseline + scoring", () => {
  test("deterministic end-to-end result with all required fields", () => {
    const a = runBaseline({ seed: 42, size: 12 });
    const b = runBaseline({ seed: 42, size: 12 });
    expect(a.completed).toBe(true);
    expect(a.actionsTaken).toBe(a.optimalActions);
    expect(a.score).toBe(100);
    expect(typeof a.wallTimeMs).toBe("number");
    expect(a.actionLog.length).toBe(a.actionsTaken);
    for (const action of a.actionLog) {
      expect(["ACTION1", "ACTION2", "ACTION3", "ACTION4"]).toContain(action);
    }
    expect(JSON.parse(JSON.stringify({ s: a.score, o: a.optimalActions, c: a.completed }))).toEqual(
      JSON.parse(JSON.stringify({ s: b.score, o: b.optimalActions, c: b.completed })),
    );
  }, 15000);

  test("score is 0 when not completed and capped at optimal ratio otherwise", () => {
    expect(computeScore(false, 10, 5)).toBe(0);
    expect(computeScore(true, 10, 20)).toBe(50);
    expect(computeScore(true, 5, 20)).toBe(25);
  });

  test("loud on invalid options", () => {
    expect(() => runBaseline({ seed: -1 })).toThrow(/seed/);
    expect(() => runBaseline({ maxActions: 0 })).toThrow(/maxActions/);
  });

  test("CLI writes the result log, disclaims ARC, and exits 0", () => {
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/arc/run_maze_selftest.mjs",
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-selftest-"));
    const outPath = path.join(outDir, "nested", "results.json");
    const stdout = execFileSync(process.execPath, [scriptPath, "--out", outPath, "--max-actions", "80"], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(stdout).toContain("[maze-selftest]");
    const payload = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(payload.game).toBe("synthetic-maze-selftest");
    expect(payload.seed).toBe(42);
    expect(payload.completed).toBe(true);
    expect(payload.harnessVersion).toBe("maze-selftest-v1");
    expect(Array.isArray(payload.actionLog)).toBe(true);
    // The disclaimer must travel WITH the data, not only in a receipt file.
    expect(payload.notAnArcScore).toBe(true);
    expect(payload.scoreKind).toBe("proxy");
    expect(payload.policyIsOracle).toBe(true);
    expect(stdout).toContain("NOT an ARC-AGI-3 score");
    // No artifact may carry the ARC name anywhere in it.
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("arc-agi");
  }, 45000);

  test("a caller-supplied policy is never reported as the oracle", () => {
    // Always walk right: reaches nothing on a walled board, but proves the
    // seam exists and that policyIsOracle tracks who actually decided.
    const r = runBaseline({ seed: 7, size: 8, maxActions: 5, policy: () => () => "ACTION4" });
    expect(r.policyIsOracle).toBe(false);
    expect(r.notAnArcScore).toBe(true);
  });

  test("loud when the policy seam is misused", () => {
    expect(() => runBaseline({ policy: 42 })).toThrow(/policy/);
    expect(() => runBaseline({ policy: () => "not-a-function" })).toThrow(/policy/);
  });

  test("CLI writes a run manifest beside the results (INVARIANT G)", () => {
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../scripts/arc/run_maze_selftest.mjs",
    );
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "maze-manifest-"));
    const outPath = path.join(outDir, "r.json");
    execFileSync(process.execPath, [scriptPath, "--out", outPath, "--max-actions", "80"], {
      encoding: "utf8",
      timeout: 30000,
    });
    const manifestPath = path.join(outDir, "run-manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(m.manifestVersion).toBe(1);
    expect(m.seed).toBe(42);
    // An oracle is a policy and must be named as one, or the manifest looks
    // like a run whose model someone forgot to record.
    expect(m.models.policy).toBe("oracle-bfs");
    expect(m.notes.join(" ")).toContain("NOT an ARC-AGI-3");
    // A manifest is published next to a scorecard — it must never carry a key.
    expect(m.config.env.CINDERPAW_DB_KEY).toMatch(/^<redacted:/);
  }, 45000);
});
