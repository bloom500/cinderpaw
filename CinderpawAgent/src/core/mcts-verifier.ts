/**
 * mcts-verifier.ts — Monte Carlo Tree Search + Active Verifier (spec §Module 3).
 *
 * The tree searches the space of grid-transformation programs. Each node
 * holds one candidate program (source code, DSL primitives in scope); each
 * expansion applies one more primitive template on top of the parent's
 * program. There is no stochastic rollout: the "simulation" step IS the
 * Active Verifier — run the candidate against the task's {input, output}
 * pairs and score it by the fraction of pairs it reproduces exactly.
 * That makes the whole search deterministic (no rng anywhere).
 *
 * Contract (same discipline as dsl/primitives.ts):
 *   - PURE inputs: task pairs and grids are never mutated.
 *   - LOUD: invalid configuration throws with what-is-wrong + what-was-expected.
 *   - Program code is compiled with `new Function` and executed synchronously;
 *     a program that throws or returns a wrong-shaped grid simply scores 0 —
 *     compile/runtime errors are captured as verification failures, never
 *     propagated out of runMCTSVerification().
 */

import { applyGravity, floodFill, mirror, recolor, rotate, shift } from "../rlm/dsl/primitives.ts";
import { assertValidGrid } from "../research/perception/scene-graph.ts";

export type Grid = number[][];
export type GridTransform = (grid: Grid) => Grid;

/** One supervised example: candidate(input) must deep-equal output. */
export interface TaskPair {
  input: Grid;
  output: Grid;
}

/**
 * One node of the search tree. `programCode` compiles to a Grid→Grid
 * function with the DSL primitives in scope; the root (id 0) has
 * `programCode === null` and represents the identity.
 */
export interface MCTSNode {
  id: number;
  parentId: number | null;
  childrenIds: number[];
  visits: number;
  value: number;
  programCode: string | null;
  depth: number;
}

/** Default exploration constant √2. */
export const DEFAULT_EXPLORATION_CONSTANT = 1.414;

/**
 * UCT: exploitation (child.value/child.visits) + exploration
 * (C·√(ln(parentVisits)/childVisits)). An unvisited child scores Infinity,
 * so it is always tried before any visited sibling.
 */
export function uctScore(
  childValue: number,
  childVisits: number,
  parentVisits: number,
  c: number = DEFAULT_EXPLORATION_CONSTANT,
): number {
  if (!Number.isFinite(childValue)) {
    throw new Error(`uctScore: childValue must be finite, got ${String(childValue)}`);
  }
  if (!Number.isInteger(childVisits) || childVisits < 0) {
    throw new Error(`uctScore: childVisits must be a non-negative integer, got ${String(childVisits)}`);
  }
  if (!Number.isInteger(parentVisits) || parentVisits <= 0) {
    throw new Error(`uctScore: parentVisits must be a positive integer, got ${String(parentVisits)}`);
  }
  if (!Number.isFinite(c) || c < 0) {
    throw new Error(`uctScore: c must be a finite non-negative constant, got ${String(c)}`);
  }
  if (childVisits === 0) return Infinity;
  return childValue / childVisits + c * Math.sqrt(Math.log(parentVisits) / childVisits);
}

export interface ExampleFailure {
  exampleIndex: number;
  reason: string;
  expected?: string;
  actual?: string;
}

export interface VerificationReport {
  passed: boolean;
  totalExamples: number;
  passedExamples: number;
  failures: ExampleFailure[];
  /**
   * Deterministic digest over every failing example (FNV-1a 32-bit over a
   * canonical serialization). null when all examples pass. Two runs on the
   * same failures produce byte-identical digests; different failures
   * (practically always) produce different ones.
   */
  failedExamplesDigest: string | null;
}

/** Compile `code` (an expression evaluating to Grid→Grid) into a transform. */
export function compileProgram(code: string): GridTransform {
  if (typeof code !== "string" || code.trim() === "") {
    throw new Error("compileProgram: program code must be a non-empty string");
  }
  // crop() needs an explicit bbox argument, so it is intentionally NOT in
  // the auto-injected scope — single-grid-expression candidates cannot call
  // it meaningfully.
  const scope: Record<string, unknown> = { rotate, mirror, shift, floodFill, applyGravity, recolor };
  const names = Object.keys(scope);
  let factory: (...args: unknown[]) => unknown;
  try {
    factory = new Function(
      "__dsl",
      `"use strict";\nconst { ${names.join(", ")} } = __dsl;\nreturn (${code});\n`,
    ) as (...args: unknown[]) => unknown;
  } catch (e) {
    throw new Error(`compileProgram: syntax error in program code — ${(e as Error).message}`);
  }
  let candidate: unknown;
  try {
    candidate = factory(scope);
  } catch (e) {
    throw new Error(`compileProgram: program factory threw — ${(e as Error).message}`);
  }
  if (typeof candidate !== "function") {
    throw new Error(
      `compileProgram: program must be an expression evaluating to (grid) => grid, got ${typeof candidate}`,
    );
  }
  return (grid: Grid) => (candidate as GridTransform)(grid);
}

/** FNV-1a 32-bit, hex-encoded. Used for failedExamplesDigest. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalFailures(failures: ExampleFailure[]): string {
  return JSON.stringify(
    failures.map((f) => ({
      i: f.exampleIndex,
      reason: f.reason,
      e: (f.expected ?? "").slice(0, 512),
      a: (f.actual ?? "").slice(0, 512),
    })),
  );
}

/**
 * Active Verifier: execute `transform` on every pair's input and require a
 * strict deep-equal match with the expected output. Runtime throws and
 * shape mismatches are failures with reasons, not exceptions.
 */
export function verifyTransform(transform: GridTransform, taskPairs: readonly TaskPair[]): VerificationReport {
  const failures: ExampleFailure[] = [];
  for (let i = 0; i < taskPairs.length; i++) {
    const pair = taskPairs[i]!;
    let actual: unknown;
    try {
      actual = transform(pair.input);
    } catch (e) {
      failures.push({ exampleIndex: i, reason: `threw: ${(e as Error).message}` });
      continue;
    }
    const expectedText = JSON.stringify(pair.output);
    if (!Array.isArray(actual)) {
      failures.push({
        exampleIndex: i,
        reason: `returned ${typeof actual}, expected a grid (number[][])`,
        expected: expectedText,
        actual: JSON.stringify(actual),
      });
      continue;
    }
    const actualText = JSON.stringify(actual);
    if (actualText !== expectedText) {
      failures.push({
        exampleIndex: i,
        reason: "output does not deep-equal the expected grid",
        expected: expectedText,
        actual: actualText,
      });
    }
  }
  const passedExamples = taskPairs.length - failures.length;
  return {
    passed: failures.length === 0,
    totalExamples: taskPairs.length,
    passedExamples,
    failures,
    failedExamplesDigest:
      failures.length > 0 ? `${fnv1a32(canonicalFailures(failures))}:${failures.length}/${taskPairs.length}` : null,
  };
}

const IDENTITY_PROGRAM = "(g) => g";

/** A pending candidate: invoked with no args, yields program source code. */
type Template = () => string;

/** User-facing candidate spec: ready code, or a template over the parent's source. */
export type CandidateTemplate = (parentCode: string) => string;

/** Upper bound on candidates generated per node — keeps branching sane. */
export const MAX_DYNAMIC_CANDIDATES = 32;

function gridColors(grid: Grid): Set<number> {
  const colors = new Set<number>();
  for (const row of grid) {
    for (const v of row!) colors.add(v);
  }
  return colors;
}

/**
 * Dynamic candidate generation (replaces the former static pool).
 *
 * Reads the TASK DATA — not a fixed list — and composes mutations for
 * `currentNode`'s program:
 *   - the geometric DSL primitives, always applied over the parent program;
 *   - data-driven `recolor(from, to)` for every color that disappears from
 *     inputs→outputs mapped onto every color that appears (bounded);
 *   - a `floodFill` seeded at the first non-background pixel of the first
 *     input, targeting the first appearing color.
 * Deterministic order; capped at MAX_DYNAMIC_CANDIDATES entries.
 */
export function generateCandidateMutations(
  currentNode: MCTSNode,
  taskPairs: readonly TaskPair[],
): Template[] {
  if (!currentNode || typeof currentNode !== "object" || Array.isArray(currentNode)) {
    throw new Error("generateCandidateMutations: currentNode must be an MCTSNode");
  }
  if (
    currentNode.programCode !== null &&
    currentNode.programCode !== undefined &&
    typeof currentNode.programCode !== "string"
  ) {
    throw new Error(
      `generateCandidateMutations: currentNode.programCode must be null or a string, got ${typeof currentNode.programCode}`,
    );
  }
  checkTaskPairs(taskPairs);

  const parent = currentNode.programCode ?? IDENTITY_PROGRAM;
  const applyP = `((${parent}))(g)`;
  const candidates: Template[] = [];
  const push = (code: string): void => {
    if (candidates.length < MAX_DYNAMIC_CANDIDATES) candidates.push(() => code);
  };

  // Geometric core — parent-composed single primitives.
  push(`(g) => rotate(${applyP}, 90)`);
  push(`(g) => rotate(${applyP}, 180)`);
  push(`(g) => rotate(${applyP}, 270)`);
  push(`(g) => mirror(${applyP}, 'horizontal')`);
  push(`(g) => mirror(${applyP}, 'vertical')`);
  push(`(g) => shift(${applyP}, 1, 0)`);
  push(`(g) => shift(${applyP}, -1, 0)`);
  push(`(g) => shift(${applyP}, 0, 1)`);
  push(`(g) => shift(${applyP}, 0, -1)`);
  push(`(g) => applyGravity(${applyP}, 'down')`);
  push(`(g) => applyGravity(${applyP}, 'up')`);
  push(`(g) => applyGravity(${applyP}, 'left')`);
  push(`(g) => applyGravity(${applyP}, 'right')`);

  // Data-driven recolors: colors present in inputs but absent from outputs
  // are rename candidates; their targets are colors that appear only in
  // outputs. Bounded so pathological palettes cannot explode the pool.
  const inputColors = new Set<number>();
  const outputColors = new Set<number>();
  for (const pair of taskPairs) {
    for (const c of gridColors(pair.input)) inputColors.add(c);
    for (const c of gridColors(pair.output)) outputColors.add(c);
  }
  const disappearing = [...inputColors].filter((c) => !outputColors.has(c)).sort((a, b) => a - b).slice(0, 4);
  const appearing = [...outputColors].filter((c) => !inputColors.has(c)).sort((a, b) => a - b).slice(0, 4);
  for (const from of disappearing) {
    for (const to of appearing) {
      push(`(g) => recolor(${applyP}, ${from}, ${to})`);
    }
  }

  // Flood-fill seed from observed structure, not a hardcoded coordinate.
  const firstInput = taskPairs[0]!.input;
  let seedRow = -1;
  let seedCol = -1;
  for (let r = 0; r < firstInput.length && seedRow < 0; r++) {
    for (let c = 0; c < firstInput[r]!.length; c++) {
      if (firstInput[r]![c] !== 0) {
        seedRow = r;
        seedCol = c;
        break;
      }
    }
  }
  if (seedRow >= 0 && appearing.length > 0) {
    push(`(g) => floodFill(${applyP}, ${seedRow}, ${seedCol}, ${appearing[0]})`);
  }

  return candidates;
}

export interface MCTSVerificationOptions {
  /** Tree iterations. Must be ≥ 1. Default 200. */
  iterations?: number;
  /** UCT exploration constant. Default 1.414 (√2). */
  explorationConstant?: number;
  /** Maximum program depth (root identity excluded). Default 4. */
  maxDepth?: number;
  /**
   * Static candidate pool override. Each entry is either ready program code
   * or a template receiving the parent's program source. When omitted,
   * candidates are generated dynamically per node via
   * generateCandidateMutations(node, taskPairs).
   */
  candidates?: ReadonlyArray<string | CandidateTemplate>;
  /** Override compilation (e.g. sandboxed evaluator). Default compileProgram. */
  compileProgram?: (code: string) => GridTransform;
  /** Per-iteration observability hook. */
  onIteration?: (info: { iteration: number; treeSize: number; bestRewardSoFar: number }) => void;
}

export interface MCTSVerificationResult {
  bestNode: MCTSNode;
  verification: VerificationReport;
  treeSize: number;
}

interface NodeState {
  node: MCTSNode;
  /** Unexpanded candidate factories bound to this node's parent program. */
  pendingCodes: Template[];
  reward: number | null;
  report: VerificationReport | null;
}

function checkTaskPairs(taskPairs: readonly TaskPair[]): void {
  if (!Array.isArray(taskPairs) || taskPairs.length === 0) {
    throw new Error("runMCTSVerification: taskPairs must be a non-empty array of { input, output } pairs");
  }
  for (let i = 0; i < taskPairs.length; i++) {
    const pair = taskPairs[i]!;
    try {
      assertValidGrid(pair?.input, `taskPairs[${i}].input`);
    } catch (e) {
      throw new Error(`runMCTSVerification: ${(e as Error).message}`);
    }
    try {
      assertValidGrid(pair?.output, `taskPairs[${i}].output`);
    } catch (e) {
      throw new Error(`runMCTSVerification: ${(e as Error).message}`);
    }
  }
}

/**
 * Search program space with UCT-guided MCTS where simulation is replaced by
 * direct verification against `taskPairs`. Fully deterministic: same inputs
 * and options → identical trees, rewards and digests.
 *
 * Returns the best-scoring node together with its full verification report
 * (failedExamplesDigest set when anything fails) and the final tree size.
 */
export async function runMCTSVerification(
  taskPairs: readonly TaskPair[],
  options: MCTSVerificationOptions = {},
): Promise<MCTSVerificationResult> {
  checkTaskPairs(taskPairs);

  const iterations = options.iterations ?? 200;
  const c = options.explorationConstant ?? DEFAULT_EXPLORATION_CONSTANT;
  const maxDepth = options.maxDepth ?? 4;
  const compile = options.compileProgram ?? compileProgram;

  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`runMCTSVerification: iterations must be an integer ≥ 1, got ${String(iterations)}`);
  }
  if (!Number.isFinite(c) || c < 0) {
    throw new Error(`runMCTSVerification: explorationConstant must be finite and ≥ 0, got ${String(c)}`);
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error(`runMCTSVerification: maxDepth must be an integer ≥ 1, got ${String(maxDepth)}`);
  }

  const customCandidates = options.candidates;
  if (customCandidates && customCandidates.length === 0) {
    throw new Error("runMCTSVerification: candidates pool is empty — nothing to expand, no search possible");
  }
  const candidatesFor = (node: MCTSNode): Template[] => {
    const parentCode = node.programCode ?? IDENTITY_PROGRAM;
    if (customCandidates) {
      return customCandidates.map((entry) =>
        typeof entry === "string" ? () => entry : () => (entry as CandidateTemplate)(parentCode),
      );
    }
    // Dynamic generation from task data + node position in the tree.
    return generateCandidateMutations(node, taskPairs);
  };

  const states = new Map<number, NodeState>();
  let nextId = 0;

  const rootNode: MCTSNode = { id: nextId++, parentId: null, childrenIds: [], visits: 0, value: 0, programCode: null, depth: 0 };
  const rootState: NodeState = { node: rootNode, pendingCodes: candidatesFor(rootNode), reward: null, report: null };
  states.set(rootNode.id, rootState);

  const evaluate = (state: NodeState): void => {
    if (state.reward !== null) return;
    const code = state.node.programCode!;
    let report: VerificationReport;
    try {
      report = verifyTransform(compile(code), taskPairs);
    } catch (e) {
      report = {
        passed: false,
        totalExamples: taskPairs.length,
        passedExamples: 0,
        failures: [{ exampleIndex: 0, reason: `compile error: ${(e as Error).message}` }],
        failedExamplesDigest: `${fnv1a32(canonicalFailures([{ exampleIndex: 0, reason: "compile" }]))}:compile-error`,
      };
    }
    state.report = report;
    state.reward = report.totalExamples > 0 ? report.passedExamples / report.totalExamples : 0;
  };

  const backpropagate = (pathIds: number[], reward: number): void => {
    for (const id of pathIds) {
      const state = states.get(id)!;
      state.node.visits += 1;
      state.node.value += reward;
    }
  };

  let bestId = -1;
  let bestReward = -1;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const pathIds: number[] = [];
    let currentId = rootNode.id;

    // Selection + expansion.
    for (;;) {
      const state = states.get(currentId)!;
      pathIds.push(currentId);

      const canExpand = state.pendingCodes.length > 0 && state.node.depth < maxDepth;
      if (canExpand) {
        const code = state.pendingCodes.shift()!();
        const child: MCTSNode = {
          id: nextId++,
          parentId: currentId,
          childrenIds: [],
          visits: 0,
          value: 0,
          programCode: code,
          depth: state.node.depth + 1,
        };
        states.set(child.id, {
          node: child,
          pendingCodes: candidatesFor(child),
          reward: null,
          report: null,
        });
        state.node.childrenIds.push(child.id);
        pathIds.push(child.id);
        const childState = states.get(child.id)!;
        evaluate(childState);
        backpropagate(pathIds, childState.reward!);
        const reward = childState.reward!;
        const shallowerThanBest = bestId < 0 || child.depth < states.get(bestId)!.node.depth;
        if (reward > bestReward || (reward === bestReward && shallowerThanBest)) {
          bestReward = reward;
          bestId = child.id;
        }
        break;
      }

      if (state.node.childrenIds.length > 0) {
        let bestChildId = -1;
        let bestUct = -Infinity;
        for (const childId of state.node.childrenIds) {
          const childState = states.get(childId)!;
          const uct = uctScore(childState.node.value, childState.node.visits, state.node.visits, c);
          if (uct > bestUct) {
            bestUct = uct;
            bestChildId = childId;
          }
        }
        currentId = bestChildId!;
        continue;
      }

      // Terminal leaf: nothing pending, no children. Evaluate once, backprop.
      evaluate(state);
      backpropagate(pathIds, state.reward!);
      break;
    }

    options.onIteration?.({ iteration: iteration + 1, treeSize: states.size, bestRewardSoFar: Math.max(bestReward, 0) });
  }

  // Root fallback: only reachable when every expansion was impossible
  // (empty pool throws earlier), but guard anyway.
  if (bestId < 0) {
    throw new Error("runMCTSVerification: internal invariant broken — no candidate node was ever evaluated");
  }

  const bestState = states.get(bestId)!;
  return {
    bestNode: { ...bestState.node },
    verification: bestState.report!,
    treeSize: states.size,
  };
}
