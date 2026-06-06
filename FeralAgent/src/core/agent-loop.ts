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
  /** One working-memory transcript per session, retained across messages. */
  readonly #sessions = new Map<string, WorkingMemory>();

  constructor(
    router: InferenceRouter,
    registry: ToolRegistry,
    episodic: EpisodicMemory,
    config: Partial<AgentLoopConfig> = {},
    recall: RecallEngine | null = null,
    extractor: MemoryExtractor | null = null,
  ) {
    this.#router = router;
    this.#registry = registry;
    this.#episodic = episodic;
    this.#recall = recall;
    this.#extractor = extractor;
    this.#config = { ...DEFAULT_CONFIG, ...config };
    this.#systemPrompt = buildSystemPrompt(registry);
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
    const memory = this.#memoryFor(sessionId);
    memory.setSkillMenu(skillsContext ?? []);

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

    try {
      const limit = isComplexTask(userText)
        ? this.#config.maxIterationsDeep
        : this.#config.maxIterations;
      const final = await this.#run(sessionId, memory, messageId, emit, limit);
      memory.addAssistant(final);
      const { text: finalClean } = stripPrivate(final);
      this.#episodic.record(sessionId, "assistant", finalClean);
      emit({ type: "done", id: messageId, content: final });

      // Fire-and-forget: extract durable user facts from the turn just completed.
      this.#extractor?.extractAsync(sessionId, [...memory.turns]);

      return final;
    } catch (err) {
      const message = errorMessage(err);
      emit({ type: "error", id: messageId, message });
      return message;
    }
  }

  async #run(
    sessionId: string,
    memory: WorkingMemory,
    messageId: string,
    emit: EventSink,
    maxIterations: number,
  ): Promise<string> {
    for (let i = 0; i < maxIterations; i++) {
      // Stream tokens live. We optimistically stream every completion; if the
      // model ends up emitting a tool call the accumulated tokens are discarded
      // from the UI perspective (the tool events replace them), but the model
      // rarely mixes prose + tool call in one turn in practice.
      let streamedSoFar = "";
      const onToken = (token: string) => {
        streamedSoFar += token;
        emit({ type: "chunk", id: messageId, content: token });
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
        emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args });
        const result = await this.#registry.call(call.name, call.args, sessionId);
        emit({ type: "tool_done", id: messageId, tool: call.name, result });

        const rendered = result.ok
          ? result.content
          : `ERROR: ${result.content}`;
        memory.addToolResult(call.name, rendered);
        this.#episodic.record(sessionId, "tool", `${call.name}: ${rendered}`);
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

function buildSystemPrompt(registry: ToolRegistry): string {
  const tools = registry.describe();
  return [
    "You are Feral, a proactive and helpful AI assistant running locally on the user's device.",
    "You have access to tools and use them when they help answer a question.",
    "You never invent tool results — always call the tool and wait for the real output.",
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
  ].join("\n");
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
