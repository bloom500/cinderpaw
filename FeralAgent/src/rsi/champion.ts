/**
 * The Crux — bridging the RSI loop to the LIVE agent.
 *
 * The RSI engine ratchets the best genome config onto `main`. On its
 * own that is academic: the genome optimises an abstract configuration
 * that never touches the agent the user actually talks to. The champion
 * bridge closes that loop. On each RatchetAdvanced the sidecar reads the
 * new best genome's config and:
 *   1. maps it onto the subset of fields that apply cleanly to the live
 *      agent loop (via `mapGenomeToAgentConfig`), and
 *   2. persists it (`writeChampion`) so the agent boots with the last
 *      winner across restarts.
 *
 * Field mapping today: temperature only. The other genome fields
 * (systemPromptId / promptTemplateId / retrievalStrategy /
 * decompositionDepth / toolPreferenceWeights) are abstract indices into
 * pools the live agent does not yet share, so mapping them would be
 * meaningless — they are deliberately left out until those pools are
 * real. The shape is the extension point: add fields here and the live
 * agent picks them up with no other change. The user's explicit UI
 * controls always override the champion (see agent-loop `#complete`).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { GenomeConfig } from "./genome.ts";
import type { GenomeSpec } from "./population-manager.ts";

/** The live-agent inference params a champion can set. Mirrors the
 *  agent loop's per-session override shape so wiring is a direct pass. */
export interface AgentChampionParams {
  temperature?: number;
}

/** Project a genome config onto the live-agent params. Only fields that
 *  map cleanly are emitted; an out-of-range value is dropped rather than
 *  poisoning the agent with a bad override. */
export function mapGenomeToAgentConfig(config: GenomeConfig): AgentChampionParams {
  const params: AgentChampionParams = {};
  const t = config.temperature;
  if (typeof t === "number" && Number.isFinite(t) && t >= 0) {
    params.temperature = t;
  }
  return params;
}

/** The persisted champion record. */
export interface ChampionRecord {
  genomeId: string;
  score: number;
  config: GenomeConfig;
  updatedAt: number;
}

/** Default on-disk location: `~/.feral/rsi/champion.json` (sibling of
 *  the git substrate; matches the taste miner's homedir-rooted layout). */
export function defaultChampionPath(): string {
  return join(homedir(), ".feral", "rsi", "champion.json");
}

/** Persist the champion. Creates the parent dir if needed. */
export function writeChampion(path: string, record: ChampionRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
}

/** Build a population seed from the persisted champion so a fresh run
 *  resumes from the best-known config instead of cold defaults (the
 *  git ratchet bar persists across restarts; without re-seeding the
 *  champion, a cold population would have to rediscover it from scratch
 *  to clear that bar). Returns null when there is no champion yet. */
export function championSeed(record: ChampionRecord | null): GenomeSpec | null {
  if (!record) return null;
  return {
    id: `champion-${record.genomeId}`,
    generation: 0,
    lineage: [],
    config: record.config,
    mutationType: "seed",
  };
}

/** Read the persisted champion. Returns null for a missing or corrupt
 *  file — a bad champion file must never crash the agent's boot. */
export function readChampion(path: string): ChampionRecord | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "config" in parsed &&
      (parsed as ChampionRecord).config
    ) {
      return parsed as ChampionRecord;
    }
  } catch {
    // Missing / corrupt — treat as "no champion yet".
  }
  return null;
}
