#!/usr/bin/env node
/**
 * ARC-AGI-3 Baseline Measurement Runner.
 *
 * Runs an offline simulated interactive ARC-AGI-3 environment game loop to
 * establish Baseline 0 performance metrics (actions, score, latency).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

function createSimulatedEnvironment(id) {
  const walls = new Set();
  // Simple 5x5 maze environment
  walls.add("1,1");
  walls.add("1,2");
  walls.add("2,2");

  return {
    id,
    gridDimensions: { rows: 5, cols: 5 },
    startPos: [0, 0],
    goalPos: [4, 4],
    walls,
  };
}

function runGreedyBFS(env) {
  const visited = new Set();
  const queue = [[env.startPos, 0]];
  visited.add(`${env.startPos[0]},${env.startPos[1]}`);

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  let totalActions = 0;
  let solved = false;

  while (queue.length > 0) {
    const [[r, c], steps] = queue.shift();
    totalActions++;

    if (r === env.goalPos[0] && c === env.goalPos[1]) {
      solved = true;
      break;
    }

    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      const key = `${nr},${nc}`;

      if (
        nr >= 0 &&
        nr < env.gridDimensions.rows &&
        nc >= 0 &&
        nc < env.gridDimensions.cols &&
        !env.walls.has(key) &&
        !visited.has(key)
      ) {
        visited.add(key);
        queue.push([[nr, nc], steps + 1]);
      }
    }
  }

  return {
    solved,
    actionCount: totalActions,
    score: solved ? 1.0 : 0.0,
  };
}

export function runBaselineRunner() {
  const startTime = Date.now();
  console.log("[Cinderpaw ARC-AGI-3 Baseline] Starting offline runner...");

  const env = createSimulatedEnvironment("env_public_1");
  const result = runGreedyBFS(env);
  const elapsedMs = Date.now() - startTime;

  const summary = {
    timestamp: new Date().toISOString(),
    environmentId: env.id,
    solved: result.solved,
    score: result.score,
    actionCount: result.actionCount,
    elapsedMs,
  };

  const logsDir = join(process.cwd(), "scripts", "arc", "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  const logPath = join(logsDir, "baseline_results.json");
  writeFileSync(logPath, JSON.stringify(summary, null, 2));

  console.log(`[Cinderpaw ARC-AGI-3 Baseline] Finished! Score: ${result.score}, Actions: ${result.actionCount}, Elapsed: ${elapsedMs}ms`);
  console.log(`[Cinderpaw ARC-AGI-3 Baseline] Summary saved to: ${logPath}`);

  return summary;
}

if (process.argv[1]?.endsWith("run_arc_agi3_baseline.mjs")) {
  runBaselineRunner();
}
