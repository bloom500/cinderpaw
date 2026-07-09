/**
 * Per-tool circuit breaker — P2-#2.
 *
 * If a tool fails N times in a row within a window, the breaker
 * "trips" and short-circuits subsequent calls with a structured error
 * WITHOUT invoking the tool. The agent gets a clean
 * `{ok: false, error: "circuit_open"}` and can either try a different
 * tool, give up, or wait for the breaker to half-open.
 *
 * Why: a misbehaving tool (downstream API in a bad state, runaway
 * subprocess, broken auth) used to drag the agent through repeated
 * long waits. The breaker trades those waits for a fast, deterministic
 * "this tool is currently sick" signal — which the LLM can use to
 * pivot to a different approach.
 *
 * Three states (classic circuit-breaker):
 *   - CLOSED       → calls flow through; track failures
 *   - OPEN         → short-circuit; do not call the tool
 *   - HALF_OPEN   → after `cooldownMs` in OPEN, allow ONE call. If it
 *                    succeeds, transition to CLOSED. If it fails,
 *                    transition back to OPEN and restart the cooldown.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures in the rolling window that trips
   * the breaker. Default 3.
   */
  failureThreshold: number;
  /**
   * Rolling window in milliseconds. Default 60_000 (1 min).
   */
  windowMs: number;
  /**
   * How long to stay OPEN before transitioning to HALF_OPEN to probe
   * whether the tool has recovered. Default 30_000 (30s).
   */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

export interface BreakerCheck {
  /** True if the call is allowed through. */
  allow: boolean;
  /** Current state at check time. Useful for the agent to log. */
  state: BreakerState;
  /** If !allow, why. */
  reason?: string;
}

export class CircuitBreaker {
  readonly #config: CircuitBreakerConfig;
  /** Per-tool breaker state. Key = tool name. */
  readonly #breakers = new Map<string, BreakerState>();
  /**
   * Per-tool rolling failure log. Each entry is a timestamp of a
   * recent failure. Pruned lazily on every check.
   */
  readonly #failures = new Map<string, number[]>();
  /**
   * Per-tool timestamp at which the breaker entered OPEN. Used to
   * schedule the half-open transition.
   */
  readonly #openedAt = new Map<string, number>();
  /**
   * Per-tool flag: while a half-open probe is in flight, don't allow
   * other calls. The probe is the only call allowed.
   */
  readonly #halfOpenInflight = new Set<string>();

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check whether a call to `tool` should be allowed. Returns the
   * decision + current state. Side-effect: may transition CLOSED →
   * OPEN if failures have crossed the threshold, or OPEN → HALF_OPEN
   * if cooldown has elapsed.
   */
  check(tool: string): BreakerCheck {
    const now = Date.now();
    this.#pruneFailures(tool, now);
    const state = this.#breakers.get(tool) ?? "closed";

    if (state === "open") {
      const openedAt = this.#openedAt.get(tool) ?? now;
      if (now - openedAt >= this.#config.cooldownMs) {
        // Cooldown elapsed → allow ONE probe in half-open.
        this.#breakers.set(tool, "half_open");
        this.#halfOpenInflight.add(tool);
        return { allow: true, state: "half_open" };
      }
      return {
        allow: false,
        state: "open",
        reason: `circuit_open: too many recent failures (≥${this.#config.failureThreshold} in ${this.#config.windowMs}ms)`,
      };
    }

    if (state === "half_open") {
      // A probe is already in flight. Block other concurrent calls
      // until the probe resolves.
      if (this.#halfOpenInflight.has(tool)) {
        return {
          allow: false,
          state: "half_open",
          reason: "circuit_half_open: probe in flight",
        };
      }
      this.#halfOpenInflight.add(tool);
      return { allow: true, state: "half_open" };
    }

    // CLOSED — always allow.
    return { allow: true, state: "closed" };
  }

  /** Record a successful call. Resets the breaker. */
  recordSuccess(tool: string): void {
    this.#failures.set(tool, []);
    this.#breakers.set(tool, "closed");
    this.#openedAt.delete(tool);
    this.#halfOpenInflight.delete(tool);
  }

  /** Record a failure. May trip the breaker. */
  recordFailure(tool: string): void {
    const now = Date.now();
    const failures = this.#failures.get(tool) ?? [];
    failures.push(now);
    this.#failures.set(tool, failures);

    // If we were in HALF_OPEN, the probe failed → back to OPEN.
    if (this.#breakers.get(tool) === "half_open") {
      this.#breakers.set(tool, "open");
      this.#openedAt.set(tool, now);
      this.#halfOpenInflight.delete(tool);
      return;
    }

    // CLOSED — check threshold after pruning stale entries.
    this.#pruneFailures(tool, now);
    const recent = this.#failures.get(tool) ?? [];
    if (recent.length >= this.#config.failureThreshold) {
      this.#breakers.set(tool, "open");
      this.#openedAt.set(tool, now);
    }
  }

  /** Read-only state inspection (debugging, observability). */
  stateOf(tool: string): BreakerState {
    return this.#breakers.get(tool) ?? "closed";
  }

  /** Number of recent failures for a tool (within window). */
  failureCount(tool: string): number {
    this.#pruneFailures(tool, Date.now());
    return (this.#failures.get(tool) ?? []).length;
  }

  /**
   * Drop failure entries older than windowMs. Called on every check
   * to keep the failure array bounded without a background timer.
   */
  #pruneFailures(tool: string, now: number): void {
    const failures = this.#failures.get(tool);
    if (!failures) return;
    const cutoff = now - this.#config.windowMs;
    const pruned = failures.filter((ts) => ts >= cutoff);
    if (pruned.length === 0) {
      this.#failures.delete(tool);
    } else if (pruned.length !== failures.length) {
      this.#failures.set(tool, pruned);
    }
  }
}
