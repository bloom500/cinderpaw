import { describe, it, expect } from "bun:test";
import { createRecallTool, type EpisodicSemanticSearch } from "../src/tools/builtin/recall.ts";

describe("recall tool", () => {
  it("returns ranked snippets under a 'Related past conversations' header", async () => {
    const search: EpisodicSemanticSearch = async (q, limit) => {
      expect(q).toBe("deploy");
      expect(limit).toBe(5);
      return [
        { leafId: 41, text: "we deployed the release through the updater" },
        { leafId: 88, text: "the deploy failed on the signature step" },
      ];
    };
    const tool = createRecallTool(search);
    const res = await tool.execute({ query: "deploy" });
    expect(res.ok).toBe(true);
    expect(res.content.toLowerCase()).toMatch(/related past conversation/);
    expect(res.content).toContain("deployed the release");
    expect((res.data as { hits: unknown[] }).hits).toHaveLength(2);
  });

  it("clamps limit to the max", async () => {
    let seen = 0;
    const search: EpisodicSemanticSearch = async (_q, limit) => { seen = limit; return []; };
    await createRecallTool(search).execute({ query: "x", limit: 999 });
    expect(seen).toBe(20);
  });

  it("floors and lower-clamps a small/odd limit", async () => {
    let seen = 0;
    const search: EpisodicSemanticSearch = async (_q, limit) => { seen = limit; return []; };
    await createRecallTool(search).execute({ query: "x", limit: 0 });
    expect(seen).toBe(1);
  });

  it("degrades to an empty, ok result when the search throws", async () => {
    const search: EpisodicSemanticSearch = async () => { throw new Error("no model"); };
    const res = await createRecallTool(search).execute({ query: "anything" });
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/Nothing in memory matched/);
  });

  it("rejects a missing query with bad_args", async () => {
    const res = await createRecallTool(async () => []).execute({});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("bad_args");
  });
});
