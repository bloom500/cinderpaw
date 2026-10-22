/**
 * MCP manager — the single owner of live MCP server connections (R5,
 * docs/2026-07-09-v1-architecture-hardening-spec.md).
 *
 * Before R5 there were two MCP stacks: rmcp in the Rust desktop host
 * (Extensions page) and this sidecar's MCPClient (never wired — the agent
 * could not use MCP tools at all). Now the sidecar owns every connection:
 *
 *   - Config stays Rust-owned: the desktop writes `~/.cinderpaw/mcp.json`
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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MCPClient } from "./mcp-client.ts";
import { accessToken, pruneTokens, signIn as signInWithBrowser } from "./mcp-oauth.ts";
import type { AuditLogger } from "../types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { cinderpawHome } from "../config.ts";

/** Mirrors `McpServerConfig` in `src-tauri/src/mcp.rs` (serde field names). */
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  category?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** A server on the web ("Add your own"): no command is run. */
  url?: string;
  headers?: Record<string, string>;
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
  return join(cinderpawHome(), "mcp.json");
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
        Array.isArray((s as McpServerConfig).args) &&
        ((s as McpServerConfig).url === undefined || typeof (s as McpServerConfig).url === "string"),
    );
  } catch {
    return [];
  }
}

/**
 * A service added by its link, the same entry the desktop's "Add your own"
 * writes (`custom_server` in src-tauri/src/mcp.rs; keep the two in step, or
 * one side names the same service twice). Returns the reason when refused.
 */
export function customServer(url: string, key = "", name = ""): McpServerConfig | string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "That is not a web link. Ask for the whole link, starting with https://";
  }
  const host = parsed.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  // The key rides along with every request: never in the clear off this machine.
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
    return "The link has to start with https://, so the key travels encrypted.";
  }
  const k = key.trim();
  if (/[\x00-\x1f\x7f]/.test(k)) return "The key has a line break in it. Ask for it again, on its own.";
  const headers: Record<string, string> = {};
  if (k) headers.Authorization = k.toLowerCase().startsWith("bearer ") ? k : `Bearer ${k}`;
  return {
    id: `custom-${host.replace(/[.:[\]]/g, "-")}`,
    name: name.trim() || host,
    description: `Added by you, from ${host}.`,
    category: "Added by you",
    command: "",
    args: [],
    env: {},
    url: parsed.href,
    ...(k ? { headers } : {}),
    enabled: true,
  };
}

/** Same file the desktop writes; temp + rename, private, like its writer. */
function writeMcpConfig(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, raw, { mode: 0o600 });
  renameSync(tmp, path);
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

/**
 * Is this config a `mcp-remote` bridge to a vendor-hosted MCP server?
 *
 * Those connect by opening a browser and waiting for the user to sign in, so
 * they need a handshake budget measured in minutes rather than seconds. The
 * config file carries no flag for it — the desktop host builds these command
 * lines and the shape is the signal.
 */
export function usesRemoteBridge(server: Pick<McpServerConfig, "args">): boolean {
  return server.args.some((a) => a === "mcp-remote" || a.startsWith("mcp-remote@"));
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
  /** The boot reconcile never opens a browser; one a person caused (Connect, a toggle) may. */
  #booted = false;

  constructor(registry: ToolRegistry, audit: AuditLogger, configPath?: string) {
    this.#registry = registry;
    this.#audit = audit;
    this.#configPath = configPath ?? defaultMcpConfigPath();
  }

  /** Diff config against live connections; spawn / tear down / register. */
  reconcile(): Promise<void> {
    const signIn = this.#booted;
    this.#booted = true;
    this.#reconciling = this.#reconciling.then(() => this.#reconcileOnce(signIn));
    return this.#reconciling;
  }

  /**
   * Add (or replace) a server from chat, as "Add your own" does on the desktop,
   * and keep it only if it connects: a failed add leaves the file as it was,
   * so the next boot does not retry a dead server forever.
   */
  addServer(entry: McpServerConfig): Promise<{ ok: true; tools: string[] } | { ok: false; error: string }> {
    const run = this.#reconciling.then(async () => {
      let before: string | null = null;
      try {
        before = readFileSync(this.#configPath, "utf8");
      } catch {
        /* first extension on this machine */
      }
      const servers = loadMcpConfig(this.#configPath).filter((s) => s.id !== entry.id);
      writeMcpConfig(this.#configPath, JSON.stringify({ servers: [...servers, entry] }, null, 2));
      await this.#stop(entry.id); // same id, new link or key: reconnect
      await this.#reconcileOnce(true);
      const running = this.#running.get(entry.id);
      if (running) return { ok: true as const, tools: running.toolNames };
      const error = this.#errors.get(entry.id) ?? "it did not start";
      if (before === null) rmSync(this.#configPath, { force: true });
      else writeMcpConfig(this.#configPath, before);
      await this.#reconcileOnce();
      this.#errors.delete(entry.id);
      return { ok: false as const, error };
    });
    this.#reconciling = run.then(() => {}, () => {});
    return run;
  }

  /**
   * Resolve once the in-flight reconcile settles, or after `timeoutMs` —
   * whichever comes first. Never rejects.
   *
   * The boot reconcile is deliberately fire-and-forget (a broken extension must
   * not delay startup), which left a window where the FIRST user message was
   * planned against a tool registry that did not yet contain any MCP tool. The
   * agent then answered "I don't have a tool for that" for a server the user
   * could see connected a second later. Waiting a bounded moment on the first
   * message closes that window without reintroducing the startup stall — and
   * `#complete` still calls `#syncTools()` every turn, so anything slower than
   * the timeout is picked up on the next turn as before.
   */
  async ready(timeoutMs = 3_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#reconciling.catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async #reconcileOnce(signIn = false): Promise<void> {
    const servers = loadMcpConfig(this.#configPath);
    // An empty list may be a torn or broken file: never sign everyone out over it.
    if (servers.length > 0 || !existsSync(this.#configPath)) pruneTokens(new Set(servers.map((s) => s.id)));
    const wanted = new Map(servers.filter((s) => s.enabled).map((s) => [s.id, s]));

    // Tear down anything running that is no longer wanted.
    for (const id of [...this.#running.keys()]) {
      if (!wanted.has(id)) await this.#stop(id);
    }

    // Spawn anything wanted that is not running.
    for (const [id, server] of wanted) {
      if (this.#running.has(id)) continue;
      await this.#start(server, signIn);
    }
  }

  async #start(server: McpServerConfig, signIn = false): Promise<void> {
    if (server.url) {
      const web = () =>
        new MCPClient(
          { command: "", url: server.url, headers: server.headers ?? {}, bearer: () => accessToken(server.id) },
          this.#audit,
        );
      const client = web();
      await this.#connect(server, client);
      // Notion, Linear: the service asked for a sign-in in the browser. Only
      // when a person just asked for this (never at boot), and once.
      if (!signIn || this.#running.has(server.id) || !client.signInHint) return;
      try {
        await signInWithBrowser(server.id, server.url, client.signInHint);
      } catch (err) {
        this.#errors.set(server.id, String(err));
        return;
      }
      return this.#connect(server, web());
    }
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
      {
        command: spec.command,
        args: spec.args,
        env: server.env ?? {},
        // A bridged remote server does not answer `initialize` until the user
        // has finished signing in through the browser window it opened, so
        // the handshake budget here is bounded by a person, not by software.
        // The desktop host allows the same for these (BROWSER_LOGIN_TIMEOUT in
        // src-tauri/src/mcp.rs); if the two ever disagree, the shorter one
        // wins and the install fails mid-login for no visible reason.
        ...(usesRemoteBridge(server) ? { initTimeoutMs: 570_000 } : {}),
      },
      this.#audit,
    );
    return this.#connect(server, client);
  }

  async #connect(server: McpServerConfig, client: MCPClient): Promise<void> {
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
