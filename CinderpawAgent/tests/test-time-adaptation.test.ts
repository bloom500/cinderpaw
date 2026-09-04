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

const RUN = "ttt-test-run";

describe("writeTttDataset", () => {
  test("writes trainer-ready JSONL + inspectable JSON mirror", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttt-"));
    const result = writeTttDataset({ taskName: "task-07", runId: RUN, pairs: PAIRS, outDir });
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

  test("two tasks in one run keep SEPARATE files", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttt-"));
    const a = writeTttDataset({ taskName: "a", runId: RUN, pairs: [PAIRS[0] as never], outDir });
    const b = writeTttDataset({ taskName: "b", runId: RUN, pairs: [PAIRS[1] as never], outDir });
    // The old code wrote both to one fixed ttt_dataset.jsonl, so b silently
    // replaced a — and the previous version of this test still passed because
    // it only ever read b back. Assert BOTH survive.
    expect(a.jsonlPath).not.toBe(b.jsonlPath);
    expect(fs.existsSync(a.jsonlPath)).toBe(true);
    expect(fs.existsSync(b.jsonlPath)).toBe(true);
    expect(fs.readFileSync(a.jsonlPath, "utf8")).not.toBe(fs.readFileSync(b.jsonlPath, "utf8"));
  });

  test("loud when pairs are missing", () => {
    expect(() =>
      writeTttDataset({ taskName: "x", runId: RUN, pairs: [], outDir: os.tmpdir() }),
    ).toThrow(/non-empty array/);
  });

  // ---- RUN SCOPING (INV-F) ------------------------------------------------

  test("requires a runId — there is no unscoped default", () => {
    // @ts-expect-error deliberately omitting the required runId
    expect(() => writeTttDataset({ taskName: "x", pairs: PAIRS, outDir: os.tmpdir() })).toThrow(
      /runId/,
    );
  });

  test("refuses a runId that would escape the run directory", () => {
    expect(() => writeTttDataset({ taskName: "x", runId: "../../etc", pairs: PAIRS })).toThrow(
      /path-safe/,
    );
  });

  test("the default output directory is isolated per run", () => {
    const a = writeTttDataset({ taskName: "same-task", runId: "ttt-ep-1", pairs: PAIRS });
    const b = writeTttDataset({ taskName: "same-task", runId: "ttt-ep-2", pairs: PAIRS });
    expect(a.jsonlPath).not.toBe(b.jsonlPath);
    expect(path.dirname(a.jsonlPath)).not.toBe(path.dirname(b.jsonlPath));
    fs.rmSync(path.dirname(a.jsonlPath), { recursive: true, force: true });
    fs.rmSync(path.dirname(b.jsonlPath), { recursive: true, force: true });
  });

  test("never silently replaces an existing dataset for the same run+task", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttt-"));
    writeTttDataset({ taskName: "dup", runId: RUN, pairs: PAIRS, outDir });
    expect(() => writeTttDataset({ taskName: "dup", runId: RUN, pairs: PAIRS, outDir })).toThrow(
      /refusing to overwrite/,
    );
    // Replacing it stays possible, but only when asked for explicitly.
    expect(() =>
      writeTttDataset({ taskName: "dup", runId: RUN, pairs: PAIRS, outDir, overwrite: true }),
    ).not.toThrow();
  });
});
