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
  /** Only meaningful when fs permissions are present. */
  allowedPaths?: string[];
  /**
   * Only meaningful when the `process:spawn` permission is present.
   * Allowlist of executables the tool may invoke. Each entry is either an
   * absolute path (e.g. "/usr/bin/git") or a bare command name resolved via
   * PATH at registration time (e.g. "git"). The ProcessSandbox refuses
   * any executable not in this list.
   */
  allowedExecutables?: string[];
}

/** JSON Schema-ish parameter description surfaced to the LLM. */
export interface ToolParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
}

/** Context handed to a tool when it executes. */
export interface ToolContext {
  sessionId: string;
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
   * Interactive-questions bridge. Present only when the transport supports
   * ask_user (Tauri does). Tools that emit questions (currently just
   * `ask_user`) call `ctx.askUser.ask(questions)` and await the user's
   * selection; the bridge emits an `ask_user` event, waits for the matching
   * `ask_user_response`, and resolves. Undefined for transports that do
   * not support interactive questions.
   */
  askUser?: AskUserBridge;
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
   * Rejects with `AskUserTimeoutError` after 5 minutes.
   */
  ask(questions: AskUserQuestion[]): Promise<AskUserAnswer[]>;
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
}

export interface InferenceRequest {
  sessionId: string;
  messages: ChatMessage[];
  /** Soft cap for this single completion. */
  maxTokens?: number;
  temperature?: number;
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
}

export interface InferenceResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  /** True when the primary target failed and the fallback served the request. */
  usedFallback: boolean;
}

export type BudgetExhaustedReason = "conversation" | "day";

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
  type: "message" | "ping" | "shutdown" | "set_model" | "ask_user_response";
  id?: string;
  content?: string;
  sessionId?: string;
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
  | { type: "chunk"; id: string; content: string }
  | { type: "done"; id: string; content: string; stopped: boolean }
  | { type: "tool_start"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_done"; id: string; tool: string; result: unknown }
  | { type: "proactive"; content: string }
  | { type: "model_set"; provider: string; model: string }
  | { type: "model_error"; message: string }
  | { type: "pong" }
  | { type: "error"; id?: string; message: string }
  | { type: "ask_user"; id: string; sessionId: string; questions: AskUserQuestion[] }
  | { type: "ask_user_cancelled"; id: string; sessionId: string; reason: string };

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
