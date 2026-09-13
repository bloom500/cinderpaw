/**
 * S3 arms (competence plan §2.6b): the four learners the first campaign
 * compares, on the fixtures in `fixtures.ts`, through the runner in
 * `campaign.ts`.
 *
 *   fixed  the product baseline: tries repairs in catalog order, learns nothing.
 *   fms    the fixed agent plus receipt retrieval: on a new task it first
 *          tries what worked on the most similar past failure.
 *   brsi   M0 choosing what to try next from its own receipts (the
 *          experiment-selector policy, uncertainty x gain), no retrieval.
 *   both   retrieval first, then M0's order for the rest.
 *
 * What "learning" means here, precisely: an arm sees the development
 * partition during its learning phase and may keep receipts of what it tried
 * and whether the verifier passed. On the promotion partition the runner
 * asks it to solve tasks whose TEMPLATE it never saw, one at a time, and
 * counts a task solved when the verifier passes within `maxAttempts`. Cost
 * is one unit per repair attempt: a learner that finds the right repair on
 * the first try is cheaper than one that walks the catalog.
 *
 * No model. Astra's metric (cost per verified task, failures included) is
 * what the ledger reports; H1 is whether `brsi`/`both` beat `fixed` at the
 * same budget on failures they have not met. A positive result here says the
 * selector transfers across templates; it does not say anything about a
 * model in the loop, and the campaign manifest says so.
 */

import type { ArmFn, ArmRun, FixtureTask } from "./campaign.ts";
import { REPAIRS, checkRepo, rngOf, type Fixture, type Repair, type Repo } from "./fixtures.ts";
import { selectExperiment, type Attempt } from "../l3-code/experiment-selector.ts";

/** What the arm remembers about one attempt. Kept in the same shape as an
 *  L3 receipt so M0 can read it unchanged. */
type Receipt = Attempt;

/** Every receipt's `file` is the repair id: M0 selects among repairs the
 *  way it selects among source files, and its strikes/uncertainty apply. */
const asReceipt = (repair: Repair, task: Fixture, ok: boolean, ts: number): Receipt => ({
  file: repair.id,
  rationale: signatureOf(task.repo),
  verdict: ok ? "accept" : "reject",
  reason: ok ? "verified" : "verifier failed",
  ts,
  predicted: { pAccept: 0.5, expectedEffect: 1, expectedCost: 1, failureClass: null, missing: null },
  observed: { accepted: ok, effect: ok ? 1 : null, cost: 1, failureClass: ok ? null : "wrong_proposal" },
});

/** The failure's fingerprint: the checker's problems with the specifics
 *  blanked out, so two repositories with the same kind of failure look the
 *  same and two with different names do not look different. */
export function signatureOf(repo: Repo): string {
  return checkRepo(repo)
    .problems.map((p) => p.replace(/"[^"]*"/g, '"_"').replace(/env [A-Z_]+/g, "env _").replace(/^[^:]+: /, ""))
    .sort()
    .join(" | ");
}

/** Shared learning-phase machinery: try repairs in `order`, remember what
 *  happened, up to `maxAttempts` per task. */
function attemptAll(
  tasks: readonly FixtureTask[],
  order: (task: Fixture, receipts: Receipt[]) => Repair[],
  receipts: Receipt[],
  maxAttempts: number,
  clock: { t: number },
): number {
  let cost = 0;
  for (const t of tasks as Fixture[]) {
    let tries = 0;
    for (const repair of order(t, receipts)) {
      if (tries++ >= maxAttempts) break;
      cost++;
      const ok = t.verify(repair.apply(t.repo));
      receipts.push(asReceipt(repair, t, ok, clock.t++));
      if (ok) break;
    }
  }
  return cost;
}

/** The no-learning order: a shuffle. A learner that has nothing to go on
 *  has no reason to prefer the catalog's order, and giving it one would
 *  hand the comparison to whichever arm the author happened to list its
 *  fixes first for. Seeded, so both arms of a pair shuffle alike. */
function shuffled(rng: () => number): Repair[] {
  const xs = [...REPAIRS];
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
  return xs;
}

/** Retrieval: the repair that worked on the most similar past signature,
 *  first; then the rest in the no-learning order. Similarity is shared
 *  problem lines. */
function retrieved(task: Fixture, receipts: Receipt[]): Repair | null {
  const sig = new Set(signatureOf(task.repo).split(" | "));
  let best: { score: number; id: string } | null = null;
  for (const r of receipts) {
    if (r.verdict !== "accept") continue;
    const shared = r.rationale.split(" | ").filter((p) => sig.has(p)).length;
    if (shared > 0 && (!best || shared > best.score)) best = { score: shared, id: r.file };
  }
  return best ? (REPAIRS.find((r) => r.id === best!.id) ?? null) : null;
}

function retrieveFirst(task: Fixture, receipts: Receipt[], rng: () => number): Repair[] {
  const hit = retrieved(task, receipts);
  const rest = shuffled(rng);
  return hit ? [hit, ...rest.filter((r) => r !== hit)] : rest;
}

/** M0's order: repeatedly ask the selector for the next repair it is least
 *  sure about with the best gain, over the receipts so far, until every
 *  repair has been offered once. */
function m0Order(_task: Fixture, receipts: Receipt[], rng: () => number): Repair[] {
  const remaining = new Map(REPAIRS.map((r) => [r.id, r]));
  const out: Repair[] = [];
  while (remaining.size > 0) {
    const pick = selectExperiment([...remaining.keys()], receipts, rng);
    const id = pick?.target ?? [...remaining.keys()][0]!;
    out.push(remaining.get(id)!);
    remaining.delete(id);
  }
  return out;
}

export interface ArmOptions {
  /** Repair attempts allowed per task before it counts as unsolved. */
  maxAttempts?: number;
}

function makeArm(
  kind: "fixed" | "fms" | "brsi" | "both",
  opts: ArmOptions = {},
): ArmFn {
  const maxAttempts = opts.maxAttempts ?? REPAIRS.length;
  return ({ seed, train }) => {
    const rng = rngOf(seed);
    const receipts: Receipt[] = [];
    const clock = { t: 1 };
    const order = (task: Fixture, rs: Receipt[]): Repair[] => {
      switch (kind) {
        case "fixed":
          return shuffled(rng);
        case "fms":
          return retrieveFirst(task, rs, rng);
        case "brsi":
          return m0Order(task, rs, rng);
        case "both": {
          // Retrieval first only when it has something; otherwise this IS
          // the brsi arm. The pilot caught the version that put a random
          // repair first on a miss and wasted one of the two attempts.
          const hit = retrieved(task, rs);
          const m0 = m0Order(task, rs, rng);
          return hit ? [hit, ...m0.filter((r) => r !== hit)] : m0;
        }
      }
    };
    // Learning phase: the fixed arm learns nothing but still pays to solve
    // its training tasks, so every arm's ledger covers the same work.
    const learnCost = attemptAll(train, order, receipts, maxAttempts, clock);
    const trainReceipts = kind === "fixed" ? [] : receipts;

    // Scoring phase: the runner calls solve() one task at a time. Cost is
    // counted here too and reported through the closure.
    let solveCost = 0;
    const run: ArmRun = {
      cost: { tokens: learnCost, usd: 0 },
      solve: (task) => {
        const t = task as Fixture;
        let tries = 0;
        for (const repair of order(t, trainReceipts)) {
          if (tries++ >= maxAttempts) break;
          solveCost++;
          if (t.verify(repair.apply(t.repo))) return true;
        }
        return false;
      },
    };
    // The runner reads cost once, after learning; solve-phase cost is the
    // same for every arm at equal maxAttempts on unsolved tasks and lower
    // for a smarter arm, so it is exposed for the pilot report.
    Object.defineProperty(run, "solveCost", { get: () => solveCost, enumerable: true });
    return run;
  };
}

export const ARMS: Readonly<Record<"fixed" | "fms" | "brsi" | "both", ArmFn>> = {
  fixed: makeArm("fixed"),
  fms: makeArm("fms"),
  brsi: makeArm("brsi"),
  both: makeArm("both"),
};

export const armWith = makeArm;
