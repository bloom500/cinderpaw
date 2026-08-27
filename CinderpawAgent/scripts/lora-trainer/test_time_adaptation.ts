/**
 * test_time_adaptation.ts — TTT DATASET BUILDER. It builds a file; it does
 * not train anything.
 *
 * Say the scope out loud, because the name does not: there is no training
 * loop here, no optimizer state, no checkpoints, no rollback, no eval gate
 * and no GPU handling. Test-Time Training as a capability is NOT
 * implemented. What this does is take the demonstration pairs of one task
 * and materialize a fine-tuning dataset in the authoritative trainer
 * contract format (docs/LORA_TRAINER.md): JSONL, one {"prompt","response"}
 * per line, consumed by `CINDERPAW_LORA_TRAINER_BIN finetune --data <file>`
 * (bundled trainer install: scripts/setup-lora-trainer.sh / .ps1).
 *
 * Anyone planning a "+TTT" benchmark column should read the paragraph above
 * first: that column cannot be produced from this file alone.
 *
 * RUN SCOPING (INV-F). `runId` is required and datasets land under
 * <tmp>/cinderpaw-ttt/<runId>/. The previous default wrote every task to
 * one fixed `ttt_dataset.jsonl` in the OS temp dir, so two episodes
 * silently overwrote each other and a trainer pointed at a stale path would
 * fine-tune episode N+1 on episode N's data — contamination with no error
 * and no trace. Existing files are never replaced unless the caller says so.
 *
 * Outputs (per run, per task):
 *   - ttt_<task>.jsonl  trainer-ready dataset (the contract format)
 *   - ttt_<task>.json   human-inspectable mirror of the same records
 *
 * Pure Node/Bun APIs, no network, works on a fresh machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertValidRunId } from "../../src/core/run-id.ts";

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
  /** REQUIRED. The episode this dataset belongs to. See RUN SCOPING. */
  runId: string;
  pairs: readonly TttPair[];
  description?: string;
  outDir?: string;
  /** Allow replacing an existing dataset for this run+task. Default false. */
  overwrite?: boolean;
}): TttDatasetResult {
  assertValidRunId(options?.runId);
  const records = buildTttRecords(options.taskName, options.pairs, options.description);
  const outDir = options.outDir ?? path.join(os.tmpdir(), "cinderpaw-ttt", options.runId);
  fs.mkdirSync(outDir, { recursive: true });

  // The task name is in the FILENAME too: one run can hold many tasks, and
  // they must not overwrite one another either.
  const slug =
    options.taskName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task";
  const jsonlPath = path.join(outDir, `ttt_${slug}.jsonl`);
  const jsonPath = path.join(outDir, `ttt_${slug}.json`);

  if (options.overwrite !== true) {
    for (const existing of [jsonlPath, jsonPath]) {
      if (fs.existsSync(existing)) {
        throw new Error(
          `test_time_adaptation: ${existing} already exists for run "${options.runId}" — ` +
            "refusing to overwrite a dataset another step may already be training on; " +
            "pass overwrite:true (or --overwrite) if replacing it is what you mean",
        );
      }
    }
  }

  fs.writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  return { jsonlPath, jsonPath, recordCount: records.length, taskName: options.taskName };
}

interface TttArgs {
  task?: string;
  outDir?: string;
  runId?: string;
  overwrite?: boolean;
}

function parseArgs(argv: readonly string[]): TttArgs {
  const out: TttArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    // `--overwrite` is a flag, so the old fixed 2-step stride would have
    // swallowed the following argument as its value.
    if (key === "--overwrite") {
      out.overwrite = true;
      continue;
    }
    const value = argv[i + 1];
    if (key === "--task") out.task = value;
    else if (key === "--out-dir") out.outDir = value;
    else if (key === "--run-id") out.runId = value;
    else throw new Error(`test_time_adaptation: unknown argument "${String(key)}"`);
    i++;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv);
  if (!args.task || !args.runId) {
    console.error(
      "[ttt] usage: bun scripts/lora-trainer/test_time_adaptation.ts --task <task.json> --run-id <id> [--out-dir DIR] [--overwrite]",
    );
    console.error('[ttt]   task file shape: { "taskName": "...", "description": "...?", "pairs": [{ "input": ..., "output": ... }] }');
    console.error("[ttt]   --run-id names the episode; datasets are isolated per run so two episodes cannot overwrite each other.");
    console.error("[ttt] NOTE: this builds a dataset. It does not train, checkpoint or roll anything back.");
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
      runId: args.runId,
      pairs: parsed.pairs ?? [],
      description: parsed.description,
      outDir: args.outDir,
      overwrite: args.overwrite === true,
    });
    console.log(`[ttt] task "${result.taskName}": ${result.recordCount} demonstration pairs`);
    console.log(`[ttt] trainer-ready dataset (contract JSONL): ${result.jsonlPath}`);
    console.log(`[ttt] inspectable mirror: ${result.jsonPath}`);
    console.log("[ttt] next step: CINDERPAW_LORA_TRAINER_BIN finetune --data <jsonl above>");
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
