/**
 * Tool tiers — which builtin tools the owner agent advertises by default.
 *
 * Every registered tool used to be injected into the system prompt / native
 * tool list on EVERY completion (~28 schemas ≈ 5-8K tokens before the task).
 * That's the dominant context-bloat layer now that memory and skills are
 * already on-demand drawers. Tools are split into:
 *
 *   - core      → always advertised to the owner (default: anything not listed
 *                 below, so a new tool is visible unless deliberately demoted).
 *   - extended  → NOT advertised by default; the model pulls them in on demand
 *                 via `list_tools` + `load_tool` (see tool-drawer.ts).
 *   - connector → never in the owner surface; only exposed through an explicit
 *                 connector profile's tool whitelist (transports/connectors.ts).
 *
 * This is the single source of truth. `EXTENDED_TOOLS` / `CONNECTOR_TOOLS`
 * list names by exception; everything else is core (default-visible, so the
 * agent never silently loses a capability when a tool is added).
 *
 * Tiering only changes which tool SCHEMAS are advertised — execution is
 * unchanged: the registry still runs any registered tool by name, and
 * connector profiles still build from the full set (AgentLoop keeps the full
 * `#openAITools`/`#nativeTools` for `registerProfile`).
 */

/** Loaded only via the on-demand drawer (`list_tools` → `load_tool`). */
export const EXTENDED_TOOLS = new Set<string>([
  "file_search",
  "scan_workspace",
  "fetch_url",
  "calculator",
  "time_date",
  "http_request",
  "tool_health",
  "deep_research",
  "delegate_task",
  "control_app",
  // code-quality family (code-quality.ts CodeQualityKind)
  "run_tests",
  "format_code",
  "lint_code",
  "install_deps",
  "build_project",
]);

/** Connector-profile-only (sales/public mode). Never in the owner surface. */
export const CONNECTOR_TOOLS = new Set<string>([
  "capture_lead",
  "escalate_to_human",
  "schedule_meeting",
]);

export const isExtendedTool = (name: string): boolean =>
  // MCP tools (dynamic, registered by sandbox/mcp-manager.ts as `mcp_<tool>`)
  // always live in the drawer: a user with several extensions installed
  // would otherwise re-inflate the per-turn schema bloat this file exists
  // to prevent. `list_tools` → `load_tool` reaches them on demand.
  EXTENDED_TOOLS.has(name) || name.startsWith("mcp_");
export const isConnectorTool = (name: string): boolean => CONNECTOR_TOOLS.has(name);

/** Advertised to the owner agent by default: not extended, not connector-only. */
export const isCoreTool = (name: string): boolean =>
  !EXTENDED_TOOLS.has(name) && !CONNECTOR_TOOLS.has(name);
