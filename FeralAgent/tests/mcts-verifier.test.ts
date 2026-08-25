import { describe, expect, it } from "vitest";
import {
  computeUCT,
  runMCTSVerification,
  verifyProgram,
} from "../src/core/mcts-verifier.js";

describe("MCTS Engine & Active Verifier", () => {
  it("computes UCT formula correctly", () => {
    const unvisitedNode = {
      id: "n1",
      parentId: "n0",
      childrenIds: [],
      visits: 0,
      value: 0,
      programCode: "",
    };
    expect(computeUCT(unvisitedNode, 10)).toBe(Infinity);

    const visitedNode = {
      id: "n2",
      parentId: "n0",
      childrenIds: [],
      visits: 5,
      value: 2.5,
      programCode: "",
    };
    const uct = computeUCT(visitedNode, 10, 1.414);
    expect(uct).toBeGreaterThan(0.5);
    expect(Number.isFinite(uct)).toBe(true);
  });

  it("verifies passing programs on task pairs", () => {
    const taskPairs = [
      {
        input: [
          [1, 2],
          [3, 4],
        ],
        output: [
          [3, 1],
          [4, 2],
        ],
      },
    ];

    const rotateCode = "function solve(I) { return DSL.rotate(I, 90); }";
    const result = verifyProgram(rotateCode, taskPairs);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.failedExamples).toHaveLength(0);
  });

  it("catches failing programs and records failed examples digest", () => {
    const taskPairs = [
      {
        input: [
          [1, 2],
          [3, 4],
        ],
        output: [
          [9, 9],
          [9, 9],
        ],
      },
    ];

    const wrongCode = "function solve(I) { return I; }";
    const result = verifyProgram(wrongCode, taskPairs);

    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.failedExamples).toHaveLength(1);
    expect(result.failedExamplesDigest).toBeDefined();
    expect(result.failedExamplesDigest.length).toBe(8);
  });

  it("runs MCTS search and discovers passing rotation program", async () => {
    const taskPairs = [
      {
        input: [
          [1, 2],
          [3, 4],
        ],
        output: [
          [3, 1],
          [4, 2],
        ],
      },
    ];

    const searchResult = await runMCTSVerification(taskPairs, {
      maxSimulations: 20,
    });

    expect(searchResult.verification.passed).toBe(true);
    expect(searchResult.bestNode.programCode).toContain("DSL.rotate");
    expect(searchResult.treeSize).toBeGreaterThan(1);
  });
});
