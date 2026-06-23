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
import {
  EscapeTimeTracker,
  type EscapeTimeOptions,
} from "./escape-time.ts";
import { EscapeTimeRecorder } from "./escape-time-recorder.ts";
import type { RsiBridge } from "./bridge.ts";
import { TasteMiner, makeTasteDeps } from "./taste-miner.ts";

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
  /** Escape-time tracker tuning (optional; sensible defaults). The
   *  recorder is always wired (so a future SelectionDeps.escapeTracker
   *  is not a dead reference); the tracker's zoom sensitivity drives
   *  how strongly `selection.escapeTracker.zoomFactorFor` shrinks the
   *  mutation grammar in long-escape-time regions. */
  escapeTime?: EscapeTimeOptions;
  /** Optional taste miner — subscribes to RatchetAdvanced and feeds
   *  `selection.taste` automatically. Production wires this in via
   *  `makeTasteMiner({ bridge, pop })`; tests inject a stub. The
   *  `selection.taste` dep is read each time the selection handler
   *  births, so the binding is live across the run. */
  tasteMiner?: TasteMiner;
  /** Starting concurrency; raised live via rsi_set_concurrency. Default 1. */
  concurrency?: number;
}

export interface RsiEngine {
  bus: EventBus;
  pop: PopulationManager;
  gm: GoalMode;
  /** The shared escape-time tracker — exposed so production wiring
   *  can hand the SAME instance to SelectionDeps.escapeTracker if it
   *  wants to share state with the recorder. Default: a fresh tracker
   *  built from `deps.escapeTime ?? {}`. */
  escapeTracker: EscapeTimeTracker;
  /** The taste miner if one was supplied — exposed so the sidecar
   *  can `await engine.tasteMiner.drain()` before quitting, and so
   *  tests can assert post-mine state directly. */
  tasteMiner?: TasteMiner;
  /** Drive the engine until a StopReason. */
  run: () => Promise<GoalResult>;
}

/** Construct and wire the full RSI engine. Does not start it — call run(). */
export function createRsiEngine(deps: RsiEngineDeps): RsiEngine {
  const bus = new EventBus();
  const pop = new PopulationManager({ concurrency: deps.concurrency ?? 1 });
  for (const seed of deps.seeds) pop.add(seed);

  const evalWorker = new EvalWorker(bus, deps.evalDeps);
  const escapeTracker = new EscapeTimeTracker(deps.escapeTime ?? {});

  // If a taste miner was supplied, inject its current vector + weight
  // into the selection handler so the very first birth already sees
  // the persisted taste (no mine wait). The miner keeps the
  // selection.taste binding live via its `getVector` / `getWeight`
  // accessors, so subsequent re-mines flow through automatically.
  if (deps.tasteMiner) {
    deps.selection.taste = makeTasteDeps(deps.tasteMiner);
  }

  // 1. population recorder first (shared fitness visible downstream in the same cascade)
  attachPopulationRecorder(bus, pop);
  // 2. escape-time recorder (same EvalComplete — feeds the tracker from
  //    the freshly-set fitnessScore; wired before ratchet so the
  //    ratchet's RatchetAdvanced chain runs after the escape-time
  //    observation is recorded).
  new EscapeTimeRecorder(bus, pop, escapeTracker);
  // 3. ratchet, 4. selection, 5. recalcitrance, 6. extinction
  new RatchetHandler(bus, deps.ratchetDeps, pop);
  new SelectionMutationHandler(bus, pop, deps.selection);
  new RecalcitranceTracker(bus, deps.recalcitrance ?? {});
  new ExtinctionHandler(bus, pop, deps.extinction ?? {});

  const gm = new GoalMode(bus, pop, evalWorker, deps.goal);
  return {
    bus,
    pop,
    gm,
    escapeTracker,
    ...(deps.tasteMiner ? { tasteMiner: deps.tasteMiner } : {}),
    run: () => gm.run(),
  };
}

/**
 * Helper: build a taste miner bound to a bridge + population. The
 * production wiring (`FeralAgent/src/index.ts`) calls this so the
 * miner is part of the engine surface — `createRsiEngine({...,
 * tasteMiner})` then wires the live binding into `selection.taste`.
 */
export function makeTasteMiner(deps: {
  bus: EventBus;
  bridge: RsiBridge;
  pop: PopulationManager;
  fsRoot?: string;
  historyWindow?: number;
}): TasteMiner {
  return new TasteMiner(deps.bus, {
    bridge: deps.bridge,
    pop: deps.pop,
    ...(deps.fsRoot ? { fsRoot: deps.fsRoot } : {}),
    ...(deps.historyWindow ? { historyWindow: deps.historyWindow } : {}),
  });
}
