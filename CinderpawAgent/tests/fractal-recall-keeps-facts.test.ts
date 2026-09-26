/**
 * The fractal tree augments recall; it must never replace what the user told
 * the agent.
 *
 * `FractalMemory.recall` used to return the fractal hybrid block wholesale as
 * soon as a tree existed. That block is episodic-only by design
 * (`fractal-recall.ts`: "it does NOT render the structured-facts or
 * knowledge-graph blocks"), and the legacy `RecallEngine` — the only place the
 * "Known facts about the user" block is rendered for the per-turn injection —
 * was no longer consulted at all. So the moment Fractal Memory Search started
 * working (embedding model on disk, first tree built), every turn lost the
 * user's name, preferences and graph facts. The agent got better at finding
 * old conversations and forgot who it was talking to.
 *
 * Built from the REAL RecallEngine + SemanticMemory + EpisodicMemory so the
 * test pins the composition production runs, not a stand-in for it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { FractalMemory } from "../src/memory/fractal/fractal-memory.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Deterministic, non-degenerate embedder: a vector from the text's bytes. */
async function embed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((t) => {
    const v = new Float32Array(4);
    for (let i = 0; i < t.length; i++) v[i % 4]! += t.charCodeAt(i) % 7;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-fms-facts-"));
  dirs.push(dir);
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const semantic = new SemanticMemory(db.raw, audit.logger);
  semantic.upsert("name", "Ana");
  semantic.upsert("favourite editor", "helix");
  // Enough past conversation for a tree (minLeaves defaults to 8).
  for (let i = 0; i < 12; i++) {
    episodic.record(i < 6 ? "s-old-a" : "s-old-b", "user", `we talked about sourdough bread batch ${i}`);
  }
  const legacy = new RecallEngine(episodic, semantic);
  const fm = new FractalMemory({
    loadLeaves: () =>
      episodic.all().map((e) => ({
        id: e.id ?? 0,
        text: e.content,
        vec: e.embedding ?? new Float32Array(0),
        ts: e.timestamp,
        sessionId: e.sessionId,
      })),
    embed,
    summarize: async (items) => `summary of ${items.length}`,
    ftsSearch: (q, limit) => episodic.search(q, limit),
    fallback: legacy,
    treePath: join(dir, "fractal-tree.json"),
  });
  return { fm };
}

describe("FractalMemory.recall keeps the known-facts block", () => {
  it("before a tree exists, the legacy engine already renders the facts", async () => {
    const { fm } = setup();
    expect(fm.hasTree).toBe(false);
    const r = await fm.recall("what bread did we bake", "s-now");
    expect(r.context).toContain("Known facts about the user");
    expect(r.context).toContain("name: Ana");
  });

  it("after the tree is built, the facts are STILL in the per-turn block", async () => {
    const { fm } = setup();
    expect(await fm.rebuild()).toBe(true);
    expect(fm.hasTree).toBe(true);
    const r = await fm.recall("what bread did we bake", "s-now");
    // The fractal layer answered (its header is present)...
    expect(r.context).toContain("fractal hybrid");
    // ...and did not take the user's facts away with it.
    expect(r.context).toContain("Known facts about the user");
    expect(r.context).toContain("name: Ana");
    // One memory block, not two stitched together.
    expect(r.context.match(/\[Memory context\]/g)?.length).toBe(1);
    expect(r.context.match(/\[End memory context\]/g)?.length).toBe(1);
  });

  it("facts survive whatever the tree returns for the query", async () => {
    const { fm } = setup();
    await fm.rebuild();
    const r = await fm.recall("zzzz qqqq", "s-old-a");
    expect(r.context).toContain("name: Ana");
  });
});
