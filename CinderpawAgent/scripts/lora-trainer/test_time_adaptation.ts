/**
 * test_time_adaptation.ts — Test-Time Training (TTT) dataset builder.
 *
 * Takes the demonstration pairs of the CURRENT task and materializes a
 * fine-tuning dataset ready for local LoRA training. Format follows the
 * authoritative trainer contract (docs/LORA_TRAINER.md): JSONL, one
 * {"prompt", "response"} pair per line, consumed by
 * `FERAL_LORA_TRAINER_BIN finetune --data <file>` (bundled trainer install:
 * scripts/setup-lora-trainer.sh / .ps1).
 *
 * Outputs (OS temp dir unless --out-dir):
 *   - ttt_dataset.jsonl  trainer-ready dataset (the contract format)
 *   - ttt_dataset.json   human-inspectable mirror of the same records
 *
 * Pure Node/Bun APIs, no network, works on a fresh machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface TttPair {
  input: unknown;
  output: unknown;
}

export interface TttRecord {
  prompt: string;
  response: string;
}

export interface TttDatasetResult {
  jsonlPath: string;
  jsonPath: string;
  recordCount: number;
  taskName: string;
}

function assertPairs(pairs: readonly TttPair[]): void {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("test_time_adaptation: pairs must be a non-empty array of { input, output }");
  }
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i] as Partial<TttPair> | undefined;
    if (!pair || typeof pair !== "object" || !("input" in pair) || !("output" in pair)) {
      throw new Error(
        `test_time_adaptation: pairs[${i}] must be an object with both "input" and "output" fields`,
      );
    }
  }
}

/** Build trainer-contract records from demonstration pairs. */
export function buildTttRecords(
  taskName: string,
  pairs: readonly TttPair[],
  description?: string,
): TttRecord[] {
  if (typeof taskName !== "string" || taskName.trim() === "") {
    throw new Error("test_time_adaptation: taskName must be a non-empty string");
  }
  assertPairs(pairs);
  return pairs.map((pair, index) => {
    const hint = description ? ` Rule hint: ${description}.` : "";
    return {
      prompt:
        `Task ${taskName}, example ${index + 1}: transform the input into the demonstrated output.` +
        `${hint}\nInput: ${JSON.stringify(pair.input)}`,
      response: `Output: ${JSON.stringify(pair.output)}`,
    };
  });
}

/**
 * Materialize the dataset. Writes BOTH files loudly and returns their paths
 * so the caller can hand `jsonlPath` straight to the trainer contract.
 */
export function writeTttDataset(options: {
  taskName: string;
  pairs: readonly TttPair[];
  description?: string;
  outDir?: string;
}): TttDatasetResult {
  const records = buildTttRecords(options.taskName, options.pairs, options.description);
  const outDir = options.outDir ?? os.tmpdir();
  fs.mkdirSync(outDir, { recursive: true });

  const jsonlPath = path.join(outDir, "ttt_dataset.jsonl");
  const jsonPath = path.join(outDir, "ttt_dataset.json");

  fs.writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  return { jsonlPath, jsonPath, recordCount: records.length, taskName: options.taskName };
}

function parseArgs(argv: readonly string[]): { task?: string; outDir?: string } {
  const out: { task?: string; outDir?: string } = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--task") out.task = value;
    else if (key === "--out-dir") out.outDir = value;
    else throw new Error(`test_time_adaptation: unknown argument "${String(key)}"`);
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  if (!args.task) {
    console.error("[ttt] usage: bun scripts/lora-trainer/test_time_adaptation.ts --task <task.json> [--out-dir DIR]");
    console.error('[ttt]   task file shape: { "taskName": "...", "description": "...?", "pairs": [{ "input": ..., "output": ... }] }');
    process.exitCode = 1;
    return;
  }
  const resolved = path.resolve(args.task);
  if (!fs.existsSync(resolved)) {
    console.error(`[ttt] task file not found: ${resolved}`);
    process.exitCode = 1;
    return;
  }
  let parsed: { taskName?: string; description?: string; pairs?: TttPair[] };
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as typeof parsed;
  } catch (e) {
    console.error(`[ttt] task file is not valid JSON — ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const taskName = parsed.taskName ?? path.basename(resolved).replace(/\.json$/i, "");
  try {
    const result = writeTttDataset({
      taskName,
      pairs: parsed.pairs ?? [],
      description: parsed.description,
      outDir: args.outDir,
    });
    console.log(`[ttt] task "${result.taskName}": ${result.recordCount} demonstration pairs`);
    console.log(`[ttt] trainer-ready dataset (contract JSONL): ${result.jsonlPath}`);
    console.log(`[ttt] inspectable mirror: ${result.jsonPath}`);
    console.log("[ttt] next step: FERAL_LORA_TRAINER_BIN finetune --data <jsonl above>");
  } catch (e) {
    console.error(`[ttt] ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  main();
}
