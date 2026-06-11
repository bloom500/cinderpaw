import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { MemoryGraphData } from "./graph.ts";

const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;
const GRAPH_PATH = path.join(os.homedir(), ".feral", "memory-graph.json");

// Module-level mutex: prevents concurrent clean() runs from racing with
// MemoryGraph.persist() on the same file. A single boolean is sufficient
// because JS/TS is single-threaded — no atomic needed.
let cleanInProgress = false;

export class MemoryGraphCleaner {
  #timer: ReturnType<typeof setInterval> | null = null;

  clean(): void {
    if (cleanInProgress) return;
    cleanInProgress = true;
    try {
      let g: MemoryGraphData;
      try {
        const raw = fs.readFileSync(GRAPH_PATH, "utf8");
        g = JSON.parse(raw) as MemoryGraphData;
      } catch {
        return; // no graph yet
      }

      const now = Date.now();
      const connected = new Set<string>();
      for (const e of g.edges) {
        connected.add(e.from);
        connected.add(e.to);
      }

      const toPrune = new Set<string>();
      for (const node of Object.values(g.nodes)) {
        if (now - node.touchedAt > STALE_MS) toPrune.add(node.id);
        else if (!connected.has(node.id) && now - node.createdAt > ORPHAN_CUTOFF_MS) toPrune.add(node.id);
      }

      if (toPrune.size === 0) return;

      for (const id of toPrune) delete g.nodes[id];
      g.edges = g.edges.filter((e) => !toPrune.has(e.from) && !toPrune.has(e.to));

      try {
        fs.writeFileSync(GRAPH_PATH, JSON.stringify(g, null, 2), "utf8");
      } catch {
        // best-effort
      }
    } finally {
      cleanInProgress = false;
    }
  }

  startSchedule(intervalMs = 24 * 60 * 60 * 1000): void {
    this.clean();
    this.#timer = setInterval(() => this.clean(), intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
