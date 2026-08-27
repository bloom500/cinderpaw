/**
 * Passive RSI — the background-engine supervisor.
 *
 * The RSI / Fractal-Search engine is meant to run *passively*, the way
 * the old memory system did: it starts on its own when the sidecar
 * boots with a real model and keeps running across the whole app
 * session, so a non-technical user gets a self-improving agent without
 * ever opening /rsi, picking a goal, or touching a config. The only
 * user-facing surface (later, Faza 4) is the read-only Mandelbrot view.
 *
 * This module is the lifecycle brain, kept pure + injectable:
 *
 *   - `shouldAutostartPassive(env)` — the boot-time gate. Off when
 *     explicitly disabled (the CINDERPAW_RSI_PASSIVE=false kill switch) or
 *     when no real model is configured (a placeholder model returns
 *     empty responses — spinning the engine would just burn cycles
 *     learning from nothing; see the empty-response telemetry).
 *   - `passiveStartOptions(env)` — the standing run config: a fixed
 *     internal goal, an effectively-unbounded iteration/token budget so
 *     the run is continuous, and a low concurrency cap (the user chose
 *     always-on, so compute is bounded by concurrency, not by idle
 *     gating).
 *   - `PassiveSupervisor` — issues the first start and re-issues it
 *     whenever a run ends (plateau, convergence, iteration cap), so the
 *     engine evolves continuously. `shutdown()` breaks the loop on app
 *     teardown so we don't restart into a closing process.
 *
 * The supervisor never drives the engine math — it only decides *when*
 * to (re)start. Scheduling is injected so the restart loop is
 * deterministic in tests.
 */

/** The fixed, internal objective the passive engine optimises toward.
 *  There is no user-typed goal in passive mode — the agent improves its
 *  own general-purpose configuration against the frozen eval suite. */
export const STANDING_GOAL =
  "Continuously improve the agent's general-purpose configuration: maximise answer " +
  "quality and reliability across the eval suite while minimising token cost and latency.";

export interface PassiveDecision {
  enabled: boolean;
  reason: string;
}

/** Placeholder model id set by the host when no real model resolved
 *  from /v1/models (see cinderpaw_agent.rs). Spinning the engine against it
 *  produces empty responses. */
export const PLACEHOLDER_MODEL = "cinderpaw-local";

/** The same stand-in under its pre-rename name. A sidecar can be rebuilt on its
  * own (that is what code-RSI does), so it can find itself running beside a host
  * that still sends the old id — and failing to recognise the placeholder is not
  * cosmetic: it makes the agent announce itself ready with a model that answers
  * nothing. */
export const LEGACY_PLACEHOLDER_MODEL = "feral-local";

/**
 * Is this model id a stand-in rather than something that can answer?
 *
 * Exported because two halves of the process used to disagree about it. RSI
 * read an unset `CINDERPAW_MODEL` and correctly reported "no real model
 * configured"; boot substituted `qwen2.5:7b` — an id nobody has installed —
 * and announced itself ready with it. A fresh install therefore said "ready",
 * named a model, and failed the first message. One rule, one answer.
 */
export function isPlaceholderModel(model: string | undefined): boolean {
  const m = (model ?? "").trim();
  return m === "" || m === PLACEHOLDER_MODEL || m === LEGACY_PLACEHOLDER_MODEL;
}

/** Decide whether the passive engine should autostart from the
 *  sidecar's environment. */
export function shouldAutostartPassive(
  env: Record<string, string | undefined>,
): PassiveDecision {
  if ((env.CINDERPAW_RSI_PASSIVE ?? "").toLowerCase() === "false") {
    return { enabled: false, reason: "disabled via CINDERPAW_RSI_PASSIVE=false" };
  }
  const model = (env.CINDERPAW_MODEL ?? "").trim();
  if (isPlaceholderModel(model)) {
    return {
      enabled: false,
      reason: "no real model configured (placeholder/empty CINDERPAW_MODEL)",
    };
  }
  return { enabled: true, reason: `model=${model}` };
}

export interface PassiveStartOptions {
  goal: string;
  maxIterations: number;
  maxTotalTokens: number;
  /** USD spend cap for the passive engine. 0 = local-only (default). */
  maxTotalCostUsd: number;
  concurrency: number;
}

/** Build the standing run config. Defaults make the run effectively
 *  continuous; env knobs let an operator tune it without code. */
export function passiveStartOptions(
  env: Record<string, string | undefined>,
): PassiveStartOptions {
  const positive = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const nonNegative = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    goal: STANDING_GOAL,
    maxIterations: positive(env.CINDERPAW_RSI_MAX_ITER, 100_000),
    maxTotalTokens: positive(env.CINDERPAW_RSI_MAX_TOKENS, 1_000_000_000),
    maxTotalCostUsd: nonNegative(env.CINDERPAW_RSI_MAX_COST_USD, 0),
    // Compute cap: the user chose always-on, so concurrency is the only
    // throttle. Default 1; clamp any override to a sane 1..4.
    concurrency: Math.max(1, Math.min(4, Math.floor(positive(env.CINDERPAW_RSI_CONCURRENCY, 1)))),
  };
}

export interface PassiveSupervisorDeps {
  /** Issue a passive run. Resolves once the start has been dispatched. */
  start: () => Promise<void>;
  /** Is a run currently active? Guards against double-start. */
  isRunning: () => boolean;
  /** Deferred scheduling (injectable for tests). Default: an unref'd
   *  setTimeout so a pending restart never keeps the process alive. */
  schedule?: (cb: () => void, ms: number) => void;
  /** Delay before re-starting after a run ends (or after a failed
   *  start). Default 5000ms. */
  restartDelayMs?: number;
  /** Optional log sink. */
  log?: (msg: string) => void;
}

export class PassiveSupervisor {
  private shuttingDown = false;
  private readonly schedule: (cb: () => void, ms: number) => void;
  private readonly delay: number;

  constructor(private readonly deps: PassiveSupervisorDeps) {
    this.schedule =
      deps.schedule ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        // Don't let a pending restart pin the event loop open.
        if (typeof t === "object" && t && "unref" in t) {
          (t as { unref: () => void }).unref();
        }
      });
    this.delay = deps.restartDelayMs ?? 5000;
  }

  /** Start the engine if idle. Safe to call repeatedly. */
  async begin(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.deps.isRunning()) return;
    try {
      await this.deps.start();
    } catch (err) {
      this.deps.log?.(`passive: start failed (${String(err)}) — retrying in ${this.delay}ms`);
      this.scheduleRestart();
    }
  }

  /** Called when a run ends; schedules the next one (continuous mode). */
  onRunEnded(): void {
    if (this.shuttingDown) return;
    this.deps.log?.(`passive: run ended — restarting in ${this.delay}ms`);
    this.scheduleRestart();
  }

  /** Break the restart loop (app teardown). */
  shutdown(): void {
    this.shuttingDown = true;
  }

  private scheduleRestart(): void {
    if (this.shuttingDown) return;
    this.schedule(() => {
      void this.begin();
    }, this.delay);
  }
}
