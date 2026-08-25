#!/usr/bin/env node
/**
 * run_arc_agi3_baseline.mjs — ARC-AGI-3 interactive baseline harness.
 *
 * Simulates ONE interactive ARC-AGI-3-style environment offline (no
 * network, no API keys — runs green on a fresh machine): a grid world where
 * the agent walks from spawn to target using the ACTION1..ACTION4
 * vocabulary while avoiding walls. A greedy BFS policy drives the agent;
 * this is the slot where the MCTS+verifier loop plugs in later.
 *
 * Measures: actions taken, wall time, and a score proxy:
 *   score = completed ? round(100 * optimalActions / actionsTaken) : 0
 * (100 = optimal play; RHAE counts environment actions, so fewer is better.)
 *
 * Usage:
 *   node scripts/arc/run_arc_agi3_baseline.mjs [--seed 42] [--size 16]
 *        [--max-actions 200] [--out scripts/arc/logs/baseline_results.json]
 *
 * Always writes the JSON log (dir auto-created) and prints a human summary.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const ACTION_VOCABULARY = ["ACTION1", "ACTION2", "ACTION3", "ACTION4"];
// ACTION1=up, ACTION2=down, ACTION3=left, ACTION4=right (ARC-AGI-3 style ids)
const MOVES = {
  ACTION1: [-1, 0],
  ACTION2: [1, 0],
  ACTION3: [0, -1],
  ACTION4: [0, 1],
};

/** Deterministic PRNG — same seed, same world. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distance-to-target for every free cell (BFS seeded AT THE TARGET, since
 * the greedy policy descends this field toward the goal). In an undirected
 * grid the values equal spawn→target distances, but the direction matters
 * for correctness of the gradient.
 */
export function bfsDistances(env) {
  const dist = Array.from({ length: env.size }, () => new Array(env.size).fill(-1));
  const queue = [[env.target.row, env.target.col]];
  dist[env.target.row][env.target.col] = 0;
  let head = 0;
  while (head < queue.length) {
    const [r, c] = queue[head++];
    for (const action of ACTION_VOCABULARY) {
      const [dr, dc] = MOVES[action];
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= env.size || nc >= env.size) continue;
      if (env.walls.has(`${nr},${nc}`)) continue;
      if (dist[nr][nc] !== -1) continue;
      dist[nr][nc] = dist[r][c] + 1;
      queue.push([nr, nc]);
    }
  }
  return dist;
}

/**
 * Build one simulated environment. Walls are sampled at ~10% density but a
 * layout whose target is unreachable is rejected (up to 40 retries with the
 * same rng stream); worst case falls back to an empty board, loudly marked.
 */
export function createEnvironment(rng, size = 16) {
  if (!Number.isInteger(size) || size < 4) {
    throw new Error(`createEnvironment: size must be an integer ≥ 4, got ${String(size)}`);
  }
  const agent = { row: 0, col: 0 };
  const target = { row: size - 1, col: size - 1 };

  let walls = new Set();
  let layoutRetries = 0;
  let solvable = false;
  let distances = null;
  while (layoutRetries < 40) {
    layoutRetries++;
    walls = new Set();
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if ((r === agent.row && c === agent.col) || (r === target.row && c === target.col)) continue;
        if (rng() < 0.1) walls.add(`${r},${c}`);
      }
    }
    distances = bfsDistances({ size, agent, target, walls });
    if (distances[agent.row][agent.col] !== -1) {
      solvable = true;
      break;
    }
  }
  const fallbackUsed = !solvable;
  if (fallbackUsed) {
    walls = new Set();
    distances = bfsDistances({ size, agent, target, walls });
  }

  return {
    size,
    agent: { ...agent },
    target,
    walls,
    optimalActions: distances[agent.row][agent.col],
    meta: { fallbackLayoutUsed: fallbackUsed, layoutRetries },
  };
}

/** Apply one action; returns whether the move actually changed position. */
export function step(env, action) {
  if (!Object.hasOwn(MOVES, action)) {
    throw new Error(
      `step: unknown action "${String(action)}" — expected one of ${ACTION_VOCABULARY.join(", ")}`,
    );
  }
  const [dr, dc] = MOVES[action];
  const nr = env.agent.row + dr;
  const nc = env.agent.col + dc;
  const inBounds = nr >= 0 && nc >= 0 && nr < env.size && nc < env.size;
  if (inBounds && !env.walls.has(`${nr},${nc}`)) {
    env.agent.row = nr;
    env.agent.col = nc;
    return true;
  }
  return false;
}

/** Greedy BFS policy: always step to the neighbor with the smallest distance. */
export function makeGreedyPolicy(env) {
  const distances = bfsDistances(env);
  return function policy() {
    let bestAction = null;
    let bestDist = Infinity;
    for (const action of ACTION_VOCABULARY) {
      const [dr, dc] = MOVES[action];
      const nr = env.agent.row + dr;
      const nc = env.agent.col + dc;
      if (nr < 0 || nc < 0 || nr >= env.size || nc >= env.size) continue;
      if (env.walls.has(`${nr},${nc}`)) continue;
      const d = distances[nr][nc];
      if (d !== -1 && d < bestDist) {
        bestDist = d;
        bestAction = action;
      }
    }
    return bestAction;
  };
}

export function computeScore(completed, optimalActions, actionsTaken) {
  if (!completed || actionsTaken <= 0) return 0;
  return Math.round((100 * optimalActions) / actionsTaken * 100) / 100;
}

/** Run the full baseline: build env → drive policy → measure → report. */
export function runBaseline({ seed = 42, size = 16, maxActions = 200 } = {}) {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`runBaseline: seed must be a non-negative integer, got ${String(seed)}`);
  }
  if (!Number.isInteger(maxActions) || maxActions < 1) {
    throw new Error(`runBaseline: maxActions must be an integer ≥ 1, got ${String(maxActions)}`);
  }
  const rng = mulberry32(seed);
  const env = createEnvironment(rng, size);
  const policy = makeGreedyPolicy(env);

  const actionLog = [];
  const startedAt = performance.now();
  let completed = false;
  for (let i = 0; i < maxActions; i++) {
    const action = policy();
    if (action === null) break;
    step(env, action);
    actionLog.push(action);
    if (env.agent.row === env.target.row && env.agent.col === env.target.col) {
      completed = true;
      break;
    }
  }
  const wallTimeMs = Math.round((performance.now() - startedAt) * 100) / 100;

  return {
    game: "arc-agi-3-sim-baseline",
    seed,
    gridSize: `${size}x${size}`,
    completed,
    actionsTaken: actionLog.length,
    optimalActions: env.optimalActions,
    score: computeScore(completed, env.optimalActions, actionLog.length),
    wallTimeMs,
    actionLog,
    environmentMeta: env.meta,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === undefined || value === undefined) break;
    if (key === "--seed") out.seed = Number.parseInt(value, 10);
    else if (key === "--size") out.size = Number.parseInt(value, 10);
    else if (key === "--max-actions") out.maxActions = Number.parseInt(value, 10);
    else if (key === "--out") out.out = value;
    else throw new Error(`run_arc_agi3_baseline: unknown argument "${key}"`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const result = runBaseline({
    seed: Number.isFinite(args.seed) ? args.seed : 42,
    size: Number.isFinite(args.size) ? args.size : 16,
    maxActions: Number.isFinite(args.maxActions) ? args.maxActions : 200,
  });

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.resolve(scriptDir, args.out ?? "logs/baseline_results.json");
  const logPayload = {
    generatedAt: new Date().toISOString(),
    harnessVersion: "baseline-v1",
    ...result,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(logPayload, null, 2)}\n`, "utf8");

  // Human summary — visible on the caller's screen, not just in the log.
  console.log(`[arc-baseline] game=${result.game} seed=${result.seed} grid=${result.gridSize}`);
  console.log(
    `[arc-baseline] ${result.completed ? "COMPLETED" : "NOT completed"} in ${result.actionsTaken} actions ` +
      `(optimal: ${result.optimalActions}) — score ${result.score}, ${result.wallTimeMs} ms`,
  );
  console.log(`[arc-baseline] log written to ${outPath}`);
  if (!result.completed) {
    console.error(`[arc-baseline] FAILED to reach target within budget — inspect ${outPath}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
