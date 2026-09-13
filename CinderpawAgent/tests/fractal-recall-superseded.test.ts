import { describe, it, expect } from "bun:test";
import { FractalRecallEngine } from "../src/memory/fractal/fractal-recall.ts";
import type { Leaf, TreeNode } from "../src/memory/fractal/types.ts";

/** Two leaves, one tree node each; no clustering needed to test the formatter. */
const LEAVES: Leaf[] = [
  { id: 1, text: "editor: vim", vec: new Float32Array([1, 0]), ts: 1_700_000_000_000, sessionId: "old" },
  { id: 2, text: "hello from a plain turn", vec: new Float32Array([0.99, 0.14]), ts: 1_700_000_000_000, sessionId: "old" },
];
const TREE: TreeNode = {
  id: "root", level: 1, centroid: new Float32Array([1, 0]), summary: "root", leafIds: [1, 2],
  children: LEAVES.map((l) => ({ id: `L0-${l.id}`, level: 0, centroid: l.vec, summary: "", children: [], leafIds: [l.id] })),
};

function engine(over: Partial<ConstructorParameters<typeof FractalRecallEngine>[0]>) {
  return new FractalRecallEngine({
    tree: TREE,
    embed: async (texts) => texts.map(() => new Float32Array([1, 0])),
    ftsSearch: () => [],
    leavesById: new Map(LEAVES.map((l) => [l.id, l])),
    ...over,
  });
}

describe("a replaced fact is labelled when it comes back", () => {
  it("adds the date the fact was superseded, and nothing to a plain turn", async () => {
    const r = await engine({
      factKeyOf: (id) => (id === 1 ? "editor" : undefined),
      supersededAt: (key, writtenAt) => (key === "editor" && writtenAt <= 1_700_000_000_000 ? 1_700_086_400_000 : null),
    }).recall("editor", "now");
    const lines = r.context.split("\n");
    expect(lines.find((l) => l.includes("editor: vim"))).toMatch(/\(superseded 2023-11-15\)$/);
    expect(lines.find((l) => l.includes("plain turn"))).not.toMatch(/superseded/);
  });

  it("adds nothing while the fact is still current, or when nobody can say", async () => {
    const current = await engine({ factKeyOf: () => "editor", supersededAt: () => null }).recall("editor", "now");
    expect(current.context).not.toMatch(/superseded/);
    const unwired = await engine({}).recall("editor", "now");
    expect(unwired.context).not.toMatch(/superseded/);
  });
});
