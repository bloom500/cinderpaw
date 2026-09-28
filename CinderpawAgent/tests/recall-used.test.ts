/**
 * RecallEngine says, item by item, what it put in the memory block: the facts
 * (with the graph edge Forget removes) and the past exchanges.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import { RecallEngine } from "../src/memory/recall.ts";

describe("RecallEngine.used", () => {
  test("a fact carries its mirrored edge, and only what the block shows is listed", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const semantic = new SemanticMemory(db.raw, audit.logger);
    semantic.upsert("city", "Cluj");
    const graph = new MemoryGraph(join(mkdtempSync(join(tmpdir(), "graph-")), "g.json"));
    graph.upsertNode("k-city", "city", "concept");
    graph.upsertNode("v-cluj", "Cluj", "entity");
    graph.addEdge("k-city", "v-cluj", "has");
    const engine = new RecallEngine(new EpisodicMemory(db.raw, audit.logger), semantic);
    engine.setGraph(graph);

    const r = engine.recall("which city do I live in", "s1");
    expect(r.context).toContain("city: Cluj");
    const fact = r.used?.find((m) => m.text === "city: Cluj");
    expect(fact).toEqual({ kind: "fact", text: "city: Cluj", forget: { from: "k-city", to: "v-cluj", relation: "has" } });
    // The graph block leaves out the edge the facts block already said, so it is listed once.
    expect(r.used?.filter((m) => m.text.includes("Cluj"))).toHaveLength(1);
    db.close();
  });

  test("nothing used when there is nothing to say", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const engine = new RecallEngine(new EpisodicMemory(db.raw, audit.logger), new SemanticMemory(db.raw, audit.logger));
    const r = engine.recall("anything", "s1");
    expect(r.context).toBe("");
    expect(r.used).toEqual([]);
    db.close();
  });
});
