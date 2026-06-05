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
// Transports
// ---------------------------------------------------------------------------

/** Inbound message envelope from any transport. */
export interface InboundMessage {
  type: "message" | "ping" | "shutdown" | "set_model";
  id?: string;
  content?: string;
  sessionId?: string;
  // set_model fields (all present when type === "set_model")
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** API key injected by Rust from the BYOK store — never touches React. */
  apiKey?: string;
}

/** Outbound event envelope to any transport. */
export type OutboundEvent =
  | { type: "chunk"; id: string; content: string }
  | { type: "done"; id: string; content: string }
  | { type: "tool_start"; id: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_done"; id: string; tool: string; result: unknown }
  | { type: "proactive"; content: string }
  | { type: "model_set"; provider: string; model: string }
  | { type: "model_error"; message: string }
  | { type: "pong" }
  | { type: "error"; id?: string; message: string };

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
