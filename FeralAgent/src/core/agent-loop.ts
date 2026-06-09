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
  ChatMessage,
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
  buildToolContinuation,
} from "./feral-prompt.ts";

export interface AgentLoopConfig {
  /** Hard cap on tool-call/inference cycles for simple/chat tasks. */
  maxIterations: number;
  /** Cap for deep-research and complex multi-step tasks. Model stops when it
   *  has no more tool calls to make; this is just the safety ceiling. */
  maxIterationsDeep: number;
  /** Soft token cap passed to each completion. */
  maxTokensPerCall: number;
  /** Behavior when a budget is exhausted (mirrors InferenceConfig). */
  onBudgetExhausted: InferenceConfig["tokenBudget"]["onExhausted"];
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  maxIterations: 6,
  maxIterationsDeep: 50,
  // Raised from 4096 → 16384: Qwen3 and other thinking models (DeepSeek, QwQ)
  // consume a large share of the budget on chain-of-thought tokens before the
  // visible answer starts. 4096 left too little room for the actual reply,
  // cutting responses mid-sentence on anything but the shortest exchanges.
  // 16384 gives enough headroom for thinking + a full multi-paragraph reply.
  // The router's per-conversation and per-day budgets still cap total usage.
  maxTokensPerCall: 16384,
  onBudgetExhausted: "compress_and_continue",
};

export type EventSink = (event: OutboundEvent) => void;

export class AgentLoop {
  readonly #router: InferenceRouter;
  readonly #registry: ToolRegistry;
  readonly #episodic: EpisodicMemory;
  readonly #recall: RecallEngine | null;
  readonly #extractor: MemoryExtractor | null;
  readonly #config: AgentLoopConfig;
  readonly #systemPrompt: string;
  /** Identity document (SOUL.md) used to build the system prompt. Kept for
   *  future per-turn refresh; currently the system prompt is built once. */
  readonly #soul: SoulConfig | null | undefined;
  /** P0-4: optional hook registry. `agent_start` / `agent_end` /
   *  `before_prompt_build` / `before_compaction` events fire into it.
   *  Null in unit tests; in production index.ts wires the shared registry. */
  readonly #hooks: HookRegistry | null;
  /** Per-user personalization (USER block). Injected into the system prompt
   *  after SOUL. Null = user has not onboarded; no USER block rendered. */
  readonly #user: UserConfig | null;
  /** One working-memory transcript per session, retained across messages. */
  readonly #sessions = new Map<string, WorkingMemory>();
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
   * The chain is a Map<sessionId, Promise<void>> where the value is the
   * tail of the chain — appending a new handle creates a fresh promise
   * and links it to the previous one. Empty when no session is active.
   */
  readonly #sessionLocks = new Map<string, Promise<void>>();
  /**
   * Flag carried by the `done` event so the frontend can distinguish a clean
   * user-initiated stop from natural completion. Reset to false at the top of
   * each `#run()` and set to true in the catch path when the failure is an
   * AbortError (i.e. `stop()` was called mid-iteration). Read in `#handle()`
   * when emitting `done`.
   */
  #lastStopped = false;
  /**
   * Last `emit` sink passed to `handle()`. The router's budget warning
   * listener (P1-#1) doesn't get the per-handle sink so it uses this
   * cached reference. Set at the top of each `handle()` call. Null
   * before the first handle().
   */
  #lastEmitSink: EventSink | null = null;

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
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#soul = soul;
    this.#user = user;
    this.#hooks = hooks;
    this.#systemPrompt = buildSystemPrompt(registry, soul, user);

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
      const sink = this.#lastEmitSink;
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
  ): Promise<string> {
    this.#activeSessions.add(sessionId);
    this.#sessionStartedAt.set(sessionId, Date.now());
    // P0-#3: per-session tool AbortController so stop() can reach in-flight
    // tools, not just the router. Created fresh for every handle() so a
    // previous stop() doesn't leave a stale aborted controller in place.
    this.#sessionToolSignals.set(sessionId, new AbortController());
    // P1-#1: cache the sink so the router's budget-warning listener
    // (set in the constructor) can forward session-scoped warnings.
    this.#lastEmitSink = emit;

    // P0-#4: per-session mutex. Two `handle()` calls dispatched for the
    // same sessionId in quick succession (e.g. user sends two messages
    // back-to-back) used to share a single `WorkingMemory` instance and
    // race on `messages.push()`. Now each handle awaits the previous
    // handle's tail before starting. Different sessionIds are independent
    // and run in parallel.
    const prev = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    // Chain: if `prev` rejects, we still proceed (the next handle should
    // not be blocked by a previous failure), but we swallow the rejection
    // so the chain itself never stays rejected.
    const safePrev = prev.catch(() => undefined);
    this.#sessionLocks.set(sessionId, safePrev.then(() => next));

    try {
      await safePrev;
      return await this.#handle(sessionId, userText, messageId, emit, skillsContext);
    } finally {
      release();
      this.#activeSessions.delete(sessionId);
      this.#sessionStartedAt.delete(sessionId);
      this.#sessionToolSignals.delete(sessionId);
      // If this handle is still the tail, drop the entry so the map
      // doesn't grow with one-off sessionIds. The check is reference-
      // based: we only delete when the map's tail is OUR `next` promise.
      // (If a newer handle has already chained, we leave it alone.)
      if (this.#sessionLocks.get(sessionId) === safePrev.then(() => next)) {
        this.#sessionLocks.delete(sessionId);
      }
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
    emit: EventSink,
    skillsContext?: SkillMeta[],
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

    memory.addUser(userText);
    this.#episodic.record(sessionId, "user", userTextClean);

    const turnStartedAt = Date.now();
    let toolCallCount = 0;
    let tokensUsed = 0;

    try {
      const limit = isComplexTask(userText)
        ? this.#config.maxIterationsDeep
        : this.#config.maxIterations;
      const final = await this.#run(sessionId, memory, messageId, emit, limit, traceId);
      memory.addAssistant(final);
      const { text: finalClean } = stripPrivate(final);
      this.#episodic.record(sessionId, "assistant", finalClean);
      emit({ type: "done", id: messageId, content: final, stopped: this.#lastStopped, traceId });

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
      if (isAbortError(err)) {
        this.#lastStopped = true;
        const partial = memory.render();
        const lastAssistant = [...partial].reverse().find((m) => m.role === "assistant");
        const content = lastAssistant?.content?.trim() || "(stopped by user)";
        emit({ type: "done", id: messageId, content, stopped: true, traceId });
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
      emit({ type: "error", id: messageId, message, traceId });
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
    emit: EventSink,
    maxIterations: number,
    traceId: string,
  ): Promise<string> {
    // Reset stop flag at the start of every run. `#handle()` reads it on
    // emission; default = natural completion.
    this.#lastStopped = false;
    for (let i = 0; i < maxIterations; i++) {
      // Stream tokens live. We optimistically stream every completion; if the
      // model ends up emitting a tool call the accumulated tokens are discarded
      // from the UI perspective (the tool events replace them), but the model
      // rarely mixes prose + tool call in one turn in practice.
      let streamedSoFar = "";
      const onToken = (token: string) => {
        streamedSoFar += token;
        emit({ type: "chunk", id: messageId, content: token, traceId });
      };

      const completion = await this.#complete(sessionId, memory, onToken);
      const knownTools = new Set(this.#registry.list().map((t) => t.manifest.name));
      const parsed = parseResponse(completion, knownTools);

      if (parsed.toolCalls.length === 0) {
        // No tool calls → this is the final answer. Tokens already streamed.
        // Strip reasoning tags so a thinking-only completion (degraded models
        // that emit `<think>` and stop) never leaks raw tags as the answer.
        const answer = stripThinking(parsed.text) || stripThinking(streamedSoFar);
        if (!answer) {
          // Empty answer — distinguish "model only reasoned, no answer" from
          // a true silence so the user knows whether to retry with a shorter
          // prompt (cut-off) or a different model (degenerate).
          const hadThinking = /<think>|<thinking>|<\|channel>thought/i.test(completion);
          if (hadThinking) {
            return "(The model used all available tokens on reasoning and produced no answer. This usually means the response was cut off. Try a shorter prompt, a larger model, or increase max_tokens.)";
          }
          return "(The model returned an empty response.)";
        }
        return answer;
      }

      // Record the assistant's tool-calling turn so the model sees its own
      // decisions on the next pass.
      memory.addAssistant(completion);

      for (const call of parsed.toolCalls) {
        emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args, traceId });
        // P0-#3: thread the per-session tool signal so AgentLoop.stop()
        // aborts the in-flight tool (in addition to the router).
        const toolSignal = this.#sessionToolSignals.get(sessionId)?.signal;
        const result = await this.#registry.call(call.name, call.args, sessionId, {
          ...(toolSignal ? { signal: toolSignal } : {}),
        });
        emit({ type: "tool_done", id: messageId, tool: call.name, result, traceId });

        // P0-#3: a `cancelled` result means the user invoked stop() during
        // this tool. We must exit the iteration loop cleanly — otherwise
        // the model would re-issue tool calls (or even worse, complete
        // naturally) and the user's intent to stop would be ignored.
        // We distinguish `cancelled` (user-initiated) from `timeout`
        // (tool hung) so the model can recover from timeouts by trying
        // a different approach.
        if (result.error === "cancelled") {
          this.#lastStopped = true;
          break;
        }

        const rendered = result.ok
          ? result.content
          : `ERROR: ${result.content}`;
        memory.addToolResult(call.name, rendered);
        this.#episodic.record(sessionId, "tool", `${call.name}: ${rendered}`);

        // Re-engagement nudge: the model often drifts or stalls after a
        // tool result (especially multi-step or error cases). The full
        // tool result is already in the transcript as a `tool` role
        // message; this user-side reminder explicitly tells the model to
        // re-read the result and continue driving the original goal
        // rather than waiting for the next user message.
        memory.addUser(buildToolContinuation(rendered));
      }
    }

    // Exhausted the iteration budget without a final answer.
    return (
      "I reached the maximum number of reasoning steps before finishing. " +
      "Please narrow the request or try again."
    );
  }

  /** One completion with budget handling (compress-and-retry or stop). */
  async #complete(
    sessionId: string,
    memory: WorkingMemory,
    onToken?: (token: string) => void,
  ): Promise<string> {
    try {
      const res = await this.#router.complete({
        sessionId,
        messages: memory.render(),
        maxTokens: this.#config.maxTokensPerCall,
        onToken,
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
          const res = await this.#router.complete({
            sessionId,
            messages: memory.render(),
            maxTokens: this.#config.maxTokensPerCall,
            onToken,
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

  #memoryFor(sessionId: string): WorkingMemory {
    let memory = this.#sessions.get(sessionId);
    if (!memory) {
      memory = new WorkingMemory(this.#systemPrompt);
      this.#sessions.set(sessionId, memory);
    }
    return memory;
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

  // Dangling open tag (model started reasoning and never closed / produced an
  // answer): drop the tag and everything after it.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/gi, "");

  // Orphan stray tags.
  out = out.replace(/<\/?think(?:ing)?>/gi, "");

  return out.trim();
}

export function parseResponse(raw: string, knownTools?: Set<string>): ParsedResponse {
  const toolCalls: ParsedToolCall[] = [];
  let text = raw;

  // Pass 0: <tool_call>...</tool_call> tags — Gemma4 and similar native formats.
  const toolCallTag = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = toolCallTag.exec(raw)) !== null) {
    const call = tryParseCall(match[1]?.trim() ?? "");
    if (call) {
      toolCalls.push(call);
      text = text.replace(match[0], "").trim();
    }
  }

  if (toolCalls.length > 0) return { text: text.trim(), toolCalls };

  // Pass 1: fenced blocks (```tool, ```json, or unlabelled)
  const fence = /```(?:tool|json|[a-z]*)?\s*([\s\S]*?)```/g;
  while ((match = fence.exec(raw)) !== null) {
    const call = tryParseCall(match[1] ?? "");
    if (call) {
      toolCalls.push(call);
      text = text.replace(match[0], "").trim();
    }
  }

  if (toolCalls.length > 0) return { text: text.trim(), toolCalls };

  // Pass 2: bare JSON object on its own line (models sometimes skip fences)
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const call = tryParseCall(trimmed);
    if (call) {
      toolCalls.push(call);
      text = text.replace(line, "").trim();
    }
  }

  if (toolCalls.length > 0) return { text: text.trim(), toolCalls };

  // Pass 3: entire response is a bare JSON tool call
  const bare = tryParseCall(raw.trim());
  if (bare) return { text: "", toolCalls: [bare] };

  // Pass 4: bracket format [tool_name(key="value", key2=num)]
  // Gated on knownTools to avoid false positives from degraded/zombie models.
  const bracketLine = /^\[([a-zA-Z_]\w*)\(([^)]*)\)\]$/;
  for (const line of raw.split("\n")) {
    const m = bracketLine.exec(line.trim());
    if (m && (!knownTools || knownTools.has(m[1]!))) {
      const call = { name: m[1]!, args: parseBracketArgs(m[2]!) };
      toolCalls.push(call);
      text = text.replace(line, "").trim();
    }
  }

  if (toolCalls.length > 0) return { text: text.trim(), toolCalls };

  return { text: raw.trim(), toolCalls: [] };
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

function parseBracketArgs(argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const pattern = /(\w+)\s*=\s*(?:"([^"\\]*)"|'([^'\\]*)'|(\d+(?:\.\d+)?)|(true|false))/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(argsStr)) !== null) {
    const key = m[1]!;
    if (m[2] !== undefined)      args[key] = m[2];
    else if (m[3] !== undefined) args[key] = m[3];
    else if (m[4] !== undefined) args[key] = Number(m[4]);
    else if (m[5] !== undefined) args[key] = m[5] === "true";
  }
  return args;
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
 * Heuristic: true when the user message signals deep research or a complex
 * multi-step task that may need many tool-call rounds to answer well.
 *
 * Signals checked (any one is enough):
 *   - message is long (> 60 words) — implies multi-part or detailed request
 *   - contains explicit research/analysis keywords
 *   - asks for comparisons, lists, or comprehensive coverage
 */
export function isComplexTask(text: string): boolean {
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount > 60) return true;
  return /\b(research|analyze|analyse|investigate|compare|summarize|summarise|find all|deep|comprehensive|thorough|in[\s-]depth|step[\s-]by[\s-]step|multiple|several sources?|every|all the|overview|survey|audit|report)\b/i.test(text);
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
