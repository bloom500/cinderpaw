/**
 * Evolution Budget — per-cycle, per-phase resource caps (BRSI §2.5).
 *
 * Why this exists separate from `goal-mode.ts`:
 *   `GoalConfig` enforces stop conditions at EPISODE END (maxIterations,
 *   maxTotalTokens, maxTotalCostUsd, maxWallClockMs). The BRSI budget
 *   needs per-PHASE enforcement — a contract stage should refuse to
 *   BEGIN if its estimated cost would push the cycle over a cap.
 *   `GoalConfig` can't answer "would starting the Evaluate phase now
 *   exceed the budget?" because it only sees cumulative totals, and
 *   only at episode boundaries.
 *
 * Six resources, all per-cycle (BRSI §2.5):
 *   - wallClockMin  (User setting — 30 min default)
 *   - cpuPct        (User setting — 50 % peak default)
 *   - ramMb         (User setting — 2 GB peak default)
 *   - tokens        (Token-meter counter — 100 k default)
 *   - energyKwh     (Best-effort, never enforced as a hard cap)
 *   - diskMb        (Engine self-reports — 5 GB cumulative default)
 *
 *   CPU % and RAM MB are PEAK metrics (max across phases in a cycle).
 *   Wall-clock, tokens, energy, and disk are CUMULATIVE (sum across
 *   phases). The distinction matters for `applySpend`.
 *
 * Discipline: pure logic, no IO. The Contract runner rejects null/empty
 * estimates before calling the gate. `CycleBudgetLedger` owns one cycle's
 * committed spend plus concurrent reservations; raw `assertCanSpend` retains
 * its legacy null behavior only for callers outside the Contract.
 *
 * Defaults mirror BRSI §2.5. SandboxBounds should hold the user's
 * overrides so the agent cannot widen its own budget — this module
 * takes the caps as a parameter to keep it pure.
 */

import type { DreamStage } from "./journal.ts";

/** A dream-cycle stage. Re-exported from `journal.ts` so budget
 *  decisions and journal entries stay aligned. */
export type CyclePhase = DreamStage;

/** Per-cycle caps (BRSI §2.5). User-overridable via settings UI;
 *  SandboxBounds should own the live values. */
export interface BudgetCaps {
  wallClockMin: number;
  cpuPct: number;
  ramMb: number;
  tokens: number;
  /** Best-effort, never enforced as a hard cap (RAPL / battery only). */
  energyKwh: number;
  diskMb: number;
}

/** Default caps from BRSI §2.5. Used when the user has not customised. */
export const DEFAULT_BUDGET_CAPS: BudgetCaps = {
  wallClockMin: 30,
  cpuPct: 50,
  ramMb: 2_048, // 2 GB
  tokens: 100_000,
  energyKwh: 0.05,
  diskMb: 5_120, // 5 GB
};

/** Consumption so far this cycle. CPU and RAM are peaks; the rest
 *  are cumulative. Initialise with `zeroSpend()` at the start of a cycle. */
export interface BudgetSpend {
  wallClockMin: number;
  cpuPct: number;
  ramMb: number;
  tokens: number;
  energyKwh: number;
  diskMb: number;
}

/** Estimate of what a phase WOULD consume. Optional fields mean the estimator
 * does not consume that resource. Evidence-only work must say
 * `unmetered:true`; an empty object is rejected by the cycle ledger. */
export interface PhaseEstimate {
  /** Explicit declaration that this stage only classifies existing evidence. */
  unmetered?: boolean;
  wallClockMin?: number;
  cpuPct?: number;
  ramMb?: number;
  tokens?: number;
  energyKwh?: number;
  diskMb?: number;
}

export interface BudgetReservation {
  settle(actual: BudgetSpend): void;
  release(): void;
}

/**
 * One live, concurrency-safe ledger for an entire evolution cycle. Estimates
 * are reserved synchronously before work starts and actual deltas replace the
 * reservation afterward, so parallel candidates cannot each spend the same
 * remaining budget.
 */
export class CycleBudgetLedger {
  readonly #caps: BudgetCaps;
  #spent: BudgetSpend;
  readonly #reservations = new Map<number, BudgetSpend>();
  #nextReservation = 1;

  constructor(caps: BudgetCaps, initialSpend: BudgetSpend = zeroSpend()) {
    this.#caps = { ...caps };
    this.#spent = { ...initialSpend };
  }

  get spent(): BudgetSpend {
    return { ...this.#spent };
  }

  get caps(): BudgetCaps {
    return { ...this.#caps };
  }

  /** Actual cost already incurred before the contract stages (e.g. eval). */
  charge(actual: BudgetSpend): void {
    this.#spent = applySpend(this.#spent, actual);
  }

  projectedSpend(): BudgetSpend {
    let projected = this.#spent;
    for (const reservation of this.#reservations.values()) {
      projected = applySpend(projected, reservation);
    }
    return { ...projected };
  }

  reserve(phase: CyclePhase, estimate: PhaseEstimate): {
    decision: BudgetDecision;
    reservation?: BudgetReservation;
  } {
    if (!meaningfulEstimate(estimate)) {
      return {
        decision: {
          allow: false,
          breaches: [],
          reason: `phase ${phase}: empty budget estimate (fail-closed)`,
        },
      };
    }
    const delta = ALL_RESOURCES.some((resource) => estimate[resource] !== undefined)
      ? estimateToSpend(estimate)
      : zeroSpend();
    const decision = assertCanSpend(this.#caps, this.projectedSpend(), phase, estimate);
    if (!decision.allow) return { decision };

    const id = this.#nextReservation++;
    this.#reservations.set(id, delta);
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      this.#reservations.delete(id);
    };
    return {
      decision,
      reservation: {
        release,
        settle: (actual) => {
          if (!open) return;
          release();
          this.charge(actual);
        },
      },
    };
  }
}

function meaningfulEstimate(estimate: PhaseEstimate): boolean {
  return estimate.unmetered === true || ALL_RESOURCES.some((resource) => estimate[resource] !== undefined);
}

function estimateToSpend(estimate: PhaseEstimate): BudgetSpend {
  const spend = zeroSpend();
  for (const resource of ALL_RESOURCES) spend[resource] = Math.max(0, estimate[resource] ?? 0);
  return spend;
}

/** What the gate decides. */
export interface BudgetDecision {
  allow: boolean;
  /** Resources (if any) that would breach. Empty when allow=true. */
  breaches: BudgetBreach[];
  /** Human-readable reason; safe for `JournalEntry.decided.reason`. */
  reason: string;
}

/** One resource that would breach its cap. */
export interface BudgetBreach {
  resource: keyof BudgetCaps;
  /** The cap value (snapshot at decision time). */
  cap: number;
  /** Spend so far before this phase's estimate. */
  spend: number;
  /** The phase's estimate for this resource. */
  estimate: number;
}

/** All six resource keys, in the order they appear in BRSI §2.5. */
const ALL_RESOURCES: ReadonlyArray<keyof BudgetCaps> = [
  "wallClockMin",
  "cpuPct",
  "ramMb",
  "tokens",
  "energyKwh",
  "diskMb",
];

/** Decide whether a phase may begin given the cycle's caps, what has
 *  been spent so far, and the phase's own cost estimate.
 *
 *  Returns `{allow: true}` when the phase is within budget. The low-level null
 *  branch is retained for compatibility; the Contract rejects null first.
 *
 *  Returns `{allow: false, breaches: [...]}` listing every resource
 *  that would breach. `reason` is fit for the Evolution Journal. */
export function assertCanSpend(
  caps: BudgetCaps,
  spent: BudgetSpend,
  phase: CyclePhase,
  estimate: PhaseEstimate | null,
): BudgetDecision {
  // Fail-open: no estimator at all → allow with a logged caveat.
  if (estimate === null) {
    return {
      allow: true,
      breaches: [],
      reason: `phase ${phase}: no estimator, fail-open (caller must log)`,
    };
  }

  const breaches: BudgetBreach[] = [];
  for (const resource of ALL_RESOURCES) {
    const est = estimate[resource];
    const cap = caps[resource];
    const spendSoFar = spent[resource];
    if (est === undefined && spendSoFar <= cap) continue;
    const estimated = est ?? 0;
    const projected = resource === "cpuPct" || resource === "ramMb"
      ? Math.max(spendSoFar, estimated)
      : spendSoFar + estimated;
    if (projected > cap) {
      breaches.push({ resource, cap, spend: spendSoFar, estimate: estimated });
    }
  }

  if (breaches.length === 0) {
    return {
      allow: true,
      breaches: [],
      reason: `phase ${phase}: within budget`,
    };
  }

  const breachedNames = breaches.map((b) => b.resource).join(", ");
  return {
    allow: false,
    breaches,
    reason: `phase ${phase}: ${breaches.length} breach(es) on ${breachedNames}`,
  };
}

/** Apply an actual spend to the running total. CPU and RAM are peaks
 *  (`Math.max`); the rest are cumulative (sum). The result is a NEW
 *  object — no mutation, matching the rest of the engine. */
export function applySpend(prev: BudgetSpend, delta: BudgetSpend): BudgetSpend {
  return {
    wallClockMin: prev.wallClockMin + delta.wallClockMin,
    cpuPct: Math.max(prev.cpuPct, delta.cpuPct),
    ramMb: Math.max(prev.ramMb, delta.ramMb),
    tokens: prev.tokens + delta.tokens,
    energyKwh: prev.energyKwh + delta.energyKwh,
    diskMb: prev.diskMb + delta.diskMb,
  };
}

/** Initial spend at the start of a cycle. */
export function zeroSpend(): BudgetSpend {
  return {
    wallClockMin: 0,
    cpuPct: 0,
    ramMb: 0,
    tokens: 0,
    energyKwh: 0,
    diskMb: 0,
  };
}

/** Remaining budget per resource at decision time. Convenience for
 *  the UI / journal — not used by `assertCanSpend` itself. */
export function remaining(caps: BudgetCaps, spent: BudgetSpend): BudgetCaps {
  return {
    wallClockMin: caps.wallClockMin - spent.wallClockMin,
    cpuPct: caps.cpuPct - spent.cpuPct,
    ramMb: caps.ramMb - spent.ramMb,
    tokens: caps.tokens - spent.tokens,
    energyKwh: caps.energyKwh - spent.energyKwh,
    diskMb: caps.diskMb - spent.diskMb,
  };
}
