/**
 * S2 artifact parity: what eval scores versus what the live agent actually
 * runs. The eval harness applies all seven genome dimensions; the live agent
 * applies two. These tests pin that gap in place so it is a recorded fact on
 * every champion instead of a footnote in a module header, and so it shrinks
 * the day someone wires a dimension through.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIVE_REACH,
  droppedDimensions,
  parityOf,
  readChampion,
  writeChampion,
  type ChampionRecord,
} from "../src/rsi/l1-config/champion.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const config = (over: Partial<GenomeConfig> = {}): GenomeConfig => ({
  promptTemplateId: 0,
  temperature: 0.7,
  systemPromptId: 1,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.4,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 0,
  ...over,
});

const record = (c: GenomeConfig, id = "g1", score = 1): ChampionRecord => ({
  genomeId: id,
  score,
  config: c,
  updatedAt: 1_700_000_000_000,
});

describe("live reach", () => {
  test("every genome dimension is classified", () => {
    const keys = Object.keys(config()).sort();
    expect(Object.keys(LIVE_REACH).sort()).toEqual(keys);
  });

  test("the dropped list is the five dimensions eval scores and the agent ignores", () => {
    expect(droppedDimensions()).toEqual([
      "contextWindowUsage",
      "decompositionDepth",
      "promptTemplateId",
      "retrievalStrategy",
      "toolPreferenceWeights",
    ]);
  });
});

describe("parity hash", () => {
  test("two genomes differing only in dropped dimensions are the same agent live", () => {
    const a = config();
    const b = config({
      retrievalStrategy: "graph",
      decompositionDepth: 3,
      contextWindowUsage: 0.9,
      toolPreferenceWeights: [1, 0, 0, 0],
      promptTemplateId: 7,
    });
    // Eval can rank these apart. Production cannot tell them apart at all.
    expect(parityOf(b).hash).toBe(parityOf(a).hash);
  });

  test("a change in an applied dimension changes the hash", () => {
    expect(parityOf(config({ temperature: 0.2 })).hash).not.toBe(parityOf(config()).hash);
    expect(parityOf(config({ systemPromptId: 4 })).hash).not.toBe(parityOf(config()).hash);
  });
});

describe("writeChampion stamps parity", () => {
  const withTmp = (fn: (path: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "champ-parity-"));
    try {
      fn(join(dir, "champion.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("the first champion on a fresh install carries the stamp", () => {
    withTmp((path) => {
      const stamped = writeChampion(path, record(config()));
      expect(stamped.parity?.applied).toEqual(["systemPromptId", "temperature"]);
      expect(stamped.parity?.dropped).toHaveLength(5);
      // Nothing preceded it, so it is not "the same as before".
      expect(stamped.parity?.sameAppliedAsPrevious).toBe(false);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as ChampionRecord;
      expect(onDisk.parity?.hash).toBe(stamped.parity!.hash);
    });
  });

  test("a ratchet that only moves dropped dimensions is marked as no live change", () => {
    withTmp((path) => {
      writeChampion(path, record(config(), "g1", 1));
      const next = writeChampion(
        path,
        record(config({ retrievalStrategy: "hybrid", decompositionDepth: 2 }), "g2", 9),
      );
      expect(next.parity?.sameAppliedAsPrevious).toBe(true);
    });
  });

  test("a ratchet that moves an applied dimension is marked as a real change", () => {
    withTmp((path) => {
      writeChampion(path, record(config(), "g1", 1));
      const next = writeChampion(path, record(config({ temperature: 0.1 }), "g2", 2));
      expect(next.parity?.sameAppliedAsPrevious).toBe(false);
    });
  });

  test("a champion written before S2 still reads back", () => {
    withTmp((path) => {
      writeChampion(path, record(config()));
      const back = readChampion(path);
      expect(back?.genomeId).toBe("g1");
      expect(back?.parity?.hash).toBeTruthy();
    });
  });
});
