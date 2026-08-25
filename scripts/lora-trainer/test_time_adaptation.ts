/**
 * Test-Time Adaptation (TTT) Dataset Generator.
 *
 * Takes task input/output training pairs at inference time and formats them into
 * a JSONL dataset (`ttt_dataset.jsonl` and `ttt_dataset.json`) ready for local LoRA fine-tuning.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

export interface TaskPair {
  input: any;
  output: any;
}

export interface TTTDatasetEntry {
  prompt: string;
  response: string;
}

/**
 * Formats a task pair into a prompt/response string pair.
 */
export function formatTTTEntry(pair: TaskPair, exampleIndex: number): TTTDatasetEntry {
  const prompt = `Task Example ${exampleIndex + 1}:\nInput Grid:\n${JSON.stringify(
    pair.input
  )}\nProduce the transformed output grid in JSON format.`;

  const response = `Output Grid:\n${JSON.stringify(pair.output)}`;

  return { prompt, response };
}

/**
 * Generates TTT fine-tuning datasets from task pairs.
 */
export function generateTTTDataset(
  taskPairs: TaskPair[],
  outputDir: string = "/tmp/ttt"
): { jsonlPath: string; jsonPath: string; count: number } {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const entries: TTTDatasetEntry[] = taskPairs.map((pair, idx) =>
    formatTTTEntry(pair, idx)
  );

  const jsonlPath = join(outputDir, "ttt_dataset.jsonl");
  const jsonPath = join(outputDir, "ttt_dataset.json");

  const jsonlContent = entries.map((e) => JSON.stringify(e)).join("\n");
  const jsonContent = JSON.stringify(entries, null, 2);

  writeFileSync(jsonlPath, jsonlContent, "utf-8");
  writeFileSync(jsonPath, jsonContent, "utf-8");

  return {
    jsonlPath,
    jsonPath,
    count: entries.length,
  };
}
