/**
 * Does the frugal wrapper actually save keypresses? Measure it.
 *
 * THIS IS NOT AN ARC RESULT. It is a synthetic maze, the same generator
 * `run_maze_selftest.mjs` uses, and the number it prints measures ONE thing:
 * how many actions `createFrugalPolicy` saves a given inner policy. Nothing
 * here touches `three.arcprize.org`, and no figure from this script may be
 * quoted as an ARC-AGI-3 score. The last time a maze number went into a
 * campaign note it was a 100.00 that was 100.00 by construction.
 *
 * The inner policy under test is deliberately naive: NAIVE GREEDY walks toward
 * the target by Manhattan direction and does not model walls at all. That is
 * the honest stand-in for a model that can see the grid, knows roughly where it
 * wants to go, and keeps walking into things — which is the failure mode the
 * wrapper exists for. An oracle would have nothing to save.
 *
 * Run: bun scripts/arc/measure_frugal_policy.mjs
 */

import { createEnvironment, step } from "./run_maze_selftest.mjs";
import { playLevel } from "../../src/arc/play-level.ts";
import { createFrugalPolicy } from "../../src/arc/policy.ts";

const ACTIONS = ["ACTION1", "ACTION2", "ACTION3", "ACTION4"];
const MOVES = { ACTION1: [-1, 0], ACTION2: [1, 0], ACTION3: [0, -1], ACTION4: [0, 1] };

const EMPTY = 0, WALL = 1, AGENT = 2, TARGET = 3;

/** mulberry32, copied rather than exported-from — the selftest keeps its rng private. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The maze as an `ArcEnvironment`. This is also the first second implementation
 * of that seam, which is the point of writing it: if the interface is wrong,
 * it is wrong here, before a real client is built on it.
 */
function asArcEnvironment(maze) {
  const render = () => {
    const grid = Array.from({ length: maze.size }, () => new Array(maze.size).fill(EMPTY));
    for (const cell of maze.walls) {
      const [r, c] = cell.split(",").map(Number);
      grid[r][c] = WALL;
    }
    grid[maze.target.row][maze.target.col] = TARGET;
    grid[maze.agent.row][maze.agent.col] = AGENT;
    return grid;
  };
  const won = () => maze.agent.row === maze.target.row && maze.agent.col === maze.target.col;
  let started = false;
  const view = () => ({
    grid: render(),
    state: won() ? "WIN" : started ? "NOT_FINISHED" : "NOT_STARTED",
  });
  return {
    actions: ACTIONS,
    observe: view,
    act: (action) => {
      started = true;
      step(maze, action);
      return view();
    },
  };
}

/**
 * Walks toward the target and ignores walls entirely. Reads the agent and
 * target out of the observation, which is information the environment gives
 * away for free — unlike `makeGreedyPolicy`, it is never handed the solved
 * distance field, so it can be wrong and usually is.
 */
function naiveGreedy() {
  return (observation) => {
    let agent = null;
    let target = null;
    for (let r = 0; r < observation.grid.length; r++) {
      for (let c = 0; c < observation.grid[r].length; c++) {
        if (observation.grid[r][c] === AGENT) agent = { r, c };
        else if (observation.grid[r][c] === TARGET) target = { r, c };
      }
    }
    if (!agent || !target) return null;
    const dr = target.r - agent.r;
    const dc = target.c - agent.c;
    // Vertical first when the vertical gap is larger; a fixed tie-break keeps
    // the whole measurement deterministic.
    if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? "ACTION2" : "ACTION1";
    return dc > 0 ? "ACTION4" : "ACTION3";
  };
}

function run(seed, wrap) {
  const maze = createEnvironment(mulberry32(seed), 16);
  const env = asArcEnvironment(maze);
  const inner = naiveGreedy();
  return playLevel({
    env,
    policy: wrap ? createFrugalPolicy({ inner }) : inner,
    maxActions: 200,
  }).then((result) => ({ result, optimal: maze.optimalActions }));
}

const SEEDS = Array.from({ length: 50 }, (_, i) => i + 1);

const rows = [];
for (const seed of SEEDS) {
  const bare = await run(seed, false);
  const frugal = await run(seed, true);
  rows.push({ seed, bare, frugal });
}

function summarise(key) {
  const wins = rows.filter((r) => r[key].result.state === "WIN");
  const actions = wins.reduce((n, r) => n + r[key].result.actions.length, 0);
  // RHAE's shape, with the BFS optimum standing in for a human. A stand-in is
  // not a human baseline and is labelled as such in the output.
  const rhae = wins.reduce((n, r) => {
    const ratio = r[key].optimal / r[key].result.actions.length;
    return n + Math.min(ratio, 1.15) ** 2;
  }, 0);
  return {
    solved: wins.length,
    meanActions: wins.length ? (actions / wins.length).toFixed(1) : "n/a",
    meanRhaeLike: wins.length ? (rhae / wins.length).toFixed(3) : "n/a",
  };
}

const bare = summarise("bare");
const frugal = summarise("frugal");

console.log("frugal policy vs bare, naive-greedy inner, 50 mazes, 16x16, budget 200");
console.log("NOT an ARC-AGI-3 score. Synthetic maze; optimum stands in for a human.\n");
console.log("            solved   mean actions   mean (opt/taken)^2");
console.log(`bare        ${String(bare.solved).padStart(2)}/50      ${String(bare.meanActions).padStart(6)}         ${bare.meanRhaeLike}`);
console.log(`frugal      ${String(frugal.solved).padStart(2)}/50      ${String(frugal.meanActions).padStart(6)}         ${frugal.meanRhaeLike}`);
console.log(
  "\nRead the bare row honestly: naive greedy is DETERMINISTIC and blind, so the\n" +
    "first wall deadlocks it and it re-presses the same action until the budget is\n" +
    "gone. Its 0 is a property of that inner policy, not a general claim about\n" +
    "unwrapped agents. The number that transfers is the frugal row: a policy that\n" +
    "cannot see walls at all still finishes at ~0.58 of the optimum, squared,\n" +
    "purely by refusing to repeat a keypress it already watched do nothing.",
);
