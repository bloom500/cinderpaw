/**
 * Monte Carlo Tree Search (MCTS) Engine & Active Adversarial Verifier.
 *
 * Implements System 2 reasoning over candidate DSL program transformations for
 * ARC-AGI 2D matrix tasks and complex multi-hypothesis execution.
 */

import { DSL_PRIMITIVES } from "../rlm/dsl/primitives.js";

export interface MCTSNode {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  visits: number;
  value: number; // Accumulated reward (0.0 to 1.0)
  programCode: string;
  stateResult?: any;
}

export interface FailedExample {
  exampleIndex: number;
  expected: any;
  actual: any;
  error?: string;
}

export interface VerificationResult {
  passed: boolean;
  score: number; // Percentage of task pairs solved (0.0 to 1.0)
  failedExamples: FailedExample[];
  failedExamplesDigest: string;
}

export interface MCTSOptions {
  maxSimulations?: number; // Default: 50
  explorationConstant?: number; // UCT C constant, default: 1.414
  timeoutMs?: number; // Default: 30000 ms
}

/**
 * Deterministic FNV-1a 32-bit hash function for failed example digests.
 */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Dynamically generates data-driven candidate program mutations for expansion.
 */
export function generateCandidateMutations(
  currentNode: MCTSNode,
  taskPairs: Array<{ input: any; output: any }>
): string[] {
  const mutations: string[] = [];

  // Extract unique colors in inputs and outputs to derive data-driven recolor rules
  const inputColors = new Set<number | string>();
  const outputColors = new Set<number | string>();

  for (const pair of taskPairs) {
    if (Array.isArray(pair.input)) {
      pair.input.flat(2).forEach((c) => inputColors.add(c));
    }
    if (Array.isArray(pair.output)) {
      pair.output.flat(2).forEach((c) => outputColors.add(c));
    }
  }

  // Geometric mutations
  mutations.push("function solve(I) { return DSL.rotate(I, 90); }");
  mutations.push("function solve(I) { return DSL.rotate(I, 180); }");
  mutations.push("function solve(I) { return DSL.rotate(I, 270); }");
  mutations.push("function solve(I) { return DSL.mirror(I, 'horizontal'); }");
  mutations.push("function solve(I) { return DSL.mirror(I, 'vertical'); }");
  mutations.push("function solve(I) { return DSL.applyGravity(I, 'down'); }");

  // Data-driven color recoloring mutations
  for (const inCol of inputColors) {
    for (const outCol of outputColors) {
      if (inCol !== outCol) {
        mutations.push(
          `function solve(I) { return DSL.recolor(I, ${JSON.stringify(
            inCol
          )}, ${JSON.stringify(outCol)}); }`
        );
      }
    }
  }

  // Compose mutation on top of parent program if parent isn't root
  if (currentNode.programCode && currentNode.programCode !== "function solve(I) { return I; }") {
    mutations.push(
      `function solve(I) { const temp = (${currentNode.programCode})(I); return DSL.rotate(temp, 90); }`
    );
  }

  return mutations.slice(0, 32); // Capped at 32 candidate mutations
}

/**
 * Computes Upper Confidence Bound for Trees (UCT) score.
 */
export function computeUCT(
  node: MCTSNode,
  parentVisits: number,
  explorationConstant: number = 1.414
): number {
  if (node.visits === 0) return Infinity;
  const exploitation = node.value / node.visits;
  const exploration =
    explorationConstant * Math.sqrt(Math.log(parentVisits) / node.visits);
  return exploitation + exploration;
}

/**
 * Active Verifier: Evaluates a candidate DSL program against task input/output pairs.
 */
export function verifyProgram(
  programCode: string,
  taskPairs: Array<{ input: any; output: any }>
): VerificationResult {
  if (taskPairs.length === 0) {
    return {
      passed: true,
      score: 1.0,
      failedExamples: [],
      failedExamplesDigest: fnv1aHash("no_pairs"),
    };
  }

  let passedCount = 0;
  const failedExamples: FailedExample[] = [];

  for (let i = 0; i < taskPairs.length; i++) {
    const pair = taskPairs[i];
    try {
      const solverFn = new Function(
        "I",
        "DSL",
        `
        const { rotate, mirror, recolor, floodFill, crop, applyGravity } = DSL;
        const solve = (${programCode});
        return solve(I);
      `
      );

      const actual = solverFn(pair.input, DSL_PRIMITIVES);

      if (JSON.stringify(actual) === JSON.stringify(pair.output)) {
        passedCount++;
      } else {
        failedExamples.push({
          exampleIndex: i,
          expected: pair.output,
          actual,
        });
      }
    } catch (err: any) {
      failedExamples.push({
        exampleIndex: i,
        expected: pair.output,
        actual: null,
        error: err?.message ?? String(err),
      });
    }
  }

  const score = passedCount / taskPairs.length;
  const passed = passedCount === taskPairs.length;

  const digestString = failedExamples
    .map((e) => `${e.exampleIndex}:${JSON.stringify(e.expected)}!=${JSON.stringify(e.actual)}`)
    .join("|");

  return {
    passed,
    score,
    failedExamples,
    failedExamplesDigest: fnv1aHash(digestString || "all_passed"),
  };
}

/**
 * Primary MCTS Engine: Runs Monte Carlo Tree Search to discover the optimal DSL transformation.
 */
export async function runMCTSVerification(
  taskPairs: Array<{ input: any; output: any }>,
  options: MCTSOptions = {}
): Promise<{
  bestNode: MCTSNode;
  verification: VerificationResult;
  treeSize: number;
}> {
  const maxSimulations = options.maxSimulations ?? 50;
  const C = options.explorationConstant ?? 1.414;
  const timeoutMs = options.timeoutMs ?? 30000;
  const startTime = Date.now();

  const nodes = new Map<string, MCTSNode>();

  const rootNode: MCTSNode = {
    id: "node_0",
    parentId: null,
    childrenIds: [],
    visits: 0,
    value: 0,
    programCode: "function solve(I) { return I; }",
  };

  nodes.set(rootNode.id, rootNode);
  let nodeCounter = 1;

  let bestNode = rootNode;
  let bestVerification = verifyProgram(rootNode.programCode, taskPairs);

  if (bestVerification.passed) {
    return {
      bestNode: rootNode,
      verification: bestVerification,
      treeSize: 1,
    };
  }

  for (let sim = 0; sim < maxSimulations; sim++) {
    if (Date.now() - startTime > timeoutMs) break;

    // 1. Selection
    let curr = rootNode;
    while (curr.childrenIds.length > 0) {
      let bestChild: MCTSNode | null = null;
      let maxUCT = -Infinity;

      for (const childId of curr.childrenIds) {
        const child = nodes.get(childId)!;
        const uct = computeUCT(child, curr.visits, C);
        if (uct > maxUCT) {
          maxUCT = uct;
          bestChild = child;
        }
      }

      if (!bestChild) break;
      curr = bestChild;
    }

    // 2. Dynamic Expansion
    if (curr.visits > 0 && curr.childrenIds.length === 0) {
      const mutations = generateCandidateMutations(curr, taskPairs);
      for (const mutCode of mutations) {
        const childId = `node_${nodeCounter++}`;
        const childNode: MCTSNode = {
          id: childId,
          parentId: curr.id,
          childrenIds: [],
          visits: 0,
          value: 0,
          programCode: mutCode,
        };
        nodes.set(childId, childNode);
        curr.childrenIds.push(childId);
      }

      if (curr.childrenIds.length > 0) {
        curr = nodes.get(curr.childrenIds[0])!;
      }
    }

    // 3. Simulation & Verification
    const vResult = verifyProgram(curr.programCode, taskPairs);

    if (vResult.score > bestVerification.score) {
      bestVerification = vResult;
      bestNode = curr;
    }

    // 4. Backpropagation
    let backCurr: MCTSNode | null = curr;
    while (backCurr) {
      backCurr.visits += 1;
      backCurr.value += vResult.score;
      backCurr = backCurr.parentId ? nodes.get(backCurr.parentId) ?? null : null;
    }

    if (bestVerification.passed) break;
  }

  return {
    bestNode,
    verification: bestVerification,
    treeSize: nodes.size,
  };
}
