#!/usr/bin/env node
/**
 * run_maze_selftest.mjs - synthetic maze self-test for the interactive
 * agent loop. THIS IS NOT AN ARC-AGI-3 BENCHMARK AND ITS SCORE IS NOT RHAE.
 *
 * What it actually is: a deterministic, offline grid world (no network, no
 * API keys - green on a fresh machine) used to exercise the ACTION1..ACTION4
 * loop plumbing end to end. The default policy is an ORACLE: it is handed
 * the environment, runs BFS over the true wall layout, and descends the true
 * distance field to the goal. An oracle cannot be wrong, so the default run
 * scores 100 by construction. That number measures the harness, not an agent.
 *
 * The score is a PROXY: score = round(100 * optimalActions / actionsTaken).
 * It is meaningful ONLY when comparing two non-oracle policies on the same
 * seed. Every artifact this script writes carries `notAnArcScore: true` and
 * `policyIsOracle` so a JSON log can never be mistaken for an ARC result on
 * its own - the disclaimer travels with the data, not just with this comment.
 *
 * The `policy` option is the seam where a real agent plugs in (MCTS, model
 * driven, anything): pass `{ policy: (env) => () => "ACTION1" }`. A policy
 * supplied by the caller is assumed NON-oracle and is reported as such.
 *
 * Usage:
 *   node scripts/arc/run_maze_selftest.mjs [--seed 42] [--size 16]
 *        [--max-actions 200] [--out scripts/arc/logs/maze_selftest_results.json]
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
export function runBaseline({ seed = 42, size = 16, maxActions = 200, policy: makePolicy } = {}) {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`runBaseline: seed must be a non-negative integer, got ${String(seed)}`);
  }
  if (!Number.isInteger(maxActions) || maxActions < 1) {
    throw new Error(`runBaseline: maxActions must be an integer ≥ 1, got ${String(maxActions)}`);
  }
  if (makePolicy !== undefined && typeof makePolicy !== "function") {
    throw new Error(
      `runBaseline: policy must be a function (env) => () => action, got ${typeof makePolicy}`,
    );
  }
  const rng = mulberry32(seed);
  const env = createEnvironment(rng, size);
  // No caller policy = the built-in ORACLE (BFS over the true layout). It
  // cannot lose, so its score is a property of the harness, not of an agent.
  // This flag is what stops a JSON log from reading as a real result.
  const policyIsOracle = makePolicy === undefined;
  const policy = policyIsOracle ? makeGreedyPolicy(env) : makePolicy(env);
  if (typeof policy !== "function") {
    throw new Error("runBaseline: policy(env) must return a function () => action | null");
  }

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
    game: "synthetic-maze-selftest",
    // These three travel with every artifact on purpose. A reader who has
    // only the JSON must still be unable to mistake it for an ARC result.
    notAnArcScore: true,
    scoreKind: "proxy",
    policyIsOracle,
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
    else throw new Error(`run_maze_selftest: unknown argument "${key}"`);
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
  const outPath = path.resolve(scriptDir, args.out ?? "logs/maze_selftest_results.json");
  const logPayload = {
    generatedAt: new Date().toISOString(),
    harnessVersion: "maze-selftest-v1",
    ...result,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(logPayload, null, 2)}\n`, "utf8");

  // Human summary — visible on the caller's screen, not just in the log.
  console.log(`[maze-selftest] game=${result.game} seed=${result.seed} grid=${result.gridSize}`);
  console.log(
    `[maze-selftest] ${result.completed ? "COMPLETED" : "NOT completed"} in ${result.actionsTaken} actions ` +
      `(optimal: ${result.optimalActions}) — score ${result.score}, ${result.wallTimeMs} ms`,
  );
  console.log(
    "[maze-selftest] NOT an ARC-AGI-3 score. " +
      (result.policyIsOracle
        ? "Policy was the built-in ORACLE (it sees the solved maze), so 100 is expected and means nothing about agent quality."
        : "Policy was caller-supplied; the score is a proxy, comparable only against another policy on the same seed."),
  );
  console.log(`[maze-selftest] log written to ${outPath}`);
  if (!result.completed) {
    console.error(`[maze-selftest] FAILED to reach target within budget - inspect ${outPath}`);
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
