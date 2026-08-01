/**
 * Inference router — the single controlled point for every LLM call.
 *
 * Non-negotiable constraint: no LLM call may bypass this router. It is the
 * sanctioned exception to the egress proxy (local inference talks to Ollama on
 * localhost, which the proxy would otherwise block). Responsibilities:
 *   - enforce per-conversation and per-day token budgets
 *   - track and persist token usage
 *   - fall back to a secondary model when the primary target fails
 *   - audit every completion (and every budget block)
 *   - support hot-swap of the active model without restarting (reconfigure)
 *
 * Protocol-specific logic lives in inference-providers.ts. The router is a
 * clean plugin manager: it holds one InferenceProvider per protocol family and
 * delegates #callTarget to the appropriate one. Adding a new provider requires
 * no changes here — implement InferenceProvider, export it from
 * inference-providers.ts, and add it to the #providers map below.
 */

import type { Database } from "bun:sqlite";
import { countTokens } from "../core/tokenizer.ts";
import type {
  AuditLogger,
  BudgetExhaustedReason,
  BudgetWarning,
  InferenceConfig,
  InferenceRequest,
  InferenceResponse,
  ModelTarget,
  TokenBudgetConfig,
} from "../types.ts";
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  postJson,
  type InferenceProvider,
} from "./inference-providers.ts";
import {
  MAX_RETRY_AFTER_MS,
  RequestRateLimiter,
  abortableSleep,
  backoffMs,
  parseRetryAfter,
  type ThrottleWait,
} from "./rate-limiter.ts";

/**
 * How many times a 429 is retried before it surfaces as a failure.
 *
 * The gate makes a 429 unlikely; this catches the cases it cannot see — a key
 * used from outside Feral, or a provider whose window does not line up with
 * ours. Three attempts covers a transient collision without turning a genuine
 * "you are out of quota" into a minutes-long silent stall.
 */
const MAX_RATE_LIMIT_RETRIES = 3;

export class BudgetExhaustedError extends Error {
  readonly reason: BudgetExhaustedReason;
  constructor(reason: BudgetExhaustedReason, message: string) {
    super(message);
    this.name = "BudgetExhaustedError";
    this.reason = reason;
  }
}

export class InferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceError";
  }
}

/**
 * Background session ids — inference work no human is waiting on. These
 * yield to interactive sessions at the router's priority gate. Everything
 * not listed here is treated as interactive (chat, api, plain, connector
 * sessions, recall-tool, …) so a new background caller must opt in
 * explicitly rather than accidentally competing with the user.
 */
const BACKGROUND_SESSION_PREFIXES = [
  "rsi-eval",
  "code-rsi",
  "inner-thoughts",
  "semantic",
  "migration",
  "dream",
  "meta",
] as const;

export function isBackgroundSession(sessionId: string): boolean {
  return BACKGROUND_SESSION_PREFIXES.some((p) => sessionId.startsWith(p));
}

/**
 * True when an error means "this target has no model resident", not "your
 * request was bad". The bundled local engine answers `503 {"type":
 * "model_not_ready"}` (see `no_model_response` in crates/feral-core/src/api.rs)
 * whenever the desktop has unloaded the GGUF — which it does deliberately on
 * every switch to a cloud route. A fallback that says this was never eligible
 * for the turn, so its message must not be pinned onto the primary's failure.
 */
export function isNoModelReady(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const msg = String((err as { message?: string } | null)?.message ?? err);
  return (
    /model_not_ready|no model (selected|loaded)/i.test(msg) ||
    (status === 503 && /\bmodel\b/i.test(msg))
  );
}

/** Re-throwable form of an unknown error, preserving InferenceError instances. */
function asInferenceError(err: unknown): Error {
  return err instanceof Error ? err : new InferenceError(String(err));
}

export class InferenceRouter {
  // Mutable so reconfigure() can hot-swap the active model at runtime.
  #primary: ModelTarget;
  #fallback: ModelTarget | undefined;
  #trusted: Set<string>;
  /**
   * The operator's EXPLICIT allowlist (`FERAL_TRUSTED_BASE_URLS`), kept
   * separately from `#trusted` because `#trusted` is derived and gets rebuilt
   * on every hot-swap. Before F-03 that rebuild seeded itself from the very
   * target it was about to validate, so a `set_model` silently discarded the
   * operator's list and then "validated" the new URL against itself — the
   * check could not fail. Undefined when no list was configured, which keeps
   * the derive-from-targets default intact.
   */
  readonly #configuredTrusted: string[] | undefined;
  /** Active local-model context window (tokens), forwarded by Rust on set_model.
   *  Drives the agent's transcript-compaction budget so it matches the KV cache
   *  the engine actually allocated. 0 = unknown (fall back to env/default). */
  #contextWindow = 0;

  // Provider instances — one per protocol family. Stateless, so shared.
  readonly #providers: Record<string, InferenceProvider> = {
    ollama: new OllamaProvider(),
    anthropic: new AnthropicProvider(),
    openai: new OpenAICompatibleProvider(),
  };

  readonly #tokenBudget: TokenBudgetConfig;
  readonly #audit: AuditLogger;
  readonly #db: Database;
  /**
   * In-memory per-conversation token totals (reset when process restarts).
   *
   * N2 fix: this map used to grow without bound. The extractor creates
   * `${sessionId}__facts` and `${sessionId}__obs` synthetic sessionIds on
   * every turn, and cron creates `cron:${id}` for every scheduled job —
   * none of them were ever evicted, so the map accumulated one entry per
   * turn for the entire sidecar lifetime. Now bounded by
   * MAX_TRACKED_CONVERSATIONS (LRU, oldest entry evicted on overflow).
   * The synthetic extractor / cron keys are also explicitly evicted by
   * `evictSession()` after their one-shot inference call returns.
   */
  readonly #conversationTokens = new Map<string, number>();
  /**
   * Per-session AbortController map. `complete()` installs the controller's
   * signal into its fetch requests; `abort(sessionId)` aborts it, which
   * surfaces as a DOMException("AbortError") from the in-flight fetch.
   * The agent loop catches AbortError and emits `done` with `stopped:true`
   * (P0-#3 — paired with the tool-side abort wired in ToolRegistry).
   */
  readonly #sessionControllers = new Map<string, AbortController>();
  /**
   * Optional callback fired ONCE per session+kind when usage crosses the
   * soft warning threshold (default 80% of the budget — see
   * SOFT_WARN_RATIO). Used by the agent loop to emit a `budget_warning`
   * event so the UI can show "approaching limit" BEFORE the hard stop.
   * Set after construction via `setBudgetWarningListener`. P1-#1.
   */
  #budgetWarningListener: ((info: BudgetWarning) => void) | null = null;
  /**
   * Tracks which (sessionId, kind) tuples have already fired the warning
   * so the listener is called at most once per session per dimension.
   * Reset when the conversation counter resets (process restart).
   *
   * N2 fix: stored as a Map<key, true> (not a Set) so we can apply the
   * same LRU cap as `#conversationTokens` — overflow evicts the oldest
   * entries, which is safe because the worst-case side effect of
   * forgetting an entry is "the warning fires a second time for an
   * ancient session", and that's bounded to ≤ MAX_TRACKED_WARNINGS
   * duplicate fires across the sidecar lifetime.
   */
  readonly #budgetWarningFired = new Map<string, true>();
  /**
   * Keeps requests to rate-limited endpoints (NVIDIA NIM's free tier: 40 RPM)
   * inside the cap. An agent turn spends one request per tool round-trip, so
   * the first genuinely multi-step task used to walk straight into 429s.
   * Endpoints with no published cap — the local engine above all — pass
   * through untouched.
   */
  readonly #rateLimiter: RequestRateLimiter;
  /**
   * Fired when a request has to wait for a rate-limit slot, so the agent loop
   * can tell the user. A silent multi-second pause looks exactly like a hang.
   */
  #throttleListener: ((info: ThrottleWait & { sessionId: string }) => void) | null = null;

  constructor(config: InferenceConfig, audit: AuditLogger, db: Database) {
    this.#primary = config.primary;
    this.#fallback = config.fallback;
    this.#tokenBudget = config.tokenBudget;
    this.#audit = audit;
    this.#db = db;
    this.#rateLimiter = new RequestRateLimiter(config.rateLimitRpm ?? 0);
    this.#configuredTrusted = config.trustedBaseUrls;
    this.#trusted = this.#buildTrusted(
      config.primary,
      config.fallback,
      config.trustedBaseUrls,
    );

    // Fail fast at construction if any configured target is not trusted.
    for (const target of [config.primary, config.fallback]) {
      if (target && !this.#trusted.has(normalizeBaseUrl(target.baseUrl))) {
        throw new InferenceError(
          `inference target "${target.baseUrl}" is not in trustedBaseUrls`,
        );
      }
    }
  }

  /**
   * Hot-swap the active model without restarting the sidecar.
   *
   * Called by the transport layer when Rust forwards a `set_model` message.
   * Rebuilds the trusted URL set to match the new targets, so any previously
   * trusted endpoint that is no longer configured is no longer reachable.
   * In-flight completions already in progress are not affected (they snapshot
   * primary/fallback at call time).
   *
   * F-03: when the operator configured an explicit allowlist, it survives the
   * swap and the new target must be a member — `set_model` picks FROM the list,
   * it does not get to replace it. `dispatch.ts` passes no `trustedUrls`, so
   * without the fallback to `#configuredTrusted` the allowlist stopped applying
   * at the first model switch. No list configured → unchanged: the trusted set
   * is derived from the new targets and any endpoint is reachable, gated only
   * by the host channel (loopback + bearer token).
   */
  reconfigure(
    primary: ModelTarget,
    fallback?: ModelTarget,
    trustedUrls?: string[],
  ): void {
    const newTrusted = this.#buildTrusted(
      primary,
      fallback,
      trustedUrls ?? this.#configuredTrusted,
    );

    for (const target of [primary, fallback]) {
      if (target && !newTrusted.has(normalizeBaseUrl(target.baseUrl))) {
        throw new InferenceError(
          `inference target "${target.baseUrl}" is not in trustedBaseUrls`,
        );
      }
    }

    this.#primary = primary;
    this.#fallback = fallback;
    this.#trusted = newTrusted;
  }

  /** Active local-model context window in tokens, or 0 when unknown. Set by the
   *  transport on `set_model`; read by the agent loop to size its compaction
   *  budget to the model's real window instead of a fixed cap. */
  get contextWindow(): number {
    return this.#contextWindow;
  }
  setContextWindow(tokens: number | undefined): void {
    this.#contextWindow = Number.isFinite(tokens) && (tokens ?? 0) > 0 ? Math.floor(tokens!) : 0;
  }

  /** Display-safe view of the currently active model (no API keys). */
  get currentModel(): { provider: string; model: string; baseUrl: string } {
    return {
      provider: this.#primary.provider,
      model: this.#primary.model,
      baseUrl: this.#primary.baseUrl,
    };
  }

  /**
   * Display-safe view of the configured fallback target (no API keys), or
   * null if none is configured. Surfaced through `self_providers` so the
   * agent can reason about routing + Brain Stack without leaking the key.
   */
  get currentFallback(): { provider: string; model: string; baseUrl: string } | null {
    if (!this.#fallback) return null;
    return {
      provider: this.#fallback.provider,
      model: this.#fallback.model,
      baseUrl: this.#fallback.baseUrl,
    };
  }

  /** True when the active primary target is a local loopback address. */
  get isPrimaryLocal(): boolean {
    return this.#isLocalHost(this.#primary.baseUrl);
  }

  /**
   * True when at least one configured target (primary OR fallback) is on
   * a non-loopback host — i.e. cloud is reachable from this router.
   *
   * Brain Stack (slice S5) uses this to compute the `offline` hint passed
   * to `brain.route()`: offline = (primary is local) AND (cloud not
   * reachable). When false, Brain Stack won't force-route to local-only
   * models — even if primary is local, a cloud fallback means cloud
   * models are reachable.
   */
  get cloudReachable(): boolean {
    if (!this.#isLocalHost(this.#primary.baseUrl)) return true;
    if (this.#fallback === undefined) return false;
    return !this.#isLocalHost(this.#fallback.baseUrl);
  }

  #isLocalHost(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
    } catch {
      return false;
    }
  }

  /**
   * Abort an in-flight completion for the given session. The next `complete()`
   * call's underlying fetch receives an AbortError. Safe to call when no
   * completion is in flight (no-op). Used by `AgentLoop.stop()` to honor
   * user-initiated stops (P0-#3).
   */
  abort(sessionId: string): void {
    const ac = this.#sessionControllers.get(sessionId);
    if (ac && !ac.signal.aborted) {
      ac.abort("user stop");
    }
  }

  /** Current per-conversation token total for a session. */
  conversationTokens(sessionId: string): number {
    return this.#conversationTokens.get(sessionId) ?? 0;
  }

  /**
   * N2 fix: evict a session's per-conversation state from the router.
   *
   * Callers that create synthetic sessionIds (the memory extractor's
   * `${sid}__facts` and `${sid}__obs` passes, cron's `cron:${id}`) must
   * invoke this after their one-shot inference call so the maps do not
   * accumulate one entry per turn for the life of the sidecar. Also
   * drops the in-memory entry for the natural sessionId so a long-idle
   * session can be reclaimed.
   */
  evictSession(sessionId: string): void {
    this.#conversationTokens.delete(sessionId);
    // The warning-fired map is keyed by `${sessionId}:conversation` and
    // `${sessionId}:day`. Remove both — they're cheap to recompute if
    // the session ever re-enters the warning band.
    this.#budgetWarningFired.delete(`${sessionId}:conversation`);
    this.#budgetWarningFired.delete(`${sessionId}:day`);
  }

  /** Tokens consumed today (UTC) across all sessions. */
  dayTokens(): number {
    const row = this.#db
      .query<{ tokens: number }, [string]>(
        "SELECT tokens FROM token_usage WHERE day = ?",
      )
      .get(today());
    return row?.tokens ?? 0;
  }

  /**
   * Run one completion through the router. Thin wrapper that delegates to
   * `completeWith(this.#primary, this.#fallback, req)` — the default path
   * for callers that haven't picked a model yet. Brain Stack (slice S5)
   * calls `completeWith` directly with the targets it routed to.
   *
   * Throws BudgetExhaustedError when a budget is hit (the agent loop
   * decides whether to stop or compress) and InferenceError when both
   * primary and fallback fail.
   */
  async complete(req: InferenceRequest): Promise<InferenceResponse> {
    return this.completeWith(this.#primary, this.#fallback, req);
  }

  /**
   * Like `complete()`, but routes to the given targets instead of the
   * router's configured `#primary` / `#fallback`. This is the seam the
   * Brain Stack uses (slice S5): it picks a `{primary, fallback}` per
   * turn via `route()` and hands them here.
   *
   * Reuses the SAME budget / audit / abort / circuit machinery as
   * `complete()` — one code path, two entry points. The `trustedBaseUrls`
   * enforcement is the same as the constructor: any passed target
   * whose base URL is not in `this.#trusted` is refused with an
   * `InferenceError` (and a `blocked` audit row) before any fetch /
   * budget / abort plumbing runs. `#callTarget` re-checks at call
   * time as defense-in-depth — the constructor-style check here just
   * fails fast with a cleaner stack.
   *
   * Caller's responsibility: ensure the passed targets are in the
   * router's trusted URL set. For Brain Stack this means every model
   * in the registry must be in `trustedBaseUrls` at router-construction
   * time (S5 will validate this).
   */
  async completeWith(
    primary: ModelTarget,
    fallback: ModelTarget | undefined,
    req: InferenceRequest,
  ): Promise<InferenceResponse> {
    // Interactive-priority gate (2026-07-11): background work (RSI evals,
    // dreams, semantic indexing, …) must never starve a user-facing chat.
    // Observed failure: an RSI eval sweep saturated the provider while the
    // user's TUI message waited >90s for its first token → TtftTimeoutError
    // on "the most basic request". Background calls now wait while any
    // interactive request is in flight (plus a short cooldown so an active
    // conversation keeps priority between turns); interactive calls are
    // counted so the gate knows when the coast is clear.
    const interactive = !isBackgroundSession(req.sessionId);
    if (!interactive) {
      await this.#yieldToInteractive();
    } else {
      this.#interactiveInFlight++;
    }
    try {
      return await this.#completeWithPrioritized(primary, fallback, req);
    } finally {
      if (interactive) {
        this.#interactiveInFlight--;
        this.#lastInteractiveDoneAt = Date.now();
      }
    }
  }

  /** Count of user-facing requests currently inside #completeWithPrioritized. */
  #interactiveInFlight = 0;
  /** When the last interactive request finished (ms epoch). */
  #lastInteractiveDoneAt = 0;

  /** Background calls poll here until no interactive work is in flight and
   *  the cooldown since the last interactive completion has passed. Bounded
   *  so a marathon chat session can't starve background work forever —
   *  after the cap the background call proceeds anyway (it will simply
   *  share the provider like before this gate existed). */
  async #yieldToInteractive(): Promise<void> {
    const COOLDOWN_MS = 15_000;
    const MAX_WAIT_MS = 10 * 60_000;
    const start = Date.now();
    while (
      (this.#interactiveInFlight > 0 ||
        Date.now() - this.#lastInteractiveDoneAt < COOLDOWN_MS) &&
      Date.now() - start < MAX_WAIT_MS
    ) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async #completeWithPrioritized(
    primary: ModelTarget,
    fallback: ModelTarget | undefined,
    req: InferenceRequest,
  ): Promise<InferenceResponse> {
    // Same trusted-URL check as the constructor: passed targets must be
    // in `this.#trusted` (or `trustedBaseUrls` was omitted, in which case
    // the trusted set was seeded from the configured targets — the caller
    // is responsible for widening it before invoking `completeWith`).
    for (const target of [primary, fallback]) {
      if (target && !this.#trusted.has(normalizeBaseUrl(target.baseUrl))) {
        this.#auditBlocked(
          req.sessionId,
          `inference target not in trustedBaseUrls: ${target.baseUrl}`,
        );
        throw new InferenceError(
          `refusing to contact untrusted inference endpoint: ${target.baseUrl}`,
        );
      }
    }

    if (!req.skipBudgetCheck) this.#enforceBudget(req.sessionId);

    // Install a per-session AbortController (P0-#3) so `abort(sessionId)` can
    // actually reach an in-flight fetch. The signal is read by the streaming
    // / non-streaming call paths and combined with their internal timeouts.
    const ac = new AbortController();
    const existing = this.#sessionControllers.get(req.sessionId);
    if (existing && !existing.signal.aborted) {
      existing.signal.addEventListener(
        "abort",
        () => ac.abort(existing.signal.reason),
        { once: true },
      );
    }
    if (req.signal && !req.signal.aborted) {
      req.signal.addEventListener(
        "abort",
        () => ac.abort(req.signal?.reason),
        { once: true },
      );
    } else if (req.signal?.aborted) {
      ac.abort(req.signal.reason);
    }
    this.#sessionControllers.set(req.sessionId, ac);

    const start = Date.now();
    // Snapshot at call time so an in-flight reconfigure() doesn't affect us.
    const reqWithSignal = { ...req, signal: ac.signal };

    try {
      let response: InferenceResponse;
      try {
        response = await this.#callTarget(primary, reqWithSignal, false);
      } catch (primaryErr) {
        if (!fallback) {
          this.#auditFailure(req.sessionId, start, String(primaryErr));
          throw new InferenceError(
            `primary inference failed and no fallback configured: ${String(
              primaryErr,
            )}`,
          );
        }
        try {
          response = await this.#callTarget(fallback, reqWithSignal, true);
        } catch (fallbackErr) {
          this.#auditFailure(
            req.sessionId,
            start,
            `primary: ${String(primaryErr)}; fallback: ${String(fallbackErr)}`,
          );
          // The local engine answering "I have no model resident" is not a
          // diagnosis of the user's request — it is the fallback saying it was
          // never eligible. Appending it buried the REAL cloud failure (context
          // overflow, timeout, 429) behind "no model selected — choose one in
          // Models", which reads to the user as "Feral lost my model".
          if (isNoModelReady(fallbackErr)) throw asInferenceError(primaryErr);
          // Surface BOTH errors. The primary (usually the cloud/BYOK model)
          // is the one the user actually wants working; showing only the
          // fallback's error hid a bad key / URL / model name behind a
          // misleading local "no model selected" 503 on every request.
          throw new InferenceError(
            `both primary and fallback inference failed — primary: ${String(
              primaryErr,
            )}; fallback: ${String(fallbackErr)}. ` +
              `If you just added or changed a provider/key, the gateway is still ` +
              `running with the old config — restart it: \`feral gateway restart\`.`,
          );
        }
      }

      this.#recordUsage(req.sessionId, response.totalTokens);

      this.#audit({
        timestamp: Date.now(),
        sessionId: req.sessionId,
        actionType: "inference",
        toolName: response.model,
        result: "success",
        tokenCost: response.totalTokens,
        durationMs: Date.now() - start,
      });

      return response;
    } finally {
      // P0-#3: clear the per-session controller on every path so the next
      // call gets a fresh one. Without this, an aborted controller would
      // linger in the map and a later abort() would target a stale signal.
      if (this.#sessionControllers.get(req.sessionId) === ac) {
        this.#sessionControllers.delete(req.sessionId);
      }
    }
  }

  #buildTrusted(
    primary: ModelTarget,
    fallback: ModelTarget | undefined,
    trustedBaseUrls: string[] | undefined,
  ): Set<string> {
    const sources =
      trustedBaseUrls && trustedBaseUrls.length > 0
        ? trustedBaseUrls
        : [primary.baseUrl, ...(fallback ? [fallback.baseUrl] : [])];
    return new Set(sources.map(normalizeBaseUrl));
  }

  /**
   * Thresholds for the soft warning event (P1-#1). The warning fires
   * when conversation tokens exceed the configured % of the budget so
   * the UI can show "approaching limit" BEFORE the hard stop kicks in.
   * Default 80% — high enough that a normal user almost never sees it
   * in passing, low enough to surface before a runaway agent burns
   * through the rest.
   */
  static readonly SOFT_WARN_RATIO = 0.8;

  /**
   * N2 fix: hard cap on the per-conversation token map. The synthetic
   * sessionIds created by the extractor (`${sid}__facts` / `${sid}__obs`)
   * and by cron (`cron:${id}`) used to grow this map unboundedly. 256
   * entries covers every realistic power-user session count; LRU eviction
   * on overflow keeps memory bounded regardless of how many distinct
   * sessionIds the caller churns through.
   */
  static readonly MAX_TRACKED_CONVERSATIONS = 256;

  /**
   * N2 fix: hard cap on the "warning already fired" map. Same rationale
   * as MAX_TRACKED_CONVERSATIONS — one entry per (sessionId, kind) pair,
   * LRU eviction on overflow. The worst-case side effect of forgetting
   * a key is one duplicate `budget_warning` event for an ancient session,
   * which is harmless.
   */
  static readonly MAX_TRACKED_WARNINGS = 1024;

  /**
   * Install a callback fired when a session crosses the soft warning
   * threshold. The callback receives structured info the agent loop
   * forwards to the UI as a `budget_warning` event. P1-#1.
   */
  setBudgetWarningListener(listener: (info: BudgetWarning) => void): void {
    this.#budgetWarningListener = listener;
  }

  #enforceBudget(sessionId: string): void {
    const { perConversation, perDay } = this.#tokenBudget;

    if (this.conversationTokens(sessionId) >= perConversation) {
      this.#auditBlocked(sessionId, "conversation token budget exhausted");
      throw new BudgetExhaustedError(
        "conversation",
        `conversation budget of ${perConversation} tokens exhausted`,
      );
    }
    if (this.dayTokens() >= perDay) {
      this.#auditBlocked(sessionId, "daily token budget exhausted");
      throw new BudgetExhaustedError(
        "day",
        `daily budget of ${perDay} tokens exhausted`,
      );
    }
  }

  #recordUsage(sessionId: string, tokens: number): void {
    // N2 fix: bounded LRU — delete + re-insert moves the entry to the
    // tail of the Map's iteration order, so it becomes "newest" for the
    // cap check. On overflow, evict the oldest entry (head of the Map).
    const prev = this.#conversationTokens.get(sessionId) ?? 0;
    this.#conversationTokens.delete(sessionId);
    this.#conversationTokens.set(sessionId, prev + tokens);
    this.#evictOldestConversationsIfOver();

    this.#db
      .query(
        `INSERT INTO token_usage (day, tokens) VALUES ($day, $tokens)
         ON CONFLICT(day) DO UPDATE SET tokens = tokens + $tokens`,
      )
      .run({ $day: today(), $tokens: tokens });
    // P1-#1: soft warning. After the increment, check if we just crossed
    // the threshold for either dimension. The fired-map ensures the
    // listener is called at most once per (session, kind).
    this.#maybeFireBudgetWarning(sessionId);
  }

  /**
   * N2 fix: trim the per-conversation token map to its cap by dropping
   * the oldest entries (Map preserves insertion order, and the access
   * path in `#recordUsage` always re-inserts the touched key, so
   * "oldest" = "least-recently-touched" = correct LRU order).
   */
  #evictOldestConversationsIfOver(): void {
    const cap = InferenceRouter.MAX_TRACKED_CONVERSATIONS;
    while (this.#conversationTokens.size > cap) {
      const oldest = this.#conversationTokens.keys().next().value;
      if (oldest === undefined) break;
      this.#conversationTokens.delete(oldest);
    }
  }

  #maybeFireBudgetWarning(sessionId: string): void {
    const listener = this.#budgetWarningListener;
    if (!listener) return;
    const { perConversation, perDay } = this.#tokenBudget;
    const conv = this.conversationTokens(sessionId);
    const day = this.dayTokens();
    const threshold = InferenceRouter.SOFT_WARN_RATIO;

    if (Number.isFinite(perConversation) && conv >= perConversation * threshold) {
      const key = `${sessionId}:conversation`;
      if (!this.#budgetWarningFired.get(key)) {
        this.#recordBudgetWarningFired(key);
        listener({
          sessionId,
          kind: "conversation",
          usage: conv,
          limit: perConversation,
          percent: Math.round((conv / perConversation) * 100),
        });
      }
    }
    if (Number.isFinite(perDay) && day >= perDay * threshold) {
      const key = `${sessionId}:day`;
      if (!this.#budgetWarningFired.get(key)) {
        this.#recordBudgetWarningFired(key);
        listener({
          sessionId,
          kind: "day",
          usage: day,
          limit: perDay,
          percent: Math.round((day / perDay) * 100),
        });
      }
    }
  }

  /**
   * N2 fix: bounded insert for the warning-fired map. The same LRU
   * pattern as `#evictOldestConversationsIfOver`. Worst-case side
   * effect of overflow: an ancient session's warning can re-fire —
   * bounded to `MAX_TRACKED_WARNINGS` duplicate events across the
   * sidecar's lifetime, which is harmless UX noise.
   */
  #recordBudgetWarningFired(key: string): void {
    this.#budgetWarningFired.delete(key); // touch — moves to MRU
    this.#budgetWarningFired.set(key, true);
    const cap = InferenceRouter.MAX_TRACKED_WARNINGS;
    while (this.#budgetWarningFired.size > cap) {
      const oldest = this.#budgetWarningFired.keys().next().value;
      if (oldest === undefined) break;
      this.#budgetWarningFired.delete(oldest);
    }
  }

  #auditBlocked(sessionId: string, reason: string): void {
    this.#audit({
      timestamp: Date.now(),
      sessionId,
      actionType: "blocked",
      result: "blocked",
      blockedReason: reason,
    });
  }

  #auditFailure(sessionId: string, start: number, reason: string): void {
    this.#audit({
      timestamp: Date.now(),
      sessionId,
      actionType: "inference",
      result: "error",
      blockedReason: reason,
      durationMs: Date.now() - start,
    });
  }

  /**
   * Dispatch to the appropriate InferenceProvider. Defense-in-depth URL check
   * runs here (not just at construction) so no reconfigure() race can reach an
   * untrusted endpoint. The provider receives the fully-wired request
   * (signal chained, budget already checked).
   */
  async #callTarget(
    target: ModelTarget,
    req: InferenceRequest,
    isFallback: boolean,
  ): Promise<InferenceResponse> {
    if (!this.#trusted.has(normalizeBaseUrl(target.baseUrl))) {
      this.#auditBlocked(
        req.sessionId,
        `inference target not in trustedBaseUrls: ${target.baseUrl}`,
      );
      throw new InferenceError(
        `refusing to contact untrusted inference endpoint: ${target.baseUrl}`,
      );
    }

    const provider: InferenceProvider =
      this.#providers[target.provider] ??
      // Treat unknown providers as OpenAI-compatible (openai, deepseek, …).
      this.#providers["openai"]!;

    const notifyWait = (waitMs: number) => {
      this.#throttleListener?.({
        baseUrl: target.baseUrl,
        waitMs,
        limitRpm: this.#rateLimiter.limitFor(target.baseUrl),
        sessionId: req.sessionId,
      });
    };

    for (let attempt = 0; ; attempt++) {
      // Wait here, not inside the provider: this is the one funnel both the
      // primary and the fallback pass through, so a fallback landing on the
      // same rate-limited endpoint is counted too. `req.signal` is already the
      // per-session controller, so a user stop cuts the wait short instead of
      // making them sit through it.
      await this.#rateLimiter.acquire(target.baseUrl, req.signal, (info) =>
        this.#throttleListener?.({ ...info, sessionId: req.sessionId }),
      );

      try {
        return await provider.complete(target, req, isFallback);
      } catch (err) {
        // The gate is best-effort — our request count is local, so a key used
        // from outside Feral is invisible to it. A 429 is that blind spot
        // showing up, not a bug: respect the provider's Retry-After and go
        // again rather than failing the user's task on a transient collision.
        const status = (err as { status?: number }).status;
        if (status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;

        // The provider counted the attempt it rejected, so our window must too
        // — otherwise it drifts optimistic exactly when we are already over.
        this.#rateLimiter.note(target.baseUrl);

        const retryAfter = parseRetryAfter((err as { retryAfter?: string | null }).retryAfter);
        const waitMs = retryAfter ?? backoffMs(attempt);

        // A provider asking us to come back in ten minutes is not asking us to
        // block for ten minutes. Surface it instead of freezing the agent.
        if (waitMs > MAX_RETRY_AFTER_MS) throw err;

        notifyWait(waitMs);
        await abortableSleep(waitMs, req.signal);
      }
    }
  }

  /**
   * Register the callback fired when a request waits for a rate-limit slot.
   * The agent loop uses it to emit a `rate_limited` event.
   */
  setThrottleListener(
    listener: ((info: ThrottleWait & { sessionId: string }) => void) | null,
  ): void {
    this.#throttleListener = listener;
  }

  /** Requests counted against `baseUrl` in the current window. Telemetry/tests. */
  rateLimitCount(baseUrl: string): number {
    return this.#rateLimiter.countInWindow(baseUrl);
  }

  /**
   * Tokenize text using the local llama.cpp server's /tokenize endpoint.
   * This provides accurate token counts matching the model's actual vocabulary,
   * unlike the GPT-2 BPE fallback which uses a different vocabulary.
   *
   * @param text - The text to tokenize
   * @param model - Optional model name (uses primary model if not specified)
   * @returns Number of tokens, or -1 if the endpoint is unavailable
   */
  async tokenizeLocal(text: string, model?: string): Promise<number> {
    if (!text) return 0;

    const targetModel = model ?? this.#primary.model;
    const url = `${trimSlash(this.#primary.baseUrl)}/tokenize`;

    try {
      const data = (await postJson(
        url,
        { content: text, model: targetModel },
        undefined,
        AbortSignal.timeout(5000),
      )) as { tokens?: number[]; count?: number };
      if (Array.isArray(data.tokens)) return data.tokens.length;
      if (typeof data.count === "number") return data.count;
      return -1;
    } catch {
      return -1;
    }
  }

  /**
   * Count tokens using the local llama.cpp tokenizer when available,
   * falling back to GPT-2 BPE for cloud providers or when local endpoint fails.
   *
   * This is async because it may hit the local /tokenize endpoint.
   * For hot paths that need sync counting, use `countTokensSync` (GPT-2 BPE).
   */
  /**
   * P3: per-message count cache. The agent loop re-counts the same message
   * texts on every turn (working-memory budget, recall injection, compression
   * checks) — without a cache each recount is a network round-trip to
   * /tokenize. Keyed by text, bounded FIFO so a long session can't grow it
   * unboundedly. Invalidated wholesale on model switch (different vocab).
   */
  #tokenCountCache = new Map<string, number>();
  #tokenCacheModel = "";
  static readonly #TOKEN_CACHE_MAX = 512;

  async countTokensAccurate(text: string, model?: string): Promise<number> {
    const effectiveModel = model ?? this.#primary.model;
    if (this.#tokenCacheModel !== effectiveModel) {
      this.#tokenCountCache.clear();
      this.#tokenCacheModel = effectiveModel;
    }
    const hit = this.#tokenCountCache.get(text);
    if (hit !== undefined) return hit;

    let count: number;
    // Use the local /tokenize endpoint for any provider that exposes it
    // (bundled llama.cpp engine on openai_compatible, or external Ollama).
    if (
      this.#primary.provider === "ollama" ||
      this.#primary.provider === "openai_compatible"
    ) {
      const localCount = await this.tokenizeLocal(text, model);
      count = localCount >= 0 ? localCount : countTokens(text);
    } else {
      count = countTokens(text);
    }

    if (this.#tokenCountCache.size >= InferenceRouter.#TOKEN_CACHE_MAX) {
      // FIFO eviction: drop the oldest insertion.
      const oldest = this.#tokenCountCache.keys().next().value;
      if (oldest !== undefined) this.#tokenCountCache.delete(oldest);
    }
    this.#tokenCountCache.set(text, count);
    return count;
  }

  /**
   * Synchronous token count using GPT-2 BPE.
   * Use for hot paths where async is not feasible (streaming, per-message render).
   * Less accurate for non-GPT-2 vocabularies but zero latency.
   */
  countTokensSync(text: string): number {
    return countTokens(text);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Default port for a URL scheme, or "" when the scheme has none we track. */
function defaultPortFor(scheme: string): string {
  if (scheme === "https:") return "443";
  if (scheme === "http:") return "80";
  return "";
}

/**
 * Canonical form for base-URL allowlist comparison.
 *
 * Built from `hostname` and the *explicit* port only — never `URL.host`, which
 * folds the port into the string and makes an explicit default port
 * (`https://ollama.com:443`) compare unequal to its implicit form
 * (`https://ollama.com`). A port is included only when it is present AND differs
 * from the scheme's default, so the two forms canonicalize identically.
 *
 * The exact same function is used for allowlist construction and request-time
 * validation, so there is no asymmetry between the two checks.
 */
export function normalizeBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    const scheme = u.protocol.toLowerCase();
    const port =
      u.port && u.port !== defaultPortFor(scheme) ? `:${u.port}` : "";
    const path = trimSlash(u.pathname);
    return `${scheme}//${u.hostname}${port}${path}`.toLowerCase();
  } catch {
    return trimSlash(url.trim()).toLowerCase();
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
