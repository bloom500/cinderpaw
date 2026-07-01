/**
 * Tree of Champions (BRSI §4.3 / §7.4) — per-niche champion archive.
 *
 * Contract under test:
 *   - record() keeps the best-in-niche (strict-greater; ties don't churn);
 *   - the niche count is bounded by an LRU cap (least-recently-updated evicted);
 *   - best() is the global max across niches; get()/all()/size() reflect state;
 *   - persistence round-trips; a missing/corrupt file loads as an empty tree;
 *   - fromState trims a snapshot larger than the cap to the most-recent niches.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import {
  SpeciesChampions,
  nicheOf,
  writeChampionTree,
  readChampionTree,
  type ChampionTreeState,
} from "../src/rsi/champion-tree.ts";
import type { ChampionRecord } from "../src/rsi/champion.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";

function champ(score: number, id = `g-${score}`): ChampionRecord {
  return {
    genomeId: id,
    score,
    config: { temperature: 0.5 } as GenomeConfig,
    updatedAt: 0,
  };
}

const tmpPaths: string[] = [];
function tempPath(): string {
  const p = join(tmpdir(), `rsi-champion-tree-${crypto.randomUUID()}.json`);
  tmpPaths.push(p);
  return p;
}
afterEach(() => {
  for (const p of tmpPaths.splice(0)) {
    try { rmSync(p, { force: true }); } catch { /* best-effort */ }
  }
});

describe("SpeciesChampions.record — best-in-niche", () => {
  test("records the first champion for a niche", () => {
    const t = new SpeciesChampions();
    expect(t.record("n1", champ(50))).toBe(true);
    expect(t.get("n1")?.score).toBe(50);
  });

  test("replaces only on a strictly higher score (ties don't churn)", () => {
    const t = new SpeciesChampions();
    t.record("n1", champ(50));
    expect(t.record("n1", champ(50))).toBe(false); // tie → rejected
    expect(t.record("n1", champ(49))).toBe(false); // worse → rejected
    expect(t.record("n1", champ(60))).toBe(true); // better → recorded
    expect(t.get("n1")?.score).toBe(60);
  });

  test("keeps distinct niches separate", () => {
    const t = new SpeciesChampions();
    t.record("n1", champ(50));
    t.record("n2", champ(40));
    expect(t.get("n1")?.score).toBe(50);
    expect(t.get("n2")?.score).toBe(40);
    expect(t.size()).toBe(2);
  });
});

describe("SpeciesChampions — LRU niche cap (D8)", () => {
  test("evicts the least-recently-updated niche past the cap", () => {
    const t = new SpeciesChampions(2);
    t.record("n1", champ(10));
    t.record("n2", champ(20));
    t.record("n3", champ(30)); // over cap → evicts n1 (LRU)
    expect(t.get("n1")).toBeUndefined();
    expect(t.get("n2")?.score).toBe(20);
    expect(t.get("n3")?.score).toBe(30);
    expect(t.size()).toBe(2);
  });

  test("updating a niche refreshes its recency (protects it from eviction)", () => {
    const t = new SpeciesChampions(2);
    t.record("n1", champ(10));
    t.record("n2", champ(20));
    t.record("n1", champ(15)); // n1 updated → now most-recent
    t.record("n3", champ(30)); // over cap → evicts n2 (now LRU), not n1
    expect(t.get("n1")?.score).toBe(15);
    expect(t.get("n2")).toBeUndefined();
    expect(t.get("n3")?.score).toBe(30);
  });
});

describe("SpeciesChampions — queries", () => {
  test("best() is the global max across niches", () => {
    const t = new SpeciesChampions();
    t.record("n1", champ(50));
    t.record("n2", champ(80));
    t.record("n3", champ(60));
    expect(t.best()?.score).toBe(80);
  });

  test("best() is undefined for an empty tree", () => {
    expect(new SpeciesChampions().best()).toBeUndefined();
  });

  test("all() lists every niche champion", () => {
    const t = new SpeciesChampions();
    t.record("n1", champ(50));
    t.record("n2", champ(40));
    expect(t.all().map((n) => n.niche).sort()).toEqual(["n1", "n2"]);
  });
});

describe("SpeciesChampions — persistence", () => {
  test("round-trips through disk", () => {
    const path = tempPath();
    const t = new SpeciesChampions();
    t.record("n1", champ(50));
    t.record("n2", champ(80));
    writeChampionTree(path, t);

    const loaded = readChampionTree(path);
    expect(loaded.size()).toBe(2);
    expect(loaded.get("n1")?.score).toBe(50);
    expect(loaded.best()?.score).toBe(80);
  });

  test("a missing file loads as an empty tree", () => {
    const loaded = readChampionTree(tempPath());
    expect(loaded.size()).toBe(0);
  });

  test("a corrupt file loads as an empty tree (never throws)", () => {
    const path = tempPath();
    require("node:fs").writeFileSync(path, "{ not json", "utf8");
    expect(() => readChampionTree(path)).not.toThrow();
    expect(readChampionTree(path).size()).toBe(0);
  });

  test("fromState trims a snapshot larger than the cap to the most-recent niches", () => {
    const state: ChampionTreeState = {
      version: 1,
      niches: [
        { niche: "n1", champion: champ(10) },
        { niche: "n2", champion: champ(20) },
        { niche: "n3", champion: champ(30) },
      ],
    };
    const t = SpeciesChampions.fromState(state, 2);
    expect(t.size()).toBe(2);
    expect(t.get("n1")).toBeUndefined(); // oldest trimmed
    expect(t.get("n3")?.score).toBe(30);
  });
});

describe("nicheOf", () => {
  test("maps a config to its escape-time region key (t:c:r:d shape)", () => {
    const key = nicheOf({
      temperature: 0.5,
      contextWindowUsage: 0.5,
      retrievalStrategy: "semantic",
      decompositionDepth: 1,
    } as GenomeConfig);
    expect(key).toContain("r semantic".replace(" ", "")); // contains :rsemantic
    expect(key).toMatch(/^t\d:c\d:r.+:d\d+$/);
  });
});
