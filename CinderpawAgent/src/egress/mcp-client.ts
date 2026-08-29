/**
 * MCP (Model Context Protocol) stdio client.
 *
 * Launches an external MCP server as a subprocess, runs the JSON-RPC 2.0
 * initialize handshake, discovers tools via tools/list, and wraps them as
 * Cinderpaw Tool instances that can be registered directly in ToolRegistry.
 *
 * Architecture:
 *   MCPClient owns the server process. MCP tool calls go through the client's
 *   callTool() method — no direct process:spawn permission is needed per tool.
 *   The client is itself sandboxed: it is created by index.ts with explicit
 *   configuration (command, args, allowed domains), not by agent-accessible code.
 *
 * Dynamic sandbox mapping:
 *   Discovered tools are wrapped with a ToolManifest that reflects their actual
 *   capabilities. Network-capable MCP servers get network:outbound; file-system
 *   servers get fs:read + fs:write with the declared roots. Unknown servers get
 *   the conservative default (no permissions declared, no network, no fs access).
 *   All tool calls are audited via the registry's normal pipeline (circuit breaker,
 *   retry, hooks) because the wrappers implement the Tool interface.
 */

import type { AuditLogger, Tool, ToolContext, ToolManifest, ToolParameter, ToolResult } from "../types.ts";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// MCP protocol shapes (subset used for tool discovery + invocation)
// ---------------------------------------------------------------------------

export interface MCPToolInputSchema {
  type: string;
  properties?: Record<string, { type?: string; description?: string; [k: string]: unknown }>;
  required?: string[];
  /** Sibling definitions that `$ref` pointers inside `properties` resolve against.
   *  Every pydantic-generated schema puts nested models here. */
  $defs?: Record<string, unknown>;
  definitions?: Record<string, unknown>;
}

export interface MCPToolDef {
  name: string;
  description?: string;
  inputSchema: MCPToolInputSchema;
}

interface MCPCallToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Permissions hint for wrapping discovered tools
// ---------------------------------------------------------------------------

/**
 * Caller-supplied hints about what permissions a particular MCP server needs.
 * The sandbox respects these at tool-registration time; tools only ever receive
 * what is declared here. When omitted, the conservative no-permission default
 * is used (suitable for pure compute / in-process MCP servers).
 */
export interface MCPServerPermissions {
  /** Server can make outbound HTTP requests. */
  networkOutbound?: boolean;
  /** Allowed domains for network access (only effective when networkOutbound). */
  allowedDomains?: string[];
  /** Server reads from these filesystem roots. */
  fsReadRoots?: string[];
  /** Server writes to these filesystem roots. */
  fsWriteRoots?: string[];
}

// ---------------------------------------------------------------------------
// MCPClient
// ---------------------------------------------------------------------------

export interface MCPClientConfig {
  /** The executable to launch (absolute path or PATH-resolvable name). */
  command: string;
  /** Arguments passed to the server process. */
  args?: string[];
  /**
   * Extra environment variables for the server process. Combined with a
   * safe base env (PATH, HOME, LANG). Blocked prefixes (LD_, DYLD_, NODE_)
   * are stripped so a rogue MCP server config cannot inject shared libraries.
   */
  env?: Record<string, string>;
  /**
   * How long to wait for the initialize handshake (default 90 s).
   *
   * This budget covers a COLD `npx -y <pkg>` on a machine that has never
   * run the extension: npm resolves and downloads the package before the
   * server prints its first byte, which routinely takes far longer than the
   * handshake itself. The old 10 s default was survivable only with a warm
   * npm cache — i.e. on a machine where the extension had already been
   * installed once — so on a fresh install every extension "timed out"
   * regardless of whether it worked. Boot reconcile is fire-and-forget and
   * `McpManager.ready()` caps its own wait at 3 s, so a slow server delays
   * nothing except the install call that asked for it.
   */
  initTimeoutMs?: number;
  /** How long to wait for each tool call (default 30 s). */
  callTimeoutMs?: number;
  /** Sandbox permissions to grant wrapped tools. Conservative by default. */
  permissions?: MCPServerPermissions;
}

const BLOCKED_ENV_PREFIXES = ["LD_", "DYLD_", "NODE_", "PYTHONPATH"];

export class MCPClient {
  readonly #config: Required<MCPClientConfig>;
  readonly #audit: AuditLogger;

  #proc: ReturnType<typeof Bun.spawn> | null = null;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #nextId = 1;
  #buf = "";
  #connected = false;
  /**
   * Tail of the server's stderr. `Bun.spawn` gives us a stderr pipe that
   * nothing used to read, so the ONE line that says what actually went
   * wrong — `npm error 404 Not Found`, `Missing API key`, a stack trace —
   * drained into a buffer no human ever saw, and every failure surfaced to
   * the user as a bare handshake timeout. Kept bounded; attached to the
   * connect error so the desktop can humanize the real cause.
   */
  #stderrTail = "";

  constructor(config: MCPClientConfig, audit: AuditLogger) {
    this.#audit = audit;
    this.#config = {
      command: config.command,
      args: config.args ?? [],
      env: config.env ?? {},
      initTimeoutMs: config.initTimeoutMs ?? 90_000,
      callTimeoutMs: config.callTimeoutMs ?? 30_000,
      permissions: config.permissions ?? {},
    };
  }

  get connected(): boolean {
    return this.#connected;
  }

  /**
   * Launch the MCP server and complete the initialize handshake.
   * Must be called before listTools() or callTool().
   */
  async connect(): Promise<void> {
    if (this.#connected) return;

    const safeEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? (process.env.USERPROFILE ?? ""),
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    for (const [k, v] of Object.entries(this.#config.env)) {
      if (BLOCKED_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
      safeEnv[k] = v;
    }

    this.#proc = Bun.spawn({
      cmd: [this.#config.command, ...this.#config.args],
      env: safeEnv,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Start background reader that dispatches incoming JSON-RPC lines.
    // Fire-and-forget: it runs until the process's stdout closes; #readLoop
    // catches its own errors, so the promise never rejects unhandled.
    void this.#readLoop();
    void this.#drainStderr();

    // Run MCP initialize handshake. On failure, re-throw with the server's
    // own stderr appended — that text is the only place the real reason
    // (missing package, bad key, crash) ever appears.
    let initResult: unknown;
    try {
      initResult = await this.#rpc(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "cinderpaw-agent", version: "1.0.0" },
        },
        this.#config.initTimeoutMs,
      );
    } catch (err) {
      throw new Error(this.#withStderr(String(err)));
    }

    if (!initResult || typeof initResult !== "object") {
      throw new Error(this.#withStderr("MCP initialize returned unexpected result"));
    }

    // Send initialized notification (required by MCP spec).
    this.#notify("notifications/initialized", {});

    this.#connected = true;

    this.#audit({
      timestamp: Date.now(),
      sessionId: "mcp",
      actionType: "tool_call",
      toolName: `mcp:${this.#config.command}`,
      result: "success",
    });
  }

  /** Discover all tools exposed by the server. */
  async listTools(): Promise<MCPToolDef[]> {
    this.#assertConnected();
    const result = await this.#rpc("tools/list", {}, this.#config.callTimeoutMs);
    const tools = (result as { tools?: MCPToolDef[] })?.tools ?? [];
    return tools;
  }

  /**
   * Invoke a tool on the MCP server. Returns the text content of the result
   * or throws on protocol/tool error.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.#assertConnected();
    const result = (await this.#rpc(
      "tools/call",
      { name, arguments: args },
      this.#config.callTimeoutMs,
    )) as MCPCallToolResult | null;

    if (!result) return "";

    if (result.isError) {
      const errText = result.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n") ?? "MCP tool returned an error";
      throw new Error(errText);
    }

    return (
      result.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n") ?? ""
    );
  }

  /** Terminate the server process and clean up. */
  async disconnect(): Promise<void> {
    this.#connected = false;
    if (this.#proc) {
      try {
        this.#proc.kill();
        await this.#proc.exited;
      } catch {
        /* already dead */
      }
      this.#proc = null;
    }
    // Reject all pending RPCs.
    for (const { reject } of this.#pending.values()) {
      reject(new Error("MCPClient disconnected"));
    }
    this.#pending.clear();
  }

  /**
   * Discover tools from the server and return them as Cinderpaw Tool instances
   * ready to be passed to ToolRegistry.register(). Each tool is sandboxed
   * according to the MCPServerPermissions declared at construction time.
   */
  async buildTools(): Promise<Tool[]> {
    const defs = await this.listTools();
    return defs.map((def) => this.#wrapTool(def));
  }

  // ---------------------------------------------------------------------------
  // Internal: tool wrapping
  // ---------------------------------------------------------------------------

  #wrapTool(def: MCPToolDef): Tool {
    const perms = this.#config.permissions;
    const permissions: ToolManifest["permissions"] = [];
    if (perms.networkOutbound) permissions.push("network:outbound");
    if (perms.fsReadRoots && perms.fsReadRoots.length > 0) permissions.push("fs:read");
    if (perms.fsWriteRoots && perms.fsWriteRoots.length > 0) permissions.push("fs:write");

    const allowedPaths: string[] = [
      ...(perms.fsReadRoots ?? []),
      ...(perms.fsWriteRoots ?? []),
    ];

    const manifest: ToolManifest = {
      name: `mcp_${def.name}`,
      description: def.description ?? `MCP tool: ${def.name}`,
      permissions,
      networkAccess: perms.networkOutbound ?? false,
      allowedDomains: perms.allowedDomains,
      allowedPaths: allowedPaths.length > 0 ? allowedPaths : undefined,
    };

    const parameters = schemaToParameters(def.inputSchema);

    const client = this;
    const execute = async (
      args: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> => {
      try {
        const text = await client.callTool(def.name, args);
        return { ok: true, content: text || "(no output)" };
      } catch (err) {
        return {
          ok: false,
          content: `MCP tool "${def.name}" failed: ${String(err)}`,
          error: "execution_error",
        };
      }
    };

    return { manifest, parameters, execute };
  }

  // ---------------------------------------------------------------------------
  // Internal: JSON-RPC transport
  // ---------------------------------------------------------------------------

  /** Keep the last ~2 KB of the server's stderr for error reporting. */
  async #drainStderr(): Promise<void> {
    const stderr = this.#proc?.stderr;
    if (!stderr || typeof (stderr as ReadableStream<Uint8Array>).getReader !== "function") return;
    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#stderrTail = (this.#stderrTail + decoder.decode(value, { stream: true })).slice(-2048);
      }
    } catch {
      /* proc died */
    } finally {
      reader.releaseLock();
    }
  }

  /** Append the stderr tail to `message` so the real cause travels with it. */
  #withStderr(message: string): string {
    const tail = this.#stderrTail.trim();
    return tail ? `${message} — server said: ${tail}` : message;
  }

  async #readLoop(): Promise<void> {
    const proc = this.#proc;
    if (!proc?.stdout) return;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buf += decoder.decode(value, { stream: true });

        const lines = this.#buf.split("\n");
        this.#buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          this.#dispatch(trimmed);
        }
      }
    } catch {
      /* proc died */
    } finally {
      reader.releaseLock();
    }
  }

  #dispatch(line: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Notifications have no id — ignore for now (could be used for progress).
    if (!("id" in msg)) return;

    const resp = msg as JsonRpcResponse;
    const pending = this.#pending.get(resp.id);
    if (!pending) return;
    this.#pending.delete(resp.id);

    if (resp.error) {
      pending.reject(
        new Error(`MCP error ${resp.error.code}: ${resp.error.message}`),
      );
    } else {
      pending.resolve(resp.result ?? null);
    }
  }

  #rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP RPC "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.#send(request);
    });
  }

  #notify(method: string, params: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.#send(notification);
  }

  #send(msg: unknown): void {
    const proc = this.#proc;
    if (!proc?.stdin) return;
    const line = JSON.stringify(msg) + "\n";
    const stdin = proc.stdin as { write(data: string): void };
    stdin.write(line);
  }

  #assertConnected(): void {
    if (!this.#connected) {
      throw new Error("MCPClient is not connected — call connect() first");
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an external JSON-Schema tool definition into registry parameters.
 *
 * Exported because it is not MCP-specific: anything handing us JSON Schema
 * (an MCP server, a host lending the agent its own tools — see
 * `core/host-tool-bridge.ts`) needs exactly this conversion, and a second copy
 * would be a second place for the nesting bug below to come back.
 *
 * `schema` is carried through VERBATIM, which is the whole point. The flat
 * `{type, description}` pair is all the text-prompt path needs, but in
 * native-tools mode the docs are stripped from the system prompt and the model
 * sees only what lands in `ToolParameter.schema` (see its doc comment). Without
 * it, a parameter like airline's `passengers` — an array of objects with three
 * required fields — reaches the model as the bare word "array" and it has to
 * invent the item shape. That is the documented main source of bad_args, and
 * every pydantic-generated server hits it, not just tau2.
 *
 * `$ref`/`$defs` are inlined rather than passed through, because the refs point
 * at a `$defs` block that lives on the schema ROOT while each parameter's
 * schema is handed over as a detached subtree — the pointer would dangle and
 * the model would see `{"$ref": "#/$defs/Passenger"}`, which is strictly worse
 * than the bare type it replaced.
 */
export function schemaToParameters(
  schema: MCPToolInputSchema,
): Record<string, ToolParameter> {
  const params: Record<string, ToolParameter> = {};
  if (!schema.properties) return params;

  const defs = (schema.$defs ?? schema.definitions ?? {}) as Record<string, unknown>;
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties)) {
    const inlined = inlineRefs(prop, defs) as { type?: unknown; description?: string };
    const rawType = typeof inlined.type === "string" ? inlined.type : "string";
    const type = normalizeType(rawType);
    params[key] = {
      type,
      description: prop.description ?? key,
      required: required.has(key) ? true : false,
      schema: inlined as Record<string, unknown>,
    };
  }
  return params;
}

/**
 * Replace every `{"$ref": "#/$defs/Name"}` with the definition it names.
 *
 * `seen` breaks reference cycles: a self-referential model (a tree node, a
 * linked list) is legal JSON Schema and would otherwise recurse until the stack
 * gives out — taking down the whole sidecar at tool-registration time, on a
 * schema the server is entitled to send. A cycle degrades to a plain object,
 * which loses detail but keeps the agent running.
 */
function inlineRefs(node: unknown, defs: Record<string, unknown>, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, seen));
  if (!node || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const ref = obj.$ref;
  if (typeof ref === "string") {
    const name = ref.replace(/^#\/(?:\$defs|definitions)\//, "");
    if (seen.has(name)) return { type: "object" };
    const target = defs[name];
    if (target === undefined) return { type: "object" };
    // Any siblings of `$ref` (a local `description`, say) stay and win.
    const { $ref: _drop, ...rest } = obj;
    return {
      ...(inlineRefs(target, defs, new Set([...seen, name])) as Record<string, unknown>),
      ...rest,
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    // `$defs` itself is scaffolding for the refs we just inlined.
    if (k === "$defs" || k === "definitions") continue;
    out[k] = inlineRefs(v, defs, seen);
  }
  return out;
}

function normalizeType(
  raw: string,
): "string" | "number" | "boolean" | "object" | "array" {
  switch (raw) {
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return "string";
  }
}
