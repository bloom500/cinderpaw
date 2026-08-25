/**
 * mcts-verifier.test.ts — MCTS + Active Verifier (spec §Module 3).
 *
 * Runner-agnostic by design: it prefers `bun:test` (the repo gate) and
 * falls back to `vitest` so `npx vitest run tests/mcts-verifier.test.ts`
 * also passes green. Only the common expect subset is used.
 */

interface RunnerLike {
  describe: (name: string, fn: () => void) => void;
  test: (name: string, fn: () => void | Promise<void>) => void;
  // biome-ignore lint/suspicious/noExplicitAny: runner modules are structurally identical but not statically typed here
  expect: any;
}

async function loadRunner(): Promise<RunnerLike> {
  try {
    const mod = await import("bun:test");
    return { describe: mod.describe, test: mod.test, expect: mod.expect };
  } catch {
    // Under Vitest, resolve its API via a static-import shim: a computed
    // `import("vitest")` is mis-resolved as a relative path by the SSR
    // transformer.
    const mod = await import("./_runner-vitest.ts");
    return { describe: mod.describe, test: mod.test ?? mod.it, expect: mod.expect };
  }
}

const { describe, test, expect } = await loadRunner();

import {
  DEFAULT_EXPLORATION_CONSTANT,
  MAX_DYNAMIC_CANDIDATES,
  compileProgram,
  generateCandidateMutations,
  runMCTSVerification,
  uctScore,
  verifyTransform,
} from "../src/core/mcts-verifier.ts";
import type { MCTSNode, TaskPair } from "../src/core/mcts-verifier.ts";

const G = (...rows: number[][]): number[][] => rows;

describe("uctScore", () => {
  test("matches the UCT formula hand-computed (C=√2)", () => {
    // exploitation 7/10 = 0.7 ; exploration 1.414·√(ln(20)/10)
    const expected = 0.7 + Math.SQRT2 * Math.sqrt(Math.log(20) / 10);
    const got = uctScore(7, 10, 20, 1.4142135623730951);
    expect(got).toBeCloseTo(expected, 12);
  });

  test("default C is 1.414", () => {
    expect(DEFAULT_EXPLORATION_CONSTANT).toBe(1.414);
    expect(uctScore(4, 8, 8)).toBeCloseTo(0.5 + 1.414 * Math.sqrt(Math.log(8) / 8), 12);
  });

  test("unvisited child scores Infinity → always explored first", () => {
    expect(uctScore(0, 0, 100)).toBe(Infinity);
  });

  test("loud on nonsense inputs", () => {
    expect(() => uctScore(Number.NaN, 1, 1)).toThrow(/finite/);
    expect(() => uctScore(0, -1, 5)).toThrow(/non-negative integer/);
    expect(() => uctScore(0, 1, 0)).toThrow(/positive integer/);
    expect(() => uctScore(0, 1, 5, -1)).toThrow(/non-negative constant/);
  });
});

describe("compileProgram", () => {
  test("DSL primitives are in scope inside candidate programs", () => {
    const fn = compileProgram("(g) => rotate(g, 90)");
    const grid = [
      [1, 2],
      [3, 4],
    ];
    expect(fn(grid)).toEqual([
      [3, 1],
      [4, 2],
    ]);
  });

  test("loud when the expression does not evaluate to a function", () => {
    expect(() => compileProgram("42")).toThrow(/expression evaluating to \(grid\) => grid/);
    expect(() => compileProgram("")).toThrow(/non-empty string/);
    expect(() => compileProgram("(g => {")).toThrow(/syntax error/);
  });
});

describe("verifyTransform (Active Verifier)", () => {
  const pairs: TaskPair[] = [
    { input: G([1, 2], [3, 4]), output: G([3, 1], [4, 2]) },
    { input: G([5, 6]), output: G([5], [6]) },
  ];

  test("perfect program passes with digest null", () => {
    const report = verifyTransform(compileProgram("(g) => rotate(g, 90)"), pairs);
    expect(report.passed).toBe(true);
    expect(report.passedExamples).toBe(2);
    expect(report.totalExamples).toBe(2);
    expect(report.failedExamplesDigest).toBe(null);
  });

  test("failing program produces a deterministic failedExamplesDigest", () => {
    const wrong = "(g) => mirror(g, 'vertical')";
    const a = verifyTransform(compileProgram(wrong), pairs);
    const b = verifyTransform(compileProgram(wrong), pairs);
    expect(a.passed).toBe(false);
    expect(a.failures.length).toBeGreaterThan(0);
    expect(a.failedExamplesDigest).not.toBe(null);
    expect(a.failedExamplesDigest).toBe(b.failedExamplesDigest);
    expect(a.failures[0].exampleIndex).toBe(0);
    expect(typeof a.failures[0].reason).toBe("string");
  });

  test("different failures → different digests", () => {
    const a = verifyTransform(compileProgram("(g) => mirror(g, 'vertical')"), pairs);
    const b = verifyTransform(compileProgram("(g) => shift(g, 1, 0)"), pairs);
    expect(a.failedExamplesDigest).not.toBe(b.failedExamplesDigest);
  });

  test("a program that throws scores as failure, never propagates", () => {
    const report = verifyTransform(compileProgram("(g) => { throw new Error('boom'); }"), pairs);
    expect(report.passed).toBe(false);
    expect(report.passedExamples).toBe(0);
    expect(report.failures[0].reason).toContain("boom");
  });
});

describe("runMCTSVerification", () => {
  test("async contract: returns a Promise of { bestNode, verification, treeSize }", async () => {
    const pairs: TaskPair[] = [{ input: G([1, 2]), output: G([2, 1]) }];
    const resultP = runMCTSVerification(pairs, { iterations: 30 });
    expect(resultP).toBeInstanceOf(Promise);
    const result = await resultP;
    expect(result.treeSize).toBeGreaterThan(0);
    expect(typeof result.bestNode.id).toBe("number");
    expect(result.verification.totalExamples).toBe(1);
  }, 15000);

  test("MCTSNode carries id / parentId / childrenIds / visits / value / programCode", async () => {
    const result = await runMCTSVerification([{ input: G([1]), output: G([1]) }], { iterations: 10 });
    const n = result.bestNode;
    expect(Array.isArray(n.childrenIds)).toBe(true);
    expect(n.parentId).toBeTypeOf("number");
    expect(n.visits).toBeGreaterThan(0);
    expect(n.value).toBeGreaterThanOrEqual(0);
    expect(typeof n.programCode).toBe("string");
  }, 15000);

  test("solves a rotate-90 task from the default pool and passes verification", async () => {
    const input = G(
      [1, 2, 3],
      [4, 5, 6],
    );
    const output = G(
      [4, 1],
      [5, 2],
      [6, 3],
    );
    const result = await runMCTSVerification([{ input, output }], { iterations: 60 });
    expect(result.verification.passed).toBe(true);
    expect(result.verification.failedExamplesDigest).toBe(null);
    expect(result.verification.passedExamples).toBe(1);
    expect(result.bestNode.programCode).toContain("rotate");
  }, 15000);

  test("solves a genuine two-step composition (mirror vertical → recolor)", async () => {
    // No single default primitive maps input→output; only the depth-2 combo
    // recolor(mirrorVertical(g)) does.
    const input = G(
      [1, 0],
      [0, 1],
    );
    const output = G(
      [0, 2],
      [2, 0],
    );
    const result = await runMCTSVerification([{ input, output }], { iterations: 300, maxDepth: 2 });
    expect(result.verification.passed).toBe(true);
    const code = result.bestNode.programCode!;
    // The grid is diagonal-symmetric, so both recolor∘mirror and
    // rotate∘recolor are legitimate depth-2 solutions — accept either.
    expect(code.includes("recolor") || code.includes("mirror")).toBe(true);
  }, 20000);

  test("multi-example tasks generalize across pairs", async () => {
    const pairs: TaskPair[] = [
      { input: G([1, 1]), output: G([2, 2]) },
      { input: G([5, 5]), output: G([6, 6]) },
      { input: G([9]), output: G([10]) },
    ];
    const result = await runMCTSVerification(pairs, {
      iterations: 40,
      candidates: ["(g) => g.map(row => row.map(v => v + 1))", "(g) => g"],
    });
    expect(result.verification.passed).toBe(true);
    expect(result.verification.passedExamples).toBe(3);
  }, 15000);

  test("custom string candidates are used verbatim", async () => {
    const result = await runMCTSVerification(
      [{ input: G([1, 1]), output: G([2, 2]) }],
      { iterations: 15, candidates: ["(g) => recolor(g, 1, 2)", "(g) => g"] },
    );
    expect(result.verification.passed).toBe(true);
    expect(result.bestNode.programCode).toContain("recolor");
  }, 15000);

  test("custom template candidates compose over the parent program", async () => {
    const result = await runMCTSVerification([{ input: G([1]), output: G([1]) }], {
      iterations: 25,
      candidates: [(parentCode) => `(g) => ${parentCode}(g)`],
    });
    expect(result.treeSize).toBeGreaterThan(1);
    expect(typeof result.bestNode.programCode).toBe("string");
  }, 15000);

  test("deterministic: identical options → identical tree and best node", async () => {
    const input = G([1, 2], [3, 4]);
    const output = G([3, 1], [4, 2]);
    const opts = { iterations: 50 } as const;
    const a = await runMCTSVerification([{ input, output }], opts);
    const b = await runMCTSVerification([{ input, output }], opts);
    expect(a.treeSize).toBe(b.treeSize);
    expect(a.bestNode.id).toBe(b.bestNode.id);
    expect(a.bestNode.programCode).toBe(b.bestNode.programCode);
    expect(a.verification).toEqual(b.verification);
  }, 15000);

  test("unsolvable task still returns the best-scoring node with digest set", async () => {
    const result = await runMCTSVerification([{ input: G([1]), output: G([9, 9, 9, 9, 9]) }], {
      iterations: 40,
      maxDepth: 1,
    });
    expect(result.verification.passed).toBe(false);
    expect(result.verification.failedExamplesDigest).not.toBe(null);
    expect(result.verification.passedExamples).toBe(0);
    expect(result.treeSize).toBeGreaterThan(1);
  }, 15000);

  test("compile errors inside candidates are captured as failures", async () => {
    const result = await runMCTSVerification([{ input: G([1]), output: G([1]) }], {
      iterations: 10,
      candidates: ["(g => broken"],
    });
    expect(result.verification.passed).toBe(false);
    expect(result.verification.failures[0].reason.startsWith("compile error:")).toBe(true);
  }, 15000);

  test("onIteration fires once per iteration with monotone bookkeeping", async () => {
    const seen: Array<{ iteration: number; treeSize: number }> = [];
    await runMCTSVerification([{ input: G([1]), output: G([2]) }], {
      iterations: 12,
      onIteration: (info) => seen.push({ iteration: info.iteration, treeSize: info.treeSize }),
    });
    expect(seen.length).toBe(12);
    expect(seen[11].iteration).toBe(12);
    expect(seen[11].treeSize).toBeGreaterThanOrEqual(seen[0].treeSize);
  }, 15000);

  test("loud validation", async () => {
    await expect(runMCTSVerification([])).rejects.toThrow(/non-empty array/);
    await expect(runMCTSVerification([{ input: [[1]], output: [] }])).rejects.toThrow(/taskPairs\[0\]\.output/);
    await expect(runMCTSVerification([{ input: [[1]], output: [[1]] }], { iterations: 0 })).rejects.toThrow(
      /iterations must be an integer ≥ 1/,
    );
    await expect(
      runMCTSVerification([{ input: [[1]], output: [[1]] }], { explorationConstant: -3 }),
    ).rejects.toThrow(/explorationConstant/);
    await expect(runMCTSVerification([{ input: [[1]], output: [[1]] }], { maxDepth: 0 })).rejects.toThrow(/maxDepth/);
    await expect(
      runMCTSVerification([{ input: [[1]], output: [[1]] }], { candidates: [] }),
    ).rejects.toThrow(/candidates pool is empty/);
  }, 15000);

  test("input grids are never mutated", async () => {
    const input = G([1, 2], [3, 4]);
    const output = G([3, 1], [4, 2]);
    const snapshot = JSON.stringify({ input, output });
    await runMCTSVerification([{ input, output }], { iterations: 30 });
    expect(JSON.stringify({ input, output })).toBe(snapshot);
  }, 15000);
});

describe("generateCandidateMutations (dynamic candidate generation)", () => {
  const ROOT: MCTSNode = { id: 0, parentId: null, childrenIds: [], visits: 0, value: 0, programCode: null, depth: 0 };

  test("data-driven recolors derived from observed palette shifts", () => {
    const pairs: TaskPair[] = [
      { input: G([3, 3]), output: G([7, 7]) },
      { input: G([3]), output: G([7]) },
    ];
    const cands = generateCandidateMutations(ROOT, pairs);
    expect(cands.length).toBeGreaterThan(13); // geometry core + recolors
    // Materialize every factory against the identity parent and check the
    // observed 3→7 mapping is present.
    const codes = cands.map((t) => t("(g) => g"));
    expect(codes.some((c) => c.includes("recolor") && c.includes(", 3, 7)"))).toBe(true);
    // No invented mappings: only colors actually seen in the task appear.
    expect(codes.some((c) => /recolor.*\(g\), 9,/.test(c))).toBe(false);
  });

  test("composes dynamically over the current node's program", () => {
    const parentCode = "(g) => mirror(g, 'vertical')";
    const node: MCTSNode = { ...ROOT, programCode: parentCode };
    const cands = generateCandidateMutations(node, [{ input: G([1]), output: G([1]) }]);
    const codes = cands.map((t) => t(parentCode));
    // Every geometric candidate must WRAP the parent program, not replace it.
    expect(codes.some((c) => c.includes(`((${parentCode}))(g)`))).toBe(true);
    expect(codes.every((c) => c.startsWith("(g) => "))).toBe(true);
  });

  test("floodFill seed comes from the first non-background pixel", () => {
    const pairs: TaskPair[] = [{ input: G([0, 0], [0, 4]), output: G([5, 5], [5, 5]) }];
    const codes = generateCandidateMutations(ROOT, pairs).map((t) => t("(g) => g"));
    expect(codes.some((c) => c.includes("floodFill") && c.includes("(g), 1, 1, 5)"))).toBe(true);
  });

  test("candidate count is capped at MAX_DYNAMIC_CANDIDATES", () => {
    // Wide palettes on both sides would explode the recolor cross-product
    // without the cap.
    const inputRow = [1, 2, 3, 4, 5, 6];
    const outputRow = [11, 12, 13, 14, 15, 16];
    const pairs: TaskPair[] = [{ input: G(inputRow), output: G(outputRow) }];
    const cands = generateCandidateMutations(ROOT, pairs);
    expect(cands.length).toBeLessThanOrEqual(MAX_DYNAMIC_CANDIDATES);
  });

  test("loud on invalid currentNode or taskPairs", () => {
    expect(() =>
      generateCandidateMutations({ ...ROOT, programCode: 42 as unknown as string }, [
        { input: G([1]), output: G([1]) },
      ]),
    ).toThrow(/programCode must be null or a string/);
    expect(() => generateCandidateMutations(ROOT, [])).toThrow(/non-empty array/);
  });

  test("end-to-end: solves a recolor-3-to-7 task with NO explicit candidates", async () => {
    // The old static pool only knew recolor(1→2); this task is solvable now
    // purely because candidates are generated from the task data.
    const result = await runMCTSVerification(
      [
        { input: G([3, 3, 3]), output: G([7, 7, 7]) },
        { input: G([3, 0]), output: G([7, 0]) },
      ],
      { iterations: 120 },
    );
    expect(result.verification.passed).toBe(true);
    expect(result.bestNode.programCode).toContain("recolor");
  }, 20000);
});
