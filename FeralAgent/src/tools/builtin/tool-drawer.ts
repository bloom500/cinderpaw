/**
 * Tool drawer — `list_tools` + `load_tool`.
 *
 * The owner agent advertises only the CORE tools by default (see tiers.ts).
 * Everything tagged `extended` is hidden from the per-turn tool list to keep
 * the context lean, and the model pulls one in on demand:
 *
 *   1. `list_tools(query?)`  → names + one-line descriptions of the extended
 *                              tools not yet loaded this session.
 *   2. `load_tool(names[])`  → marks those tools active for THIS session; the
 *                              next completion advertises their full schemas.
 *
 * Both are themselves core (always advertised) so the affordance is always
 * reachable. They close over the shared per-session `loadedTools` map that
 * AgentLoop reads when building each turn's advertised tool set, and key off
 * `ctx.sessionId` so one session's loaded tools never leak into another.
 *
 * Execution is unaffected: the registry already runs any registered tool by
 * name. The drawer only controls which schemas the model is TOLD about.
 */

import type { Tool, ToolManifest } from "../../types.ts";
import type { ToolRegistry } from "../registry.ts";
import { isExtendedTool } from "../tiers.ts";

/**
 * Build the two drawer tools over a shared per-session loaded-tools map.
 * `registry` is read at call time (so it reflects whatever extended tools are
 * actually registered — e.g. `control_app` only exists when desktop control is
 * enabled).
 */
export function createToolDrawerTools(
  registry: ToolRegistry,
  loadedTools: Map<string, Set<string>>,
): [Tool, Tool] {
  /** Extended tools that are actually registered, as {name, description}. */
  const extendedRoster = (): { name: string; description: string }[] =>
    registry
      .list()
      .filter((t) => isExtendedTool(t.manifest.name))
      .map((t) => ({ name: t.manifest.name, description: t.manifest.description }));

  const listManifest: ToolManifest = {
    name: "list_tools",
    description:
      "Discover optional tools that are NOT loaded by default (desktop control, " +
      "deep research, code-quality runners, scanners, etc.). Returns a compact " +
      "'name: description' list you can filter with an optional query. Call this, " +
      "then load_tool with the names you need before using them.",
    permissions: [],
    networkAccess: false,
  };

  const listTools: Tool = {
    manifest: listManifest,
    parameters: {
      query: {
        type: "string",
        description:
          "Optional case-insensitive substring filter over name + description. " +
          "Omit to list every optional tool not yet loaded.",
        required: false,
      },
    },
    async execute(args, ctx) {
      const loaded = loadedTools.get(ctx.sessionId);
      const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const rows = extendedRoster()
        .filter((t) => !loaded?.has(t.name))
        .filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q))
        .map((t) => `- ${t.name}: ${t.description}`);
      if (rows.length === 0) {
        return {
          ok: true,
          content: q
            ? `No optional tools match "${q}".`
            : "All optional tools are already loaded.",
        };
      }
      return {
        ok: true,
        content:
          `Optional tools (call load_tool with one or more names to enable):\n` +
          rows.join("\n"),
        data: { count: rows.length },
      };
    },
  };

  const loadManifest: ToolManifest = {
    name: "load_tool",
    description:
      "Enable one or more optional tools (from list_tools) for the rest of this " +
      "conversation. After loading, call the tool normally. Use this when a task " +
      "needs a capability that isn't in the default tool set.",
    permissions: [],
    networkAccess: false,
  };

  const loadTool: Tool = {
    manifest: loadManifest,
    parameters: {
      names: {
        type: "array",
        description: "Names of optional tools to enable, exactly as list_tools reports them.",
        required: true,
        schema: { type: "array", items: { type: "string" }, description: "Tool names to enable." },
      },
    },
    async execute(args, ctx) {
      const names = Array.isArray(args.names)
        ? args.names.filter((n): n is string => typeof n === "string")
        : [];
      if (names.length === 0) {
        return { ok: false, content: "load_tool needs a non-empty 'names' array.", error: "bad_args" };
      }
      const valid = new Set(extendedRoster().map((t) => t.name));
      const unknown = names.filter((n) => !valid.has(n));
      if (unknown.length > 0) {
        return {
          ok: false,
          content:
            `Not optional/loadable: ${unknown.join(", ")}. ` +
            `Call list_tools to see valid names (core tools are already available).`,
          error: "bad_args",
        };
      }
      let set = loadedTools.get(ctx.sessionId);
      if (!set) {
        set = new Set();
        loadedTools.set(ctx.sessionId, set);
      }
      for (const n of names) set.add(n);
      return {
        ok: true,
        content: `Enabled: ${names.join(", ")}. They are now available to call.`,
        data: { loaded: [...set] },
      };
    },
  };

  return [listTools, loadTool];
}
