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
   * YOLO escape hatch: when true, the ProcessSandbox accepts ANY absolute
   * `cwd`, not just ones inside `allowedPaths`. Only shell_exec sets this,
   * and only when its whitelist is the wildcard "*" (full-host mode). The
   * env scrub and executable resolution still apply — this relaxes the
   * working directory, nothing else.
   */
  allowAnyCwd?: boolean;
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

  /**
   * Capability bridge — list / inspect / install skills through the host's
   * own catalogue. Present only when the transport is the Tauri host; the
   * capability tools refuse to run without it rather than falling back to
   * anything, because there is no safe fallback for "install software".
   */
  capabilities?: CapabilityBridge;

  /** Administrative commands — update, switch model. Tauri host only. */
  admin?: AdminBridge;
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

/**
 * Bridge to the host's capability catalogue. `request` emits a
 * `capability_request` and resolves with the host's `data`, or rejects with
 * its message. Present only on the Tauri host; the `install_capability` tool
 * refuses to run without it.
 */
export interface CapabilityBridge {
  request(
    action: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
}

/**
 * Bridge to the host's administrative commands — update, model switching.
 * Present only on the Tauri host; the `feral_admin` tool refuses to run
 * without it rather than pretending.
 */
export interface AdminBridge {
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
  /**
   * Tools already tried in the current fallback chain. Internal.
   *
   * Falling back re-enters `registry.call`, so two tools declaring each other
   * as a fallback recursed until the stack ran out — and every level left an
   * AbortController and a 60-second timer behind it. Carrying the chain makes
   * a cycle a refusal instead of a crash.
   */
  fallbackChain?: readonly string[];
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
  // A STATE-CHANGING request to an external host (POST/PUT/PATCH/DELETE) —
  // separated from plain "network" because these are the calls with
  // consequences outside this machine: money spent on an ad platform, a post
  // published, a CRM record written. Reads are recoverable, these are not, and
  // they are the ones you want to grep for after an unattended run.
  | "network_write"
  | "memory_write"
  | "blocked"
  // User thumbs up/down on an assistant message — the wired source of the
  // §2.10 `acceptance` personal-fitness signal. result "success" = 👍,
  // "error" = 👎; toolName carries the rated message id.
  | "feedback";

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
   * The list is a FLOOR, not a default: a runtime `set_model` picks from it and
   * cannot replace it (F-03 — it used to, silently, at the first hot-swap).
   *
   * When omitted, the trusted set is derived from whatever targets are active at
   * the time, so a `set_model` can point inference anywhere. That is the shipped
   * default; the boundary in that configuration is the host channel carrying
   * `set_model` (loopback + bearer token), not this list.
   */
  trustedBaseUrls?: string[];
  /**
   * Requests-per-minute cap applied to EVERY inference endpoint, overriding the
   * published caps the router knows about (see `DEFAULT_RPM_BY_HOST`). Omit or
   * 0 to use those defaults, which is what you want unless you are on a paid
   * tier with a different limit, or you share one key with something else.
   */
  rateLimitRpm?: number;
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
  /**
   * True when this turn was replayed from episodic memory at session start
   * rather than lived in this session.
   *
   * Local bookkeeping only — no provider ever sees it. It exists so the cost
   * breakdown can tell "what this conversation is doing" apart from "what it
   * costs to remember the last one", which are separate decisions.
   */
  replayed?: boolean;
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

export interface StreamProgressEvent {
  type: "stream_progress";
  sessionId: string;
  phase: "prefill" | "generating";
  elapsedMs: number;
  promptTokens: number;
  tokensGenerated: number;
  tokensPerSec: number;
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
   * Heartbeat progress callback fired by the sidecar's
   * `deadlineController` on a ~750 ms cadence (and once at start so the
   * UI sees activity immediately, even during prefill silence). The
   * agent loop wires this to a `stream_progress` OutboundEvent so the
   * React `events.onStreamProgress` listener can update the live
   * thinking-splitter. Optional — providers no-op when absent.
   *
   * The provider fires this from the deadline controller, NOT from
   * each token: a 200-tok/s model would otherwise spam the UI.
   */
  onProgress?: (event: StreamProgressEvent) => void;
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
   * "The part of this request in front of the conversation does not change —
   * bill it as such."
   *
   * One concept, expressed by each provider in its own dialect: Anthropic gets
   * a `cache_control` breakpoint, a local llama.cpp engine gets `cache_prompt`,
   * OpenAI-compatible endpoints that cache a stable prefix automatically need
   * nothing at all. A provider with no caching ignores it, which is the point —
   * the caller states a fact about the request, not a vendor feature.
   *
   * This is the largest single lever on what an agent costs, because the prefix
   * is not sent once. A turn that makes 28 tool calls is 29 completions, and on
   * a real install the fixed part measured 9,875 tokens — 317,000 of that turn's
   * 337,000 tokens were the same bytes, re-sent and re-billed 29 times.
   *
   * "short" is the ordinary setting. "long" buys a longer retention window at a
   * higher write price and only pays off when a session has gaps between turns.
   * "none" is for one-shot calls with no reusable prefix, where a cache write is
   * pure cost.
   */
  cachePrefix?: "none" | "short" | "long";
  /**
   * What the caller believes it is sending, split into categories, measured
   * with our own tokenizer.
   *
   * Telemetry, never behaviour: no provider sees it and no decision is made
   * from it inside the router. It rides along on the request for one reason —
   * so the two accounts of the same completion land in the SAME row. Written
   * separately and joined on a timestamp, they would be correlated by guess,
   * and a cost table built on a guessed join is worse than none.
   *
   * The two accounts are never mixed. This one is ours and approximate; the
   * provider's `prompt_tokens` is theirs and authoritative.
   */
  promptBreakdown?: import("./memory/working.ts").PromptBreakdown;
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
  /**
   * Prompt tokens served from the provider's cache, and tokens written to it.
   *
   * Reported because a caching feature you cannot see is a caching feature you
   * cannot trust: the failure mode is silent — one byte moves in the prefix,
   * every request pays full price, and nothing anywhere says so. A read count
   * that stays at zero across turns with an unchanged prefix is the symptom.
   *
   * Undefined on providers that report neither.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Prompt tokens that were NOT served from cache — the ones processed, and
   * billed, at full price.
   *
   * Normalized HERE, by each adapter in its own dialect, because the two
   * conventions are opposites and nothing downstream can tell them apart:
   *
   *   OpenAI-compatible — `prompt_tokens` INCLUDES
   *     `prompt_tokens_details.cached_tokens`, so fresh = prompt − cached.
   *   Anthropic — `input_tokens` EXCLUDES both `cache_read_input_tokens` and
   *     `cache_creation_input_tokens`, so fresh = input_tokens, and the total
   *     input actually processed is input + read + creation.
   *
   * A consumer that computes `promptTokens - cacheReadTokens` is therefore
   * right on one provider and wrong on the other, with no way to know which —
   * which is precisely how a cost table ends up ranking the wrong category
   * first. Do not derive this by subtraction anywhere. Read it.
   *
   * Undefined on providers that report no cache information at all: unknown is
   * not zero, and a fresh count of zero would read as "everything was cached".
   */
  freshPromptTokens?: number;
  /**
   * True when the provider reported no usage and these token counts are OUR
   * estimate of our own messages.
   *
   * The fallback has always existed — a turn must not fail because a server was
   * quiet about accounting — but it was indistinguishable from a real answer,
   * and that is how an estimate came to be recorded as "what the provider
   * charged" on every streamed completion for months. Same rule as the cache
   * columns: unknown is not zero, and ours is not theirs.
   */
  tokensEstimated?: boolean;
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
   * parsed (corrupted JSON, e.g. `{"name="read_skill">`). The fragment is
   * scrubbed from `text`, but the loop must NOT treat the turn as a final
   * answer — the model meant to act. The loop feeds back a corrective nudge
   * so the model re-emits a valid call instead of silently stopping mid-task.
   */
  malformedToolCall: boolean;

  /**
   * How many `<tool_call>` blocks in this turn failed to parse while OTHERS in
   * the same turn succeeded. Those calls did NOT run.
   *
   * `malformedToolCall` cannot cover this: it only fires when the turn produced
   * no usable call at all. A mixed batch used to drop the bad blocks silently
   * and report success, so the model believed every call in its batch had run.
   * Observed on the walk-away bench's leads-to-crm task (2026-07-25): the model
   * POSTed three leads in one turn, one parsed, two vanished, and it then told
   * the user "all three POSTs returned 201". Silent partial execution is the
   * worst failure shape for write workloads — the retry that follows creates
   * duplicates. The loop feeds this count back so the model knows what to redo.
   */
  droppedToolCalls: number;
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
  /**
   * Caller-supplied id for this run. Lets a caller that already tracks the
   * child (the notebook's ChildRegistry) use the same id the child's session
   * is built from, so a tool called BY the child can be traced back to the
   * caller's record of it. Omit and one is generated as before.
   */
  subagentId?: string;
  /**
   * Cancellation from the caller. Without it a subagent could not be stopped
   * at all: the user's Stop reaches the PARENT's session controller, and a
   * child runs its own AgentLoop under its own session id, so the abort never
   * arrived. Harmless for `delegate_task`, which at least blocks the parent's
   * turn while it runs — but `rlm()` children run detached in the background,
   * so pressing Stop left two model loops spending money invisibly.
   *
   * Aborting stops the child the same way a user stop does (its loop's own
   * `stop()`), rather than through a second, less-tested cancellation path.
   */
  signal?: AbortSignal;
  /**
   * Observer for the child loop's events (tool_start/tool_done/error…).
   * The delegate tool forwards these as tool_progress on the PARENT's
   * stream so every surface (desktop, TUI, Discord status line) shows
   * what the subagent is doing instead of a silent multi-minute stall.
   */
  onEvent?: (event: OutboundEvent) => void;
}

/** The subagent's outcome. Returned to the parent agent for context. */
export interface SubagentResult {
  /**
   * Terminal status of the subagent run. `cancelled` is its own outcome and
   * not a kind of `failed`: a caller that retries failures must NOT retry a
   * run the user deliberately stopped (see delegate-task.ts).
   */
  status: "completed" | "failed" | "timeout" | "budget_exceeded" | "cancelled";
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
  | "subagent_complete"
  | "after_memory_write";

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
  status: "completed" | "failed" | "timeout" | "budget_exceeded" | "cancelled";
  durationMs: number;
}

/**
 * after_memory_write — fired by MemoryExtractor after every fact
 * persistence to SemanticMemory and after every observation persistence
 * to EpisodicMemory. The Reconciler (Pathway 3 step 2) is the first
 * subscriber; the event is informational (cannot be blocked).
 *
 * Discriminated by `kind`:
 *   - "fact": { key, value } — durable user fact (name, language, …)
 *   - "observation": { obsType, title, concepts } — typed observation
 *     (claude-mem style) for episodic recall and concept-graph linking.
 */
export type AfterMemoryWriteKind = "fact" | "observation";

export interface AfterMemoryWritePayload {
  kind: AfterMemoryWriteKind;
  sessionId: string;
  /** Wall-clock at the moment of the write. `Date.now()` from the extractor. */
  ts: number;
  // For "fact"
  key?: string;
  value?: string;
  // For "observation"
  obsType?: import("./memory/extractor.ts").ObservationType;
  title?: string;
  concepts?: string[];
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
import type { DoneWhen } from "./cron/done-when.ts";

export interface CronRunRecord {
  runAt: number;
  /**
   * `incomplete` = the agent ran but stopped with work outstanding (the turn
   * budget expired, or continuations were exhausted). Distinct from `failed`:
   * there IS usable partial output, and it is delivered — but the run must not
   * count as a success or a job could report finished work it never did.
   */
  status: "success" | "incomplete" | "failed" | "timeout" | "budget_exceeded" | "skipped";
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
  /**
   * Optional mechanical proof that the task is done — see cron/done-when.ts.
   * When present it OVERRIDES the agent's own claim of completion.
   */
  doneWhen?: DoneWhen | null;
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
  doneWhen?: DoneWhen | null;
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
  // `record_turn` files an exchange that happened elsewhere without answering
  // it. A speech-to-speech call is conducted by Gemini, so by the time it ends
  // the user has already been heard and answered; `message` would make the
  // agent reply to a question that is already answered, which is why this is a
  // type of its own rather than a flag on that one.
  type: "message" | "record_turn" | "ping" | "shutdown" | "set_model" | "stop"
    | "ask_user_response" | "ask_user_cancel"
    | "cron_add" | "cron_remove" | "cron_toggle" | "cron_list"
    | "desktop_control_response" | "capability_response" | "admin_response" | "connectors_reload"
    // PROVISIONAL — temporary Settings button to run the Fractal Memory Search
    // benchmark gate on demand. Remove with the button after the ship/hold call.
    | "fractal_benchmark"
    // Reactive-tree drill-down: the host requests the member memories of one
    // top-level cluster; the sidecar replies with a `fractal_cluster_leaves_result`
    // paired by `id`. Reuses the plain `id` field as the request correlator.
    | "fractal_cluster_leaves"
    // RSI engine driver (Faza 1 production wiring) — the Rust host
    // commands the sidecar engine via these messages; the sidecar
    // emits `rsi_engine_event` outbound events to ack + mirror state.
    | "rsi_start" | "rsi_stop" | "rsi_set_concurrency"
    // BRSI §2.8 `user` Wake trigger — the host asks the Dream Cycle to run one
    // episode now, bypassing the idle/cooldown gate (explicit user intent).
    | "rsi_dream_now"
    // Faza 2 Slice 5 — the code-patch approval gate. `list` asks for the
    // pending queue (sidecar replies with one `code_patches` event);
    // `resolve` approves/rejects patch `id` (payload `patchAction`), and an
    // approval also live-applies when FERAL_CODE_RSI_REPO is set. The
    // sidecar replies with `code_patch_resolved` + a refreshed `code_patches`.
    | "rsi_code_patches_list" | "rsi_code_patch_resolve"
    // Faza 4 (L2 LoRA) — the personal-adaptation gate. `train` runs one
    // full candidate cycle (dataset → trainer → paired eval → review card;
    // replies with `lora_train_result` + `lora_reviews`); `list` asks for
    // the review inbox (`lora_reviews`); `resolve` approves/rejects card
    // `id` (payload `loraAction`) — an approval promotes the adapter to
    // domain champion and applies it to the loaded model live.
    | "rsi_lora_train" | "rsi_lora_reviews_list" | "rsi_lora_review_resolve"
    // Faza 6 (L6) Meta Evolution — the host queries/drives the MetaGenome
    // engine; the sidecar replies with one `meta_result` paired by `id`.
    | "meta_status" | "meta_evolve" | "meta_rollback" | "meta_history"
    // Slice A5 (L5 Governance) — host drives the policy FSM through the
    // `GovernanceLifecycle` (see `rsi/governance-lifecycle.ts`). Nine ops,
    // all reply with one `governance_result` paired by `id`. The transport
    // payload fields (`document`, `policyId`, `documentHash`, `layers`,
    // `note`, `reason`, `limit`) are flattened into the inbound message
    // alongside `type` + `id`; missing fields default to sensible empties
    // in the handler (see `index.ts` case "governance_*").
    | "governance_status" | "governance_propose" | "governance_approve" | "governance_reject"
    | "governance_rollback" | "governance_freeze" | "governance_unfreeze" | "governance_verify"
    | "governance_history"
    // Phase B (L4 Architecture Evolution) — host drives the module
    // lifecycle (see `rsi/module-lifecycle.ts`). Three ops, all reply
    // with one `modules_result` paired by `id` (ops: list / resolve /
    // evaluate; watchdog quarantines arrive unpaired as op "quarantined").
    // Payload fields (`moduleId`, `moduleAction`, `seam`, `note`) are
    // flattened into the inbound message alongside `type` + `id`.
    // `module_propose` asks the LOCAL model to author a module candidate
    // for a seam (op "propose"); feed the returned moduleId to
    // `module_evaluate` to run it through the lifecycle.
    | "modules_list" | "module_resolve" | "module_evaluate" | "module_propose"
    // Sprint 1.6 — Memory Resume. The host asks for the persisted
    // `current_task` + active workspace + last-active timestamp; the sidecar
    // replies with one `resume_get_result` paired by `id`. Powers the React
    // WelcomeBack banner + TUI last-task row. Reads from `meta` + `workspaces`
    // only — never writes, so no migration needed on the inbound path.
    | "resume_get"
    // /compact (OpenClaw slash parity) — the host asks the loop to summarize
    // the older portion of one session's transcript NOW (not only when over
    // budget); the sidecar replies with one `compact_result` paired by `id`.
    | "compact_session"
    | "provider_conformance"
    // R5 — MCP over stdin. The host manages `~/.feral/mcp.json` and pokes
    // `mcp_reload` after every change; `mcp_status` / `mcp_list_tools` /
    // `mcp_call_tool` serve the Extensions page's live queries. All four
    // reply with one `mcp_result` paired by `id`. Payload fields
    // (`serverId`, `tool`, `args`) are flattened alongside `type` + `id`.
    | "mcp_reload" | "mcp_status" | "mcp_list_tools" | "mcp_call_tool"
    // Bridge response delivery — every `rsi_request` the sidecar emits
    // is paired with exactly one `rsi_response` line by Rust. Routed
    // to `RsiBridge.onResponse` in the sidecar.
      | "rsi_response"
      // Onboarding mode (Etapa 1): host asks the sidecar to prepare an
      // onboarding profile and session. The sidecar replies with status
      // events and awaits config tools on the special session.
      | "start_onboarding"
      // Onboarding confirmation response: the user's answer to a
      // `confirmation_required` event. `ok` true = allow the gated tool.
      | "tool_confirmation_response"
      // User thumbs up/down on an assistant message. Recorded to the audit
      // log as an actionType "feedback" row, which feeds the §2.10
      // `acceptance` personal-fitness signal. Fire-and-forget (no reply).
      | "feedback";
  id?: string;

  content?: string;
  /** `record_turn` only: what the agent said back. `content` carries what the
   *  user said, so the pair travels in one message and cannot be split by a
   *  crash between two. */
  assistantContent?: string;
  /** `set_model` only: a second configured cloud provider to fail over to. The
   *  host picks it, because it is the side that can read the keychain. Absent
   *  when the user has only one provider set up. */
  fallback?: { provider: string; model: string; baseUrl: string; apiKey?: string };
  sessionId?: string;
  /** RSI start payload (type === "rsi_start"). */
  rsiGoal?: string;
  rsiMaxIterations?: number;
  rsiMaxTotalTokens?: number;
  rsiConcurrency?: number;
  /** RSI set_concurrency payload (type === "rsi_set_concurrency"). */
  rsiNewConcurrency?: number;
  /** Reactive-tree drill-down payload (type === "fractal_cluster_leaves"). */
  clusterIndex?: number;
  /** Approval-gate payload (type === "rsi_code_patch_resolve"); the patch
   *  id rides the plain `id` field. */
  patchAction?: "approve" | "reject";
  /** LoRA gate payloads. `loraAction` rides "rsi_lora_review_resolve" (the
   *  card id on the plain `id` field); `loraDomain` optionally scopes
   *  "rsi_lora_train" (default "general"). */
  loraAction?: "approve" | "reject";
  loraDomain?: string;
  /** Thumbs feedback payload (type === "feedback"). `feedbackMessageId` is the
   *  rated assistant message's id; `feedbackValue` is the vote. */
  feedbackMessageId?: string;
  feedbackValue?: "up" | "down";
  /**
   * RSI response payload (type === "rsi_response") reuses the PLAIN fields
   * `id` (above) and `ok`/`data`/`error` (declared below). Rust's
   * `handle_rsi_request` sends exactly these, mirroring the `rsi_request`
   * envelope. The earlier `rsiRequestId`/`rsiOk`/`rsiData`/`rsiError` names
   * matched nothing Rust sent, so every bridge response was dropped and
   * `embed_text` hung forever.
   */
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
  /**
   * Where this turn's answer will be consumed (type === "message").
   *
   * `"voice"` means it is going to be spoken aloud, which changes what a good
   * answer looks like more than any other surface does: no headings, no lists, no
   * code blocks, and a length someone can listen to instead of skim. Without it a
   * voice call received the desktop's full markdown answer read out loud — 1382
   * characters, 95 seconds of speech, in reply to "what can you do?".
   *
   * Absent (connectors, TUI) leaves whatever brief that surface already set.
   */
  surface?: "voice" | "text";
  // set_model fields (all present when type === "set_model")
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** API key injected by Rust from the BYOK store — never touches React. */
  apiKey?: string;
  /** Active context window (tokens) for a LOCAL model, forwarded by Rust so the
   *  agent compacts to the engine's real KV-cache size. Absent for cloud. */
  contextWindow?: number;
  /** Whether the bundled local engine still has a model resident and may be
   *  used as the degrade-to-local fallback. The desktop UNLOADS the GGUF when
   *  the user switches to a cloud route, so it sends `false` there: keeping the
   *  fallback made every cloud hiccup 503 on "no model selected" AND made the
   *  Rust API lazily re-load the multi-GB model the unload just released.
   *  Absent = unknown; the sidecar keeps its boot-time behaviour. */
  localFallbackAvailable?: boolean;
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
  /**
   * "A human must answer this one." Walk-away mode (FERAL_AUTONOMOUS) answers
   * questions by itself so a long task is not blocked by an absent user; a
   * question marked this way is exempt and waits for a real person, or fails
   * closed when there is nobody to wait for.
   *
   * For decisions where being wrong is not recoverable by re-running: spending
   * money, publishing something public, deleting, sending on someone's behalf.
   *
   * Honest about its limits — this protects against a CONSCIENTIOUS agent's
   * hard calls, not against a confused one. The agent writes the question AND
   * decides whether to set this flag, so an agent that does not realise a
   * decision is expensive simply will not mark it. The guard that does not
   * depend on the agent's judgement is at the egress layer, where writes are
   * counted and sensitive hosts are refused unattended. Both layers exist
   * because each covers the other's blind spot.
   */
  forceEscalate?: boolean;
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
  /**
   * One turn ended. `incomplete: true` means the turn was cut off with work
   * outstanding and an unattended caller may continue it — so a consumer that
   * waits for "the answer" must wait for a `done` WITHOUT it, not the first
   * one it sees. `outcome` is the structured reason (see TurnOutcome).
   */
  | {
      type: "done";
      id: string;
      content: string;
      stopped: boolean;
      traceId: string;
      outcome?: string;
      incomplete?: boolean;
      /**
       * True on the single event that closes an UNATTENDED run, as opposed to
       * one turn inside it. Consumers counting turns must skip it; consumers
       * waiting for the answer must accept it.
       */
      runSummary?: boolean;
    }
  | { type: "tool_start"; id: string; tool: string; args: Record<string, unknown>; traceId: string }
  | { type: "tool_progress"; sessionId: string; tool: string; stage: string; progress: number | null; message: string; data?: unknown; traceId?: string }
  | { type: "tool_done"; id: string; tool: string; result: unknown; traceId?: string }
  | { type: "proactive"; content: string; traceId?: string }
  | { type: "model_set"; provider: string; model: string }
  | { type: "model_error"; message: string; traceId?: string }
  /**
   * Which model this turn is being answered by, and why that one.
   *
   * Emitted on BOTH the success and the failure path, which is the point:
   * automatic model selection used to fail into a `console.warn` and a
   * silent switch to the router's defaults, so a user whose routing broke
   * saw a different model answer with no explanation available anywhere on
   * their screen. Same reasoning as `rate_limited` below — a change the
   * user can feel must be a change the user can read.
   *
   * `reason`:
   *   - `brain`          — Brain scored the candidates and chose this one
   *   - `only_candidate` — exactly one usable model existed
   *   - `fallback`       — routing failed; the router's default was used.
   *                        `detail` carries the real cause for the UI's
   *                        progressive-disclosure "Why?" affordance and is
   *                        never shown in the primary line.
   */
  | {
      type: "model_routed";
      sessionId: string;
      provider: string;
      model: string;
      reason: "brain" | "only_candidate" | "fallback";
      category?: string;
      detail?: string;
      traceId?: string;
    }
  | { type: "pong" }
  | { type: "error"; id?: string; message: string; traceId?: string }
  | { type: "ask_user"; id: string; sessionId: string; questions: AskUserQuestion[]; traceId?: string }
  | { type: "ask_user_cancelled"; id: string; sessionId: string; reason: string; traceId?: string }
  | { type: "usage"; id: string; sessionId: string; promptTokens: number; completionTokens: number; traceId?: string }
  | { type: "budget_warning"; sessionId: string; kind: BudgetExhaustedReason; usage: number; limit: number; percent: number; traceId?: string }
  | { type: "budget_exceeded"; sessionId: string; kind: BudgetExhaustedReason; usage: number; limit: number; message: string; traceId?: string }
  // The next request would exceed the provider's requests-per-minute cap, so
  // it is being held back for `waitMs`. Emitted so the pause is legible: a
  // silent gap of several seconds is indistinguishable from a hung agent.
  | { type: "rate_limited"; sessionId: string; waitMs: number; limitRpm: number; baseUrl: string; traceId?: string }
  /**
   * A background worker spawned by the notebook's `rlm()`.
   *
   * Deliberately NOT `tool_start`/`tool_done`: those belong to a tool call
   * inside a turn, and a worker is the opposite — `rlm()` returns the instant
   * the child is admitted, so the child does all its work AFTER the turn that
   * created it has ended. It therefore carries a sessionId and no message id,
   * like `tool_progress`, and the UI must be able to show it while the agent
   * is otherwise idle.
   *
   * Without this the only trace of a worker was two incidental log lines in
   * the sidecar's stderr: the user saw a turn end normally while two paid
   * model loops ran on invisibly.
   */
  | {
      type: "rlm_child";
      sessionId: string;
      /** The ChildRegistry id — stable for the life of the worker. */
      childId: string;
      /** Human-readable name (`subagent-count-the-files-a1b2`). */
      name: string;
      status: "running" | "completed" | "error" | "cancelled";
      /** What it is doing right now, or why it ended. */
      detail?: string;
      durationMs?: number;
      traceId?: string;
    }
  | { type: "heartbeat"; uptimeMs: number; rssMb: number; activeSessions: number }
  // Heartbeat for in-flight agent inference (mirrors Rust
  // `events::StreamProgressEvent`). Emitted on a ~750 ms cadence so the
  // UI can show live progress instead of a static "Thinking…" black box.
  // The React `events.onStreamProgress` listener filters this kind out of
  // the raw `feral://agent-output` stream. `promptTokens` is set once the
  // provider reports it (cloud: in the final SSE chunk; local: n/a here).
  | {
      type: "stream_progress";
      sessionId: string;
      phase: "prefill" | "generating";
      elapsedMs: number;
      promptTokens?: number;
      tokensGenerated?: number;
      tokensPerSec?: number;
    }
  | { type: "cron_fired"; jobId: string; jobName: string; sessionId: string; content: string; traceId?: string }
  // X3: surfaced when a scheduled job throws or times out — previously cron
  // failures were logged to stderr only and invisible in the UI.
  | { type: "cron_error"; jobId: string; jobName: string; message: string; traceId?: string }
  // Desktop-control bridge request. Handled in the Rust host (not the React
  // UI): the host runs the OS accessibility action behind its security gate
  // and replies on stdin with a `desktop_control_response` carrying this `id`.
  | { type: "desktop_control_request"; id: string; sessionId: string; action: string; params: Record<string, unknown> }
  // RSI engine event — emitted by the sidecar to mirror engine state into
  // Rust (`RsiEngineState`) and to ack in-flight `rsi_start` /
  // `rsi_stop` / `rsi_set_concurrency` commands. Rust reads
  // `event` + `id` (when present) and updates its mirror + fires the
  // matching `oneshot::Sender`.
  | { type: "rsi_engine_event"; event: "started" | "stopped" | "concurrency_set" | "progress" | "stagnation" | "pbt_sync"; id?: string; iteration?: number; bestScore?: number; costSoFarUsd?: number; concurrency?: number; stopReason?: string; reason?: string; killed?: number; creditedId?: string; nextActiveId?: string; replaced?: boolean; genomeId?: string; mutationType?: string; score?: number; tokenCost?: number; durationMs?: number; errored?: boolean; commitHash?: string; previousBest?: number; ratchet?: boolean; cause?: string; died?: boolean; extinction?: boolean; stage?: string }
  // RSI request — emitted by the RsiBridge client. Paired with a
  // matching `rsi_response` inbound line. Rust's `handle_rsi_request`
  // dispatcher writes the response back on stdin.
  | { type: "rsi_request"; id: string; method: string; params: unknown }
  // Capability bridge request — list / inspect / install a capability.
  // Handled in the Rust host, never in the React UI.
  //
  // Note what this event cannot carry: content, metadata, or a trust label.
  // The sidecar sends a NAME. What that name means — which catalogue it came
  // from, how far it is trusted, what bytes reach the disk — is decided on the
  // host side. The agent may request a capability; it may not vouch for one,
  // and it may not authorize its own install.
  | { type: "capability_request"; id: string; sessionId: string; action: string; params: Record<string, unknown> }
  // Admin bridge request — the commands a person would otherwise open a
  // terminal for: update, switch model. Handled in the Rust host, which owns
  // what each action means and whether it is permitted.
  | { type: "admin_request"; id: string; sessionId: string; action: string; params: Record<string, unknown> }
  // Faza 6 (L6) Meta Evolution reply — payload shape depends on `op`
  // (status/evolve/rollback/history); `ok:false` carries a `reason`.
  | { type: "meta_result"; id: string; op: string; ok: boolean; [key: string]: unknown }
  // /compact reply — `result` is "compacted" or "not needed"; `error` set
  // when the summarizer itself failed (ok=false).
  | { type: "compact_result"; id: string; ok: boolean; result?: string; error?: string }
  /**
   * Result of the provider conformance probe (egress/conformance.ts).
   * `ready: false` means the configured model cannot emit a tool call the agent
   * can parse — it will answer chat and silently narrate actions instead of
   * taking them, so setup must not present it as working.
   */
  | {
      type: "provider_conformance_result";
      id: string;
      ok: boolean;
      ready: boolean;
      summary: string;
      probes: Array<{ id: string; title: string; passed: boolean; detail: string }>;
    }
  // Slice A5 (L5 Governance) reply — payload shape depends on `op`
  // (status/propose/approve/reject/rollback/freeze/unfreeze/verify/history);
  // always `ok:boolean` so the gateway + CLI can route without knowing the
  // op-specific extra fields. `ok:false` carries a `reason`. The
  // `documentHash` field is echoed by the `approve` handler when the
  // caller omits it, so the CLI's plain `feral governance approve <id>`
  // (which doesn't compute the sha256 itself) still gets a verifiable
  // record.
  | {
      type: "governance_result";
      id: string;
      op: string;
      ok: boolean;
      reason?: string;
      documentHash?: string;
      [key: string]: unknown;
    }
  // Phase B (L4 Architecture Evolution) reply — payload shape depends on
  // `op` (list/resolve/evaluate); watchdog auto-quarantine arrives as an
  // UNPAIRED `op:"quarantined"` row (empty `id`) so the desktop toast can
  // fire without a request in flight. `ok:false` carries a `reason`.
  | {
      type: "modules_result";
      id: string;
      op: string;
      ok: boolean;
      reason?: string;
      [key: string]: unknown;
    }
  // R5 — MCP reply. Payload depends on `op`: reload/status carry
  // `servers` (per-config rows: id/running/toolCount/error?), list_tools
  // carries `tools` (name/description), call_tool carries `result`
  // (already-flattened text). `ok:false` carries `error` (raw — the Rust
  // host humanizes before the frontend sees it).
  | {
      type: "mcp_result";
      id: string;
      op: string;
      ok: boolean;
      error?: string;
      [key: string]: unknown;
    }
  // Sprint 1.6 — Memory Resume reply. Mirrors the Rust `LastTaskView`
  // wire shape (snake_case keys): `task` is null on first launch,
  // `workspace_id` + `workspace_name` are the active workspace,
  // `last_active_at` is the unix-ms of the most recent turn. The Tauri
  // command `get_last_task` and the gateway `/runtime/resume` route
  // both deserialize this shape verbatim.
  | {
      type: "resume_get_result";
      id: string;
      task: { title: string; ts: number; workspace_id?: string | null } | null;
      workspace_id: string | null;
      workspace_name: string | null;
      last_active_at: number | null;
    }
  // PROVISIONAL — temporary progress + result events for the Settings
  // Fractal Benchmark button. The sidecar emits any number of
  // `fractal_bench_progress` lines while the bench runs (so the panel
  // can show "generating queries 4/12" instead of an opaque spinner),
  // and exactly ONE `fractal_bench_result` per click — `ok:false` on
  // any error path (timeout, no tree, throw) and `ok:true` on a normal
  // report. Remove with the button after the ship/hold decision.
  | {
      type: "fractal_bench_progress";
      kind: "generate_queries" | "run_queries";
      current: number;
      total: number;
      message: string;
    }
  | {
      type: "fractal_bench_result";
      ok: boolean;
      // ok:false path — at least one of `error` / `phase` is set.
      error?: string;
      phase?: "build" | "queries" | "run";
      // ok:true path — the full report payload.
      ship?: boolean;
      reasons?: string[];
      n?: number;
      k?: number;
      fractalRecall?: number;
      ftsRecall?: number;
      fractalP99Ms?: number;
      ftsP99Ms?: number;
      path?: string;
    }
  // Faza 2 Slice 5 — the code-patch approval gate (frozen IPC for the
  // Dreams-panel "Pending patches" card). `code_patches` is the full queue
  // (sent on `rsi_code_patches_list` and after every resolution);
  // `code_patch_resolved` acks one `rsi_code_patch_resolve`. `status`
  // values: pending | approved | rejected | applied | apply_failed |
  // reverted — an approval auto-applies when the host repo is configured,
  // so the ack usually reports "applied" or "apply_failed", and "approved"
  // only when live apply is unavailable (no FERAL_CODE_RSI_REPO).
  | {
      type: "code_patches";
      patches: Array<{
        id: string;
        status: string;
        score: number;
        rationale: string;
        affectedFiles: string[];
        /** The unified diff itself — the card renders it for review. */
        patch: string;
        commitHash: string;
        createdAt: number;
        note?: string;
      }>;
      /** True while the first-10 window is open (spec §2.5): every apply
       *  needs an explicit human approval. */
      manualWindowOpen: boolean;
      appliedCount: number;
    }
  | {
      type: "code_patch_resolved";
      id: string;
      status: string;
      error?: string;
    }
  // Faza 4 (L2 LoRA) — the personal-adaptation review gate. `lora_reviews`
  // is the full inbox + per-domain champions (sent on `rsi_lora_reviews_list`
  // and after every train/resolve); `lora_review_resolved` acks one
  // `rsi_lora_review_resolve`; `lora_train_result` reports one training
  // cycle (ok:false = infra failure — trainer unavailable, train/eval error).
  | {
      type: "lora_reviews";
      reviews: Array<{
        id: string;
        domain: string;
        /** Card status: pending | approved | rejected. */
        status: string;
        /** Gate verdict: recommend_promote | reject | insufficient_evidence. */
        verdict: string;
        reason: string;
        metrics: Record<string, number>;
        adapterPath: string;
        baseModel: string;
        createdAt: number;
      }>;
      champions: Array<{ domain: string; id: string; adapterPath: string }>;
      /** Slice 5 dashboard aggregates (see `LoraStats` in lora-pipeline.ts). */
      stats: {
        adapters: number;
        datasets: number;
        pendingReviews: number;
        champions: number;
        rollbacks: number;
        acceptanceRate: number | null;
        averageGain: number | null;
        trainingMsTotal: number;
      };
    }
  | {
      type: "lora_review_resolved";
      id: string;
      status: string;
      error?: string;
    }
  | {
      type: "lora_train_result";
      ok: boolean;
      reason?: string;
      adapterId?: string;
      verdict?: string;
    }
  // Living-organism pulses. Forwarded verbatim over `feral://agent-output`
  // so the React `events.onFractalActivity` listener can route each kind
  // into the Mandelbrot renderer. The sidecar never enriches these — only
  // the `kind` discriminator + the kind-specific fields.
  | {
      type: "fractal_activity";
      kind: "recall" | "grow" | "seed" | "prune";
      hits?: number;
      leafCount?: number;
      clusterCount?: number;
      clusters?: { x: number; y: number; weight: number }[];
      leafId?: number;
      sessionId?: string;
      evictedLeafIds?: number[];
      ts?: number;
      clusterIndex?: number;
    }
  // Reactive-tree drill-down response: the real member memories of one
  // top-level cluster, paired by `id` with the `fractal_cluster_leaves`
  // request Rust forwarded. Feeds the zoom-reveal + leaf card.
  | {
      type: "fractal_cluster_leaves_result";
      id: string;
      leaves: { leafId: number; text: string; ts: number }[];
    }
  // Dream Cycle lifecycle — emitted by the host when an evolutionary episode
  // starts (`phase:"started"`) and ends (`phase:"ended"`). Forwarded verbatim
  // over `feral://agent-output` so the React `events.onDreamCycle` listener can
  // raise a toast and put the typing-bar mascot into its `dreaming` pose.
  | {
      type: "dream_cycle";
      /** Coarse envelope for the UI toast + mascot `dreaming` pose: present on
       *  the wake ("started") and sleep ("ended") transitions only. Absent on
       *  the intermediate stage pulses so existing consumers that key on
       *  started/ended ignore them. */
      phase?: "started" | "ended";
      /** Fine 7-stage FSM transition (BRSI §2.8 Wake→Observe→Dream→Mutate→
       *  Evaluate→Remember→Sleep). Present on every stage pulse; `dream` /
       *  `mutate` are subsumed by the engine episode in Faza 1 (reserved). */
      stage?: "wake" | "observe" | "dream" | "mutate" | "evaluate" | "remember" | "sleep";
      trigger: "idle" | "error" | "schedule" | "user" | "threshold" | "budget_available";
      iterations?: number;
      ratchets?: number;
      stopReason?: string;
    }
  // ─── AI-Guided Onboarding (Etapa 1, ADR-0013) ─────────────────────────────
  // Domain events emitted by the config tools in tools/builtin/config/. The
  // TUI renders each directly (no generic "config_changed" parsing) so the
  // onboarding chat can show "provider added", "connector connected",
  // "download 47%", etc. as concise status lines and cards.
  //
  // Every config tool is gated by a `confirmation_required` ↔
  // `tool_confirmation_response` round-trip (see the gate in agent-loop's
  // #run): the model proposes, the user approves, the tool executes, the
  // domain event fires. The `requestId` correlates the request with the
  // user's reply.
  // Provider config.
  | { type: "provider_added"; id: string; model?: string }
  | { type: "provider_removed"; id: string }
  | { type: "provider_validated"; id: string; ok: boolean; error?: string; models?: string[] }
  | { type: "provider_validation_failed"; id: string; error: string }
  // Connector lifecycle. `qrPending` lets the TUI render a QR placeholder
  // until the backend returns the real payload.
  | { type: "connector_configured"; id: string; enabled: boolean; qrPending?: boolean }
  | { type: "connector_connected"; id: string }
  | { type: "connector_disconnected"; id: string }
  | { type: "connector_connection_failed"; id: string; error: string }
  // Memory mode (private | hybrid | cloud).
  | { type: "memory_mode_changed"; mode: "private" | "hybrid" | "cloud" }
  // Permission gate toggle (e.g. "shell_exec", "computer_use", "desktop_notify").
  | { type: "permission_changed"; key: string; value: boolean }
  // Model download lifecycle. Progress is emitted on the gateway's cadence;
  // the TUI maps it to a percent + ETA strip.
  | { type: "model_download_started"; model: string }
  | { type: "model_download_progress"; model: string; bytesDone: number; bytesTotal: number; mbps: number }
  | { type: "model_download_finished"; model: string }
  | { type: "model_download_failed"; model: string; error: string }
  // Onboarding flow state. `wizard_step_completed` marks one wizard screen
  // done; `onboarding_goal_completed` reports the goal set progress; the
  // session emits `onboarding_all_goals_done` once when every required goal
  // is met (connectors optional). `onboarding_suggestion` is the sidecar's
  // nudge text surfaced to the user (suggested next action, with optional
  // quick-reply action labels the TUI renders as chips).
  | { type: "wizard_step_completed"; step: string }
  | { type: "onboarding_goal_completed"; goal: string; completed: string[]; pending: string[] }
  | { type: "onboarding_all_goals_done" }
  | { type: "onboarding_suggestion"; text: string; actions?: string[] }
  // Confirmation gate. Emitted by agent-loop's #run when a tool whose profile
  // marks it `requiresConfirmation` is about to run. The TUI shows the args +
  // reason and replies with `tool_confirmation_response` carrying the same
  // `requestId` and `ok` (true = run, false = deny). `confirmation_granted` /
  // `confirmation_denied` are emitted back so other observers (and tests) can
  // see the verdict alongside the tool's own domain event.
  | { type: "confirmation_required"; tool: string; args: Record<string, unknown>; reason: string; requestId: string }
  | { type: "confirmation_granted"; requestId: string }
  | { type: "confirmation_denied"; requestId: string; reason?: string };

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
  /**
   * Stored 384-dim L2-normalized embedding (raw little-endian f32 bytes).
   * Populated by `EpisodicMemory.all()` when the row already has a vector in
   * SQLite — `undefined` for rows that haven't been embedded yet (older rows,
   * or ones enqueued for a backfill). Optional so legacy callers don't have
   * to change.
   */
  embedding?: Float32Array;
}
