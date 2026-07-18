/**
 * tool_forge — the agent's door for creating, modifying and deleting its
 * OWN tools (self-extension of the tool surface).
 *
 * Guardrails:
 *   - Only tools created through the forge can be modified or deleted —
 *     builtins and MCP tools are untouchable (checked against the live
 *     registry, not just the store).
 *   - Same trust class as shell_exec: registered only under the
 *     FERAL_ENABLE_SHELL_EXEC gate (see boot.ts). Execution runs in a
 *     subprocess through the ProcessSandbox — see custom-tools.ts.
 *   - Create/update transpiles the code (syntax gate) BEFORE anything is
 *     persisted or registered; a broken tool never enters the registry.
 *   - Every forge call is audited by the registry like any tool call.
 *
 * The created tool is available immediately (hot-registered) and
 * persists across restarts (~/.feral/tools/).
 */

import type { Tool, ToolManifest, ToolParameter } from "../../types.ts";
import type { ToolRegistry } from "../registry.ts";
import {
  createCustomTool,
  customToolsDir,
  deleteCustomTool,
  loadCustomTools,
  MAX_CUSTOM_TOOLS,
  resolveToolRuntime,
  saveCustomTool,
  transpileToolCode,
  validateCustomTool,
  type CustomToolRecord,
} from "../custom-tools.ts";

export interface ToolForgeDeps {
  registry: ToolRegistry;
  workspaceRoots: string[];
  /** Injectable for tests. Default: ~/.feral/tools. */
  dir?: string;
  /** Injectable for tests. Default: resolved bun/node. */
  runtime?: string | null;
}

/** Load persisted custom tools and register them. Returns the names
 *  registered — boot calls this once, before registering the forge. */
export function registerPersistedCustomTools(deps: ToolForgeDeps): string[] {
  const dir = deps.dir ?? customToolsDir();
  const runtime = deps.runtime !== undefined ? deps.runtime : resolveToolRuntime();
  if (!runtime) return [];
  const registered: string[] = [];
  for (const record of loadCustomTools(dir)) {
    if (deps.registry.has(record.name)) continue; // never shadow a builtin
    deps.registry.register(createCustomTool(record, dir, deps.workspaceRoots, runtime));
    registered.push(record.name);
  }
  return registered;
}

export function createToolForgeTool(deps: ToolForgeDeps): Tool {
  const dir = deps.dir ?? customToolsDir();
  const runtime = deps.runtime !== undefined ? deps.runtime : resolveToolRuntime();

  const manifest: ToolManifest = {
    name: "tool_forge",
    description:
      "Create, modify, delete or inspect your OWN custom tools. Actions: " +
      "`create` (name, description, parameters, code), `update` (partial), " +
      "`delete` (name), `list`, `show` (name). The tool's `code` is a " +
      "TypeScript/JavaScript module: `export default async function (args) " +
      "{ return { ok: true, content: \"...\", data?: any }; }`. It runs in a " +
      "sandboxed subprocess with Node/Bun builtins available (node:fs, " +
      "node:path, fetch, …). The new tool is callable immediately by its " +
      "name and persists across restarts. Only forge-created tools can be " +
      "updated or deleted — builtins are protected. Use this when you lack " +
      "a tool for a recurring task, or an existing custom tool is buggy.",
    permissions: ["fs:read", "fs:write"],
    networkAccess: false,
    allowedPaths: [dir],
  };

  /** Names created by the forge (loaded from disk + created this session).
   *  The store on disk is the durable source of truth. */
  const ownedNames = (): Set<string> => new Set(loadCustomTools(dir).map((r) => r.name));

  return {
    manifest,
    parameters: {
      action: {
        type: "string",
        description: "One of: create, update, delete, list, show.",
        required: true,
      },
      name: {
        type: "string",
        description: "Tool name (snake_case, 3-32 chars). Required for all actions except `list`.",
        required: false,
      },
      description: {
        type: "string",
        description: "What the tool does — shown to you when choosing tools. Required for `create`.",
        required: false,
      },
      parameters: {
        type: "object",
        description:
          'Parameter spec: {"<param>": {"type": "string|number|boolean|object|array", "description": "...", "required": true|false}}. Default {} (no parameters).',
        required: false,
      },
      code: {
        type: "string",
        description:
          "The module source. Must have `export default async function (args) { ... }` returning {ok, content, data?}. Required for `create`.",
        required: false,
      },
      timeout_ms: {
        type: "number",
        description: "Per-call timeout in ms (default 30000, max 300000).",
        required: false,
      },
    },
    async execute(args) {
      const action = typeof args.action === "string" ? args.action : "";
      const name = typeof args.name === "string" ? args.name.trim() : "";

      if (action === "list") {
        const records = loadCustomTools(dir);
        if (records.length === 0) {
          return { ok: true, content: "No custom tools yet. Use action=create to make one." };
        }
        const lines = records.map((r) => `- ${r.name}: ${r.description}`);
        return { ok: true, content: `Custom tools (${records.length}):\n${lines.join("\n")}`, data: { tools: records.map((r) => r.name) } };
      }

      if (!name) return { ok: false, content: `tool_forge: action "${action}" requires a name.`, error: "bad_args" };

      if (action === "show") {
        const record = loadCustomTools(dir).find((r) => r.name === name);
        if (!record) return { ok: false, content: `tool_forge: no custom tool "${name}".`, error: "not_found" };
        return {
          ok: true,
          content: `${record.name}: ${record.description}\nparameters: ${JSON.stringify(record.parameters)}\n\n${record.code}`,
          data: { record },
        };
      }

      if (action === "delete") {
        if (!ownedNames().has(name)) {
          return {
            ok: false,
            content: `tool_forge: "${name}" is not a forge-created tool — builtins cannot be deleted.`,
            error: "protected",
          };
        }
        deleteCustomTool(dir, name);
        deps.registry.unregister(name);
        return { ok: true, content: `Deleted custom tool "${name}".` };
      }

      if (action !== "create" && action !== "update") {
        return { ok: false, content: `tool_forge: unknown action "${action}". Use create|update|delete|list|show.`, error: "bad_args" };
      }

      if (!runtime) {
        return {
          ok: false,
          content:
            "tool_forge: no JS runtime found on PATH (need `bun` or `node`) — custom tools cannot execute. Install one and restart.",
          error: "no_runtime",
        };
      }

      const existing = loadCustomTools(dir).find((r) => r.name === name);
      if (action === "create" && deps.registry.has(name) && !ownedNames().has(name)) {
        return { ok: false, content: `tool_forge: "${name}" already exists as a builtin — pick another name.`, error: "name_taken" };
      }
      if (action === "update" && !existing) {
        return { ok: false, content: `tool_forge: no custom tool "${name}" to update — use action=create.`, error: "not_found" };
      }
      if (action === "create" && !existing && loadCustomTools(dir).length >= MAX_CUSTOM_TOOLS) {
        return { ok: false, content: `tool_forge: limit of ${MAX_CUSTOM_TOOLS} custom tools reached — delete one first.`, error: "limit" };
      }

      // Merge update over the existing record; create demands the full shape.
      const description =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim()
          : existing?.description ?? "";
      const parameters =
        args.parameters && typeof args.parameters === "object" && !Array.isArray(args.parameters)
          ? (args.parameters as Record<string, ToolParameter>)
          : existing?.parameters ?? {};
      const code = typeof args.code === "string" && args.code.trim() ? args.code : existing?.code ?? "";
      const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : existing?.timeoutMs;

      const invalid = validateCustomTool({ name, description, parameters, code });
      if (invalid) return { ok: false, content: `tool_forge: ${invalid}`, error: "bad_args" };

      const transpiled = transpileToolCode(code);
      if ("error" in transpiled) return { ok: false, content: `tool_forge: ${transpiled.error}`, error: "bad_code" };
      if (!code.includes("export default")) {
        return { ok: false, content: "tool_forge: code must have `export default async function (args) {...}`.", error: "bad_code" };
      }

      const now = Date.now();
      const record: CustomToolRecord = {
        version: 1,
        name,
        description,
        parameters,
        code,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      saveCustomTool(dir, record, transpiled.js);
      deps.registry.unregister(name);
      deps.registry.register(createCustomTool(record, dir, deps.workspaceRoots, runtime));

      return {
        ok: true,
        content:
          `${action === "create" ? "Created" : "Updated"} custom tool "${name}" — it is registered and callable now. ` +
          "Call it once with test arguments to verify it behaves as intended.",
        data: { name, action },
      };
    },
  };
}
