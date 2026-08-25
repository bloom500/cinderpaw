/**
 * test-time-adaptation.test.ts — TTT dataset builder (LoRA trainer contract).
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

import { buildTttRecords, writeTttDataset } from "../scripts/lora-trainer/test_time_adaptation.ts";

const PAIRS = [
  { input: [[1, 2], [3, 4]], output: [[3, 1], [4, 2]] },
  { input: [[5]], output: [[5]] },
];

describe("buildTttRecords", () => {
  test("produces one prompt/response record per pair, contract-shaped", () => {
    const records = buildTttRecords("task-07", PAIRS, "rotate 90 degrees clockwise");
    expect(records.length).toBe(2);
    for (const r of records) {
      expect(typeof r.prompt).toBe("string");
      expect(typeof r.response).toBe("string");
      expect(Object.keys(r).sort()).toEqual(["prompt", "response"]);
    }
    expect(records[0].prompt).toContain("Task task-07");
    expect(records[0].prompt).toContain(JSON.stringify(PAIRS[0].input));
    expect(records[0].prompt).toContain("rotate 90 degrees clockwise");
    expect(records[0].response).toBe(`Output: ${JSON.stringify(PAIRS[0].output)}`);
  });

  test("deterministic output", () => {
    expect(buildTttRecords("t", PAIRS)).toEqual(buildTttRecords("t", PAIRS));
  });

  test("loud on empty/invalid inputs", () => {
    expect(() => buildTttRecords("", PAIRS)).toThrow(/non-empty string/);
    expect(() => buildTttRecords("t", [])).toThrow(/non-empty array/);
    expect(() => buildTttRecords("t", [{ input: 1 } as never])).toThrow(/"input" and "output"/);
  });
});

describe("writeTttDataset", () => {
  test("writes trainer-ready JSONL + inspectable JSON mirror", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttt-"));
    const result = writeTttDataset({ taskName: "task-07", pairs: PAIRS, outDir });
    expect(result.recordCount).toBe(2);
    expect(fs.existsSync(result.jsonlPath)).toBe(true);
    expect(fs.existsSync(result.jsonPath)).toBe(true);

    const lines = fs.readFileSync(result.jsonlPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].response).toContain("[[3,1],[4,2]]");

    const mirror = JSON.parse(fs.readFileSync(result.jsonPath, "utf8"));
    expect(mirror).toEqual(parsed);
  });

  test("different tasks do not collide inside the same dir (fresh files each call)", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttt-"));
    const a = writeTttDataset({ taskName: "a", pairs: [PAIRS[0] as never], outDir });
    const b = writeTttDataset({ taskName: "b", pairs: [PAIRS[1] as never], outDir });
    expect(a.recordCount).toBe(1);
    expect(b.taskName).toBe("b");
    const lines = fs.readFileSync(b.jsonlPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
  });

  test("loud when pairs are missing", () => {
    expect(() => writeTttDataset({ taskName: "x", pairs: [], outDir: os.tmpdir() })).toThrow(
      /non-empty array/,
    );
  });
});
