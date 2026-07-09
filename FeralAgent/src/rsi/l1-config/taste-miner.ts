/**
 * Faza 3 — Taste Layer: the production miner handler.
 *
 * Subscribes to `RatchetAdvanced` and re-mines the taste vector from
 * the last 20 ratchet commits (the `main` chain) every time main
 * advances. The vector is persisted to `~/.feral/meta/pbt_state.json`
 * so PBT can replay / inspect it across sidecar restarts, and is
 * exposed to the selection handler via `SelectionDeps.taste`.
 *
 * The mining is decoupled from the ratchet cascade — it runs in a
 * fire-and-forget promise after the RatchetAdvanced event finishes.
 * A failed mine (bridge error, missing configs, filesystem failure)
 * is logged but never crashes the engine; the taste vector defaults
 * to the last successful value (or zero on a fresh start).
 *
 * Why "last 20": PBT taste mining uses a rolling window so the bias
 * reflects recent wins, not the entire history. The cap mirrors the
 * `tasteWeight(historyHalf=20)` default — past that the saturating
 * curve adds no extra weight, so 20 commits are enough resolution.
 *
 * Coalescing: concurrent RatchetAdvanced events share a single
 * in-flight mine (the next mine sees the most recent main chain
 * anyway, so chaining is correct).
 */

import type { EventBus } from "../infra/event-bus.ts";
import type { RsiBridge } from "../infra/bridge.ts";
import type { PopulationManager } from "./population-manager.ts";
import { mineTasteVector, tasteWeight, type RatchetPair } from "./taste.ts";

/** Shape of `rsi_log`'s response item (Rust `rsi::repo::CommitMeta`). */
export interface CommitMetaWire {
  commit_hash: string;
  parent_hashes: string[];
  author: string;
  timestamp: number;
  summary: string;
  metadata_json: string | null;
}

/** What the miner writes to `pbt_state.json`. */
export interface PbtState {
  taste_vector: number[];
  history_depth: number;
  population_size: number;
  /** Unix-ms timestamp of the last successful mine. */
  last_mined_at: number;
}

export interface TasteMinerDeps {
  bridge: RsiBridge;
  pop: PopulationManager;
  /** Where to write `pbt_state.json`. Defaults to `~/.feral/meta/`. */
  fsRoot?: string;
  /** How many recent ratchet commits to mine. Default 20. */
  historyWindow?: number;
  /** Filesystem writer — injectable for tests. */
  writeJson?: (path: string, data: unknown) => Promise<void>;
  /** Filesystem reader — injectable for tests. */
  readJson?: (path: string) => Promise<unknown>;
  /** Monotonic clock — injectable for tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_HISTORY_WINDOW = 20;
const DEFAULT_FS_ROOT = "meta";
const STATE_FILENAME = "pbt_state.json";
const TASTE_DIMS = 7;

export class TasteMiner {
  private readonly bridge: RsiBridge;
  private readonly pop: PopulationManager;
  private readonly fsRoot: string;
  private readonly historyWindow: number;
  private readonly writeJson: (path: string, data: unknown) => Promise<void>;
  private readonly readJson: (path: string) => Promise<unknown>;
  private readonly now: () => number;

  private vector: number[] = new Array(TASTE_DIMS).fill(0);
  private historyDepth = 0;
  private populationSize = 0;
  private lastMinedAt = 0;
  /** Coalesce concurrent mines — only one in-flight at a time. */
  private mining: Promise<void> = Promise.resolve();

  constructor(bus: EventBus, deps: TasteMinerDeps) {
    this.bridge = deps.bridge;
    this.pop = deps.pop;
    this.fsRoot = deps.fsRoot ?? defaultFsRoot();
    this.historyWindow = deps.historyWindow ?? DEFAULT_HISTORY_WINDOW;
    this.writeJson = deps.writeJson ?? defaultWriteJson;
    this.readJson = deps.readJson ?? defaultReadJson;
    this.now = deps.now ?? Date.now;
    bus.on("RatchetAdvanced", () => this.scheduleMine());
  }

  /** The current taste vector (zero vector before the first mine). */
  getVector(): number[] {
    return this.vector;
  }

  /** How many pairs the most recent mine observed. */
  getHistoryDepth(): number {
    return this.historyDepth;
  }

  /** Current taste weight for the SelectionDeps.taste binding. */
  getWeight(): number {
    return tasteWeight(this.populationSize, this.historyDepth);
  }

  /** The path this miner reads / writes. */
  statePath(): string {
    return `${this.fsRoot}/${STATE_FILENAME}`;
  }

  /** Load `pbt_state.json` from disk and seed the in-memory vector.
   *  Called once at sidecar start so a restart resumes the previous
   *  taste bias. Missing file / parse error / shape mismatch is a
   *  no-op — load is ALL OR NOTHING so a partial restore can't leave
   *  the bias in a state that contradicts its declared history. */
  async loadPersisted(): Promise<void> {
    try {
      const raw = await this.readJson(this.statePath());
      if (!raw || typeof raw !== "object") return;
      const s = raw as Partial<PbtState>;
      if (
        Array.isArray(s.taste_vector) &&
        s.taste_vector.length === TASTE_DIMS &&
        typeof s.history_depth === "number" &&
        typeof s.population_size === "number" &&
        typeof s.last_mined_at === "number"
      ) {
        this.vector = s.taste_vector;
        this.historyDepth = s.history_depth;
        this.populationSize = s.population_size;
        this.lastMinedAt = s.last_mined_at;
      }
    } catch {
      // Missing file / parse error — start fresh, no-op.
    }
  }

  /** Force an immediate mine (ignores coalescing). Used at sidecar
   *  start so the first run is seeded from any pre-existing main
   *  history, and in tests for deterministic post-state assertions. */
  async mineNow(): Promise<void> {
    try {
      const next = await this.runMine();
      this.apply(next);
      await this.persist();
    } catch {
      // Soft — taste is a bias, never crash the engine on it.
    }
  }

  /** Schedule a background mine. Coalesces concurrent calls so only
   *  one fetch runs at a time; chained promises preserve correctness
   *  (the next mine sees the latest main chain). */
  scheduleMine(): void {
    this.mining = this.mining.then(async () => {
      try {
        const next = await this.runMine();
        this.apply(next);
        await this.persist();
      } catch {
        // see mineNow — silent on taste errors.
      }
    });
  }

  /** Wait for any in-flight mine to finish. Tests use this for
   *  deterministic post-state assertions without `setTimeout`. */
  async drain(): Promise<void> {
    await this.mining;
  }

  private apply(next: MinedResult): void {
    this.vector = next.vector;
    this.historyDepth = next.depth;
    this.populationSize = next.popSize;
    this.lastMinedAt = next.at;
  }

  private async persist(): Promise<void> {
    try {
      await this.writeJson(this.statePath(), {
        taste_vector: this.vector,
        history_depth: this.historyDepth,
        population_size: this.populationSize,
        last_mined_at: this.lastMinedAt,
      } satisfies PbtState);
    } catch {
      // see mineNow — disk failure must not block evolution.
    }
  }

  private async runMine(): Promise<MinedResult> {
    const commits = await this.bridge.request<CommitMetaWire[]>("rsi_log", {
      max: this.historyWindow,
    });
    const pairs: RatchetPair[] = [];
    // rsi_log returns newest first; consecutive pairs are (newer, older).
    // The miner walks the list and pairs each commit with its immediate
    // predecessor so the bias reflects the direction main advanced.
    for (let i = 0; i + 1 < commits.length; i++) {
      const newer = commits[i]!;
      const older = commits[i + 1]!;
      const winner = this.pop.getConfigByCommit(newer.commit_hash);
      const loser = this.pop.getConfigByCommit(older.commit_hash);
      if (!winner || !loser) continue; // missing snapshot → skip the pair
      pairs.push({ winner, loser });
    }
    return {
      vector: mineTasteVector(pairs),
      depth: pairs.length,
      popSize: this.pop.alive().length,
      at: this.now(),
    };
  }
}

interface MinedResult {
  vector: number[];
  depth: number;
  popSize: number;
  at: number;
}

/** Construct a SelectionDeps.taste object bound to a TasteMiner. */
export function makeTasteDeps(miner: TasteMiner): {
  vector: () => number[];
  weight: () => number;
} {
  return {
    vector: () => miner.getVector(),
    weight: () => miner.getWeight(),
  };
}

// ── Default IO (Node fs/promises under a homedir-resolved root) ─────────────

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function defaultFsRoot(): string {
  return join(homedir(), ".feral", DEFAULT_FS_ROOT);
}

async function defaultWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
}

async function defaultReadJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}
