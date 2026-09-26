/**
 * A guest speaker's facts stay theirs on every path, not only in SemanticMemory.
 *
 * `memoryScope` scopes facts mined from a room-keyed session (Discord, Slack…)
 * to the speaker so "call me Alex" from one member never becomes everyone's
 * name. The extractor then mirrored the same fact into the knowledge graph,
 * and the reconciler into the fractal tree — both shared by every session's
 * recall — which put it back in front of the owner and every other member.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { MemoryGraph } from "../src/memory/graph.ts";
import { Reconciler } from "../src/memory/reconciler.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { openDatabase } from "../src/db.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function graph(): MemoryGraph {
  const d = mkdtempSync(join(tmpdir(), "cp-guest-"));
  dirs.push(d);
  return new MemoryGraph(join(d, "graph.json"));
}

const router = {
  complete: async () => ({ content: "=== FACTS ===\nfact | name: Alex\n=== OBSERVATION ===\nSKIP" }),
  evictSession: () => {},
} as unknown as InferenceRouter;

const chat: ChatMessage[] = [
  { role: "user", content: "call me Alex" },
  { role: "assistant", content: "Sure, Alex." },
];

async function extractAs(sessionId: string) {
  const db = openDatabase(":memory:");
  const semantic = new SemanticMemory(db.raw, () => {});
  const g = graph();
  const extractor = new MemoryExtractor(router, semantic);
  extractor.setGraph(g);
  extractor.extractAsync(sessionId, chat);
  await extractor.drain(2000);
  return { semantic, g, close: () => db.close() };
}

describe("guest facts stay scoped", () => {
  it("a guild member's fact is stored for them and not mirrored into the shared graph", async () => {
    const { semantic, g, close } = await extractAs("discord:guild-room:user42");
    expect(semantic.get("name", "discord/user42")?.value).toBe("Alex");
    expect(semantic.get("name")).toBeUndefined();
    expect(g.snapshot().edges).toHaveLength(0);
    close();
  });

  it("the owner's fact still reaches the graph", async () => {
    const { g, close } = await extractAs("desktop-session-1");
    expect(g.snapshot().edges.map((e) => `${e.from} ${e.relation} ${e.to}`)).toEqual(["name has alex"]);
    close();
  });

  it("the reconciler does not put a guest's fact into the shared tree", async () => {
    const hooks = new HookRegistry();
    const upserts: string[] = [];
    const fractal = {
      upsertLeaf: async (o: { text: string }) => { upserts.push(o.text); return { kind: "grow", leafId: 1 } as const; },
    };
    new Reconciler({
      hooks, fractal: fractal as never, graph: {} as never,
      embed: async (t) => t.map(() => new Float32Array([1, 0])),
    }).start();
    const base = { kind: "fact" as const, ts: 1, key: "name", value: "Alex" };
    await hooks.fire("after_memory_write", { ...base, sessionId: "discord:guild-room:user42" });
    await hooks.fire("after_memory_write", { ...base, sessionId: "desktop-session-1" });
    expect(upserts).toEqual(["name: Alex"]);
  });
});
