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
 * `CinderpawAgent/src/index.ts` does is:
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
import type { RsiBridge, RsiResponse } from "./infra/bridge.ts";
import { createRsiEngine, makeTasteMiner, type RsiEngine } from "./engine.ts";
import {
  makeCommitGenomeAdapter,
  makeRatchetAttemptAdapter,
  makeScoreGenomeAdapter,
  makeLcaAdapter,
} from "./infra/adapters.ts";
import { makeRunEval } from "./infra/run-eval.ts";
import { makeGetSpecs } from "./infra/get-specs.ts";
import { makeInvokeAgent, type InvokeRouter } from "./infra/invoke-agent.ts";
import { builtinPlanSteps, itemsToHits, liveSeamAdapter, repliesToSteps } from "./l4-modules/seam-runtime.ts";
import { spawnModuleHost } from "./l4-modules/module-host-client.ts";
import { selectCrossoverPairs } from "./l1-config/crossover-selection.ts";
import { cfgPath, readEnv } from "../config.ts";
import { PopulationManager, type GenomeSpec } from "./l1-config/population-manager.ts";
import { EventBus } from "./infra/event-bus.ts";
import { TasteMiner, makeTasteDeps } from "./l1-config/taste-miner.ts";
import type { GenomeConfig } from "./l1-config/genome.ts";
import type { EvalKind, EvalExpected } from "./infra/eval-spec.ts";
import { STRATEGY_SEED_VERSION, STRATEGY_SEEDS } from "./l1-config/strategy-seeds.ts";
import { PROMPT_STYLE_POOL } from "./l1-config/prompt-pool.ts";
import { blendedPricePer1kUsd } from "./infra/rsi-cost.ts";
import { evaluateGate } from "./infra/confidence.ts";
import { recentToolCalls, recentFeedback } from "../egress/audit-log.ts";
import { PbtController, type StrategyGenome } from "./l1-config/pbt-controller.ts";
import { DEFAULT_META_GENOME } from "./l6-meta/meta-evolution.ts";
import { PbtHandler } from "./l1-config/pbt-handler.ts";
import {
  writeChampion,
  readChampion,
  championSeed,
  defaultChampionPath,
  type ChampionRecord,
} from "./l1-config/champion.ts";
import {
  readChampionTree,
  writeChampionTree,
  defaultChampionTreePath,
  nicheOf,
} from "./l1-config/champion-tree.ts";
import {
  readPopulationSnapshot,
  writePopulationSnapshot,
  defaultPopulationSnapshotPath,
} from "./l1-config/population-snapshot.ts";

/** Tiny contract the sidecar needs from the host's transport: a
 *  function that writes one outbound event as JSON. */
export type EmitFn = (event: Record<string, unknown>) => void;

/** What the host passes to start an engine run. */
export interface RsiStartOptions {
  goal: string;
  maxIterations: number;
  maxTotalTokens: number;
  /** USD spend cap. 0 = local-only. undefined ⇒ no cost cap (manual runs). */
  maxTotalCostUsd?: number;
  concurrency?: number;
  /** Dream Cycle episode cap: hard wall-clock bound (ms) so an episode
   *  cannot hang or burn past its window. undefined ⇒ no wall-clock cap
   *  (manual/continuous runs). Threaded into GoalConfig.maxWallClockMs. */
  maxWallClockMs?: number;
  /** Dream Cycle episode cap: stop early after this many consecutive
   *  iterations with no new ratchet. undefined ⇒ no plateau stop.
   *  Threaded into GoalConfig.plateauPatience. */
  plateauIterations?: number;
}

/** Slim run-end stats the host uses for Dream Cycle telemetry. Carried
 *  on `onIdle` so the host can append one JSONL line per episode without
 *  re-deriving anything from the engine. */
export interface RsiRunStats {
  iterations: number;
  tokens: number;
  stopReason: string;
  /** RatchetAdvanced events during this episode — the count of real
   *  improvements committed to main. The number that lets telemetry prove
   *  the Dream Cycle is improving (not just spinning). */
  ratchets: number;
  /** ConfidenceFailed events during this episode — candidates that beat
   *  main's prior score but were blocked by a pre-ratchet gate: the
   *  statistical confidence gate (BRSI §2.7) or the Tier 0 sanity floor
   *  (INVARIANT I8). The count that proves the gates are filtering noise
   *  and gaming, not rubber-stamping. Optional for back-compat with stats
   *  literals that predate the gate. */
  confidenceRejections?: number;
  /** Error messages from failed evals (capped at 5). */
  errors: string[];
  /** Number of empty model responses during this episode. */
  emptyResponses: number;
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
  /** Optional log sink (host's `log`). Background (Dream Cycle) episode
   *  failures are written here instead of being pushed to the user-facing
   *  `error` channel — an idle self-improvement run that fails must not
   *  surface as a chat error the user never asked for. */
  log?: (msg: string) => void;
  /** Optional: extra engine seeds to merge with the defaults. Used
   *  by tests; production relies on the embedded seeds. */
  extraSeeds?: GenomeSpec[];
  /** Optional: system-prompt pool. Defaults to a single
   *  generic prompt (systemPromptId is ignored in that case). */
  systemPrompts?: Record<number, string>;
  /** Optional: history window for the taste miner. Default 20. */
  historyWindow?: number;
  /** Optional: where to write `pbt_state.json`. Default
   *  `~/.cinderpaw/meta/`. */
  fsRoot?: string;
  /** Optional: called when a run ends (resolve OR reject), after the
   *  engine is torn down. The Dream Cycle scheduler uses this to enter
   *  its sleep/cooldown window; `stats` (present on a normal stop) lets
   *  the host append per-episode telemetry. */
  onIdle?: (stats?: RsiRunStats) => void;
  /** Optional: called when the engine ratchets a new best genome (the
   *  Crux). The host maps the record's config onto the live agent so
   *  the evolved configuration actually reaches the agent the user
   *  talks to. The record is also persisted to `championPath`. */
  onChampion?: (record: ChampionRecord) => void;
  /** Optional: where to persist `champion.json`. Default
   *  `~/.cinderpaw/rsi/champion.json`. */
  championPath?: string;
  /** Optional: where to persist the Tree of Champions per-niche archive
   *  (§7.4). Default `~/.cinderpaw/rsi/champion-tree.json`. */
  championTreePath?: string;
  /** Optional: where to persist the full population snapshot (Dream Cycle
   *  evolutionary continuity). Default `~/.cinderpaw/rsi/population.json`. */
  populationSnapshotPath?: string;
  /** Optional: L6 Meta Evolution — the live MetaGenome accessor. When
   *  present, its ratio-to-default fields scale the PBT-driven selection
   *  knobs and (tighten-only) the confidence-gate thresholds. Absent →
   *  exact pre-L6 behaviour. */
  metaParams?: () => import("./l6-meta/meta-evolution.ts").MetaGenome;
  /** Optional: L5 governance gates (already composed with the locked
   *  floor via `effectiveGates`). Tightens the promotion gate further —
   *  same max()/min() discipline as `metaParams`. Absent → pre-L5
   *  behaviour (§7). */
  policyGates?: () => import("./infra/confidence.ts").GateThresholds;
  /** Optional: L4 seam builtins for the paired module eval (§5) — the
   *  INCUMBENT implementation per seam, keyed by seam name. index.ts
   *  provides `retrieval_strategy` (FractalMemory-backed); `planner`
   *  defaults to the builtin split. Absent seam → that seam's method is
   *  left unbound on BOTH eval runs (symmetric pairing). */
  seamBuiltins?: Record<string, (method: string, params: unknown) => Promise<unknown>>;
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

  // ── Eval-harness building blocks (shared by start() and L4 §5) ───────

  /** Tier 0 fetcher over the bridge (the frozen sanity bar). */
  private fetchTier0() {
    return async () => {
      try {
        return await this.deps.bridge.request<
          Array<{
            id: string;
            name: string;
            description: string;
            prompt: string;
            kind: EvalKind;
            expected: EvalExpected;
          }>
        >("rsi_get_tier0_specs", {});
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.deps.log?.(`rsi_get_tier0_specs bridge error: ${detail}`);
        throw err;
      }
    };
  }

  /** Tier-0 evals are short factual answers — they never need the
   *  4096-token default budget. On slow local hardware the budget is the
   *  difference between a 50s eval and a 5-minute timeout (thinking-mode
   *  models like Qwen3.5 will happily burn the whole window "reasoning").
   *  ponytail: flat env knob; per-spec budgets if Tier 1/2 ever need more. */
  private evalTokenBudget(): number {
    const n = Number(readEnv("CINDERPAW_RSI_EVAL_TOKEN_BUDGET"));
    return n > 0 ? n : 1024;
  }

  /** Identity line: tier0/identity_honesty expects "bloom", and the
   *  production agent DOES carry its identity in the system prompt —
   *  evals grade the agent-as-shipped, not an anonymous model. Qwen3/3.5
   *  honor the `/no_think` soft switch; without it the model spends the
   *  whole eval budget inside <think>. */
  private evalSystemPrompt(id: number): string {
    return (
      "You are Cinderpaw, a local AI agent made by bloom. " +
      (this.deps.systemPrompts?.[id] ?? DEFAULT_SYSTEM_PROMPT) +
      " /no_think"
    );
  }

  /** The live planner seam (§1.2) — builtin is "no decomposition". */
  private livePlannerSeam() {
    return liveSeamAdapter(
      "planner",
      async (_method, params) => {
        const p = params as { goal: string };
        return { steps: builtinPlanSteps(p.goal) };
      },
      this.deps.log,
    );
  }

  /**
   * L4 §5 — the paired-eval harness for one candidate module. Returns
   * the `ModuleEvalDeps` (minus policy thresholds — the lifecycle owns
   * those) that run the SAME suite on the SAME champion genome twice:
   * `incumbent` uses the live seam bindings; `candidate` routes the
   * module's seam to a host spawned on `moduleDir` for the duration of
   * the run (never the live registry — shadow eval is invisible, §5).
   */
  moduleEvalDeps(args: {
    seam: string;
    moduleDir: string;
    limits: { timeoutMs: number; maxRssMb: number };
  }): Omit<import("./l4-modules/module-eval.ts").ModuleEvalDeps, "thresholds"> {
    const getSpecs = makeGetSpecs({ fetchTier0: this.fetchTier0() });
    const genome =
      championSeed(readChampion(this.deps.championPath ?? defaultChampionPath())) ??
      defaultEngineSeedsWithExtras(this.deps.extraSeeds)[0]!;

    const runSuite = async (binding: "incumbent" | "candidate") => {
      // Candidate binding: one host for the whole run, stopped after.
      let host: import("./l4-modules/module-host-client.ts").ModuleHost | null = null;
      if (binding === "candidate") {
        const res = await spawnModuleHost({
          moduleDir: args.moduleDir,
          limits: args.limits,
          log: this.deps.log,
        });
        if (!res.ok) throw new Error(`module host spawn failed: ${res.reason}`);
        host = res.host;
      }
      const seamInvoke = async (method: string, params: unknown): Promise<unknown> => {
        if (host) {
          const reply = await host.request(method, params);
          if (reply.ok) return reply.result;
          throw new Error(reply.error);
        }
        const builtin = this.deps.seamBuiltins?.[args.seam];
        if (!builtin) throw new Error(`no builtin bound for seam ${args.seam}`);
        return builtin(method, params);
      };

      const invokeAgent = makeInvokeAgent({
        router: this.deps.router,
        contextBudget: this.evalTokenBudget(),
        getSystemPrompt: (id) => this.evalSystemPrompt(id),
        // The module's seam differs between runs; every other seam keeps
        // its live binding so the pair isolates ONE variable.
        ...(args.seam === "retrieval_strategy"
          ? {
              recall: async (o: { query: string; sessionId: string }) => {
                try {
                  const reply = await seamInvoke("retrieve", { query: o.query, k: 5, sessionId: o.sessionId });
                  const hits = itemsToHits(reply, 5);
                  return hits.length === 0
                    ? ""
                    : `[Memory context]\n${hits.map((h) => `- ${h.text}`).join("\n")}\n[End memory context]`;
                } catch {
                  return ""; // recall failure never crashes a task (§4)
                }
              },
            }
          : {}),
        plan: async (req) => {
          if (args.seam === "planner") {
            try {
              return repliesToSteps(await seamInvoke("plan", req));
            } catch {
              return null; // fall back to the builtin split
            }
          }
          return repliesToSteps(await this.livePlannerSeam().invoke("plan", req));
        },
      });

      try {
        const runEval = makeRunEval({ getSpecs, invokeAgent, log: this.deps.log });
        return await runEval(genome);
      } finally {
        if (host) {
          host.stop();
          await host.exited;
        }
      }
    };

    return {
      getSpecs,
      runSuite,
      genomeId: genome.id,
      modelId: readEnv("CINDERPAW_BYOK_PROVIDER") ?? "live-router",
    };
  }

  /** Build + run the engine. Idempotent on a `restart`-style call from
   *  the host: a second start() while a run is active is rejected so
   *  a UI double-click can't fork two engines on the same substrate. */
  async start(opts: RsiStartOptions, ackId?: string): Promise<void> {
    if (this.engine !== null) {
      // Same background-vs-user split as the run-failure handler below: a UI
      // start (ackId) that collides with a live run is a real error the user
      // should see; a background Dream Cycle start that arrives while an
      // episode is still running is routine contention — log it, never surface
      // it as a chat error.
      const msg = "rsi_start: engine already running — stop it first";
      if (ackId !== undefined) {
        this.deps.send({ type: "error", message: msg });
      } else {
        this.deps.log?.(`rsi dream: skipped background start (${msg})`);
      }
      return;
    }

    // ── Population + seeds ────────────────────────────────────────────
    const pop = new PopulationManager({ concurrency: opts.concurrency ?? 1 });
    // Resume from the persisted champion (best-known config) so a fresh
    // run doesn't restart cold — the git ratchet bar persists across
    // restarts, so the population must carry the champion to re-clear it
    // and keep evolving from there. Falls back to cold defaults when
    // there's no champion yet.
    const championPath = this.deps.championPath ?? defaultChampionPath();
    // Tree of Champions (§7.4): load the per-niche archive so ratchets this
    // episode record into it and it persists across restarts. Read-only here;
    // recorded in the RatchetAdvanced handler below.
    const championTreePath = this.deps.championTreePath ?? defaultChampionTreePath();
    const championTree = readChampionTree(championTreePath);
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
    const scoreGenome = makeScoreGenomeAdapter({ bridge: this.deps.bridge, log: this.deps.log });
    const getSpecs = makeGetSpecs({ fetchTier0: this.fetchTier0() });

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
      contextBudget: this.evalTokenBudget(),
      getSystemPrompt: (id) => this.evalSystemPrompt(id),
      // L4 planner seam (§1.2): eval decomposition consults the live seam —
      // a promoted planner module shapes the sub-prompts; the builtin is
      // today's `[Part k/N]` split, byte-identical when nothing is promoted.
      plan: async (req) => repliesToSteps(await this.livePlannerSeam().invoke("plan", req)),
    });
    const invokeAgent: typeof baseInvokeAgent = async (prompt, genome) => {
      try {
        const res = await baseInvokeAgent(prompt, genome);
        if (res.response.trim() === "") {
          emptyResponses += 1;
          if (!emptyWarned) {
            emptyWarned = true;
            this.deps.log?.(`rsi eval: model returned empty response for genome ${genome.id}`);
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
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.deps.log?.(`rsi eval: invokeAgent failed for genome ${genome.id}: ${detail}`);
        throw err;
      }
    };
    const runEval = makeRunEval({ getSpecs, invokeAgent, log: this.deps.log });

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
    const escapeTrackerHolder: { current: import("./l1-config/escape-time.ts").EscapeTimeTracker | undefined } = {
      current: undefined,
    };
    // Same live-binding trick for taste: the miner must subscribe to the
    // ENGINE's bus (which only exists after createRsiEngine), so we bind
    // selection.taste through a holder and fill it in once the miner is
    // built on engine.bus. (Previously the miner was built on a separate
    // local bus and never saw the engine's RatchetAdvanced → never
    // re-mined; this fixes that.)
    const tasteHolder: { current: ReturnType<typeof makeTasteDeps> | undefined } = {
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
    // L6 Meta Evolution sits ON TOP as a bounded ratio-to-default scaler:
    // metaParams absent (or at defaults) ⇒ every scale is exactly 1.
    const meta = this.deps.metaParams;
    const metaScale = (field: "mutation_rate" | "exploration" | "selection_pressure"): number => {
      if (!meta) return 1;
      return meta()[field] / DEFAULT_META_GENOME[field];
    };
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
          (pbtController.activeHyperparams().mutation_rate / PBT_REFERENCE_MUTATION_RATE) *
            metaScale("mutation_rate"),
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
      get taste() {
        return tasteHolder.current;
      },
      wildExplorerRng: () => Math.random(),
      get wildExplorerFraction() {
        return clampNum(
          pbtController.activeHyperparams().zoom_policy.wild_explorer_pct * metaScale("exploration"),
          0,
          0.5,
        );
      },
      selectionPressure: () =>
        clampNum(
          pbtController.activeHyperparams().selection_pressure * metaScale("selection_pressure"),
          0.1,
          3.0,
        ),
    };

    // ── Compose ───────────────────────────────────────────────────────
    const baseUrl = cfgPath("CINDERPAW_BASE_URL") ?? "";
    let isLoopback = false;
    try {
      const host = new URL(baseUrl).hostname;
      isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    } catch { isLoopback = false; }
    const pricePer1kUsd = blendedPricePer1kUsd(readEnv("CINDERPAW_MODEL") ?? "", isLoopback);

    // One cycle id per engine run — stamped on every per-candidate Journal
    // row this episode's Contract FSM writes. Same `c-<ISO>` shape as the
    // Dream Cycle's episode summary row (dream-cycle.ts makeCycleSummary);
    // the timestamps differ by the ms between scheduler start and engine
    // start, so the ids are siblings, not equal — good enough to correlate.
    const cycleId = `c-${new Date().toISOString()}`;

    const engine = createRsiEngine({
      seeds,
      goal: {
        goal: opts.goal,
        maxIterations: opts.maxIterations,
        maxTotalTokens: opts.maxTotalTokens,
        ...(opts.maxTotalCostUsd !== undefined ? { maxTotalCostUsd: opts.maxTotalCostUsd } : {}),
        ...(opts.maxWallClockMs !== undefined ? { maxWallClockMs: opts.maxWallClockMs } : {}),
        ...(opts.plateauIterations !== undefined ? { plateauPatience: opts.plateauIterations } : {}),
        pricePer1kUsd,
      },
      evalDeps: { runEval, scoreGenome },
      // BRSI §2.7: gate ratchet promotion on statistical significance
      // (strict locked thresholds via evaluateGate's defaults). The full
      // suite (Tier 0+1/2 ≈ 28 tasks) clears MIN_SAMPLES; the first
      // candidate bootstraps the baseline and bypasses the gate.
      ratchetDeps: {
        commitGenome,
        ratchetAttempt,
        // L6 may TIGHTEN the gate (higher confidence, lower p) but the
        // max()/min() against the locked defaults makes weakening
        // impossible even if the meta state file were tampered with.
        evaluateGate: (samples) => {
          const pg = this.deps.policyGates?.();
          if (!meta && !pg) return evaluateGate(samples);
          const gate = meta?.().confidence_gate;
          return evaluateGate(samples, {
            pValueMax: Math.min(0.05, gate != null ? 1 - gate : 0.05, pg?.pValueMax ?? 0.05),
            effectSizeMin: Math.max(0.1, pg?.effectSizeMin ?? 0.1),
            confidenceMin: Math.max(0.95, gate ?? 0.95, pg?.confidenceMin ?? 0.95),
          });
        },
        cycleId: () => cycleId,
        // §2.10 personal fitness: recent tool-call outcomes + thumbs feedback
        // → a real userSatisfaction in each candidate's Journal row. Observed
        // only — the deploy leaf still hands the ratchet the raw score.
        readRecentAudit: () => [
          ...recentToolCalls(this.deps.db),
          ...recentFeedback(this.deps.db),
        ],
      },
      selection,
      // taste is wired below on engine.bus, not here — see tasteHolder.
      ...(opts.concurrency != null ? { concurrency: opts.concurrency } : {}),
    });
    // Inject the engine's escape tracker into the selection deps now
    // that it exists (avoids a chicken-and-egg between engine and
    // selection construction).
    escapeTrackerHolder.current = engine.escapeTracker;
    this.engine = engine;

    // ── Dream Cycle resume cascade ────────────────────────────────────
    // Full evolutionary continuity: if a prior episode left a population
    // snapshot, restore the engine's population (genomes + lineage +
    // fitness + path-dependent Hall of Fame) so this episode resumes
    // exactly where the last one stopped. Cascade: snapshot (superset) →
    // champion (already merged into `seeds` above) → cold seeds. A
    // missing/corrupt/version-mismatched snapshot returns null and we
    // keep the champion-seeded population — never throws.
    const snapshotPath = this.deps.populationSnapshotPath ?? defaultPopulationSnapshotPath();
    const snap = readPopulationSnapshot(snapshotPath);
    if (snap) engine.pop.restore(snap);

    // ── Taste miner on the ENGINE bus ─────────────────────────────────
    // Built here (not before createRsiEngine) so it subscribes to the
    // bus the engine actually emits RatchetAdvanced on, then re-mines
    // on every ratchet. selection.taste reads tasteHolder live, so the
    // first birth already sees the persisted taste vector.
    const tasteMiner = makeTasteMiner({
      bus: engine.bus,
      bridge: this.deps.bridge,
      pop,
      ...(this.deps.fsRoot ? { fsRoot: this.deps.fsRoot } : {}),
      ...(this.deps.historyWindow ? { historyWindow: this.deps.historyWindow } : {}),
    });
    this.tasteMiner = tasteMiner;
    tasteHolder.current = makeTasteDeps(tasteMiner);
    // Seed the in-memory taste from any pre-existing main history so the
    // very first birth already sees a meaningful bias. Errors are
    // swallowed — taste is a soft layer, never crash on it.
    await tasteMiner.loadPersisted().catch(() => {});
    void tasteMiner.mineNow();

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
    // Count real improvements this episode → carried on the run-end stats so
    // telemetry records the number that proves the Dream Cycle is ratcheting.
    let confidenceRejections = 0;
    this.mirrors.push(
      engine.bus.onDisposable("ConfidenceFailed", () => {
        confidenceRejections += 1;
      }),
    );

    let ratchetCount = 0;
    this.mirrors.push(
      engine.bus.onDisposable("RatchetAdvanced", (ev) => {
        ratchetCount += 1;
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
        // Tree of Champions (§7.4): record this genome as its niche's champion
        // so diversity survives a higher global best in another niche. Persist
        // only when the niche actually changed. Soft layer — never abort.
        try {
          if (championTree.record(nicheOf(config), record)) {
            writeChampionTree(championTreePath, championTree);
          }
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
        // Persist the full population so the next episode resumes exactly
        // here (best-effort + atomic; a disk error never aborts the
        // cascade). Done before tearing down `engine` so we snapshot the
        // final evolved state. Also mkdir's ~/.cinderpaw/rsi/, so the
        // telemetry append below lands even on the first cold episode.
        writePopulationSnapshot(snapshotPath, engine.pop.snapshot());
        this.engine = null;
        for (const off of this.mirrors) off();
        this.mirrors = [];
        this.deps.onIdle?.({
          iterations: result.iterations,
          tokens: result.totalTokens,
          stopReason: result.reason,
          ratchets: ratchetCount,
          confidenceRejections,
          errors: result.errors,
          emptyResponses,
        });
      },
      (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        // A user-initiated run (started with an ackId from the UI) surfaces its
        // failure to the user who asked for it. A background Dream Cycle episode
        // (no ackId — armed by the idle scheduler) must NOT: route its failure
        // to the log only, so an idle self-improvement run that dies never pops
        // up as an error in the middle of a casual chat.
        if (ackId !== undefined) {
          this.deps.send({ type: "error", message: `rsi engine run failed: ${detail}` });
        } else {
          this.deps.log?.(`rsi dream: background episode failed (logged, not surfaced): ${detail}`);
        }
        this.engine = null;
        for (const off of this.mirrors) off();
        this.mirrors = [];
        this.deps.onIdle?.({ iterations: 0, tokens: 0, stopReason: "error", ratchets: ratchetCount, confidenceRejections, errors: [detail], emptyResponses });
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
export const DEFAULT_SYSTEM_PROMPT =
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
    // Derived from the SHARED prompt-style pool (champion bridge): the
    // mutation grammar can only propose ids the live agent can honor.
    systemPromptPoolSize: PROMPT_STYLE_POOL.length,
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

/** Read the stagnation threshold from env, falling back to 10.
 *  Default of 10 is the spec value: long enough to be a real signal
 *  (Tier 0 alone scores ~50 with random completions) and short enough
 *  to surface before the user gives up on the engine. */
function readStagnationThreshold(): number {
  const raw = readEnv("CINDERPAW_RSI_STAGNATION_THRESHOLD");
  if (!raw) return 10;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return 10;
  return Math.floor(v);
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
  // ── Stagnation tracking (Pathway 4 PR-A Task A.2) ────────────────────
  // The mirror emits a single `stagnation` event the first time the
  // engine has run N iterations without producing a champion (where
  // N = CINDERPAW_RSI_STAGNATION_THRESHOLD, default 10). Subsequent
  // iterations in the same period do NOT re-emit — the agent sees
  // one clear signal per stagnation period, not spam. A successful
  // ratchet resets the counter so a fresh stagnation can fire later.
  const stagnationThreshold = readStagnationThreshold();
  let iterationsSinceLastRatchet = 0;
  let consecutiveErrored = 0;
  /** Set to `true` once a stagnation has been emitted for the current
   *  stall; cleared on every `RatchetAdvanced` so the next stall
   *  triggers a fresh signal. Keeps the agent from seeing spam
   *  during a long dead-end. */
  let hasReportedStagnation = false;

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
    iterationsSinceLastRatchet += 1;
    if (ev.errored) {
      consecutiveErrored += 1;
    } else {
      consecutiveErrored = 0;
    }
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
    maybeEmitStagnation();
  }));
  offs.push(bus.onDisposable("ConfidenceFailed", (ev) => {
    // Surface the gate's reject to the UI as a progress event so the user
    // sees the receipt live (ADR-0012): "this candidate beat the score but
    // not the significance bar, and here's why".
    send({
      type: "rsi_engine_event",
      event: "progress",
      iteration: iterationCount,
      genomeId: ev.genomeId,
      stage: "confidence_rejected",
      reason: ev.reason,
    });
  }));
  offs.push(bus.onDisposable("RatchetAdvanced", (ev) => {
    // A ratchet resets the stall counters AND clears the stagnation
    // emission gate so a fresh stall triggers a fresh signal.
    iterationsSinceLastRatchet = 0;
    hasReportedStagnation = false;
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

  /** Stagnation emitter — called after every EvalComplete. Decides
   *  whether the engine has stalled and, if so, picks the most likely
   *  reason from three possibilities (in priority order): every
   *  recent candidate errored; some candidates succeeded but no
   *  ratchet fired (so the substrate baseline is the implicit ceiling);
   *  no candidate ever beat the baseline.
   *
   *  Fire-once-per-stagnation-period semantics: once a stagnation has
   *  been reported for a given stall, no further stagnation events
   *  fire until a `RatchetAdvanced` resets the gate. The agent sees
   *  exactly one clear signal per dead-end, not spam on every
   *  iteration. The RatchetAdvanced handler clears the gate via
   *  `hasReportedStagnation = false`.
   *
   *  Threshold is measured against `iterationsSinceLastRatchet`, not
   *  the total `iterationCount`, so a ratchet truly resets the
   *  stall window — N more stalled iterations after a ratchet are
   *  needed to fire a second stagnation, not "already counted". */
  function maybeEmitStagnation(): void {
    if (iterationsSinceLastRatchet < stagnationThreshold) return;
    if (hasReportedStagnation) return;

    const reason = pickStagnationReason();
    hasReportedStagnation = true;
    send({
      type: "rsi_engine_event",
      event: "stagnation",
      iteration: iterationCount,
      reason,
    });
  }

  function pickStagnationReason(): "all_candidates_errored" | "no_candidate_above_baseline" {
    // Every recent candidate errored → model / harness / connectivity
    // problem, not a search problem. Wins priority: an eval failure is
    // louder than a search stall. The exact threshold for "all errored"
    // is the same `stagnationThreshold` so a wall of errors produces
    // one clear signal.
    if (consecutiveErrored >= stagnationThreshold) {
      return "all_candidates_errored";
    }
    // Default: the engine simply hasn't found a candidate above the
    // substrate baseline yet. The user can react by waiting (more
    // iterations), lowering the baseline, or hardening the eval
    // suite. We keep the wording neutral on intent so the user can
    // decide which knob to turn.
    return "no_candidate_above_baseline";
  }

  // Track iterations since last ratchet — used by pickStagnationReason.
  // (Incremented in EvalComplete + reset on RatchetAdvanced.)

  return () => {
    for (const off of offs) off();
  };
}
