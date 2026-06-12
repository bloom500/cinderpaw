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

export class InferenceRouter {
  // Mutable so reconfigure() can hot-swap the active model at runtime.
  #primary: ModelTarget;
  #fallback: ModelTarget | undefined;
  #trusted: Set<string>;

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

  constructor(config: InferenceConfig, audit: AuditLogger, db: Database) {
    this.#primary = config.primary;
    this.#fallback = config.fallback;
    this.#tokenBudget = config.tokenBudget;
    this.#audit = audit;
    this.#db = db;
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
   */
  reconfigure(
    primary: ModelTarget,
    fallback?: ModelTarget,
    trustedUrls?: string[],
  ): void {
    const newTrusted = this.#buildTrusted(primary, fallback, trustedUrls);

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

  /** Display-safe view of the currently active model (no API keys). */
  get currentModel(): { provider: string; model: string; baseUrl: string } {
    return {
      provider: this.#primary.provider,
      model: this.#primary.model,
      baseUrl: this.#primary.baseUrl,
    };
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
   * Run one completion through the router. Throws BudgetExhaustedError when a
   * budget is hit (the agent loop decides whether to stop or compress) and
   * InferenceError when both primary and fallback fail.
   */
  async complete(req: InferenceRequest): Promise<InferenceResponse> {
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
    const primary = this.#primary;
    const fallback = this.#fallback;
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
          throw new InferenceError(
            `both primary and fallback inference failed: ${String(fallbackErr)}`,
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

    return provider.complete(target, req, isFallback);
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
