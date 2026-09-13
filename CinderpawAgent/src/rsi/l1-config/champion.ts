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
 * Field mapping today: temperature + systemPromptId (resolved through
 * the SHARED prompt-style pool — see `prompt-pool.ts` — so what eval
 * judged is exactly what the live agent runs). Still unmapped:
 * promptTemplateId / retrievalStrategy / decompositionDepth /
 * toolPreferenceWeights / contextWindowUsage — abstract indices into
 * pools the live agent does not yet share (the live recall tool has no
 * strategy knob, and eval tool-weights have no stable alignment with the
 * live registry). The shape is the extension point: add fields here and
 * the live agent picks them up with no other change. The user's explicit
 * UI controls always override the champion (see agent-loop `#complete`).
 *
 * S2 parity (recursive-learning spec §8: "the evaluator and task execution
 * resolve the same immutable artifact ... reject unsupported fields rather
 * than evaluating knobs that disappear in live execution").
 *
 * The eval harness (`infra/invoke-agent.ts`) applies ALL SEVEN dimensions:
 * retrieval strategy, context usage, tool order and sub-call count all change
 * the score it reports. The live agent applies two. So a genome can win eval
 * on a knob that does nothing to the agent the user talks to, and the ratchet
 * would record that as an improvement. `LIVE_REACH` is now the single place
 * that says which is which, `parityOf` hashes only what actually reaches the
 * agent, and `writeChampion` stamps that on every champion record — including
 * `sameAppliedAsPrevious`, which is true exactly when the new champion will
 * behave identically to the old one live. The table itself lives in
 * `genome.ts` next to the schema, because `mutation.ts` reads it too.
 */

import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { dirname, join } from "node:path";
import { cinderpawHome } from "../../config.ts";
import { sha256Canonical } from "../infra/hash-chain.ts";
import { appliedDimensions, droppedDimensions, type GenomeConfig } from "./genome.ts";
export { LIVE_REACH, droppedDimensions } from "./genome.ts";
import type { GenomeSpec } from "./population-manager.ts";
import { promptStyleFor } from "./prompt-pool.ts";

/** The live-agent params a champion can set. Mirrors the agent loop's
 *  champion-params shape so wiring is a direct pass. */
export interface AgentChampionParams {
  temperature?: number;
  /** Style text appended to the live system prompt (per new session).
   *  Resolved from the shared pool; empty/absent = neutral. */
  systemPromptAddendum?: string;
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
  const style = promptStyleFor(config.systemPromptId);
  if (style) params.systemPromptAddendum = style;
  return params;
}

/** What the live agent will actually do, and its hash. Two genomes with the
 *  same `hash` are the same agent in production however differently eval
 *  scored them. */
export interface ChampionParity {
  /** sha256 of the canonical live projection — NOT of the genome. */
  hash: string;
  /** Dimensions that reached the agent. */
  applied: (keyof GenomeConfig)[];
  /** Dimensions eval scored and the agent ignored. */
  dropped: (keyof GenomeConfig)[];
  /** True when this champion is live-identical to the one it replaced: the
   *  ratchet advanced, the user gets the same agent. */
  sameAppliedAsPrevious?: boolean;
}

export function parityOf(config: GenomeConfig): ChampionParity {
  return {
    hash: sha256Canonical(mapGenomeToAgentConfig(config)),
    applied: [...appliedDimensions()].sort(),
    dropped: droppedDimensions(),
  };
}

/** The persisted champion record. */
export interface ChampionRecord {
  genomeId: string;
  score: number;
  config: GenomeConfig;
  updatedAt: number;
  /** Filled in by `writeChampion`; absent on records written before S2. */
  parity?: ChampionParity;
}

/** Default on-disk location: `~/.cinderpaw/rsi/champion.json` (sibling of
 *  the git substrate; matches the taste miner's homedir-rooted layout). */
export function defaultChampionPath(): string {
  return join(cinderpawHome(), "rsi", "champion.json");
}

/** Persist the champion. Creates the parent dir if needed.
 *
 *  The parity stamp is computed HERE rather than at the call site, so every
 *  writer gets it — including the first champion a fresh install ever
 *  produces, which is the one nobody is watching. */
export function writeChampion(path: string, record: ChampionRecord): ChampionRecord {
  const previous = readChampion(path);
  const parity = parityOf(record.config);
  parity.sameAppliedAsPrevious = previous ? parityOf(previous.config).hash === parity.hash : false;
  record = { ...record, parity };
  mkdirSync(dirname(path), { recursive: true });
  // Atomic: this is what boot reads to resume from the current champion. A
  // half-written file means the next start finds nothing, falls back to the
  // seed, and every gain from the previous session is gone.
  atomicWriteFileSync(path, JSON.stringify(record, null, 2));
  return record;
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
