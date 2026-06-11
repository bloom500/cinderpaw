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

const GRAPH_PATH = path.join(os.homedir(), ".feral", "memory-graph.json");

function load(): MemoryGraphData {
  try {
    const raw = fs.readFileSync(GRAPH_PATH, "utf8");
    return JSON.parse(raw) as MemoryGraphData;
  } catch {
    return { nodes: {}, edges: [], version: 1 };
  }
}

function save(g: MemoryGraphData): void {
  const dir = path.dirname(GRAPH_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(g, null, 2), "utf8");
}

export class MemoryGraph {
  #data: MemoryGraphData;

  constructor() {
    this.#data = load();
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

  persist(): void {
    try {
      save(this.#data);
    } catch {
      // Retry once after 100 ms — the cleaner may be writing at this instant.
      const snapshot = structuredClone(this.#data);
      setTimeout(() => { try { save(snapshot); } catch { /* best-effort */ } }, 100);
    }
  }

  snapshot(): MemoryGraphData {
    return structuredClone(this.#data);
  }
}
