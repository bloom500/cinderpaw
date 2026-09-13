/**
 * S1: the campaign and its paired runner (recursive-learning spec §9,
 * milestone S1). Research-only: nothing here promotes, ratchets or touches
 * the live champion.
 *
 * What it is for. To say "learner B is better than learner A" we need four
 * things the existing engine does not give us, because the engine compares a
 * candidate genome against the champion on the SAME live stream:
 *
 *   1. a frozen manifest, hashed before the first run, so nobody can widen
 *      the seeds or swap the fixtures after seeing the outcome;
 *   2. paired runs — both arms see the same seed and the same training
 *      fixtures, so the difference is the arm and not the draw;
 *   3. a cost ledger per arm, because a win bought with twice the tokens is
 *      not a win (spec §9.3);
 *   4. partition isolation — an arm trains on `development` and is scored by
 *      THIS runner on `promotion`, tasks it never received. `final` and
 *      `transfer` are never handed to an arm at all.
 *
 * The independent unit is a whole run (one seed), not one task answer, so a
 * campaign of five seeds yields five paired samples. That matters: the gate
 * in `confidence.ts` wants MIN_SAMPLES (10) before it will judge anything,
 * and the spec pilot is five. A pilot campaign therefore comes back
 * "insufficient samples" ON PURPOSE — the pilot measures variance and cost,
 * it does not authorise a claim.
 *
 * Spending: `usdCap` is an absolute ceiling the human writes into the
 * manifest. The default is 0, which means deterministic fixtures only
 * (spec §11) — an arm that reports a single cent stops the campaign instead
 * of quietly billing. A stopped campaign keeps the spend it already made.
 */

import {
  evaluateGate,
  type GateDecision,
  type GateThresholds,
  type PairedSample,
} from "./confidence.ts";
import { sha256Canonical } from "./hash-chain.ts";

/** One fixture task. `family` is the grouping used when splitting, so
 *  near-duplicate templates cannot straddle two partitions (spec §9.1). */
export interface FixtureTask {
  id: string;
  family: string;
}

export type Partition = "development" | "promotion" | "final" | "transfer";

/** What a run consumed. Wall time is measured by the runner when the arm
 *  does not report it; tokens and dollars are self-reported, because only
 *  the arm knows what it asked for. */
export interface RunCost {
  tokens: number;
  usd: number;
  wallMs: number;
}

/** An arm after its learning phase: what it spent, and what it can now do.
 *  `solve` is called by the RUNNER on promotion tasks — the arm never sees
 *  them as a list and never writes its own score (spec §10). */
export interface ArmRun {
  cost: { tokens: number; usd: number; wallMs?: number };
  solve(task: FixtureTask): boolean;
  /** Tokens spent INSIDE `solve`, read by the runner after scoring. Astra's
   *  metric counts the cost of finishing the task, not only of learning. */
  solveCost?: () => number;
}

export type ArmFn = (ctx: {
  seed: number;
  train: readonly FixtureTask[];
}) => ArmRun | Promise<ArmRun>;

/** Frozen before the first run and hashed. Two arms exactly: this is a
 *  paired comparison, not a tournament. */
export interface CampaignManifest {
  id: string;
  /** Paired seeds. One seed = one complete run per arm = one sample. */
  seeds: readonly number[];
  /** `[baseline, candidate]`. The sample delta is candidate - baseline. */
  arms: readonly [baseline: string, candidate: string];
  partitions: Readonly<Record<Partition, readonly FixtureTask[]>>;
  /** Absolute USD ceiling for the whole campaign. 0 = free fixtures only. */
  usdCap: number;
  /** Absolute wall-clock ceiling for the whole campaign, milliseconds. */
  wallMsCap: number;
}

export interface CampaignResult {
  /** sha256 of the canonical manifest — the frozen identity of this run. */
  manifestHash: string;
  /** One per seed that BOTH arms completed. */
  samples: PairedSample[];
  /** Totals per arm name, including the spend of a run that later failed. */
  ledger: Record<string, RunCost>;
  /** True when every seed in the manifest produced a paired sample. */
  matched: boolean;
  /** Why the campaign stopped early, if it did. */
  stopped?: string;
  /** The gate verdict on the samples. Advisory here: promotion is not this
   *  module's business. */
  gate: GateDecision;
}

const zeroCost = (): RunCost => ({ tokens: 0, usd: 0, wallMs: 0 });

function addCost(into: RunCost, add: RunCost): void {
  into.tokens += add.tokens;
  into.usd += add.usd;
  into.wallMs += add.wallMs;
}

function totalUsd(ledger: Record<string, RunCost>): number {
  return Object.values(ledger).reduce((s, c) => s + c.usd, 0);
}

function totalWallMs(ledger: Record<string, RunCost>): number {
  return Object.values(ledger).reduce((s, c) => s + c.wallMs, 0);
}

/** Tasks an arm is allowed to receive. Only `development`, ever. */
export function trainingSet(manifest: CampaignManifest): readonly FixtureTask[] {
  return manifest.partitions.development;
}

/** Fraction of promotion tasks the arm solves. The runner scores; the arm
 *  is asked one task at a time and is never told the total. */
function scoreOn(run: ArmRun, tasks: readonly FixtureTask[]): number {
  if (tasks.length === 0) return 0;
  let solved = 0;
  for (const t of tasks) {
    if (run.solve(t)) solved++;
  }
  return solved / tasks.length;
}

/**
 * Run one paired campaign. Both arms get the same seed and the same training
 * fixtures; both are scored by this function on the promotion partition.
 *
 * Stops (keeping the spend already made) on: an arm that throws, a USD total
 * over `usdCap`, or a wall-clock total over `wallMsCap`. A seed whose second
 * arm never finished contributes no sample, and `matched` goes false.
 */
export async function runPairedCampaign(
  manifest: CampaignManifest,
  arms: Readonly<Record<string, ArmFn>>,
  thresholds?: GateThresholds,
): Promise<CampaignResult> {
  const [baselineName, candidateName] = manifest.arms;
  for (const name of manifest.arms) {
    if (!arms[name]) throw new Error(`campaign ${manifest.id}: no arm function for "${name}"`);
  }
  if (manifest.seeds.length === 0) throw new Error(`campaign ${manifest.id}: no seeds`);

  const manifestHash = sha256Canonical(manifest);
  const ledger: Record<string, RunCost> = {
    [baselineName]: zeroCost(),
    [candidateName]: zeroCost(),
  };
  const train = trainingSet(manifest);
  const scoreTasks = manifest.partitions.promotion;
  const samples: PairedSample[] = [];
  let stopped: string | undefined;

  seeds: for (const seed of manifest.seeds) {
    const scores: Record<string, number> = {};
    for (const name of manifest.arms) {
      const started = Date.now();
      let run: ArmRun;
      try {
        run = await arms[name]!({ seed, train });
      } catch (err) {
        stopped = `arm "${name}" threw on seed ${seed}: ${String(err)}`;
        break seeds;
      }
      addCost(ledger[name]!, {
        tokens: run.cost.tokens,
        usd: run.cost.usd,
        wallMs: run.cost.wallMs ?? Date.now() - started,
      });
      if (totalUsd(ledger) > manifest.usdCap) {
        stopped =
          manifest.usdCap === 0
            ? `arm "${name}" spent $${run.cost.usd} on a campaign with no authorised budget`
            : `usd cap $${manifest.usdCap} exhausted`;
        break seeds;
      }
      if (totalWallMs(ledger) > manifest.wallMsCap) {
        stopped = `wall-clock cap ${manifest.wallMsCap}ms exhausted`;
        break seeds;
      }
      scores[name] = scoreOn(run, scoreTasks);
      addCost(ledger[name]!, { tokens: run.solveCost?.() ?? 0, usd: 0, wallMs: 0 });
    }
    samples.push({ baseline: scores[baselineName]!, candidate: scores[candidateName]! });
  }

  return {
    manifestHash,
    samples,
    ledger,
    matched: stopped === undefined && samples.length === manifest.seeds.length,
    stopped,
    gate: evaluateGate(samples, thresholds),
  };
}

/**
 * Null-effect calibration (spec §9.3: "calibrate inference using simulated
 * no-effect runs"). Runs the SAME arm as both sides, `trials` times with
 * disjoint seed blocks, and reports how often the gate said "accept".
 *
 * With an honest gate at p <= 0.05 that rate should sit near 0.05, not near
 * 0.30. It is the only way to find out whether our bootstrap tail behaves
 * like a p-value at OUR sample sizes before anyone quotes one.
 */
export async function calibrateNullEffect(
  manifest: CampaignManifest,
  arm: ArmFn,
  trials: number,
  thresholds?: GateThresholds,
): Promise<{ trials: number; accepted: number; rate: number }> {
  let accepted = 0;
  for (let t = 0; t < trials; t++) {
    const block = manifest.seeds.map((s) => s + t * 1_000_003);
    const result = await runPairedCampaign(
      { ...manifest, id: `${manifest.id}#null${t}`, seeds: block },
      { [manifest.arms[0]]: arm, [manifest.arms[1]]: arm },
      thresholds,
    );
    if (result.gate.accept) accepted++;
  }
  return { trials, accepted, rate: trials === 0 ? 0 : accepted / trials };
}
