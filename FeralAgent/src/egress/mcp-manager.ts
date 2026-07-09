/**
 * MCP manager — the single owner of live MCP server connections (R5,
 * docs/2026-07-09-v1-architecture-hardening-spec.md).
 *
 * Before R5 there were two MCP stacks: rmcp in the Rust desktop host
 * (Extensions page) and this sidecar's MCPClient (never wired — the agent
 * could not use MCP tools at all). Now the sidecar owns every connection:
 *
 *   - Config stays Rust-owned: the desktop writes `~/.feral/mcp.json`
 *     (install / enable / remove) and pokes `mcp_reload` over stdin —
 *     the same discipline as `connectors_reload`.
 *   - `reconcile()` diffs that config against live connections: spawns
 *     newly-enabled servers, tears down disabled/removed ones, and
 *     registers each server's discovered tools in the ToolRegistry so
 *     the AGENT can call them (named `mcp_<tool>`, drawer-tier — see
 *     tools/tiers.ts).
 *   - The Extensions page's live data (running state, tool lists,
 *     manual tool calls) is served over stdin request/response
 *     (`mcp_status` / `mcp_list_tools` / `mcp_call_tool` → `mcp_result`),
 *     so the desktop never opens a second connection to the same server
 *     (double-spawned MCP servers were the failure mode of keeping both
 *     stacks).
 *
 * Windows spawn discipline mirrors the old Rust side exactly: `npx`/`node`
 * are `.cmd` shims CreateProcess can't exec, so we route through
 * `cmd /c` — and because cmd.exe re-parses its command line, configs
 * carrying shell metacharacters are rejected before spawn (BatBadBut,
 * CVE-2024-24576 defense-in-depth). Those tests moved here from
 * `src-tauri/src/mcp.rs` and must never be relaxed without a security
 * review.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { MCPClient } from "./mcp-client.ts";
import type { AuditLogger } from "../types.ts";
import type { ToolRegistry } from "../tools/registry.ts";

/** Mirrors `McpServerConfig` in `src-tauri/src/mcp.rs` (serde field names). */
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  category?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface McpServerStatus {
  id: string;
  running: boolean;
  toolCount: number;
  /** Humanizable raw error from the last connect attempt, if it failed. */
  error?: string;
}

/** Default config path — the file `src-tauri/src/mcp.rs` persists. */
export function defaultMcpConfigPath(): string {
  const feralHome = process.env.FERAL_HOME ?? join(homedir(), ".feral");
  return join(feralHome, "mcp.json");
}

/** Tolerant loader: missing / malformed file → empty list (an unreadable
 *  extensions config must never take the agent down). */
export function loadMcpConfig(path: string = defaultMcpConfigPath()): McpServerConfig[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { servers?: unknown };
    if (!Array.isArray(parsed.servers)) return [];
    return parsed.servers.filter(
      (s): s is McpServerConfig =>
        !!s &&
        typeof (s as McpServerConfig).id === "string" &&
        typeof (s as McpServerConfig).command === "string" &&
        Array.isArray((s as McpServerConfig).args),
    );
  } catch {
    return [];
  }
}

/**
 * Reject command/args carrying cmd.exe metacharacters before a Windows
 * spawn (we route through `cmd /c`, which re-parses its command line).
 * `%` blocks env-var smuggling (`%PATH%`); `(`/`)` stay allowed — they
 * appear in real paths (`C:\Program Files (x86)\…`). Ported verbatim
 * from the Rust denylist in src-tauri/src/mcp.rs.
 */
export function hasWindowsMetachars(token: string): boolean {
  for (const c of token) {
    if (
      c === "&" || c === "|" || c === "<" || c === ">" ||
      c === "^" || c === "%" || c === "\n" || c === "\r" || c === "\0"
    ) {
      return true;
    }
  }
  return false;
}

/** Build the (command, args) pair actually spawned for a server config. */
export function spawnSpecFor(
  server: Pick<McpServerConfig, "command" | "args">,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", server.command, ...server.args] };
  }
  return { command: server.command, args: server.args };
}

interface RunningServer {
  client: MCPClient;
  /** Tool names this server registered, for unregistration on teardown. */
  toolNames: string[];
}

export class McpManager {
  readonly #registry: ToolRegistry;
  readonly #audit: AuditLogger;
  readonly #configPath: string;
  readonly #running = new Map<string, RunningServer>();
  /** Last connect error per server id (cleared on successful connect). */
  readonly #errors = new Map<string, string>();
  /** Serializes reconcile() calls — a reload poke arriving while a slow
   *  server is still connecting must not double-spawn it. */
  #reconciling: Promise<void> = Promise.resolve();

  constructor(registry: ToolRegistry, audit: AuditLogger, configPath?: string) {
    this.#registry = registry;
    this.#audit = audit;
    this.#configPath = configPath ?? defaultMcpConfigPath();
  }

  /** Diff config against live connections; spawn / tear down / register. */
  reconcile(): Promise<void> {
    this.#reconciling = this.#reconciling.then(() => this.#reconcileOnce());
    return this.#reconciling;
  }

  async #reconcileOnce(): Promise<void> {
    const servers = loadMcpConfig(this.#configPath);
    const wanted = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));

    // Tear down anything running that is no longer wanted.
    for (const id of [...this.#running.keys()]) {
      if (!wanted.has(id)) await this.#stop(id);
    }

    // Spawn anything wanted that is not running.
    for (const [id, server] of wanted) {
      if (this.#running.has(id)) continue;
      await this.#start(server);
    }
  }

  async #start(server: McpServerConfig): Promise<void> {
    if (
      process.platform === "win32" &&
      (hasWindowsMetachars(server.command) || server.args.some(hasWindowsMetachars))
    ) {
      this.#errors.set(
        server.id,
        "command contains characters that aren't allowed for security reasons",
      );
      return;
    }

    const spec = spawnSpecFor(server);
    const client = new MCPClient(
      { command: spec.command, args: spec.args, env: server.env ?? {} },
      this.#audit,
    );
    try {
      await client.connect();
      const tools = await client.buildTools();
      const toolNames: string[] = [];
      for (const tool of tools) {
        const name = tool.manifest.name;
        if (this.#registry.has(name)) {
          // Two servers exporting the same tool name: first one wins,
          // the collision is observable in the status error field.
          this.#errors.set(server.id, `tool name collision: ${name} already registered`);
          continue;
        }
        this.#registry.register(tool);
        toolNames.push(name);
      }
      this.#running.set(server.id, { client, toolNames });
      this.#errors.delete(server.id);
    } catch (err) {
      await client.disconnect().catch(() => {});
      this.#errors.set(server.id, String(err));
    }
  }

  async #stop(id: string): Promise<void> {
    const entry = this.#running.get(id);
    if (!entry) return;
    this.#running.delete(id);
    for (const name of entry.toolNames) this.#registry.unregister(name);
    await entry.client.disconnect().catch(() => {});
  }

  /** Per-config-entry live status (config order; includes disabled rows). */
  status(): McpServerStatus[] {
    return loadMcpConfig(this.#configPath).map((s) => {
      const entry = this.#running.get(s.id);
      const error = this.#errors.get(s.id);
      return {
        id: s.id,
        running: !!entry,
        toolCount: entry?.toolNames.length ?? 0,
        ...(error ? { error } : {}),
      };
    });
  }

  /** Names + descriptions for the Extensions page. Throws if not running. */
  async listTools(id: string): Promise<Array<{ name: string; description: string }>> {
    const entry = this.#running.get(id);
    if (!entry) throw new Error(`server "${id}" is not running`);
    const defs = await entry.client.listTools();
    return defs.map((d) => ({ name: d.name, description: d.description ?? "" }));
  }

  /** Manual tool call from the Extensions page. Throws on failure. */
  async callTool(id: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.#running.get(id);
    if (!entry) throw new Error(`server "${id}" is not running`);
    return entry.client.callTool(tool, args);
  }

  /** Best-effort synchronous teardown for the shutdown path (process.exit
   *  follows immediately — fire the kills, don't await). */
  killAll(): void {
    for (const [id] of this.#running) {
      void this.#stop(id);
    }
  }
}
