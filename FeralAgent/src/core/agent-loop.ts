/**
 * Agent loop — the core reasoning cycle.
 *
 *   build prompt → inference (via router) → parse tool calls
 *     → if tool calls: execute each through the sandboxed registry, feed
 *       results back, loop
 *     → else: final answer, persist, done
 *
 * Constraints honored here:
 *   - every LLM call goes through the InferenceRouter (never a provider direct)
 *   - every tool call goes through the ToolRegistry (the sandbox choke point)
 *   - all errors are caught and surfaced as structured events, never crashes
 *   - budget exhaustion triggers compression or a clean stop, per config
 */

import type { InferenceRouter } from "../sandbox/inference-router.ts";
import {
  BudgetExhaustedError,
  InferenceError,
} from "../sandbox/inference-router.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { EpisodicMemory } from "../memory/episodic.ts";
import type { RecallEngine } from "../memory/recall.ts";
import type { MemoryExtractor } from "../memory/extractor.ts";
import { WorkingMemory } from "../memory/working.ts";
import { stripPrivate } from "../memory/privacy.ts";
import type {
  AnthropicToolDef,
  ChatMessage,
  OpenAIToolDef,
  InferenceConfig,
  OutboundEvent,
  ParsedResponse,
  ParsedToolCall,
  SkillMeta,
} from "../types.ts";
import type { HookRegistry } from "./hook-registry.ts";
import type { SoulConfig } from "./soul-loader.ts";
import type { UserConfig } from "./user-loader.ts";
import { buildUserPromptBlock } from "./user-loader.ts";
import {
  FERAL_AGENT_BASE_PROMPT,
} from "./feral-prompt.ts";
import { buildToolCallGrammar, TOOL_CALL_TRIGGERS } from "./tool-grammar.ts";

export interface AgentLoopConfig {
  /** Soft token cap passed to each completion. */
  maxTokensPerCall: number;
  /** Behavior when a budget is exhausted (mirrors InferenceConfig). */
  onBudgetExhausted: InferenceConfig["tokenBudget"]["onExhausted"];
  /**
   * Grammar-constrained tool calls. When true, every main-loop completion
   * carries a GBNF grammar (lazy, triggered on a tool-call fence) so the local
   * engine can only emit a valid tool-call JSON once the model opens one —
   * prose answers stay unconstrained. Off by default: it requires the bundled
   * llama.cpp engine (the grammar field is a no-op on other backends) and the
   * text parser remains the proven fallback. Enable with FERAL_TOOL_GRAMMAR=true.
   */
  useToolGrammar: boolean;
  /**
   * P2 (memory leaks): cap on simultaneously-retained session states.
   * When the cap is reached, the LRU session is evicted on the next
   * access. Default 64 — generous for normal use (most users have <5
   * active sessions), strict enough that a runaway or abusive client
   * cannot exhaust RAM by creating millions of unique sessionIds.
   * Tunable via constructor; tests and high-fanout deployments can
   * raise it, low-memory deployments can lower it.
   */
  maxRetainedSessions: number;
  /**
   * P2 (memory leaks): session WorkingMemory entries that haven't been
   * accessed in this many ms are evicted on the next access to the
   * session map. Default 30 minutes — long enough that a user who
   * walks away and comes back doesn't lose their conversation, short
   * enough that forgotten sessions don't accumulate. Combined with the
   * LRU cap, this is belt-and-suspenders: LRU bounds the worst case
   * (always at most `maxRetainedSessions`), TTL bounds the typical
   * case (idle sessions cleared within `sessionIdleEvictMs`).
   */
  sessionIdleEvictMs: number;
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  // Raised from 4096 → 16384: Qwen3 and other thinking models (DeepSeek, QwQ)
  // consume a large share of the budget on chain-of-thought tokens before the
  // visible answer starts. 4096 left too little room for the actual reply,
  // cutting responses mid-sentence on anything but the shortest exchanges.
  // 16384 gives enough headroom for thinking + a full multi-paragraph reply.
  // The router's per-conversation and per-day budgets still cap total usage.
  maxTokensPerCall: 16384,
  onBudgetExhausted: "compress_and_continue",
  // Grammar-constrained decoding is on by default. The grammar fields are
  // Feral extension fields honored by the bundled llama.cpp engine; standard
  // OpenAI-compatible servers and Anthropic silently ignore unknown body fields.
  // Set FERAL_TOOL_GRAMMAR=false to disable (e.g. when targeting a strict
  // server that rejects unknown JSON fields).
  useToolGrammar: process.env.FERAL_TOOL_GRAMMAR !== "false",
  // P2: see the docstrings above for the rationale. 64 sessions × ~8KB
  // compressed transcript each ≈ 500KB worst case — trivial, but the
  // cap is a hard backstop against pathological clients. 30 min idle
  // matches a "user walked away" mental model without losing short
  // breaks (user closes laptop, opens 5 min later).
  maxRetainedSessions: 64,
  sessionIdleEvictMs: 30 * 60 * 1000,
};

export type EventSink = (event: OutboundEvent) => void;

/**
 * P3: per-session mutable flags for one handle() invocation. Isolating these
 * from the class prevents concurrent sessions from overwriting each other's
 * stopped state or emit sink — the two bugs that existed when #lastStopped and
 * #lastEmitSink were class-level fields shared across all sessions.
 */
interface SessionRunContext {
  stopped: boolean;
  readonly emit: EventSink;
}

/**
 * P2: per-session entry held in the LRU/TTL-retained session map. Bundles
 * the WorkingMemory with the last-access timestamp so the eviction policy
 * can make its decision from a single map lookup. Mutating `lastAccess`
 * is allowed (we touch it on every access to keep the LRU order correct);
 * the field is read-only through the public surface.
 */
interface SessionEntry {
  memory: WorkingMemory;
  lastAccess: number;
}

export class AgentLoop {
  readonly #router: InferenceRouter;
  readonly #registry: ToolRegistry;
  readonly #episodic: EpisodicMemory;
  readonly #recall: RecallEngine | null;
  readonly #extractor: MemoryExtractor | null;
  readonly #config: AgentLoopConfig;
  readonly #systemPrompt: string;
  // Note: SOUL.md and USER configs are consumed by buildSystemPrompt() at
  // construction; they are not retained as fields (re-add if per-turn
  // system-prompt refresh ever lands).
  /** P0-4: optional hook registry. `agent_start` / `agent_end` /
   *  `before_prompt_build` / `before_compaction` events fire into it.
   *  Null in unit tests; in production index.ts wires the shared registry. */
  readonly #hooks: HookRegistry | null;
  /**
   * P2: one working-memory transcript per retained session, keyed by
   * sessionId. Bounded by `#maxRetainedSessions` (LRU eviction) and
   * `#sessionIdleEvictMs` (TTL eviction on access). Without these bounds
   * the map grew unboundedly for any long-running sidecar — every
   * distinct sessionId ever used kept a WorkingMemory alive in RAM
   * forever. See `#memoryFor` for the eviction logic.
   */
  readonly #sessions = new Map<string, SessionEntry>();
  /**
   * Set of sessionIds currently in the middle of `handle()`. The stop handler
   * iterates this and aborts the corresponding router call so the loop
   * exits cleanly between turns.
   */
  readonly #activeSessions = new Set<string>();
  /** Wall-clock ms when each active session started — useful for diagnostics. */
  readonly #sessionStartedAt = new Map<string, number>();
  /**
   * Per-session AbortController threaded into every `registry.call()` for
   * this session (P0-#3). `stop()` aborts this controller, which makes
   * the in-flight tool's `ctx.signal` aborted AND causes the registry's
   * race to fire, so a hung tool can no longer block a user-initiated stop.
   * Created in `#handle()` and cleared in `finally` (or when the session
   * has no in-flight tool call — the controller is still safe to abort).
   */
  readonly #sessionToolSignals = new Map<string, AbortController>();
  /**
   * Per-session mutex chain (P0-#4). Each `handle(sessionId, …)` awaits
   * the previous handle's promise for the same sessionId before starting,
   * so two messages dispatched back-to-back don't race on the same
   * `WorkingMemory.messages` array. Different sessionIds run in parallel.
   * The chain is a `Map<sessionId, Promise<void>>` where the value is THIS
   * handle's `next` promise — it resolves when this handle's `finally`
   * block runs, so the next handle's `prev` resolves after this one
   * completes. Appending a new handle overwrites the entry with the new
   * handle's own `next`; the previous handle's finally block is the one
   * that owns the cleanup decision for its own entry.
   *
   * P2 fix: the old code stored `safePrev.then(() => next)` in the map
   * and compared against the same `.then()` call in the cleanup branch.
   * Because `.then()` allocates a fresh Promise every time it runs, the
   * comparison was always against a different object identity, the
   * cleanup never fired, and the map grew unboundedly with every new
   * sessionId. Storing `next` directly and comparing against the local
   * `next` variable gives us a stable identity check; the entry is
   * actually evicted when the tail handle finishes.
   */
  readonly #sessionLocks = new Map<string, Promise<void>>();
  /**
   * P3: per-session run contexts keyed by sessionId. Created at the top of
   * handle() and cleared in its finally block. Replaces the old class-level
   * #lastStopped and #lastEmitSink fields so concurrent sessions never share
   * mutable state. The budget warning listener routes via this map so warnings
   * go to the correct session's emit sink rather than the last-registered one.
   */
  readonly #sessionContexts = new Map<string, SessionRunContext>();
  /**
   * Per-session inference overrides (temperature / max_tokens) from the host
   * UI's Controls panel, refreshed on every inbound message. Read by
   * `#complete` for the MAIN loop completions only.
   */
  readonly #sessionInferParams = new Map<
    string,
    { temperature?: number; maxTokens?: number }
  >();
  /**
   * Cached GBNF tool-call grammar, built once from the registry's tool names.
   * Null when grammar is disabled or there are no tools. See `tool-grammar.ts`.
   */
  readonly #toolGrammar: string | null;
  /**
   * A3: Cached Anthropic native tool definitions. Built once at construction,
   * same lifetime as `#toolGrammar`. Passed to every main-loop `router.complete()`
   * call so `AnthropicProvider` can send them as the API `tools` field instead
   * of relying on text-injected schema. Empty array = no tools registered.
   */
  readonly #nativeTools: AnthropicToolDef[];
  /**
   * A3 regression fix: Cached OpenAI-compatible native tool definitions. Built
   * once at construction alongside `#nativeTools`. Passed to every main-loop
   * `router.complete()` call so `OpenAICompatibleProvider` and `OllamaProvider`
   * can send them as the API `tools` field instead of relying on the
   * text-injected schema in the system prompt.
   */
  readonly #openAITools: OpenAIToolDef[];

  constructor(
    router: InferenceRouter,
    registry: ToolRegistry,
    episodic: EpisodicMemory,
    config: Partial<AgentLoopConfig> = {},
    recall: RecallEngine | null = null,
    extractor: MemoryExtractor | null = null,
    soul: SoulConfig | null = null,
    user: UserConfig | null = null,
    hooks: HookRegistry | null = null,
  ) {
    this.#router = router;
    this.#registry = registry;
    this.#episodic = episodic;
    this.#recall = recall;
    this.#extractor = extractor;
    if (this.#extractor) {
      this.#extractor.setIdleChecker(() => this.activeSessionCount === 0);
    }
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#hooks = hooks;
    this.#systemPrompt = buildSystemPrompt(registry, soul, user);
    // Build the tool-call grammar once. Tool registration is complete before
    // the loop runs, so the tool-name set is stable for the process lifetime.
    const toolNames = registry.list().map((t) => t.manifest.name);
    this.#toolGrammar =
      this.#config.useToolGrammar && toolNames.length > 0
        ? buildToolCallGrammar(toolNames)
        : null;
    // A3: build native Anthropic tool definitions from the same registry snapshot.
    this.#nativeTools = buildNativeTools(registry);
    // A3 regression fix: build OpenAI-compatible tool definitions from the same snapshot.
    this.#openAITools = buildOpenAITools(registry);

    // P1-#1: wire the router's soft-warning listener to the agent loop's
    // default emit sink. The loop's per-handle `emit` is the only sink
    // that knows the messageId / sessionId, but the warning doesn't need
    // a messageId (it's session-scoped, not turn-scoped), so we emit
    // directly to the last-known sink or fall back to a no-op.
    this.#router.setBudgetWarningListener((info) => {
      const payload = {
        type: "budget_warning" as const,
        sessionId: info.sessionId,
        kind: info.kind,
        usage: info.usage,
        limit: info.limit,
        percent: info.percent,
      };
      const sink = this.#sessionContexts.get(info.sessionId)?.emit;
      if (sink) sink(payload);
    });
  }

  /**
   * Process one user message end-to-end. Emits chunk/tool/done/error events to
   * the sink and returns the final assistant text. Never throws.
   *
   * `skillsContext`, when provided, is rendered as a short "Available skills"
   * menu in the system prompt for THIS turn only (Claude Code-style: metadata
   * menu + on-demand `read_skill` tool body). It is refreshed every turn from
   * Rust, so installing or removing a skill mid-conversation is reflected in
   * the very next message without resetting the session.
   */
  async handle(
    sessionId: string,
    userText: string,
    messageId: string,
    emit: EventSink,
    skillsContext?: SkillMeta[],
    images?: string[],
    inferParams?: { temperature?: number; max_tokens?: number },
  ): Promise<string> {
    // Per-session inference overrides from the host UI's Controls panel.
    // Refreshed on every message so a Controls change applies from the very
    // next turn; cleared when the host stops sending them.
    if (inferParams) {
      this.#sessionInferParams.set(sessionId, sanitizeInferParams(inferParams));
    } else {
      this.#sessionInferParams.delete(sessionId);
    }
    const prev = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const safePrev = prev.catch(() => undefined);
    this.#sessionLocks.set(sessionId, next);

    const abortController = new AbortController();
    const ctx: SessionRunContext = { stopped: false, emit };

    try {
      await safePrev;
      this.#activeSessions.add(sessionId);
      this.#sessionStartedAt.set(sessionId, Date.now());
      this.#sessionToolSignals.set(sessionId, abortController);
      this.#sessionContexts.set(sessionId, ctx);
      return await this.#handle(sessionId, userText, messageId, ctx, skillsContext, images);
    } finally {
      release();
      this.#activeSessions.delete(sessionId);
      this.#sessionStartedAt.delete(sessionId);
      if (this.#sessionToolSignals.get(sessionId) === abortController) {
        this.#sessionToolSignals.delete(sessionId);
      }
      if (this.#sessionContexts.get(sessionId) === ctx) {
        this.#sessionContexts.delete(sessionId);
      }
      if (this.#sessionLocks.get(sessionId) === next) {
        this.#sessionLocks.delete(sessionId);
      }
      this.#extractor?.runPending();
    }
  }

  /**
   * Stop an in-flight generation. Aborts the router call AND the in-flight
   * tool (P0-#3) for the given session, if any. The router throws
   * AbortError on the next token; the tool registry returns a structured
   * `{ok:false, error:"cancelled"}` to the loop. Both paths converge into
   * a `done` event with `stopped: true` semantics upstream.
   *
   * Safe to call when no generation is in flight (no-op).
   */
  stop(sessionId: string): void {
    this.#router.abort(sessionId);
    this.#sessionToolSignals.get(sessionId)?.abort("user stop");
  }

  /**
   * Count of currently active sessions (P2-#1, exposed for heartbeat).
   * Public so the HeartbeatLoop can read it without breaking the
   * private-field encapsulation. Cheap (Set.size).
   */
  get activeSessionCount(): number {
    return this.#activeSessions.size;
  }

  /**
   * P2: number of session WorkingMemory instances currently retained
   * in the LRU cache (sum of active + idle). Exposed for tests and
   * ops dashboards. Bounded by `maxRetainedSessions` and by the
   * TTL eviction on access.
   */
  get retainedSessionCount(): number {
    return this.#sessions.size;
  }

  /**
   * P2: number of session mutex chains currently held in `#sessionLocks`.
   * Exposed for tests so they can verify the cleanup path actually fires
   * (was always non-zero after the bug fix landed; should be 0 in a
   * quiescent state when no handle() is in flight). Cheap (Map.size).
   */
  get activeLockCount(): number {
    return this.#sessionLocks.size;
  }

  /**
   * Stop every active generation. Used on shutdown so no `handle()` is
   * left mid-await when the process exits.
   */
  stopAll(): void {
    for (const sessionId of [...this.#activeSessions]) {
      this.stop(sessionId);
    }
  }

  async #handle(
    sessionId: string,
    userText: string,
    messageId: string,
    ctx: SessionRunContext,
    skillsContext?: SkillMeta[],
    images?: string[],
  ): Promise<string> {
    // P0-4: agent_start hook. Informational — fires once at the top
    // of every turn. Errors are swallowed inside the hook registry.
    if (this.#hooks) {
      try {
        await this.#hooks.fire("agent_start", { sessionId, userText });
      } catch (err) {
        process.stderr.write(
          `[agent-loop] agent_start hook fire failed: ${String(err)}\n`,
        );
      }
    }

    const memory = this.#memoryFor(sessionId);
    memory.setSkillMenu(skillsContext ?? []);

    // P2-#3: traceId — a unique identifier for this handle() invocation.
    // Threaded into every OutboundEvent the agent emits during the turn
    // (chunk, tool_start, tool_done, done, budget_warning, error) so the
    // UI can correlate the entire timeline of one user request. Also
    // used by the sidecar's audit log so a row can be cross-referenced
    // with what the user saw. Cryptographically random — collision
    // probability is negligible at the scale of a single user session.
    const traceId = crypto.randomUUID();

    // Inject relevant past context before the user message lands in the prompt.
    // This runs synchronously (no I/O — pure DB reads) and never throws.
    if (this.#recall) {
      const result = this.#recall.recall(userText, sessionId);
      memory.setMemoryContext(result.context);
    }

    // Strip <private>...</private> blocks before persisting to episodic memory.
    // The model still sees the full text during the current turn — only storage
    // is affected, preserving user privacy across sessions.
    const { text: userTextClean } = stripPrivate(userText);

    memory.addUser(userText, images);
    this.#episodic.record(sessionId, "user", userTextClean);

    const turnStartedAt = Date.now();
    let toolCallCount = 0;
    let tokensUsed = 0;

    try {
      // Self-terminating loop: no limit computation needed. #run() returns
      // naturally when the model produces a text-only turn (no tool calls).
      // The 500-ceiling inside #run() is an emergency backstop only.
      const { text: final, toolCallCount: runToolCount } = await this.#run(
        sessionId,
        memory,
        messageId,
        ctx,
        traceId,
      );
      toolCallCount = runToolCount;
      memory.addAssistant(final);
      const { text: finalClean } = stripPrivate(final);
      this.#episodic.record(sessionId, "assistant", finalClean);
      ctx.emit({ type: "done", id: messageId, content: final, stopped: ctx.stopped, traceId });

      // Fire-and-forget: extract durable user facts from the turn just completed.
      this.#extractor?.extractAsync(sessionId, [...memory.turns]);

      // P0-4: agent_end hook. Informational. Carries the final answer,
      // the tool-call count, the duration, and the token total so a
      // hook can write to a log, send a notification, or trigger a
      // background job. Errors are swallowed.
      if (this.#hooks) {
        try {
          await this.#hooks.fire("agent_end", {
            sessionId,
            userText,
            answer: final,
            toolCalls: toolCallCount,
            tokensUsed,
            durationMs: Date.now() - turnStartedAt,
          });
        } catch (err) {
          process.stderr.write(
            `[agent-loop] agent_end hook fire failed: ${String(err)}\n`,
          );
        }
      }

      return final;
    } catch (err) {
      // User-initiated stop: the router's fetch was aborted by `stop()`. Emit
      // a `done` event with `stopped: true` so the frontend can render a
      // "stopped" state without surfacing an error to the user. Use the
      // accumulated assistant text up to the abort point, or a short notice
      // if nothing was streamed.
      // #13: an idle-timeout abort is NOT a user stop — the engine went
      // silent for the whole idle window (model wedged, provider hung,
      // network dropped). Surface it as a real, explained error instead of
      // a mute "stopped" state.
      if (isIdleTimeout(err)) {
        const message =
          "The model stopped responding (no output for several minutes), so the " +
          "request was cancelled. The model or provider may be overloaded — try " +
          "again, or switch to a smaller/faster model.";
        ctx.emit({ type: "error", id: messageId, message, traceId });
        return message;
      }
      if (isAbortError(err)) {
        ctx.stopped = true;
        const partial = memory.render();
        const lastAssistant = [...partial].reverse().find((m) => m.role === "assistant");
        const content = lastAssistant?.content?.trim() || "(stopped by user)";
        ctx.emit({ type: "done", id: messageId, content, stopped: true, traceId });
        if (this.#hooks) {
          try {
            await this.#hooks.fire("agent_end", {
              sessionId,
              userText,
              answer: content,
              toolCalls: toolCallCount,
              tokensUsed,
              durationMs: Date.now() - turnStartedAt,
            });
          } catch (hookErr) {
            process.stderr.write(
              `[agent-loop] agent_end hook fire failed: ${String(hookErr)}\n`,
            );
          }
        }
        return content;
      }
      const message = errorMessage(err);
      ctx.emit({ type: "error", id: messageId, message, traceId });
      if (this.#hooks) {
        try {
          await this.#hooks.fire("agent_end", {
            sessionId,
            userText,
            answer: message,
            toolCalls: toolCallCount,
            tokensUsed,
            durationMs: Date.now() - turnStartedAt,
          });
        } catch (hookErr) {
          process.stderr.write(
            `[agent-loop] agent_end hook fire failed: ${String(hookErr)}\n`,
          );
        }
      }
      return message;
    }
  }

  async #run(
    sessionId: string,
    memory: WorkingMemory,
    messageId: string,
    ctx: SessionRunContext,
    traceId: string,
  ): Promise<{ text: string; toolCallCount: number }> {
    // Reset stop flag at the start of every run (ctx is per-handle, so this
    // only affects this session — the P3 fix for shared #lastStopped).
    ctx.stopped = false;
    let toolCallCount = 0;
    // Emergency backstop — prevents infinite loops from runaway tool calls.
    // Normal usage never approaches this ceiling; the loop self-terminates
    // whenever the model produces a text-only turn (no tool calls).
    const ABSOLUTE_CEILING = 500;
    // Token-cutoff recovery: when a completion exhausts max_tokens while the
    // model is still reasoning (thinking present, answer empty), feed the
    // partial back and ask it to finish instead of surfacing a dead-end
    // "increase max_tokens" message. Bounded so a degenerate model that only
    // ever reasons can't loop forever.
    const MAX_CONTINUATIONS = 4;
    let continuations = 0;
    // Malformed tool-call recovery: when a turn contains a tool-call attempt
    // that failed to parse (corrupted JSON like `{"name="memory_graph">`),
    // the model meant to act — ending the turn there strands the task. Feed
    // back a corrective nudge and let it re-emit a valid call. Bounded so a
    // model that can never produce valid JSON doesn't loop forever.
    const MAX_MALFORMED_RETRIES = 3;
    let malformedRetries = 0;

    for (let i = 0; i < ABSOLUTE_CEILING; i++) {
      // Stream tokens live. We optimistically stream every completion; if the
      // model ends up emitting a tool call the accumulated tokens are discarded
      // from the UI perspective (the tool events replace them), but the model
      // rarely mixes prose + tool call in one turn in practice.
      let streamedSoFar = "";
      const onToken = (token: string) => {
        streamedSoFar += token;
        ctx.emit({ type: "chunk", id: messageId, content: token, traceId });
      };

      const completion = await this.#complete(sessionId, memory, onToken);
      const parsed = parseResponse(completion);

      if (parsed.toolCalls.length === 0 && parsed.malformedToolCall) {
        if (malformedRetries < MAX_MALFORMED_RETRIES) {
          malformedRetries++;
          memory.addAssistant(completion);
          memory.addUser(
            "(system: your previous message contained a tool call with invalid " +
              "JSON, so it was NOT executed. Re-emit the call as a single valid " +
              'JSON object — {"name": "tool_name", "args": {…}} inside ' +
              "<tool_call></tool_call> tags — or answer in plain text if you no " +
              "longer need the tool.)",
          );
          continue;
        }
        // Retries exhausted: fall through to natural termination with whatever
        // prose survived the scrub, rather than looping forever.
      }

      if (parsed.toolCalls.length === 0) {
        // No tool calls → natural termination. The model chose to answer
        // rather than call another tool. Strip reasoning tags so a
        // thinking-only completion never leaks raw tags as the answer.
        const answer = stripThinking(parsed.text) || stripThinking(streamedSoFar);
        if (!answer) {
          // Empty answer — distinguish "model only reasoned, no answer" from
          // a true silence so the user knows whether to retry with a shorter
          // prompt (cut-off) or a different model (degenerate).
          const hadThinking = /<think>|<thinking>|<\|channel>thought/i.test(completion);
          if (hadThinking) {
            if (continuations < MAX_CONTINUATIONS) {
              continuations++;
              memory.addAssistant(completion);
              memory.addUser(
                "(system: your previous reply hit the per-call token limit while you " +
                  "were still reasoning. Do NOT restart your reasoning from scratch — " +
                  "pick up where you left off and produce the final answer directly " +
                  "and concisely.)",
              );
              continue;
            }
            return {
              text: "(The model used all available tokens on reasoning and produced no answer, even after several automatic continuations. Try a shorter prompt or a larger model.)",
              toolCallCount,
            };
          }
          return { text: "(The model returned an empty response.)", toolCallCount };
        }
        // Natural termination — model chose to answer rather than call a tool.
        return { text: answer, toolCallCount };
      }

      // Model called tools → process them, then loop for the next turn.
      memory.addAssistant(completion);

      for (const call of parsed.toolCalls) {
        toolCallCount++;
        ctx.emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args, traceId });
        // P0-#3: thread the per-session tool signal so AgentLoop.stop()
        // aborts the in-flight tool (in addition to the router).
        const toolSignal = this.#sessionToolSignals.get(sessionId)?.signal;
        const result = await this.#registry.call(call.name, call.args, sessionId, {
          ...(toolSignal ? { signal: toolSignal } : {}),
          onProgress: ctx.emit,
        });
        ctx.emit({ type: "tool_done", id: messageId, tool: call.name, result, traceId });

        // P0-#3: a `cancelled` result means the user invoked stop() during
        // this tool. Exit the iteration loop cleanly so the user's intent
        // to stop is respected.
        if (result.error === "cancelled") {
          ctx.stopped = true;
          break;
        }

        const rendered = result.ok ? result.content : `ERROR: ${result.content}`;
        memory.addToolResult(call.name, rendered);
        this.#episodic.record(sessionId, "tool", `${call.name}: ${rendered}`);
      }

      if (ctx.stopped) break;
    }

    // User-initiated stop via tool-cancel path: the break above exited the main
    // loop, not the ceiling. Return a clean "(stopped by user)" instead of the
    // ceiling-hit message, which is misleading when the user meant to stop.
    if (ctx.stopped) {
      return {
        text: "(stopped by user)",
        toolCallCount,
      };
    }

    // Only reached if the ABSOLUTE_CEILING was hit — an emergency backstop
    // for runaway tool-call loops, not a normal termination path.
    return {
      text: `I completed ${toolCallCount} actions but haven't been able to produce a final answer. The task may be too open-ended — try narrowing the scope or asking for a specific output format.`,
      toolCallCount,
    };
  }

  /** One completion with budget handling (compress-and-retry or stop). */
  async #complete(
    sessionId: string,
    memory: WorkingMemory,
    onToken?: (token: string) => void,
  ): Promise<string> {
    // Grammar-constrained tool calls (opt-in). Applied only to the main agent
    // loop — the summarizer and memory extractor have their own router calls
    // and must stay unconstrained.
    const grammarFields = this.#toolGrammar
      ? { grammar: this.#toolGrammar, grammarTriggers: [...TOOL_CALL_TRIGGERS] }
      : {};
    // P1 (prompt caching): the main agent loop asks the local engine to
    // reuse the persistent LlamaContext's KV cache. Combined with the
    // cache-friendly layout in WorkingMemory.render() (dynamic context
    // appended to the last user message, system prompt kept static), this
    // makes the static prefix tokenize identically turn-over-turn so the
    // engine reuses the cached KV and only recomputes the new tail.
    // The summarize() and extractor() paths leave this off — they are
    // one-shot calls with no stable prefix to cache.
    try {
      // Controls-panel overrides for this session (UX: the user's Max Tokens
      // / Temperature sliders were previously silently ignored by the agent).
      const overrides = this.#sessionInferParams.get(sessionId);
      const res = await this.#router.complete({
        sessionId,
        messages: memory.render(),
        maxTokens: overrides?.maxTokens ?? this.#config.maxTokensPerCall,
        temperature: overrides?.temperature,
        onToken,
        cachePrompt: true,
        // A3: native tool definitions for Anthropic.
        nativeTools: this.#nativeTools,
        // A3 regression fix: native tool definitions for OpenAI-compatible providers.
        openAITools: this.#openAITools,
        ...grammarFields,
      });
      return res.content;
    } catch (err) {
      if (
        err instanceof BudgetExhaustedError &&
        this.#config.onBudgetExhausted === "compress_and_continue"
      ) {
        const compressed = await memory.maybeCompress((msgs) =>
          this.#summarize(sessionId, msgs),
        );
        if (compressed) {
          const overrides = this.#sessionInferParams.get(sessionId);
          const res = await this.#router.complete({
            sessionId,
            messages: memory.render(),
            maxTokens: overrides?.maxTokens ?? this.#config.maxTokensPerCall,
            temperature: overrides?.temperature,
            onToken,
            cachePrompt: true,
            // A3: native tool definitions for Anthropic.
            nativeTools: this.#nativeTools,
            // A3 regression fix: native tool definitions for OpenAI-compatible providers.
            openAITools: this.#openAITools,
            ...grammarFields,
          });
          return res.content;
        }
      }
      throw err;
    }
  }

  /** Summarize older turns into a compact note (used by working-memory). */
  async #summarize(sessionId: string, msgs: ChatMessage[]): Promise<string> {
    const transcript = msgs
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n")
      .slice(0, 6_000);
    const res = await this.#router.complete({
      sessionId,
      messages: [
        {
          role: "system",
          content:
            "Summarize the following conversation excerpt in 3-4 sentences, " +
            "preserving facts, decisions, and open questions.",
        },
        { role: "user", content: transcript },
      ],
      maxTokens: 256,
      // Bypass the budget gate: this call exists to RECOVER from budget
      // pressure, so it must run even when the conversation is over budget.
      skipBudgetCheck: true,
    });
    return res.content.trim();
  }

  /**
   * Look up (or create) the WorkingMemory for a session, applying the
   * P2 eviction policy along the way.
   *
   * Two layers of protection against unbounded growth:
   *   1. TTL: every call sweeps the map and drops any session that
   *      hasn't been accessed in `#sessionIdleEvictMs` ms. Lazy
   *      (no background timer), bounded cost (at most `#sessions.size`
   *      checks, itself bounded by the LRU cap). A user who walks
   *      away and comes back within `sessionIdleEvictMs` keeps their
   *      transcript; one who returns after the window pays a one-time
   *      re-hydration cost (a fresh WorkingMemory, the prior
   *      conversation gone from RAM but not from episodic memory).
   *   2. LRU: when adding a new session would push the map past
   *      `#maxRetainedSessions`, the oldest entry (Map preserves
   *      insertion order, and we re-insert on every access) is
   *      evicted first. Worst-case bound: `#maxRetainedSessions`
   *      entries × WorkingMemory footprint, regardless of how many
   *      distinct sessionIds the caller churns through.
   */
  #memoryFor(sessionId: string): WorkingMemory {
    // Cheap when there's nothing to evict (the common case for an
    // active session). The for-of loop is the only allocation.
    this.#evictIdleSessions();

    let entry = this.#sessions.get(sessionId);
    if (!entry) {
      // Make room: evict the oldest until we're under the cap. The
      // re-checked `while` (vs `if`) handles the rare case where the
      // caller's `maxRetainedSessions` was lowered between config
      // updates; in steady state the loop runs at most once.
      while (this.#sessions.size >= this.#config.maxRetainedSessions) {
        const oldest = this.#sessions.keys().next().value;
        if (oldest === undefined) break; // defensive: empty map
        this.#sessions.delete(oldest);
      }
      entry = {
        memory: new WorkingMemory(this.#systemPrompt),
        lastAccess: Date.now(),
      };
      this.#sessions.set(sessionId, entry);
    } else {
      // Touch: delete + re-insert moves the entry to the tail of the
      // Map's iteration order, so it becomes "newest" for LRU. We
      // could use a doubly-linked list for O(1) LRU, but at 64 entries
      // the Map ops are cheaper than the bookkeeping.
      this.#sessions.delete(sessionId);
      entry.lastAccess = Date.now();
      this.#sessions.set(sessionId, entry);
    }
    return entry.memory;
  }

  /**
   * Drop sessions that have been idle longer than `#sessionIdleEvictMs`.
   * Called from `#memoryFor` on every access — no background timer, no
   * observable latency cost (at most 64 cheap timestamp comparisons).
   */
  #evictIdleSessions(): void {
    const cutoff = Date.now() - this.#config.sessionIdleEvictMs;
    for (const [sessionId, entry] of this.#sessions) {
      if (entry.lastAccess < cutoff) {
        this.#sessions.delete(sessionId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction & response parsing
// ---------------------------------------------------------------------------

/**
 * Compose the system prompt.
 *
 * The system prompt is composed of layered blocks, in this strict order:
 *
 *   1. `FERAL_AGENT_BASE_PROMPT` — the universal FeralAgent operating manual.
 *      Always present, always the HIGHEST priority layer. Encodes the
 *      reliability contract (task-completion-first, chain-of-thought
 *      reasoning, structured tool calls, self-correction). It cannot be
 *      diluted away by user customizations.
 *   2. SOUL.md (when provided) — the user-customizable personality/identity
 *      layer. Refines tone and behavior within the FeralAgent base. When
 *      no soul is provided, the legacy Feral opener fills this slot so
 *      callers (e.g. tests) that haven't wired SOUL.md yet still work.
 *   3. USER block (when the user has onboarded) — per-user personalization
 *      (userName + agentName). Injected after SOUL so personalization
 *      follows identity.
 *   4. Tool mechanics — the registry's `describe()` output, the tool-call
 *      format, and the always-on Rules.
 *
 * The docstring intentionally says "highest priority" for the FeralAgent
 * base, NOT the SOUL block. SOUL refines; it does not override.
 *
 * Exported for testing — the production path is `new AgentLoop(..., soul, user)`.
 */
export function buildSystemPrompt(
  registry: ToolRegistry,
  soul: SoulConfig | null = null,
  user: UserConfig | null = null,
): string {
  const tools = registry.describe();
  const identity = soul
    ? [
        "## Identity & behavior (SOUL.md — user-customizable layer)",
        "The following identity document refines the FeralAgent base above",
        "with user-chosen tone, voice, and personality. It must not contradict",
        "the reliability contract defined in the FeralAgent base.",
        "",
        soul.content,
      ].join("\n")
    : [
        "You are Feral, a proactive and helpful AI assistant running locally on the user's device.",
        "You have access to tools and use them when they help answer a question.",
        "You never invent tool results — always call the tool and wait for the real output.",
      ].join("\n");

  const userBlock = user ? buildUserPromptBlock(user) : "";

  return [
    "## FeralAgent base (highest priority — always on)",
    FERAL_AGENT_BASE_PROMPT,
    "",
    identity,
    userBlock,
    "---",
    "",
    tools ? `## Available tools\n${tools}` : "No tools are available.",
    "",
    "## How to call a tool",
    "Emit a fenced code block with the tag `tool`, containing a single JSON object:",
    "```tool",
    '{"name": "tool_name", "args": {"param": "value"}}',
    "```",
    "You may call multiple tools in sequence across turns.",
    "After each tool result is returned, continue reasoning and either call another",
    "tool or write your final answer as plain text with no tool block.",
    "",
    "## Rules",
    "- Be concise and direct.",
    "- If you cannot help or a tool fails, say so clearly.",
    "- Never output raw JSON outside a tool block as your final answer.",
    "- Respond in the same language the user writes in.",
  ].filter((s) => s.length > 0).join("\n");
}

/**
 * A3: Convert the tool registry's manifest list into Anthropic native tool
 * definitions. Called once at AgentLoop construction; the result is cached in
 * `#nativeTools` and threaded into every main-loop `router.complete()` call.
 *
 * Only `AnthropicProvider` reads this field; all other providers ignore it.
 */
export function buildNativeTools(registry: ToolRegistry): AnthropicToolDef[] {
  return registry.list().map((tool) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(tool.parameters)) {
      // Prefer the full JSON Schema when the tool provides one (nested shapes
      // like ask_user's questions array); fall back to the flat pair.
      properties[key] = param.schema ?? { type: param.type, description: param.description };
      if (param.required !== false) required.push(key);
    }
    return {
      name: tool.manifest.name,
      description: tool.manifest.description,
      input_schema: { type: "object" as const, properties, required },
    };
  });
}

/**
 * A3 regression fix: Convert the tool registry's manifest list into
 * OpenAI-compatible native tool definitions. Called once at AgentLoop
 * construction; cached in `#openAITools` and threaded into every main-loop
 * `router.complete()` call. Read by `OpenAICompatibleProvider` and
 * `OllamaProvider`; all other providers ignore it.
 */
export function buildOpenAITools(registry: ToolRegistry): OpenAIToolDef[] {
  return registry.list().map((tool) => {
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const [key, param] of Object.entries(tool.parameters)) {
      // Prefer the full JSON Schema when the tool provides one (nested shapes
      // like ask_user's questions array); fall back to the flat pair.
      properties[key] = param.schema ?? { type: param.type, description: param.description };
      if (param.required !== false) required.push(key);
    }
    return {
      type: "function" as const,
      function: {
        name: tool.manifest.name,
        description: tool.manifest.description,
        parameters: { type: "object" as const, properties, required },
      },
    };
  });
}

/**
 * Strip reasoning/thinking blocks from a model's final answer.
 *
 * Local "thinking" models wrap chain-of-thought in tags the user must never see
 * in the answer area. The frontend splits these out of the *live* token stream,
 * but the agent loop's final answer (and the `done` event's content) is the
 * authoritative fallback used when streaming produced nothing — so it must be
 * stripped here too, or a degraded model that emits only `<think>` and stops
 * leaks the raw tag into the chat.
 *
 * Handles, in order:
 *   - paired  <think>…</think> / <thinking>…</thinking>   (any number)
 *   - Gemma   <|channel>thought … <|channel>response|end  (channel sections)
 *   - dangling <think> with no close → everything after it is reasoning, dropped
 *   - orphan stray tags left behind
 */
export function stripThinking(raw: string): string {
  let out = raw;

  // Paired blocks first (non-greedy, across newlines, case-insensitive).
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  // Gemma channel: keep only the text after a <|channel>response marker; drop
  // the thought section entirely. Then strip any remaining channel markers.
  const responseIdx = out.indexOf("<|channel>response");
  if (responseIdx !== -1) {
    out = out.slice(responseIdx + "<|channel>response".length);
  }
  out = out.replace(/<\|channel>thought[\s\S]*?(?=<\|channel>|$)/gi, "");
  out = out.replace(/<\|channel>[a-z]+/gi, "");

  // Orphan close tag with no open: MiniMax-M2 / DeepSeek-R1-style chat
  // templates bake the opening <think> into the prompt, so the completion
  // arrives as "reasoning…</think>answer". Everything before the first
  // remaining close tag (pairs were already removed above) is reasoning.
  const orphanClose = /<\/think(?:ing)?>/i.exec(out);
  if (orphanClose) {
    out = out.slice(orphanClose.index + orphanClose[0].length);
  }

  // Dangling open tag (model started reasoning and never closed / produced an
  // answer): drop the tag and everything after it.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/gi, "");

  // Orphan stray tags.
  out = out.replace(/<\/?think(?:ing)?>/gi, "");

  return out.trim();
}

/**
 * Parse a model response into free text plus any tool calls.
 *
 * Accepted formats (tried in order):
 *   1. Fenced block tagged `tool` or `json` — the canonical format
 *   2. Any fenced block containing a valid tool-call JSON object
 *   3. A bare JSON object on its own line containing `name`/`args`
 *   4. A bare JSON object that is the entire response
 *
 * Malformed blocks are silently ignored; partial / extra text around a tool
 * call is preserved as the text portion.
 */
export function parseResponse(raw: string): ParsedResponse {
  const toolCalls: ParsedToolCall[] = [];
  let text = raw;

  // Pass 0: <tool_call>...</tool_call> tags — the canonical format: local
  // grammar-constrained decoding emits it, and the providers re-encode
  // cloud-native tool calls into it.
  //
  // The inner pattern forbids a nested "<tool_call>", anchoring each match
  // at the INNERMOST opening tag. Models sometimes emit a dangling
  // "<tool_call>" as prose right before the server switches to native
  // tool-call deltas (observed with MiniMax M3 on an OpenAI-compatible
  // API); the provider then appends its canonical tag, producing
  // "… <tool_call>\n<tool_call>{json}</tool_call>". A naive non-greedy
  // match anchors at the dangling tag, captures "\n<tool_call>{json}" as
  // the body, fails to parse, and the call surfaces as raw text in the
  // chat instead of executing.
  const toolCallTag = /<tool_call>((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallTag.exec(raw)) !== null) {
    const call = tryParseCall(match[1]?.trim() ?? "");
    if (call) {
      toolCalls.push(call);
      text = text.replace(match[0], "").trim();
    }
  }

  if (toolCalls.length > 0) {
    // Sweep orphan tags (the dangling "<tool_call>" prose case above, or a
    // stray closer) so they never reach the UI or the stored transcript.
    text = text.replace(/<\/?tool_call>/g, "").trim();
    return { text, toolCalls, malformedToolCall: false };
  }

  // Pass 1 (narrow): bare tool-call JSON in the content. Grammar-constrained
  // local inference normally guarantees <tool_call> tags, but models on
  // plain OpenAI-compatible APIs (observed: MiniMax M3) still emit
  // `{"name":"memory_ops","args":{…}}` — sometimes several in a row, and
  // sometimes corrupted (`{"name="memory_ops">`). Without this pass the raw
  // JSON was displayed verbatim in the chat instead of executing.
  //
  // Unlike the removed legacy passes, this one only fires on objects whose
  // FIRST key is name/tool (the tool-call signature), and never inside code
  // fences — JSON in prose ({"port": 8080, …}) is untouched.
  const scrubbed = extractBareToolCalls(raw.replace(/<\/?tool_call>/g, ""));
  // A <tool_call> opener with no parseable call inside also counts as a
  // malformed attempt — the model opened a call and never produced valid JSON.
  const danglingTag = scrubbed.calls.length === 0 && /<tool_call>/.test(raw);
  return {
    text: scrubbed.text.trim(),
    toolCalls: scrubbed.calls,
    malformedToolCall: scrubbed.malformed || danglingTag,
  };
}

/**
 * Scan text outside code fences for objects starting with a name/tool key.
 * Valid objects become tool calls; corrupted ones (malformed JSON that is
 * still unmistakably a tool-call attempt) are removed from the visible text
 * so raw JSON never reaches the user.
 */
function extractBareToolCalls(input: string): {
  text: string;
  calls: ParsedToolCall[];
  malformed: boolean;
} {
  const calls: ParsedToolCall[] = [];
  let malformed = false;
  // Split on fence markers; even segments are outside fences and get
  // scanned, odd segments (fenced code) pass through untouched.
  const segments = input.split(/(```[\s\S]*?(?:```|$))/);
  const out: string[] = [];

  // `"?` and `[:=]` tolerate the observed corruption {"name="tool"> where
  // the colon was emitted as `=`.
  const startRe = /\{\s*"?(?:name|tool)"?\s*[:=]/g;

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (s % 2 === 1) {
      out.push(seg);
      continue;
    }
    let cursor = 0;
    let kept = "";
    while (cursor < seg.length) {
      startRe.lastIndex = cursor;
      const m = startRe.exec(seg);
      if (!m) {
        kept += seg.slice(cursor);
        break;
      }
      kept += seg.slice(cursor, m.index);
      const rest = seg.slice(m.index);
      const end = findJsonEnd(rest);
      const call = end >= 0 ? tryParseCall(rest.slice(0, end + 1)) : null;
      if (call) {
        calls.push(call);
        cursor = m.index + end + 1;
      } else {
        // Corrupted tool-call fragment: hide it. Drop through the end of the
        // JSON-ish run — the matched object if one closed, else end of line.
        malformed = true;
        const lineEnd = seg.indexOf("\n", m.index);
        cursor =
          end >= 0
            ? m.index + end + 1
            : lineEnd >= 0
              ? lineEnd
              : seg.length;
      }
    }
    out.push(kept);
  }

  return { text: out.join(""), calls, malformed };
}

function tryParseCall(candidate: string): ParsedToolCall | null {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith("{")) return null;

  // Find the first complete JSON object (handles trailing text after the object)
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    // Try to extract just the first JSON object if there's trailing text
    const end = findJsonEnd(trimmed);
    if (end < 0) return null;
    try {
      obj = JSON.parse(trimmed.slice(0, end + 1));
    } catch {
      return null;
    }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const record = obj as Record<string, unknown>;
  // Support {"name":..,"args":..}, {"tool":..,"args":..}, {"tool":..,"parameters":..}
  const name = record.name ?? record.tool;
  if (typeof name !== "string" || !name.trim()) return null;

  const rawArgs = record.args ?? record.arguments ?? record.parameters ?? record.input ?? {};
  const args =
    typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  return { name: name.trim(), args };
}


/** Find the index of the closing brace of the first top-level JSON object. */
function findJsonEnd(s: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Heuristic: true when the user message is long enough that a single-pass
 * answer is unlikely to suffice.
 *
 * P7 fix: the previous implementation keyword-matched on "research",
 * "analyze", "compare", "audit", "report", "overview", "every", "multiple",
 * and ~20 more common English words. That flipped routine user messages
 * ("can you audit this report?") into long-iteration deep mode and burned
 * the local model's context for no reason. Keyword matching is gone.
 *
 * Signals that DO still count:
 *   - message is long (> 60 words) — implies a multi-part or detailed request
 *     the model is unlikely to satisfy in one round.
 *
 * For explicit "I want deep mode" opt-in, callers should use a prefix or
 * flag (e.g. `/deep <task>`) — not a heuristic on the natural language.
 */
export function isComplexTask(text: string): boolean {
  const wordCount = text.trim().split(/\s+/).length;
  return wordCount > 60;
}

/**
 * Validate and clamp Controls-panel inference overrides coming from the host.
 * Non-numeric values are dropped; numbers are clamped to safe ranges so a
 * buggy or malicious host message can't request a 10M-token completion or a
 * NaN temperature.
 */
export function sanitizeInferParams(raw: {
  temperature?: unknown;
  max_tokens?: unknown;
}): { temperature?: number; maxTokens?: number } {
  const out: { temperature?: number; maxTokens?: number } = {};
  if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
    out.temperature = Math.min(2, Math.max(0, raw.temperature));
  }
  if (typeof raw.max_tokens === "number" && Number.isFinite(raw.max_tokens)) {
    out.maxTokens = Math.min(32_768, Math.max(128, Math.floor(raw.max_tokens)));
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof BudgetExhaustedError) {
    return `Token budget exhausted (${err.reason}). ${err.message}`;
  }
  if (err instanceof InferenceError) {
    return `Inference unavailable: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

/**
 * #13: detect the inference stream's idle-timeout abort (see
 * `idleAbortController` in sandbox/inference-providers.ts — it aborts with a
 * named `IdleTimeoutError`). Matched by name to avoid a core→sandbox import.
 * Some runtimes propagate `signal.reason` wrapped, so the message is checked
 * as a fallback.
 */
function isIdleTimeout(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "IdleTimeoutError" || /stream stalled/i.test(err.message);
}

/**
 * Detect a user-initiated stop. The router throws either a DOMException with
 * name "AbortError" (browser-style) or a plain Error with the same name
 * (Node 18+ fetch). We accept both shapes.
 */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  // Some runtimes wrap the abort under a different error type
  // (e.g. "AbortError" string on a generic Error).
  return /abort/i.test(err.message);
}

