/**
 * Faza 1 — Async RSI Engine: production sidecar wiring.
 *
 * `RsiSidecar` is the singleton the Tauri transport talks to. It owns:
 *   - the live `RsiBridge` (writes `rsi_request` outbound, receives
 *     `rsi_response` inbound);
 *   - the engine + taste miner (built lazily on the first `start`);
 *   - the `mirrorEngineEvents` bus subscription (writes
 *     `rsi_engine_event` outbound for Rust's mirror + ack registry).
 *
 * All deps are constructor-injected so this module is unit-testable
 * with a fake router / bridge / transport. The only thing the real
 * `FeralAgent/src/index.ts` does is:
 *
 *   const rsi = new RsiSidecar({ router, db, send, ... });
 *   transport.onMessage(async (msg) => {
 *     switch (msg.type) {
 *       case "rsi_response": rsi.onResponse(msg); break;
 *       case "rsi_start":    await rsi.start({...}, msg.id); break;
 *       case "rsi_stop":     rsi.stop(msg.id); break;
 *       case "rsi_set_concurrency": rsi.setConcurrency(n, msg.id); break;
 *     }
 *   });
 *
 * E2E: the engine needs a live local model + the rust substrate to
 * be bootstrapped. The sidecar itself is fully unit-tested here; the
 * e2e step (cargo tauri dev + click Start in /rsi) is a manual
 * operator action.
 */

import type { Database } from "bun:sqlite";
import type { RsiBridge, RsiResponse } from "./bridge.ts";
import { createRsiEngine, makeTasteMiner, type RsiEngine } from "./engine.ts";
import {
  makeCommitGenomeAdapter,
  makeRatchetAttemptAdapter,
  makeScoreGenomeAdapter,
  makeLcaAdapter,
} from "./adapters.ts";
import { makeRunEval } from "./run-eval.ts";
import { makeGetSpecs } from "./get-specs.ts";
import { makeInvokeAgent, type InvokeRouter } from "./invoke-agent.ts";
import { selectCrossoverPairs } from "./crossover-selection.ts";
import { PopulationManager, type GenomeSpec } from "./population-manager.ts";
import { EventBus } from "./event-bus.ts";
import { TasteMiner, makeTasteDeps } from "./taste-miner.ts";
import type { GenomeConfig } from "./genome.ts";
import type { EvalKind, EvalExpected } from "./eval-spec.ts";
import { STRATEGY_SEED_VERSION, STRATEGY_SEEDS } from "./strategy-seeds.ts";
import { PbtController, type StrategyGenome } from "./pbt-controller.ts";
import { PbtHandler } from "./pbt-handler.ts";
import {
  writeChampion,
  readChampion,
  championSeed,
  defaultChampionPath,
  type ChampionRecord,
} from "./champion.ts";

/** Tiny contract the sidecar needs from the host's transport: a
 *  function that writes one outbound event as JSON. */
export type EmitFn = (event: Record<string, unknown>) => void;

/** What the host passes to start an engine run. */
export interface RsiStartOptions {
  goal: string;
  maxIterations: number;
  maxTotalTokens: number;
  concurrency?: number;
}

export interface RsiSidecarDeps {
  /** The InferenceRouter used by invokeAgent for every eval. */
  router: InvokeRouter;
  /** The 5-table sidecar SQLite DB (for commit attempts, the meta
   *  table, etc.). */
  db: Database;
  /** Bridge that carries `rsi_request` outbound and resolves the
   *  matching `rsi_response`. The sidecar wires its `transport.send`
   *  for the request side; `onResponse` is called from the host's
   *  inbound-message switch. */
  bridge: RsiBridge;
  /** Outbound sink — writes one JSON line per call. */
  send: EmitFn;
  /** Optional: extra engine seeds to merge with the defaults. Used
   *  by tests; production relies on the embedded seeds. */
  extraSeeds?: GenomeSpec[];
  /** Optional: system-prompt pool. Defaults to a single
   *  generic prompt (systemPromptId is ignored in that case). */
  systemPrompts?: Record<number, string>;
  /** Optional: history window for the taste miner. Default 20. */
  historyWindow?: number;
  /** Optional: where to write `pbt_state.json`. Default
   *  `~/.feral/meta/`. */
  fsRoot?: string;
  /** Optional: called when a run ends (resolve OR reject), after the
   *  engine is torn down. The passive supervisor uses this to restart
   *  the engine for continuous background evolution. */
  onIdle?: () => void;
  /** Optional: called when the engine ratchets a new best genome (the
   *  Crux). The host maps the record's config onto the live agent so
   *  the evolved configuration actually reaches the agent the user
   *  talks to. The record is also persisted to `championPath`. */
  onChampion?: (record: ChampionRecord) => void;
  /** Optional: where to persist `champion.json`. Default
   *  `~/.feral/rsi/champion.json`. */
  championPath?: string;
}

  /** Sidecar singleton — one per process. */
export class RsiSidecar {
  private engine: RsiEngine | null = null;
  private tasteMiner: TasteMiner | null = null;
  private mirrors: Array<() => void> = [];

  constructor(private readonly deps: RsiSidecarDeps) {}

  /** Route an inbound `rsi_response` line to the bridge. The host's
   *  transport switch calls this in its `case "rsi_response"` arm. */
  onResponse(msg: RsiResponse): void {
    this.deps.bridge.onResponse(msg);
  }

  /** The engine is running. */
  isRunning(): boolean {
    return this.engine !== null;
  }

  /** Build + run the engine. Idempotent on a `restart`-style call from
   *  the host: a second start() while a run is active is rejected so
   *  a UI double-click can't fork two engines on the same substrate. */
  async start(opts: RsiStartOptions, ackId?: string): Promise<void> {
    if (this.engine !== null) {
      this.deps.send({
        type: "error",
        message: "rsi_start: engine already running — stop it first",
      });
      return;
    }

    const bus = new EventBus();

    // ── Population + seeds ────────────────────────────────────────────
    const pop = new PopulationManager({ concurrency: opts.concurrency ?? 1 });
    // Resume from the persisted champion (best-known config) so a fresh
    // run doesn't restart cold — the git ratchet bar persists across
    // restarts, so the population must carry the champion to re-clear it
    // and keep evolving from there. Falls back to cold defaults when
    // there's no champion yet.
    const championPath = this.deps.championPath ?? defaultChampionPath();
    const resumeSeed = championSeed(readChampion(championPath));
    const baseSeeds = defaultEngineSeedsWithExtras(this.deps.extraSeeds);
    const seeds = resumeSeed ? [resumeSeed, ...baseSeeds] : baseSeeds;
    for (const seed of seeds) pop.add(seed);

    // ── Adapters (bridge → engine vocabulary) ─────────────────────────
    const commitGenome = makeCommitGenomeAdapter({
      bridge: this.deps.bridge,
      pop,
      db: this.deps.db,
      strategy: STRATEGY_SEED_VERSION,
    });
    const ratchetAttempt = makeRatchetAttemptAdapter({
      bridge: this.deps.bridge,
    });
    const scoreGenome = makeScoreGenomeAdapter({ bridge: this.deps.bridge });
    const fetchTier0 = async () => {
      const wire = await this.deps.bridge.request<
        Array<{
          id: string;
          name: string;
          description: string;
          prompt: string;
          kind: EvalKind;
          expected: EvalExpected;
        }>
      >("rsi_get_tier0_specs", {});
      return wire;
    };
    const getSpecs = makeGetSpecs({ fetchTier0 });

    // Empty-response telemetry. A model that returns empty/whitespace
    // content makes every eval score ~0 (validateOutcome fails) while
    // the engine keeps running — a silent "running but learning
    // nothing" failure that looks identical to a healthy run from the
    // engine's side. Surface it: exactly one early warning per run plus
    // a final tally on the `stopped` event, so the operator's e2e shows
    // immediately whether the MODEL (not the engine) is the problem.
    let emptyResponses = 0;
    let emptyWarned = false;
    const baseInvokeAgent = makeInvokeAgent({
      router: this.deps.router,
      getSystemPrompt: (id) =>
        this.deps.systemPrompts?.[id] ?? DEFAULT_SYSTEM_PROMPT,
    });
    const invokeAgent: typeof baseInvokeAgent = async (prompt, genome) => {
      const res = await baseInvokeAgent(prompt, genome);
      if (res.response.trim() === "") {
        emptyResponses += 1;
        if (!emptyWarned) {
          emptyWarned = true;
          this.deps.send({
            type: "rsi_engine_event",
            event: "warning",
            warning: "empty_response",
            genomeId: genome.id,
            message:
              "model returned an empty response — evals will score ~0; check the model/server (chat template, token budget, or wrong model id)",
          });
        }
      }
      return res;
    };
    const runEval = makeRunEval({ getSpecs, invokeAgent });

    // ── Escape-time + taste miner ─────────────────────────────────────
    // The taste miner shares the bus so it sees every RatchetAdvanced.
    const tasteMiner = makeTasteMiner({
      bus,
      bridge: this.deps.bridge,
      pop,
      ...(this.deps.fsRoot ? { fsRoot: this.deps.fsRoot } : {}),
      ...(this.deps.historyWindow ? { historyWindow: this.deps.historyWindow } : {}),
    });
    this.tasteMiner = tasteMiner;
    // Seed the in-memory taste from any pre-existing main history so
    // the very first birth already sees a meaningful bias. Errors are
    // swallowed — taste is a soft layer, never crash on it.
    await tasteMiner.loadPersisted().catch(() => {});
    void tasteMiner.mineNow();

    // ── Crossover wiring (LCA over the bridge) ────────────────────────
    const lca = makeLcaAdapter({ bridge: this.deps.bridge, pop });
    const crossover = {
      selectPairs: () =>
        selectCrossoverPairs(pop, { hasRecentCommonAncestor: lca }),
    };

    // ── Selection deps ────────────────────────────────────────────────
    // `escapeTracker` is a mutable holder so we can inject the engine's
    // tracker AFTER `createRsiEngine` returns it — that avoids the
    // chicken-and-egg between engine and selection construction.
    const escapeTrackerHolder: { current: import("./escape-time.ts").EscapeTimeTracker | undefined } = {
      current: undefined,
    };
    // ── PBT meta-layer (Faza 3.5) ─────────────────────────────────────
    // The strategy-genome population steers the Level-1 search. It is
    // loaded from the DB (seeded at bootstrap); a fresh/in-memory DB
    // with no seeded rows falls back to the embedded STRATEGY_SEEDS.
    const pbtController = new PbtController({
      strategies: loadStrategyGenomes(this.deps.db),
      rng: () => Math.random(),
    });

    // The selection knobs read the ACTIVE strategy's hyperparams live —
    // getters, so each strategy rotation (on RatchetAdvanced) changes
    // the search behaviour without reconstructing the handler.
    const selection = {
      get capacity() {
        return clampInt(pbtController.activeHyperparams().population_size, 2, 64);
      },
      get bounds() {
        // mutation_rate scales the bounded-real mutation magnitude
        // (temperature + context-window sigmas) relative to the
        // "balanced" reference rate.
        const base = defaultBounds();
        const factor = clampNum(
          pbtController.activeHyperparams().mutation_rate / PBT_REFERENCE_MUTATION_RATE,
          0.1,
          8,
        );
        return {
          ...base,
          temperatureSigma: base.temperatureSigma * factor,
          contextWindowSigma: base.contextWindowSigma * factor,
        };
      },
      rng: () => Math.random(),
      gaussian: boxMullerRandom,
      newId: () => crypto.randomUUID(),
      crossover,
      get escapeTracker() {
        return escapeTrackerHolder.current;
      },
      taste: makeTasteDeps(tasteMiner),
      wildExplorerRng: () => Math.random(),
      get wildExplorerFraction() {
        return pbtController.activeHyperparams().zoom_policy.wild_explorer_pct;
      },
      selectionPressure: () => pbtController.activeHyperparams().selection_pressure,
    };

    // ── Compose ───────────────────────────────────────────────────────
    const engine = createRsiEngine({
      seeds,
      goal: {
        goal: opts.goal,
        maxIterations: opts.maxIterations,
        maxTotalTokens: opts.maxTotalTokens,
      },
      evalDeps: { runEval, scoreGenome },
      ratchetDeps: { commitGenome, ratchetAttempt },
      selection,
      tasteMiner,
      ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
    });
    // Inject the engine's escape tracker into the selection deps now
    // that it exists (avoids a chicken-and-egg between engine and
    // selection construction).
    escapeTrackerHolder.current = engine.escapeTracker;
    this.engine = engine;

    // ── PBT handler on the ENGINE bus (where RatchetAdvanced fires) ───
    // Credits the active strategy + runs exploit/explore on each ratchet,
    // emits PBTSyncTriggered, and persists the strategy population to the
    // DB (canonical store). Persistence is a soft layer inside the
    // handler — a DB error never aborts the engine cascade.
    const db = this.deps.db;
    new PbtHandler(engine.bus, {
      controller: pbtController,
      persist: (strategies) => persistStrategyGenomes(db, strategies),
    });

    // ── Champion hook (the Crux): new best → live agent ───────────────
    // On each ratchet, project the new best genome's config onto the
    // live agent (via the host's onChampion) and persist it so the
    // agent boots with the last winner. Best-effort: a persist/notify
    // failure must never abort the engine cascade. (championPath is
    // hoisted above where the resume seed is built.)
    const onChampion = this.deps.onChampion;
    this.mirrors.push(
      engine.bus.onDisposable("RatchetAdvanced", (ev) => {
        const genomeId = ev.genomeId as string;
        const config = pop.get(genomeId)?.config;
        if (!config) return;
        const record: ChampionRecord = {
          genomeId,
          score: (ev.score as number) ?? 0,
          config,
          updatedAt: Date.now(),
        };
        try {
          writeChampion(championPath, record);
        } catch {
          // disk error — soft layer
        }
        try {
          onChampion?.(record);
        } catch {
          // host callback error — never abort the engine
        }
      }),
    );

    // ── Mirror engine events → outbound (Rust state + UI) ─────────────
    this.mirrors.push(mirrorEngineEvents(engine.bus, this.deps.send));

    // ── Ack the start ─────────────────────────────────────────────────
    this.deps.send({
      type: "rsi_engine_event",
      event: "started",
      ...(ackId ? { id: ackId } : {}),
      concurrency: opts.concurrency ?? 1,
    });

    // ── Drive the run in the background; report on completion ────────
    void engine.run().then(
      (result) => {
        this.deps.send({
          type: "rsi_engine_event",
          event: "stopped",
          ...(ackId ? { id: ackId } : {}),
          iteration: result.iterations,
          bestScore: result.best?.score,
          stopReason: result.reason,
          emptyResponses,
        });
        this.engine = null;
        for (const off of this.mirrors) off();
        this.mirrors = [];
        this.deps.onIdle?.();
      },
      (err) => {
        this.deps.send({
          type: "error",
          message: `rsi engine run failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        this.engine = null;
        for (const off of this.mirrors) off();
        this.mirrors = [];
        this.deps.onIdle?.();
      },
    );
  }

  /** Request a graceful stop. The engine drains in-flight evals
   *  (per GoalMode semantics) and emits `stopped` itself. */
  stop(ackId?: string): void {
    if (!this.engine) {
      this.deps.send({
        type: "error",
        message: "rsi_stop: engine is not running",
      });
      return;
    }
    this.engine.gm.stop();
    // The ack for `stopped` is emitted by the engine's run() promise
    // resolution — we don't double-ack here. But if the host passed an
    // id we surface an early "ack received" hint so a tight UI loop
    // can show "stopping…" rather than "running".
    if (ackId) {
      this.deps.send({
        type: "rsi_engine_event",
        event: "progress",
        ...(ackId ? { id: ackId } : {}),
      });
    }
  }

  /** Live concurrency ramp — read on the next refill. Setting to 0
   *  falls back to 1 inside GoalMode (defensive anti-deadlock). */
  setConcurrency(n: number, ackId?: string): void {
    if (!this.engine) {
      this.deps.send({
        type: "error",
        message: "rsi_set_concurrency: engine is not running",
      });
      return;
    }
    this.engine.pop.concurrency = Math.max(1, Math.floor(n));
    this.deps.send({
      type: "rsi_engine_event",
      event: "concurrency_set",
      ...(ackId ? { id: ackId } : {}),
      concurrency: this.engine.pop.concurrency,
    });
  }

  /** For tests + the e2e step: wait for any in-flight taste mine. */
  async drainTasteMiner(): Promise<void> {
    await this.tasteMiner?.drain();
  }
}

// ── Defaults + helpers ──────────────────────────────────────────────────────

/** Default system prompt. A more sophisticated pool can be injected
 *  via `RsiSidecarDeps.systemPrompts`; the genome's `systemPromptId`
 *  is an index into whatever pool the host supplies. */
const DEFAULT_SYSTEM_PROMPT =
  "You are a precise assistant. Answer the following question concisely and accurately.";

/** The "balanced" strategy-seed mutation_rate. The active strategy's
 *  mutation_rate scales the grammar sigmas relative to this reference,
 *  so the balanced profile leaves the embedded defaults unchanged. */
const PBT_REFERENCE_MUTATION_RATE = 0.1;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clampNum(v, lo, hi));
}

/** Load the active strategy-genome population for the PBT controller.
 *  Reads the DB rows seeded at bootstrap (preserving the lifetime
 *  `ratchet_count` so PBT credit accumulates across restarts). Falls
 *  back to the embedded STRATEGY_SEEDS when the table is empty or
 *  absent (fresh / in-memory DB), so the controller always has a
 *  heterogeneous starting population. Fitness is a within-run EMA and
 *  always starts at 0. */
function loadStrategyGenomes(db: Database): StrategyGenome[] {
  try {
    const rows = db
      .query<{ id: string; hyperparams: string; ratchet_count: number }, []>(
        `SELECT id, hyperparams, ratchet_count FROM rsi_strategy_genome
         WHERE active = 1 ORDER BY id`,
      )
      .all();
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: r.id,
        hyperparams: JSON.parse(r.hyperparams),
        ratchetCount: r.ratchet_count ?? 0,
        fitness: 0,
      }));
    }
  } catch {
    // Table missing (e.g. a bare in-memory test DB) — fall through.
  }
  return STRATEGY_SEEDS.map((s) => ({
    id: s.id,
    hyperparams: s.hyperparams,
    ratchetCount: 0,
    fitness: 0,
  }));
}

/** Persist the strategy population to the canonical DB store after a
 *  PBT sync. Best-effort: the caller (PbtHandler) swallows throws so a
 *  transient DB error never aborts the engine. A missing table is a
 *  no-op (the row UPDATEs simply match nothing). */
function persistStrategyGenomes(db: Database, strategies: StrategyGenome[]): void {
  const now = Date.now();
  const stmt = db.query(
    `UPDATE rsi_strategy_genome
       SET hyperparams = $hp, ratchet_count = $rc, last_sync_at = $t
     WHERE id = $id`,
  );
  for (const s of strategies) {
    stmt.run({
      $hp: JSON.stringify(s.hyperparams),
      $rc: s.ratchetCount,
      $t: now,
      $id: s.id,
    });
  }
}

/** Mutation bounds — sensible defaults for the embedded grammar. */
function defaultBounds() {
  return {
    templatePoolSize: 4,
    systemPromptPoolSize: 4,
    maxTemperature: 1.0,
    temperatureSigma: 0.2,
    contextWindowSigma: 0.1,
    transferEpsilon: 0.1,
  };
}

/** A small diverse seed set so the engine has variety from iter 0. */
function defaultEngineSeeds(): GenomeSpec[] {
  const make = (id: string, cfg: GenomeConfig): GenomeSpec => ({
    id,
    generation: 0,
    lineage: [],
    config: cfg,
    mutationType: "seed",
  });
  return [
    make("seed-conservative", {
      promptTemplateId: 0,
      temperature: 0.2,
      systemPromptId: 0,
      retrievalStrategy: "episodic",
      contextWindowUsage: 0.4,
      toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
      decompositionDepth: 0,
    }),
    make("seed-balanced", {
      promptTemplateId: 1,
      temperature: 0.5,
      systemPromptId: 0,
      retrievalStrategy: "semantic",
      contextWindowUsage: 0.5,
      toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
      decompositionDepth: 1,
    }),
    make("seed-aggressive", {
      promptTemplateId: 2,
      temperature: 0.8,
      systemPromptId: 1,
      retrievalStrategy: "graph",
      contextWindowUsage: 0.7,
      toolPreferenceWeights: [0.1, 0.4, 0.1, 0.4],
      decompositionDepth: 2,
    }),
    make("seed-wild", {
      promptTemplateId: 3,
      temperature: 1.0,
      systemPromptId: 1,
      retrievalStrategy: "hybrid",
      contextWindowUsage: 0.9,
      toolPreferenceWeights: [0.4, 0.1, 0.4, 0.1],
      decompositionDepth: 3,
    }),
  ];
}

/** Merge the embedded diverse seeds with any host-supplied extras. */
function defaultEngineSeedsWithExtras(extras: GenomeSpec[] | undefined): GenomeSpec[] {
  if (!extras || extras.length === 0) return defaultEngineSeeds();
  return [...defaultEngineSeeds(), ...extras];
}

/** Box-Muller standard normal. Cheap enough for the eval pool. */
function boxMullerRandom(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Subscribe to all engine events and forward them as `rsi_engine_event`
 *  outbound lines so Rust's mirror + UI can react in real time. The
 *  returned function detaches the subscriptions so teardown is clean. */
export function mirrorEngineEvents(bus: EventBus, send: EmitFn): () => void {
  const offs: Array<() => void> = [];
  // The Rust mirror's `iteration` field updates only when an emitted
  // `rsi_engine_event` carries an `iteration` value. The engine's
  // iteration counter lives in `GoalMode` (out of reach of the bus
  // subscriptions), so we mirror it here by counting EvalComplete
  // events — exactly one per iteration. GenomeBorn fires AFTER an
  // iteration completed (the selection handler runs in the same
  // EvalComplete cascade), so we tag it with the post-iteration count
  // too.
  let iterationCount = 0;

  offs.push(bus.onDisposable("GenomeBorn", (ev) => {
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      mutationType: ev.mutationType,
    });
  }));
  offs.push(bus.onDisposable("EvalStarted", (ev) => {
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      stage: "started",
    });
  }));
  offs.push(bus.onDisposable("EvalComplete", (ev) => {
    iterationCount += 1;
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      score: ev.score,
      tokenCost: ev.tokenCost,
      durationMs: ev.durationMs,
      errored: ev.errored,
    });
  }));
  offs.push(bus.onDisposable("RatchetAdvanced", (ev) => {
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      commitHash: ev.commitHash,
      score: ev.score,
      previousBest: ev.previousBest,
      ratchet: true,
    });
  }));
  offs.push(bus.onDisposable("GenomeDied", (ev) => {
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      cause: ev.cause,
      died: true,
    });
  }));
  offs.push(bus.onDisposable("PBTSyncTriggered", (ev) => {
    // Meta-RSI sync (Faza 3.5): the active strategy-genome was credited
    // for a ratchet and the population exploit/explored. Surfaced so the
    // UI can show which search strategy is steering and when it rotates.
    send({
      type: "rsi_engine_event",
      event: "pbt_sync",
      iteration: iterationCount,
      creditedId: ev.creditedId,
      nextActiveId: ev.nextActiveId,
      replaced: ev.replaced,
    });
  }));
  offs.push(bus.onDisposable("ExtinctionTriggered", (ev) => {
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      extinction: true,
      reason: ev.reason,
      killed: ev.killed,
    });
  }));

  return () => {
    for (const off of offs) off();
  };
}
