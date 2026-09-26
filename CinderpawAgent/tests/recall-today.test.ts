/**
 * The recall block says what day it is.
 *
 * Every memory line is stamped `[YYYY-MM-DD]`, and a stamp is only usable
 * against today's date: "how long ago", "before or after", "the latest" all
 * need both ends. The system prompt carries no clock on purpose (it stays
 * byte-stable for the KV cache), so the per-turn block has to. LongMemEval
 * supplies the question date for exactly this reason.
 */
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { FractalRecallEngine } from "../src/memory/fractal/fractal-recall.ts";
import { buildTree } from "../src/memory/fractal/tree-builder.ts";
import type { Leaf } from "../src/memory/fractal/types.ts";

const TODAY = Date.UTC(2026, 8, 26, 12);

describe("recall block — today's date", () => {
  test("the fractal block names today next to its dated lines", async () => {
    const leaves: Leaf[] = Array.from({ length: 4 }, (_, i) => ({
      id: i + 1,
      text: `moved to lisbon ${i}`,
      vec: new Float32Array([1, i / 10]),
      ts: Date.UTC(2026, 7, 1),
      sessionId: "past",
    }));
    const tree = await buildTree(leaves, { summarize: async () => "s", branch: 2 });
    const engine = new FractalRecallEngine({
      tree,
      embed: async (t) => t.map(() => new Float32Array([1, 0])),
      ftsSearch: () => [],
      leavesById: new Map(leaves.map((l) => [l.id, l])),
      now: () => TODAY,
    });
    const { context } = await engine.recall("where do I live", "now");
    expect(context).toContain("today is 2026-09-26");
    expect(context).toContain("[2026-08-01]");
  });

  test("the FTS5 fallback block names today too", () => {
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    episodic.record("past", "user", "I moved to Lisbon");
    const result = new RecallEngine(episodic, new SemanticMemory(db.raw), { now: () => TODAY })
      .recall("Lisbon", "now");
    expect(result.context).toContain("Relevant past exchanges (today is 2026-09-26):");
    db.close();
  });

  test("no hits, no block: the date is not injected on its own", async () => {
    const db = openDatabase(":memory:");
    const episodic = new EpisodicMemory(db.raw, new AuditLog(db.raw).logger);
    const result = new RecallEngine(episodic, new SemanticMemory(db.raw), { now: () => TODAY })
      .recall("Lisbon", "now");
    expect(result.context).toBe("");
    db.close();
  });
});
