/**
 * The Crux — the ratcheted-best genome's config applied to the LIVE agent.
 *
 * Without this, RSI optimises configs in a vacuum that never touch the
 * agent the user actually talks to. `mapGenomeToAgentConfig` projects a
 * genome onto the subset of fields that map cleanly onto the live agent
 * loop (temperature today; more as the prompt pools become real). The
 * champion is persisted so the agent boots with the last winner.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapGenomeToAgentConfig,
  writeChampion,
  readChampion,
  championSeed,
  type ChampionRecord,
} from "../src/rsi/champion.ts";
import type { GenomeConfig } from "../src/rsi/genome.ts";

const CFG: GenomeConfig = {
  promptTemplateId: 0,
  temperature: 0.65,
  systemPromptId: 0,
  retrievalStrategy: "hybrid",
  contextWindowUsage: 0.7,
  toolPreferenceWeights: [0.5, 0.5],
  decompositionDepth: 1,
};

describe("mapGenomeToAgentConfig", () => {
  test("maps temperature onto the live-agent params", () => {
    expect(mapGenomeToAgentConfig(CFG).temperature).toBe(0.65);
  });

  test("drops an invalid temperature rather than poisoning the agent", () => {
    expect(mapGenomeToAgentConfig({ ...CFG, temperature: NaN }).temperature).toBeUndefined();
    expect(mapGenomeToAgentConfig({ ...CFG, temperature: -1 }).temperature).toBeUndefined();
  });
});

describe("champion persistence", () => {
  test("write then read round-trips the record", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-champ-"));
    try {
      const path = join(dir, "rsi", "champion.json");
      const rec: ChampionRecord = { genomeId: "g1", score: 73.2, config: CFG, updatedAt: 123 };
      writeChampion(path, rec);
      const back = readChampion(path);
      expect(back).not.toBeNull();
      expect(back!.genomeId).toBe("g1");
      expect(back!.config.temperature).toBe(0.65);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read returns null for a missing file", () => {
    expect(readChampion(join(tmpdir(), "definitely-missing-champion.json"))).toBeNull();
  });

  test("championSeed builds a resume seed from the record (null when absent)", () => {
    expect(championSeed(null)).toBeNull();
    const seed = championSeed({ genomeId: "g7", score: 80, config: CFG, updatedAt: 1 });
    expect(seed).not.toBeNull();
    expect(seed!.id).toContain("g7");
    expect(seed!.mutationType).toBe("seed");
    expect(seed!.config!.temperature).toBe(0.65);
  });

  test("read returns null for corrupt JSON (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-champ-"));
    try {
      const path = join(dir, "champion.json");
      writeChampion(path, { genomeId: "x", score: 1, config: CFG, updatedAt: 1 });
      // Corrupt it.
      require("node:fs").writeFileSync(path, "{not json", "utf8");
      expect(readChampion(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
