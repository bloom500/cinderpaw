import { describe, expect, it } from "vitest";
import {
  formatTTTEntry,
  generateTTTDataset,
} from "../../scripts/lora-trainer/test_time_adaptation.js";

describe("Test-Time Adaptation (TTT) Dataset Generator", () => {
  it("formats task pair into TTT dataset prompt/response entry", () => {
    const pair = { input: [[1]], output: [[2]] };
    const entry = formatTTTEntry(pair, 0);

    expect(entry.prompt).toContain("Task Example 1:");
    expect(entry.prompt).toContain("[[1]]");
    expect(entry.response).toContain("[[2]]");
  });

  it("generates JSONL and JSON dataset files on disk", () => {
    const taskPairs = [
      { input: [[1, 2]], output: [[2, 1]] },
      { input: [[0, 0]], output: [[9, 9]] },
    ];

    const result = generateTTTDataset(taskPairs, "/tmp/ttt_test");
    expect(result.count).toBe(2);
    expect(result.jsonlPath).toContain("ttt_dataset.jsonl");
    expect(result.jsonPath).toContain("ttt_dataset.json");
  });
});
