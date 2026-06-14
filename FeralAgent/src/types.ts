/**
 * Feral Agent — shared type contracts.
 *
 * Every layer (core, memory, sandbox, transports, tools) depends on these
 * definitions. Keep this file free of runtime logic — interfaces and unions
 * only — so it can be imported anywhere without creating import cycles.
 */

// ---------------------------------------------------------------------------
// Sandbox: permissions & tool manifests
// ---------------------------------------------------------------------------

/**
 * Per-path access mode (P0-5). Pairs with {@link PathAccess} to declare
 * whether a tool may read, write, or both at a given filesystem root.
 *
 *   - "read"        → tool may call readFile, stat, etc. on this root
 *   - "write"       → tool may call writeFile, editFile, etc. on this root
 *   - "read+write"  → both (the default for bare-string allowedPaths entries)
 */
export type PathMode = "read" | "write" | "read+write";

/**
 * A single entry in `ToolManifest.allowedPaths` carrying an explicit
 * per-root access mode. Bare strings are accepted everywhere a PathAccess
 * is expected and are normalised to `{ path, mode: "read+write" }`.
 */
export interface PathAccess {
  path: string;
  mode: PathMode;
}

/** The discrete capabilities a tool may request. */
export type Permission =
  | "fs:read"
  | "fs:write"
  | "network:outbound"
  | "process:spawn";

/**
 * Declared, immutable description of what a tool is allowed to do. A tool that
 * attempts an action outside its manifest is blocked by the sandbox.
 */
export interface ToolManifest {
  name: string;
  description: string;
  permissions: Permission[];
  networkAccess: boolean;
  /** Only meaningful when networkAccess is true. */
  allowedDomains?: string[];
  /**
   * Only meaningful when fs permissions are present.
   *
   * Each entry is either a bare absolute path (treated as read+write,
   * backward-compatible with V1 manifests) or a {@link PathAccess} entry
   * that declares an explicit mode. Use the explicit form when a tool
   * should only be able to read or only write a given root — e.g. a
   * scanner tool that must never modify files, or a logger that must
   * never read them.
   */
  allowedPaths?: Array<string | PathAccess>;
  /**
   * Only meaningful when the `process:spawn` permission is present.
   * Allowlist of executables the tool may invoke. Each entry is either an
   * absolute path (e.g. "/usr/bin/git") or a bare command name resolved via
   * PATH at registration time (e.g. "git"). The ProcessSandbox refuses
   * any executable not in this list.
   */
  allowedExecutables?: string[];
  /**
   * Optional retry policy for transient failures. The registry retries the
   * tool up to `attempts` times after the initial call (so total calls =
   * 1 + attempts). Retries happen with linear backoff (250ms × attempt).
   * A retry is only triggered when the failure matches one of the
   * `on` categories:
   *   - "http"    → tool returned { ok: false, error: "http_error" | "network_error" }
   *   - "process" → tool.execute threw (e.g. spawn failure, crash)
   *   - "any"     → retry on any failure (http OR process)
   * Default (policy absent): no retry, behaviour unchanged.
   */
  retry?: ToolRetryPolicy;
  /**
   * Feral-WIP #2: optional list of fallback tool names to try in order
   * when this tool returns a non-retryable failure. Each fallback must
   * be a registered tool. The registry invokes them in the given order
   * with the SAME args, returning the first successful result. Useful
   * for chains like `web_search → deep_research → read_webpage` when
   * Jina is down or the user provided a URL directly.
   */
  fallback?: Array<string | FallbackDeclaration>;
}

export interface FallbackDeclaration {
  name: string;
  argMap?: (args: Record<string, unknown>) => Record<string, unknown>;
}


export type ToolRetryCategory = "http" | "process" | "any";

export interface ToolRetryPolicy {
  /** Number of retries after the initial attempt. 0 (default) = no retry. */
  attempts: number;
  /** Which error categories are eligible for retry. */
  on: ToolRetryCategory[];
}

/** JSON Schema-ish parameter description surfaced to the LLM. */
export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  /**
   * Full JSON Schema for this parameter, used verbatim by the native
   * tool-definition builders (`buildNativeTools` / `buildOpenAITools`)
   * instead of the flat `{type, description}` pair. Required for tools
   * with nested shapes (e.g. ask_user's `questions` array of objects):
   * in native-tools mode the text docs are stripped from the system
   * prompt, so without this the model only sees `type: "array"` and has
   * to guess the item structure — the main source of bad_args failures.
   */
  schema?: Record<string, unknown>;
}

export interface ToolProgressPayload {
  stage: string;
  progress: number | null;
  message: string;
  data?: unknown;
  traceId?: string;
}

export interface ToolProgressEvent extends ToolProgressPayload {
  type: "tool_progress";
  sessionId: string;
  tool: string;
}

/** Context handed to a tool when it executes. */
export interface ToolContext {
  sessionId: string;
  /**
   * AbortSignal that fires when the call should be cancelled. The registry
   * combines two triggers into a single signal:
   *   1. the per-call timeout (default 60s, overridable per call)
   *   2. the caller's `opts.signal` (e.g. AgentLoop.stop())
   * Tools SHOULD check `ctx.signal.aborted` before long operations and pass
   * the signal to their own `fetch` / `spawn` so cancellation is prompt.
   * Tools that ignore the signal will still be unwrapped at timeout — the
   * registry returns a `{ok:false, error:"timeout"}` to the LLM so the
   * agent loop can continue, even if the tool's promise itself hangs in
   * the background.
   */
  signal?: AbortSignal;
  /** Validated network fetch — the only network entry point for tools. */
  fetch: FeralFetch;
  /** Append an arbitrary audit entry from within a tool. */
  audit: AuditLogger;
  manifest: ToolManifest;
  /**
   * Validated process spawner — the only way tools may execute external
   * programs. Present only when the tool's manifest declares `process:spawn`;
   * tools without that permission receive `undefined` and must not call it.
   * Throws if invoked without the permission or against an executable not in
   * the tool's `allowedExecutables` list.
   */
  process?: ProcessSandbox;
  /**
   * Progress callback for long-running tools. The registry fills in `type`,
   * `sessionId`, and `tool`; tools emit stage/message/progress payloads.
   */
  progress?: (event: ToolProgressPayload) => void;
  /**
   * Interactive-questions bridge. Present only when the transport supports
   * ask_user (Tauri does). Tools that emit questions (currently just
   * `ask_user`) call `ctx.askUser.ask(questions)` and await the user's
   * selection; the bridge emits an `ask_user` event, waits for the matching
   * `ask_user_response`, and resolves. Undefined for transports that do
   * not support interactive questions.
   */
  askUser?: AskUserBridge;
  /**
   * Desktop-control bridge — structural OS-level control of native GUI apps
   * via the platform accessibility tree (UIA on Windows, AX on macOS). The OS
   * work happens in the Rust host, behind a security gate; the sidecar reaches
   * it by emitting a `desktop_control_request` event and awaiting the matching
   * `desktop_control_response` (same request/response shape as `askUser`).
   * Present only when desktop control is enabled (`FERAL_ENABLE_DESKTOP_CONTROL`)
   * and the transport is the Tauri host. Undefined otherwise — the
   * `control_app` tool refuses to run without it.
   */
  desktopControl?: DesktopControlBridge;
}

/**
 * Bridge to the Rust desktop-control backend. `request` emits a
 * `desktop_control_request` and resolves with the backend's `data` payload, or
 * rejects with an Error carrying the backend's message. All security gating
 * (opt-in flag, app allow/deny, secure-field redaction) is enforced in Rust;
 * the bridge is a thin, transport-level RPC.
 */
export interface DesktopControlBridge {
  request(
    action: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
}

/** Thrown when a desktop-control request gets no response within the timeout. */
export class DesktopControlTimeoutError extends Error {
  constructor(public readonly requestId: string, public readonly timeoutMs: number) {
    super(`desktop_control request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "DesktopControlTimeoutError";
  }
}

/**
 * The ask_user bridge — a Promise-based interface for asking the user
 * interactive questions. Created once at agent startup and threaded into
 * every ToolContext.
 */
export interface AskUserBridge {
  /**
   * Ask the user one or more questions (max 4, each with 2-4 options).
   * Emits an `ask_user` event, then awaits a matching `ask_user_response`.
   * Rejects with `AskUserTimeoutError` after 5 minutes. `sessionId` is
   * included in the emitted event so the transport can route the question
   * to the right conversation (the impl defaults it to "default").
   */
  ask(questions: AskUserQuestion[], sessionId?: string): Promise<AskUserAnswer[]>;
  /** Cancel a pending question (e.g. session shutdown). */
  cancel(requestId: string, reason?: string): void;
}

/** Thrown when ask_user does not receive a response within the timeout. */
export class AskUserTimeoutError extends Error {
  constructor(public readonly requestId: string, public readonly timeoutMs: number) {
    super(`ask_user request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "AskUserTimeoutError";
  }
}

/** A registered, executable tool. */
export interface Tool {
  manifest: ToolManifest;
  parameters: Record<string, ToolParameter>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Per-call options accepted by `ToolRegistry.call`. The agent loop passes
 * its session-level AbortSignal so `stop()` actually reaches in-flight tools.
 * Other callers (tests, ad-hoc scripts) can override the timeout or pass
 * their own signal.
 */
export interface ToolCallOptions {
  /**
   * Caller-level abort signal. When this aborts, the registry propagates
   * the abort into the tool's `ctx.signal` AND returns a structured
   * `{ok:false, error:"cancelled"}` so the agent loop sees a clean stop.
   */
  signal?: AbortSignal;
  /**
   * Per-call wall-clock timeout in milliseconds. Default `DEFAULT_TOOL_TIMEOUT_MS`
   * (60s). When the timeout fires, the registry aborts `ctx.signal` and
   * returns `{ok:false, error:"timeout"}`.
   */
  timeoutMs?: number;
  /** Progress events emitted by long-running tools during this call. */
  onProgress?: (event: ToolProgressEvent) => void;
}

/** Structured result of a tool invocation. Never throws across this boundary. */
export interface ToolResult {
  ok: boolean;
  /** Human/LLM-readable content describing the outcome. */
  content: string;
  /** Optional structured data for programmatic consumers. */
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sandbox: egress proxy
// ---------------------------------------------------------------------------

/** The validated fetch signature exposed to tools. Mirrors a subset of fetch. */
export type FeralFetch = (
  url: string,
  init?: FeralFetchInit,
) => Promise<FeralFetchResponse>;

export interface FeralFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort the request after this many milliseconds. */
  timeoutMs?: number;
  /** Abort the request when the caller's signal fires. */
  signal?: AbortSignal;
}

export interface FeralFetchResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Sandbox: audit log
// ---------------------------------------------------------------------------

export type AuditActionType =
  | "tool_call"
  | "inference"
  | "network"
  | "memory_write"
  | "blocked";

export type AuditResult = "success" | "blocked" | "error";

export interface AuditEntry {
  timestamp: number;
  sessionId: string;
  actionType: AuditActionType;
  toolName?: string;
  argsJson?: string;
  result: AuditResult;
  blockedReason?: string;
  tokenCost?: number;
  durationMs?: number;
}

/** Records a single audit entry. Implementations must never throw to callers. */
export type AuditLogger = (entry: AuditEntry) => void;

/**
 * Options accepted by `ProcessSandbox.run`. The sandbox enforces the tool's
 * `allowedExecutables` allowlist, contains the working directory inside
 * `allowedPaths`, and applies a hard timeout with an output cap.
 */
export interface ProcessRunOptions {
  /**
   * The executable to run. Either an absolute path declared in
   * `allowedExecutables`, or a bare command name whose resolved path must
   * match an `allowedExecutables` entry.
   */
  executable: string;
  /** Arguments. Each entry is passed as a separate argv slot (no shell). */
  args?: string[];
  /**
   * Working directory. Must be inside one of the tool's `allowedPaths`
   * (when the tool declares fs permissions). Omit to inherit the parent
   * process's cwd.
   */
  cwd?: string;
  /**
   * Extra environment variables. Combined with a minimal safe base (PATH,
   * HOME, LANG) — the parent process environment is NEVER inherited wholesale.
   * Blocked: any name starting with LD_, DYLD_, NODE_, PYTHONPATH, PATH
   * overrides are ignored.
   */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds. Default 30_000, max 300_000. */
  timeoutMs?: number;
  /** Optional stdin payload (e.g. piped to `git commit -F -`). */
  stdin?: string;
  /**
   * When true, the process must complete successfully (exit 0). Any non-zero
   * exit is converted to a thrown `ProcessSpawnError`. Default: false (caller
   * inspects `exitCode`).
   */
  throwOnNonZero?: boolean;
}

export interface ProcessRunResult {
  /** Process exit code. -1 if killed by signal, -2 if timed out. */
  exitCode: number;
  /** Captured stdout, UTF-8 decoded, capped at the sandbox output limit. */
  stdout: string;
  /** Captured stderr, UTF-8 decoded, capped at the sandbox output limit. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean;
  /** True when the process was killed because stdout/stderr exceeded the cap. */
  outputTruncated: boolean;
}

/**
 * The process spawner contract surfaced to tools. Concrete implementation
 * lives in `sandbox/process-sandbox.ts`. `run` validates the executable
 * against the calling tool's `allowedExecutables` allowlist before spawning
 * and audits every attempt (success or blocked) via the audit logger.
 */
export interface ProcessSandbox {
  run(
    manifest: ToolManifest,
    sessionId: string,
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>;
}

/** Raised when the sandbox refuses a spawn (unknown executable, bad cwd, …). */
export class ProcessSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessSpawnError";
  }
}

// ---------------------------------------------------------------------------
// Sandbox: inference router
// ---------------------------------------------------------------------------

export interface ModelTarget {
  provider: string;
  model: string;
  baseUrl: string;
  /** API key for cloud providers. Empty/absent for Ollama (local). */
  apiKey?: string;
}

export interface TokenBudgetConfig {
  perConversation: number;
  perDay: number;
  onExhausted: "stop" | "compress_and_continue";
}

export interface InferenceConfig {
  primary: ModelTarget;
  fallback?: ModelTarget;
  tokenBudget: TokenBudgetConfig;
  /**
   * Allowlist of base URLs the router may ever contact. Every configured target
   * (primary + fallback) must be a member; a target outside the list is refused.
   * When omitted, the allowlist defaults to exactly the configured targets, so
   * the router can never call an endpoint that was not explicitly set up.
   */
  trustedBaseUrls?: string[];
}

/** A single chat message in the LLM-facing transcript. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present when role is "tool": the tool whose output this carries. */
  name?: string;
  /**
   * Image attachments as data URLs (`data:image/png;base64,...`). Present on
   * user messages when the host app forwards pasted/uploaded images. Each
   * provider serializes these into its own multimodal format; providers and
   * models without vision support ignore them (the textual
   * "[Image attached: name]" note in `content` still describes them).
   */
  images?: string[];
}

/**
 * A3: Anthropic native function-calling tool schema.
 *
 * Mirrors the shape expected by the Anthropic `/v1/messages` `tools` field.
 * Populated by `agent-loop.ts` from the `ToolRegistry` and consumed only by
 * `AnthropicProvider`. Other providers ignore this field.
 */
export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    // Values are flat {type, description} pairs or, for tools that declare a
    // ToolParameter.schema, a full JSON Schema (nested items/properties).
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

/**
 * OpenAI-compatible native function-calling tool schema.
 *
 * Mirrors the shape expected by the OpenAI `/v1/chat/completions` `tools` field
 * (and all compatible endpoints: NIM, Groq, OpenRouter, Together, Ollama).
 * Populated by `agent-loop.ts` from the `ToolRegistry` and consumed by
 * `OpenAICompatibleProvider` and `OllamaProvider`. Other providers ignore it.
 */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      // Values are flat {type, description} pairs or, for tools that declare a
      // ToolParameter.schema, a full JSON Schema (nested items/properties).
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
  };
}

export interface InferenceRequest {
  sessionId: string;
  messages: ChatMessage[];
  /** Soft cap for this single completion. */
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional abort signal. When aborted, the in-flight fetch / streaming
   * read is cancelled. Set by the router's per-session AbortController so
   * `AgentLoop.stop()` (and `router.abort(sessionId)`) can interrupt a
   * long-running completion (P0-#3). Defaults to no signal — the call
   * uses its own timeout-only AbortController.
   */
  signal?: AbortSignal;
  /**
   * When provided, the router streams tokens from the provider and calls this
   * callback for each partial token as it arrives. The full assembled content
   * is still returned in InferenceResponse at the end.
   */
  onToken?: (token: string) => void;
  /**
   * Internal maintenance calls (e.g. the working-memory summarizer) set this to
   * skip the pre-call budget check. Without it, compress-and-continue is a dead
   * path: once a conversation is over budget, the summarizer that would free
   * space is itself blocked, permanently bricking the session. Usage is still
   * recorded — this only bypasses the *gate*, never the accounting.
   */
  skipBudgetCheck?: boolean;
  /**
   * Optional GBNF grammar constraining the local engine's decoding. Forwarded
   * to the bundled llama.cpp API (a Feral extension field) so tool calls are
   * grammar-constrained. Ignored by cloud providers, which use native
   * function-calling instead. See `core/tool-grammar.ts`.
   */
  grammar?: string;
  /**
   * Trigger strings for *lazy* grammar enforcement (e.g. tool-call fences).
   * The grammar stays dormant until one appears, so prose is unconstrained.
   */
  grammarTriggers?: string[];
  /**
   * P1 (prompt caching): hint to the local engine that this call's prompt
   * prefix is stable and the persistent LlamaContext's KV cache should be
   * reused. Defaults to `true` for the agent loop's main completions; one-shot
   * callers (summarizer, extractor, cron jobs) opt out by passing `false`.
   * Ignored by cloud providers, which have their own caching strategy.
   */
  cachePrompt?: boolean;
  /**
   * A3: Native tool definitions for the Anthropic provider.
   * When present, `AnthropicProvider` uses the API-level `tools` field instead
   * of relying on schema injected into the system prompt. Responses containing
   * `tool_use` blocks are serialised to `<tool_call>…</tool_call>` XML so
   * Pass 0 of `parseResponse` picks them up without any special-casing.
   */
  nativeTools?: AnthropicToolDef[];
  /**
   * A3 regression fix: Native tool definitions for OpenAI-compatible providers
   * (NIM, Groq, OpenRouter, Together) and Ollama. When present, these providers
   * use the API-level `tools` / `tool_choice: "auto"` fields instead of the
   * text-injected schema in the system prompt. Responses are normalised to
   * `<tool_call>…</tool_call>` XML so Pass 0 of `parseResponse` picks them up.
   */
  openAITools?: OpenAIToolDef[];
}

export interface InferenceResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  /** True when the primary target failed and the fallback served the request. */
  usedFallback: boolean;
  /**
   * Why generation ended, normalized across providers:
   * "stop" (natural end), "length" (max_tokens cutoff), "tool_calls".
   * Undefined when the provider didn't report one. The agent loop uses
   * "length" to auto-continue a reply that was cut off mid-answer instead
   * of silently presenting the truncated text as the final answer.
   */
  finishReason?: "stop" | "length" | "tool_calls" | string;
}

export type BudgetExhaustedReason = "conversation" | "day";

/**
 * Soft budget warning info (P1-#1). Surfaced to the UI as a
 * `budget_warning` OutboundEvent when usage crosses the soft threshold
 * (default 80% of the configured limit) so the user can see
 * "approaching limit" BEFORE the hard stop kicks in. Fired at most
 * once per (sessionId, kind) pair so the UI doesn't get spammed.
 */
export interface BudgetWarning {
  sessionId: string;
  kind: BudgetExhaustedReason;
  usage: number;
  limit: number;
  /** 0-100 integer. Useful for the UI to render a progress bar. */
  percent: number;
}

/** Raised internally by the router; surfaced to the agent as a structured error. */
export interface BudgetState {
  conversationTokens: number;
  dayTokens: number;
}

// ---------------------------------------------------------------------------
// Agent: parsed tool calls
// ---------------------------------------------------------------------------

/** A tool invocation parsed out of the model's response. */
export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Outcome of parsing a raw model response. */
export interface ParsedResponse {
  /** Free-text the model emitted alongside (or instead of) tool calls. */
  text: string;
  toolCalls: ParsedToolCall[];
  /**
   * True when the response contained a tool-call attempt that could not be
   * parsed (corrupted JSON, e.g. `{"name="memory_graph">`). The fragment is
   * scrubbed from `text`, but the loop must NOT treat the turn as a final
   * answer — the model meant to act. The loop feeds back a corrective nudge
   * so the model re-emits a valid call instead of silently stopping mid-task.
   */
  malformedToolCall: boolean;
}

// ---------------------------------------------------------------------------
// Subagent (P0-1) — child agent runs for delegated tasks.
// ---------------------------------------------------------------------------

/** A parent's request to spin up a subagent. */
export interface SubagentConfig {
  /** The task description — becomes the subagent's first user message. */
  task: string;
  /** Subset of the parent's tool names the subagent is allowed to call. */
  allowedTools: string[];
  /** Per-subagent budget. */
  budget: { maxTokens: number; maxIterations: number };
  /** The session id of the parent that spawned this subagent. */
  parentSessionId: string;
}

/** The subagent's outcome. Returned to the parent agent for context. */
export interface SubagentResult {
  /** Terminal status of the subagent run. */
  status: "completed" | "failed" | "timeout" | "budget_exceeded";
  /** The subagent's final answer, truncated to fit the parent's context. */
  answer: string;
  /** How many tool calls the subagent made (observability). */
  toolCalls: number;
  /** Tokens consumed (0 if the runtime doesn't surface per-run totals). */
  tokensUsed: number;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
  /** Stable id for this subagent run (used in audit + event trace). */
  subagentId: string;
}

// ---------------------------------------------------------------------------
// Hooks (P0-4) — plugin-style extension points.
//
// Pattern from OpenClaw. Each event has a typed payload; `before_*` events
// can be blocked by returning `{ block: true, reason }`. `after_*` and
// lifecycle events are informational. The registry never throws to the
// caller — a misbehaving handler is logged and skipped.
// ---------------------------------------------------------------------------

/** All hook event names the registry understands. */
export type HookEvent =
  | "before_tool_call"
  | "after_tool_call"
  | "before_prompt_build"
  | "before_compaction"
  | "agent_start"
  | "agent_end"
  | "subagent_spawn"
  | "subagent_complete";

/** Per-event payload shape. Each hook handler gets the matching one. */
export interface BeforeToolCallPayload {
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
}

export interface AfterToolCallPayload {
  tool: string;
  args: Record<string, unknown>;
  result: { ok: boolean; content: string; error?: string };
  sessionId: string;
  durationMs: number;
}

export interface BeforePromptBuildPayload {
  sessionId: string;
  systemPrompt: string;
}

export interface BeforeCompactionPayload {
  sessionId: string;
  /** Number of older messages about to be summarised. */
  olderMessageCount: number;
  /** Number of recent messages kept verbatim. */
  recentKept: number;
}

export interface AgentStartPayload {
  sessionId: string;
  userText: string;
}

export interface AgentEndPayload {
  sessionId: string;
  userText: string;
  answer: string;
  toolCalls: number;
  tokensUsed: number;
  durationMs: number;
}

export interface SubagentSpawnPayload {
  parentSessionId: string;
  subagentId: string;
  task: string;
  allowedTools: string[];
}

export interface SubagentCompletePayload {
  parentSessionId: string;
  subagentId: string;
  status: "completed" | "failed" | "timeout" | "budget_exceeded";
  durationMs: number;
}

/** Result a hook returns. `block: true` aborts `before_*` operations. */
export type HookResult = { block: false } | { block: true; reason: string };

/** Cleanup callback returned by `on()`. Idempotent. */
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Cron scheduler (P0-3) — user-schedulable tasks that run in the background.
// Pattern from Hermes `cron/jobs.py`: persistent jobs, multi-format schedule,
// delivery to any output target.
// ---------------------------------------------------------------------------

/**
 * When a job should fire. Three shapes:
 *   - "cron"  → standard 5-field cron expression (`* * * * *`), UTC
 *   - "every" → fixed interval in ms, repeats forever
 *   - "at"    → one-shot at a specific ISO timestamp
 */
export type Schedule =
  | { kind: "cron"; expression: string }
  | { kind: "every"; intervalMs: number }
  | { kind: "at"; isoTimestamp: string };

/**
 * Where a job's result is delivered. V1 supports `chat` (emit a `cron_fired`
 * event into a Tauri session) and `webhook` (POST JSON to a URL). `tool`
 * lands in P0-1 once subagent delegation is wired.
 */
export type DeliveryTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "webhook"; url: string }
  | { kind: "tool"; toolName: string; args: Record<string, unknown> };

/** One row in a job's run history. Capped to the most recent 50 entries. */
export interface CronRunRecord {
  runAt: number;
  status: "success" | "failed" | "timeout" | "budget_exceeded" | "skipped";
  durationMs: number;
  result?: string;
  error?: string;
}

/** A persisted cron job. Managed by `CronJobsRepo` (cron/jobs.ts). */
export interface CronJob {
  id: string;
  name: string;
  task: string;
  schedule: Schedule;
  delivery: DeliveryTarget;
  enabled: boolean;
  lastRunMs?: number;
  nextRunMs?: number;
  /** Last 50 runs, newest at the end. */
  history: CronRunRecord[];
  /** Max retries per failure before being marked as stuck. */
  maxRetries: number;
  /** Current consecutive failure count; reset to 0 on success. */
  retryCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Caller-supplied fields for `upsert`. The repo fills in id/timestamps. */
export interface CronJobInput {
  /** Optional explicit id; auto-generated when omitted. */
  id?: string;
  name: string;
  task: string;
  schedule: Schedule;
  delivery: DeliveryTarget;
  enabled?: boolean;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Skills (Claude Code-style: metadata menu + on-demand body load)
// ---------------------------------------------------------------------------

/**
 * Metadata for a single skill, mirroring the Rust `skills::SkillMeta` struct
 * (see `src-tauri/src/skills.rs`). Rust sends a roster of these on every
 * `message`; the agent renders them as a "skill menu" in the system prompt
 * and loads the full body on demand via the `read_skill` tool.
 */
export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  license: string;
  tags: string[];
  /** "local" | "github" | "clawhub" */
  source_provider: string;
  source_url: string | null;
  content_url: string | null;
  /** "installed" | "not_installed" */
  install_status: string;
  /** "bundled" | "local" | "verified" | "community" | "experimental" | "unknown" */
  trust_label: string;
  last_updated: string | null;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** Inbound message envelope from any transport. */
export interface InboundMessage {
  type: "message" | "ping" | "shutdown" | "set_model" | "stop"
    | "ask_user_response" | "ask_user_cancel"
    | "cron_add" | "cron_remove" | "cron_toggle" | "cron_list"
    | "desktop_control_response";
  id?: string;
  content?: string;
  sessionId?: string;
  /**
   * Image attachments as data URLs, forwarded by the host app alongside the
   * text content (type === "message"). Threaded into the user ChatMessage so
   * vision-capable models receive the actual pixels.
   */
  images?: string[];
  /**
   * Per-message inference overrides from the host UI's Controls panel
   * (type === "message"). Applied to the MAIN agent-loop completions for
   * this session only — the summarizer and memory extractor keep their own
   * fixed params. Values are validated and clamped by the agent loop.
   */
  inferParams?: { temperature?: number; max_tokens?: number };
  /**
   * Roster of currently-installed LOCAL skills, rebuilt by Rust on every send.
   * The agent loop renders this as a short "Available skills" menu inside the
   * system prompt for the current turn; the LLM loads each skill's full body
   * on demand via the `read_skill` tool. Empty/undefined → no menu rendered.
   */
  skillsContext?: SkillMeta[];
  // set_model fields (all present when type === "set_model")
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** API key injected by Rust from the BYOK store — never touches React. */
  apiKey?: string;
  // ask_user_response fields (all present when type === "ask_user_response")
  /** Matches the id of the original "ask_user" outbound event. */
  requestId?: string;
  answers?: AskUserAnswer[];
  // ask_user_cancel fields (all present when type === "ask_user_cancel")
  /** Matches the id of the original "ask_user" outbound event being cancelled. */
  // (requestId above is shared between response and cancel)
  /** Why the request was cancelled (free-form string; default "user cancelled"). */
  reason?: string;
  // desktop_control_response fields (present when type === "desktop_control_response").
  // `id` (above) echoes the originating desktop_control_request id.
  /** True when the OS action succeeded. */
  ok?: boolean;
  /** Backend payload on success (shape depends on the action). */
  data?: unknown;
  /** Human-readable failure reason on `ok === false`. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Ask user (Claude.ai-style interactive questions)
// ---------------------------------------------------------------------------

/**
 * A single option the user can pick for an ask_user question.
 * The "Other" option is implicitly added by the UI; the tool author does
 * NOT include it in the array.
 */
export interface AskUserOption {
  /** Short label, e.g. "PostgreSQL". 1-5 words. */
  label: string;
  /** Optional 1-2 sentence explanation. */
  description?: string;
  /** Mark the recommended option. At most one per question. */
  recommended?: boolean;
}

export interface AskUserQuestion {
  /** The main question text, e.g. "What database would you like to use?" */
  question: string;
  /** Short header (max 12 chars) for compact UI. e.g. "Database". */
  header?: string;
  /** 2-4 options. The UI implicitly appends an "Other" option. */
  options: AskUserOption[];
  /** Allow multiple selections. */
  multiSelect: boolean;
}

export interface AskUserAnswer {
  /** Echo of the question text for robust matching. */
  question: string;
  /** Selected option labels (1 for !multiSelect, N for multiSelect). */
  selected: string[];
  /** User-typed "Other" answer, if applicable. */
  customText?: string;
}

/** Outbound event envelope to any transport. */
export type OutboundEvent =
  | { type: "chunk"; id: string; content: string; traceId?: string }
  | { type: "done"; id: string; content: string; stopped: boolean; traceId: string }
  | { type: "tool_start"; id: string; tool: string; args: Record<string, unknown>; traceId: string }
  | { type: "tool_progress"; sessionId: string; tool: string; stage: string; progress: number | null; message: string; data?: unknown; traceId?: string }
  | { type: "tool_done"; id: string; tool: string; result: unknown; traceId: string }
  | { type: "proactive"; content: string; traceId?: string }
  | { type: "model_set"; provider: string; model: string }
  | { type: "model_error"; message: string; traceId?: string }
  | { type: "pong" }
  | { type: "error"; id?: string; message: string; traceId?: string }
  | { type: "ask_user"; id: string; sessionId: string; questions: AskUserQuestion[]; traceId?: string }
  | { type: "ask_user_cancelled"; id: string; sessionId: string; reason: string; traceId?: string }
  | { type: "usage"; id: string; sessionId: string; promptTokens: number; completionTokens: number; traceId?: string }
  | { type: "budget_warning"; sessionId: string; kind: BudgetExhaustedReason; usage: number; limit: number; percent: number; traceId?: string }
  | { type: "budget_exceeded"; sessionId: string; kind: BudgetExhaustedReason; usage: number; limit: number; message: string; traceId?: string }
  | { type: "heartbeat"; uptimeMs: number; rssMb: number; activeSessions: number }
  | { type: "cron_fired"; jobId: string; jobName: string; sessionId: string; content: string; traceId?: string }
  // X3: surfaced when a scheduled job throws or times out — previously cron
  // failures were logged to stderr only and invisible in the UI.
  | { type: "cron_error"; jobId: string; jobName: string; message: string; traceId?: string }
  | { type: "skill_created"; skillId: string; name: string; path: string; version: number; traceId?: string }
  | { type: "skill_refined"; skillId: string; version: number; traceId?: string }
  // Desktop-control bridge request. Handled in the Rust host (not the React
  // UI): the host runs the OS accessibility action behind its security gate
  // and replies on stdin with a `desktop_control_response` carrying this `id`.
  | { type: "desktop_control_request"; id: string; sessionId: string; action: string; params: Record<string, unknown> };

export interface Transport {
  /** Emit an event to the host/user. */
  send(event: OutboundEvent): void;
  /** Register the handler invoked for each inbound message. */
  onMessage(handler: (msg: InboundMessage) => void | Promise<void>): void;
  /** Called once the transport is wired and ready to receive. */
  onReady(handler: () => void): void;
  /** Begin listening. */
  start(): void;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface EpisodicEvent {
  id?: number;
  sessionId: string;
  timestamp: number;
  role: ChatMessage["role"];
  content: string;
}
