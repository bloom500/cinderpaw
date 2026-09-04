/**
 * metacognitive-auditor.ts — Stagnation watch over the MCTS search loop.
 *
 * Watches the stream of search scores. When the score has NOT improved for
 * `stagnationThreshold` consecutive simulations (default 3 — the Stagnation
 * Rate), the auditor fires triggerAssumptionReset(): it wipes the blocked
 * hypothesis set, mints a fresh strategy id and notifies listeners so the
 * search loop is forced onto a new strategy.
 *
 * Deterministic and dependency-free; the MCTS loop just calls
 * recordScore() after every simulation.
 */

export type ResetReason = "stagnation" | "manual";

export interface AssumptionResetEvent {
  reason: ResetReason;
  /** The non-improving scores that led here (empty for manual resets). */
  stagnantScores: number[];
  /** Hypothesis ids cleared by the reset. */
  clearedHypotheses: string[];
  /** Fresh strategy token to adopt after the reset. */
  newStrategyId: string;
  /** Total simulations recorded when the reset fired. */
  iterationAtReset: number;
}

type ResetListener = (event: AssumptionResetEvent) => void;

export interface MetacognitiveAuditorOptions {
  /** Non-improving simulations tolerated before a reset. Default 3. */
  stagnationThreshold?: number;
  /** Minimum gain that counts as an improvement. Default 0 (strictly greater). */
  minImprovementDelta?: number;
}

const DEFAULT_STRATEGY_PREFIX = "strategy-";

export class MetacognitiveAuditor {
  readonly #threshold: number;
  readonly #delta: number;
  #bestScore: number | null = null;
  #lastScore: number | null = null;
  #streak = 0;
  #stagnantScores: number[] = [];
  #firedForCurrentStreak = false;
  #strategyCounter = 0;
  #iterations = 0;
  readonly #hypotheses = new Set<string>();
  readonly #listeners = new Set<ResetListener>();

  constructor(options: MetacognitiveAuditorOptions = {}) {
    const threshold = options.stagnationThreshold ?? 3;
    const delta = options.minImprovementDelta ?? 0;
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error(
        `MetacognitiveAuditor: stagnationThreshold must be an integer ≥ 1, got ${String(threshold)}`,
      );
    }
    if (!Number.isFinite(delta) || delta < 0) {
      throw new Error(`MetacognitiveAuditor: minImprovementDelta must be finite ≥ 0, got ${String(delta)}`);
    }
    this.#threshold = threshold;
    this.#delta = delta;
  }

  get stagnationThreshold(): number {
    return this.#threshold;
  }

  /** Consecutive non-improving simulations since the last improvement. */
  get stagnationCount(): number {
    return this.#streak;
  }

  /** Best score seen so far; null before the first simulation. */
  get bestScore(): number | null {
    return this.#bestScore;
  }

  get currentStrategyId(): string {
    return `${DEFAULT_STRATEGY_PREFIX}${this.#strategyCounter}`;
  }

  /** Hypotheses still in play (reset empties this). */
  get activeHypotheses(): string[] {
    return [...this.#hypotheses].sort();
  }

  /** Total simulations recorded so far. */
  get simulationCount(): number {
    return this.#iterations;
  }

  addHypothesis(id: string): void {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error("MetacognitiveAuditor.addHypothesis: hypothesis id must be a non-empty string");
    }
    if (this.#hypotheses.has(id)) {
      throw new Error(`MetacognitiveAuditor.addHypothesis: hypothesis "${id}" already registered`);
    }
    this.#hypotheses.add(id);
  }

  /**
   * Feed one simulation score. The first score only establishes the
   * baseline. A score that grows beyond the previous one (+ delta) clears
   * the streak; otherwise the streak grows, and reaching the threshold
   * AUTO-fires exactly one stagnation reset.
   */
  recordScore(score: number): AssumptionResetEvent | null {
    if (!Number.isFinite(score)) {
      throw new Error(`MetacognitiveAuditor.recordScore: score must be a finite number, got ${String(score)}`);
    }
    this.#iterations += 1;
    const previous = this.#lastScore;
    this.#lastScore = score;
    if (this.#bestScore === null || score > this.#bestScore) {
      this.#bestScore = score;
    }

    if (previous === null || score > previous + this.#delta) {
      this.#streak = 0;
      this.#stagnantScores = [];
      this.#firedForCurrentStreak = false;
      return null;
    }

    this.#streak += 1;
    this.#stagnantScores.push(score);
    if (this.#streak >= this.#threshold && !this.#firedForCurrentStreak) {
      return this.triggerAssumptionReset("stagnation");
    }
    return null;
  }

  /**
   * Wipe the blocked hypotheses, mint a new strategy and notify listeners.
   * Safe to call manually at any time; a stagnation-triggered reset fires
   * at most once per non-improving streak.
   */
  triggerAssumptionReset(reason: ResetReason = "manual"): AssumptionResetEvent {
    const event: AssumptionResetEvent = {
      reason,
      stagnantScores: [...this.#stagnantScores],
      clearedHypotheses: this.activeHypotheses,
      newStrategyId: `${DEFAULT_STRATEGY_PREFIX}${this.#strategyCounter + 1}`,
      iterationAtReset: this.#iterations,
    };

    this.#hypotheses.clear();
    this.#strategyCounter += 1;
    this.#streak = 0;
    this.#stagnantScores = [];
    this.#firedForCurrentStreak = true;

    for (const listener of this.#listeners) {
      listener(event);
    }
    return event;
  }

  /** Subscribe to resets; returns the unsubscribe function. */
  onAssumptionReset(listener: ResetListener): () => void {
    if (typeof listener !== "function") {
      throw new Error("MetacognitiveAuditor.onAssumptionReset: listener must be a function");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
