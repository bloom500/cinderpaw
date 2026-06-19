/**
 * Runtime wiring — the RSI engine composition root.
 *
 * Wires the full Async RSI Engine onto a single bus and returns a handle
 * that drives it to a StopReason. This is the production counterpart of
 * the hand-wiring the goal-mode test does: it constructs the population,
 * the EvalWorker, every handler, and GoalMode in the one order the
 * cascade requires.
 *
 * Handler order matters (events fan out in registration order within a
 * pump):
 *   1. population recorder — MUST be first so a freshly-evaluated
 *      genome's shared fitness is visible to everything downstream;
 *   2. ratchet — commits/advances main on each EvalComplete;
 *   3. selection/mutation — births a replacement when a slot frees;
 *   4. recalcitrance — watches RatchetAdvanced for the zoom-out signal;
 *   5. extinction — watches EvalComplete for monoculture/plateau, culls,
 *      and emits GenomeDied which (4) selection turns back into births.
 * GoalMode is constructed last; it owns the work queue + budget.
 *
 * Everything external (eval runner, scorer, git ops, RNG, ids) is
 * injected, so the engine runs headless in tests and binds to the real
 * bridge adapters + agent loop in the sidecar.
 */

import { EventBus } from "./event-bus.ts";
import {
  PopulationManager,
  type GenomeSpec,
} from "./population-manager.ts";
import { EvalWorker, type EvalWorkerDeps } from "./eval-worker.ts";
import { RatchetHandler, type RatchetDeps } from "./ratchet-handler.ts";
import {
  SelectionMutationHandler,
  type SelectionDeps,
} from "./selection-handler.ts";
import {
  RecalcitranceTracker,
  type RecalcitranceOptions,
} from "./recalcitrance.ts";
import { ExtinctionHandler, type ExtinctionDeps } from "./extinction-handler.ts";
import {
  GoalMode,
  attachPopulationRecorder,
  type GoalConfig,
  type GoalResult,
} from "./goal-mode.ts";

export interface RsiEngineDeps {
  /** Initial population (the bootstrap strategy seeds). */
  seeds: GenomeSpec[];
  /** Stop conditions + objective. */
  goal: GoalConfig;
  /** Eval runner + scorer (real: makeRunEval + makeScoreGenomeAdapter). */
  evalDeps: EvalWorkerDeps;
  /** Git ops (real: makeCommitGenomeAdapter + makeRatchetAttemptAdapter). */
  ratchetDeps: RatchetDeps;
  /** Parent selection + mutation grammar + id source. */
  selection: SelectionDeps;
  /** Recalcitrance tuning (optional; sensible defaults). */
  recalcitrance?: RecalcitranceOptions;
  /** Extinction tuning (optional; sensible defaults). */
  extinction?: ExtinctionDeps;
  /** Starting concurrency; raised live via rsi_set_concurrency. Default 1. */
  concurrency?: number;
}

export interface RsiEngine {
  bus: EventBus;
  pop: PopulationManager;
  gm: GoalMode;
  /** Drive the engine until a StopReason. */
  run: () => Promise<GoalResult>;
}

/** Construct and wire the full RSI engine. Does not start it — call run(). */
export function createRsiEngine(deps: RsiEngineDeps): RsiEngine {
  const bus = new EventBus();
  const pop = new PopulationManager({ concurrency: deps.concurrency ?? 1 });
  for (const seed of deps.seeds) pop.add(seed);

  const evalWorker = new EvalWorker(bus, deps.evalDeps);

  // 1. recorder first (shared fitness visible downstream in the same cascade)
  attachPopulationRecorder(bus, pop);
  // 2. ratchet, 3. selection, 4. recalcitrance, 5. extinction
  new RatchetHandler(bus, deps.ratchetDeps);
  new SelectionMutationHandler(bus, pop, deps.selection);
  new RecalcitranceTracker(bus, deps.recalcitrance ?? {});
  new ExtinctionHandler(bus, pop, deps.extinction ?? {});

  const gm = new GoalMode(bus, pop, evalWorker, deps.goal);
  return { bus, pop, gm, run: () => gm.run() };
}
