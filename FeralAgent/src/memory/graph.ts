import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface GraphNode {
  id: string;
  label: string;
  type: "entity" | "concept" | "event" | "fact";
  createdAt: number;
  touchedAt: number;
  properties: Record<string, string>;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  weight: number;
  createdAt: number;
}

export interface MemoryGraphData {
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  version: 1;
}

const DEFAULT_GRAPH_PATH = path.join(os.homedir(), ".feral", "memory-graph.json");

export interface MemoryGraphOptions {
  /** Override the on-disk path. Default: `~/.feral/memory-graph.json`. */
  path?: string;
}

export class MemoryGraph {
  #data: MemoryGraphData;
  readonly #path: string;

  constructor(opts: MemoryGraphOptions | string = {}) {
    if (typeof opts === "string") {
      this.#path = opts;
    } else {
      this.#path = opts.path ?? DEFAULT_GRAPH_PATH;
    }
    this.#data = this.#load(this.#path);
  }

  #load(p: string): MemoryGraphData {
    try {
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw) as MemoryGraphData;
    } catch {
      return { nodes: {}, edges: [], version: 1 };
    }
  }

  #save(g: MemoryGraphData): void {
    const dir = path.dirname(this.#path);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.#path, JSON.stringify(g, null, 2), "utf8");
  }

  upsertNode(id: string, label: string, type: GraphNode["type"], properties: Record<string, string> = {}): void {
    const now = Date.now();
    const existing = this.#data.nodes[id];
    this.#data.nodes[id] = {
      id,
      label,
      type,
      createdAt: existing?.createdAt ?? now,
      touchedAt: now,
      properties: { ...(existing?.properties ?? {}), ...properties },
    };
  }

  addEdge(from: string, to: string, relation: string): void {
    const exists = this.#data.edges.some(
      (e) => e.from === from && e.to === to && e.relation === relation,
    );
    if (!exists) {
      this.#data.edges.push({ from, to, relation, weight: 1, createdAt: Date.now() });
    }
  }

  addFact(subject: string, predicate: string, object: string): void {
    const sId = subject.toLowerCase().replace(/\s+/g, "_");
    const oId = object.toLowerCase().replace(/\s+/g, "_");
    this.upsertNode(sId, subject, "entity");
    this.upsertNode(oId, object, "concept");
    this.addEdge(sId, oId, predicate);
  }

  removeNode(id: string): boolean {
    if (!this.#data.nodes[id]) return false;
    delete this.#data.nodes[id];
    this.#data.edges = this.#data.edges.filter((e) => e.from !== id && e.to !== id);
    return true;
  }

  /**
   * Boot-time hygiene: remove every node whose id/label the predicate flags
   * (plus its edges) and persist when anything changed. Without this sweep,
   * junk deleted from the file on disk gets resurrected by the next
   * `persist()` from a long-running process that still holds it in memory.
   * Returns the number of nodes removed.
   */
  sweepJunk(isJunk: (idAsText: string, label: string) => boolean): number {
    const doomed = Object.values(this.#data.nodes).filter((n) =>
      isJunk(n.id.replace(/_/g, " "), n.label),
    );
    for (const n of doomed) this.removeNode(n.id);
    if (doomed.length > 0) this.persist();
    return doomed.length;
  }

  removeEdge(from: string, to: string, relation?: string): number {
    const before = this.#data.edges.length;
    this.#data.edges = this.#data.edges.filter((e) => {
      if (e.from !== from || e.to !== to) return true;
      if (relation !== undefined && e.relation !== relation) return true;
      return false;
    });
    return before - this.#data.edges.length;
  }

  queryNodes(labelContains?: string, type?: GraphNode["type"]): GraphNode[] {
    return Object.values(this.#data.nodes).filter((n) => {
      if (labelContains && !n.label.toLowerCase().includes(labelContains.toLowerCase())) return false;
      if (type && n.type !== type) return false;
      return true;
    });
  }

  persist(): void {
    try {
      this.#save(this.#data);
    } catch {
      // Retry once after 100 ms — the cleaner may be writing at this instant.
      const snapshot = structuredClone(this.#data);
      setTimeout(() => { try { this.#save(snapshot); } catch { /* best-effort */ } }, 100);
    }
  }

  snapshot(): MemoryGraphData {
    return structuredClone(this.#data);
  }

  /**
   * Pathway 3 step 2 — mirror the tree's cluster + leaf summary into
   * the graph. Idempotent (upsertNode collapses on id). Returns the
   * count of nodes touched so the Reconciler can log a meaningful
   * delta on each observation write.
   *
   * Edges are not added here in Task 4 — Task 5 / Pathway 4 PR-C will
   * derive cluster↔leaf edges from the tree's membership. The graph
   * is already populated for facts by the extractor's direct addFact
   * path (kept for belt-and-braces, see spec).
   */
  reconcile(view: {
    clusters: Array<{ id: string; summary: string }>;
    leaves: Array<{ id: number; summary: string }>;
  }): { nodesTouched: number } {
    let touched = 0;
    for (const c of view.clusters) {
      this.upsertNode(`cluster_${c.id}`, c.summary || c.id, "concept", {
        kind: "cluster",
      });
      touched++;
    }
    for (const l of view.leaves) {
      this.upsertNode(`leaf_${l.id}`, l.summary || `leaf-${l.id}`, "fact", {
        kind: "leaf",
      });
      touched++;
    }
    return { nodesTouched: touched };
  }
}
