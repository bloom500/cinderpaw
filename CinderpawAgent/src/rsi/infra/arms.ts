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
 *   brsi-c the same selector scored only over receipts from THIS failure's
 *          signature (m0.3c). Measured worse than brsi on unseen templates:
 *          it discards what other failures taught, and ties become a shuffle.
 *   both   retrieval first, then M0's order for the rest.
 *   skilled `both`, plus the skill library (§3.1): after learning, every
 *          condition with a verified step and a held-out check becomes a
 *          procedure; on a task whose condition has one, the procedure is
 *          tried first and the search is skipped. This is the arm that
 *          measures Astra's metric, cost per verified task, with a library.
 *   fms-u  `fms` with utility-scored retrieval (§3.3): among receipts that
 *          look alike, prefer the one that HELPED when it was retrieved
 *          before. On clean memory it is `fms` exactly; it earns its keep
 *          when memory holds receipts that look right and are not, which
 *          `claimedAcceptRate` plants (an accept recorded without the
 *          verifier: the "[claimed, not verified]" row of §2.2).
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
import { SkillLibrary, induceFromReceipts } from "../../memory/fractal/skill-library.ts";
import { UtilityLedger, utilityScore } from "../../memory/fractal/utility.ts";

/** What the arm remembers about one attempt. Kept in the same shape as an
 *  L3 receipt so M0 can read it unchanged. */
type Receipt = Attempt;

/** Every receipt's `file` is the repair id: M0 selects among repairs the
 *  way it selects among source files, and its strikes/uncertainty apply. */
const asReceipt = (repair: Repair, task: Fixture, ok: boolean, ts: number, claimed = false): Receipt => ({
  file: repair.id,
  rationale: signatureOf(task.repo),
  condition: signatureOf(task.repo),
  verdict: ok || claimed ? "accept" : "reject",
  reason: ok ? "verified" : claimed ? "claimed, not verified" : "verifier failed",
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
  order: (task: Fixture, receipts: Receipt[], turnId: string) => Repair[],
  receipts: Receipt[],
  maxAttempts: number,
  clock: { t: number },
  closed: (turnId: string, solved: boolean) => void = () => {},
  claim: () => boolean = () => false,
): number {
  let cost = 0;
  for (const t of tasks as Fixture[]) {
    let tries = 0;
    let solved = false;
    const turnId = `task:${t.id}`;
    for (const repair of order(t, receipts, turnId)) {
      if (tries++ >= maxAttempts) break;
      cost++;
      const ok = t.verify(repair.apply(t.repo));
      // A claimed accept is a false memory: the agent keeps searching (the
      // verifier said no) but the receipt says yes, and retrieval will
      // later find it as readily as a true one.
      receipts.push(asReceipt(repair, t, ok, clock.t++, !ok && claim()));
      if (ok) { solved = true; break; }
    }
    closed(turnId, solved);
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
 *  problem lines. With a ledger and a weight, the score is similarity
 *  times utility^weight (§3.3): a receipt's leaf id is its index in the
 *  append-only list, and a leaf that was retrieved before and did not help
 *  loses to one that did. Ties keep the earliest, as before. */
function retrieved(
  task: Fixture,
  receipts: Receipt[],
  ledger?: UtilityLedger,
  weight = 0,
): { repair: Repair; leafId: number } | null {
  const sig = new Set(signatureOf(task.repo).split(" | "));
  let best: { score: number; id: string; leafId: number } | null = null;
  receipts.forEach((r, leafId) => {
    if (r.verdict !== "accept") return;
    const shared = r.rationale.split(" | ").filter((p) => sig.has(p)).length;
    if (shared === 0) return;
    const score = ledger ? utilityScore(shared, ledger.utility(leafId), weight) : shared;
    if (!best || score > best.score) best = { score, id: r.file, leafId };
  });
  if (!best) return null;
  const chosen = best as { score: number; id: string; leafId: number };
  const repair = REPAIRS.find((r) => r.id === chosen.id);
  return repair ? { repair, leafId: chosen.leafId } : null;
}

function retrieveFirst(
  task: Fixture,
  receipts: Receipt[],
  rng: () => number,
  turnId?: string,
  ledger?: UtilityLedger,
  weight = 0,
): Repair[] {
  const hit = retrieved(task, receipts, ledger, weight);
  if (hit && turnId) ledger?.shown(turnId, [hit.leafId]);
  const rest = shuffled(rng);
  return hit ? [hit.repair, ...rest.filter((r) => r !== hit.repair)] : rest;
}

/** M0's order: repeatedly ask the selector for the next repair it is least
 *  sure about with the best gain, over the receipts so far, until every
 *  repair has been offered once. */
function m0Order(task: Fixture, receipts: Receipt[], rng: () => number, conditioned = false): Repair[] {
  const remaining = new Map(REPAIRS.map((r) => [r.id, r]));
  const out: Repair[] = [];
  // Conditioned: the selector is scored only over receipts from THIS
  // failure's signature. Unconditioned (the live m0.2): every receipt counts.
  const condition = conditioned ? signatureOf(task.repo) : undefined;
  while (remaining.size > 0) {
    const pick = selectExperiment([...remaining.keys()], receipts, rng, condition);
    const id = pick?.target ?? [...remaining.keys()][0]!;
    out.push(remaining.get(id)!);
    remaining.delete(id);
  }
  return out;
}

export interface ArmOptions {
  /** Repair attempts allowed per task before it counts as unsolved. */
  maxAttempts?: number;
  /** Probability that a FAILED learning-phase attempt is still recorded as
   *  an accept (a claim the verifier never backed). 0 = clean memory. Uses
   *  its own seeded stream so the shuffles of a paired arm do not move. */
  claimedAcceptRate?: number;
  /** The §3.3 knob for the `fms-u` arm. 0 makes it `fms` byte for byte. */
  utilityWeight?: number;
}

export type ArmKind = "fixed" | "fms" | "fms-u" | "brsi" | "brsi-c" | "both" | "skilled";

function makeArm(kind: ArmKind, opts: ArmOptions = {}): ArmFn {
  const maxAttempts = opts.maxAttempts ?? REPAIRS.length;
  const claimRate = opts.claimedAcceptRate ?? 0;
  const weight = opts.utilityWeight ?? 1;
  return ({ seed, train }) => {
    const rng = rngOf(seed);
    const claimRng = rngOf(seed ^ 0x5eed);
    const receipts: Receipt[] = [];
    const clock = { t: 1 };
    const ledger = kind === "fms-u" ? new UtilityLedger() : undefined;
    const order = (task: Fixture, rs: Receipt[], turnId?: string): Repair[] => {
      switch (kind) {
        case "fixed":
          return shuffled(rng);
        case "fms":
          return retrieveFirst(task, rs, rng);
        case "fms-u":
          return retrieveFirst(task, rs, rng, turnId, ledger, weight);
        case "brsi":
          return m0Order(task, rs, rng);
        case "brsi-c":
          return m0Order(task, rs, rng, true);
        case "both":
        case "skilled": {
          // Retrieval first only when it has something; otherwise this IS
          // the brsi arm. The pilot caught the version that put a random
          // repair first on a miss and wasted one of the two attempts.
          const hit = retrieved(task, rs)?.repair;
          const m0 = m0Order(task, rs, rng);
          return hit ? [hit, ...m0.filter((r) => r !== hit)] : m0;
        }
      }
    };
    // Learning phase: the fixed arm learns nothing but still pays to solve
    // its training tasks, so every arm's ledger covers the same work.
    // The ledger learns only in this phase, like the receipts: on a task
    // that closes, every leaf shown for it was present, and helped iff the
    // verifier passed within the budget.
    const learnCost = attemptAll(
      train, order, receipts, maxAttempts, clock,
      (turnId, solved) => { ledger?.closed([turnId], solved); },
      claimRate > 0 ? () => claimRng() < claimRate : undefined,
    );
    const trainReceipts = kind === "fixed" ? [] : receipts;
    // The skilled arm consolidates what it learned into procedures, once,
    // after the learning phase. Induction is free here (no model); its cost
    // in the live loop would be one proposer call per condition.
    const library = kind === "skilled" ? new SkillLibrary() : null;
    if (library) induceFromReceipts(receipts, library);

    // Scoring phase: the runner calls solve() one task at a time. Cost is
    // counted here too and reported through the closure.
    let solveCost = 0;
    const run: ArmRun = {
      cost: { tokens: learnCost, usd: 0 },
      solve: (task) => {
        const t = task as Fixture;
        let tries = 0;
        // A known condition with a procedure: try it first, one attempt.
        const proc = library?.lookup(signatureOf(t.repo));
        const first = proc ? REPAIRS.find((r) => r.id === proc.steps[0]?.tool) : undefined;
        const plan = first ? [first, ...order(t, trainReceipts).filter((r) => r !== first)] : order(t, trainReceipts);
        for (const repair of plan) {
          if (tries++ >= maxAttempts) break;
          solveCost++;
          if (t.verify(repair.apply(t.repo))) return true;
        }
        return false;
      },
    };
    run.solveCost = () => solveCost;
    return run;
  };
}

export const ARMS: Readonly<Record<ArmKind, ArmFn>> = {
  fixed: makeArm("fixed"),
  fms: makeArm("fms"),
  "fms-u": makeArm("fms-u"),
  brsi: makeArm("brsi"),
  "brsi-c": makeArm("brsi-c"),
  both: makeArm("both"),
  skilled: makeArm("skilled"),
};

export const armWith = makeArm;
