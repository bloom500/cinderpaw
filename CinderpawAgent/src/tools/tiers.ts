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

/**
 * Which side of the drawer a tool belongs on, decided by measurement.
 *
 * Every advertised schema is re-sent on EVERY completion, and a turn that makes
 * 28 tool calls is 29 completions. Measured on a real install: 4,901 tokens of
 * schema across 26 advertised tools, on top of 6,032 tokens of system prompt —
 * so a single "how many files are there" task spent 317,000 of its 337,000
 * tokens re-sending a prefix that never changed.
 *
 * The rule this file now follows: advertise the tools that move a task
 * FORWARD, drawer the tools you only need to know EXIST. Both halves of that
 * cut the same bill — a drawered tool costs nothing per completion, and an
 * advertised search tool costs one round trip instead of twenty.
 *
 * The split was backwards in exactly the way that costs most. `file_search` and
 * `scan_workspace` — the two tools that answer "how many files / where is X" in
 * a single call — were in the drawer, so the model walked the tree directory by
 * directory: 28 calls for a question worth two. Meanwhile `tool_forge` (583
 * tokens, the single most expensive schema in the set, used about once a month),
 * both PDF tools, and all five git tools rode along on every completion of every
 * conversation, including "what is a deadlock".
 *
 * `git_status` and `git_diff` stay advertised on purpose: read-only, cheap, and
 * reached for constantly in code work, where a drawer round trip would cost
 * more than the schema saves. The three that write or page through history do
 * not need to be in front of the model until it wants them.
 */

/** Loaded only via the on-demand drawer (`list_tools` → `load_tool`). */
export const EXTENDED_TOOLS = new Set<string>([
  // `tool_forge`, both PDF tools and the three write/history git tools were
  // advertised on every completion. Together they are ~1,600 tokens per call
  // for capabilities a task asks for by name when it wants them.
  "tool_forge",
  "pdf_generator",
  "pdf_report",
  "git_branch",
  "git_commit",
  "git_log",
  "fetch_url",
  "calculator",
  "time_date",
  "http_request",
  "tool_health",
  // Added 2026-08-26 and immediately drawered, by its own evidence: the boot
  // line went from 41 of 85 tools to 42 of 86 and the per-completion floor
  // from 12,793 to 13,053 — a tool for reading the token bill was costing
  // ~260 tokens on every completion, which is the exact mistake this file
  // exists to prevent. Asked for by name, roughly monthly.
  "token_usage",
  "deep_research",
  // delegate_task is deliberately NOT here: subagents are a headline
  // capability — hiding the tool in the drawer meant the model had to
  // list_tools → load_tool before it could ever delegate, so it never did.
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

/**
 * The OTHER direction: tools that must never reach a session that is not the
 * owner's, whatever that session's profile says.
 *
 * `CONNECTOR_TOOLS` marks tools only connectors get. Nothing marked the
 * reverse, and the gap was load-bearing: a connector persona with no
 * `personaTools` list compiles to `allowed = null`, and BOTH checks in the
 * agent loop read `profile?.allowed && …` — so a null allow-list skipped the
 * check entirely and the session ran with the owner's full surface. The
 * connector log line says so out loud: "persona profile registered (full
 * toolset)".
 *
 * `notebook` is the first entry because of what it is: a persistent JavaScript
 * interpreter with every other tool bound as a function. Its sandbox is real —
 * verified by running it: no `fetch`, no `process`, no `require`, and every
 * capability still goes through the registry's permission checks — but the
 * config's own words are "a hardened context, not a jail against hostile
 * input". Someone messaging a Discord bot is hostile input by default. The
 * owner typing in their own chat is not the same person, and this is where
 * that distinction gets enforced instead of being left to whoever configures
 * the connector.
 *
 * Fail-closed by design: the rule is "ANY profile means not the owner", not
 * "an allow-list that omits it". A session gets these only when it has no
 * profile at all.
 */
export const OWNER_ONLY_TOOLS = new Set<string>(["notebook"]);

/** True when this tool must be withheld from any profiled (non-owner) session. */
export const isOwnerOnlyTool = (name: string): boolean => OWNER_ONLY_TOOLS.has(name);

/**
 * Tools a HOST declared as the job (CINDERPAW_HOST_TOOLS). Empty on every
 * ordinary install, which is the only state most people will ever be in.
 */
let HOST_TOOL_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * The two tools that must stay advertised even in host mode, because they are
 * how everything else is reached. Demoting the drawer into the drawer would
 * make the demotion permanent.
 */
const DRAWER_TOOLS: ReadonlySet<string> = new Set(["list_tools", "load_tool"]);

/**
 * Declare the host's tools, flipping this file's default on its head.
 *
 * A host that hands over a tool set is saying "this is the job". Measured on
 * tau2-bench's airline domain: the 14 domain tools ADD to Cinderpaw's own, so
 * 56 of 97 tools get advertised and the fixed prefix goes from 12,051 to
 * 16,488 tokens re-sent on EVERY completion — against roughly 4,800 for the
 * reference agent on the identical task. The model then spent its budget
 * reasoning over a toolbox the task never needed and produced no answer at all.
 *
 * So in host mode the rule at the top of this file simply points the other way:
 * the host's tools are what move the task forward, and Cinderpaw's own are the
 * ones it only needs to know EXIST. Nothing is removed — `list_tools` and
 * `load_tool` still reach every built-in on demand, and the registry still
 * executes anything by name. Only advertising changes, which is the entire
 * point of tiering.
 */
export function setHostToolNames(names: Iterable<string>): void {
  HOST_TOOL_NAMES = new Set(names);
}

export const isExtendedTool = (name: string): boolean => {
  // Host mode: everything that is not the host's job, and not the drawer that
  // reaches the rest, goes behind the drawer. Expressed here rather than in
  // `isCoreTool` so the two predicates cannot disagree — they did once, and
  // `list_tools` spent that release calling a tool optional while the prompt
  // advertised it as core.
  if (HOST_TOOL_NAMES.size > 0) {
    return !HOST_TOOL_NAMES.has(name) && !DRAWER_TOOLS.has(name);
  }
  // MCP tools (dynamic, registered by sandbox/mcp-manager.ts as `mcp_<tool>`)
  // always live in the drawer: a user with several extensions installed
  // would otherwise re-inflate the per-turn schema bloat this file exists
  // to prevent. `list_tools` → `load_tool` reaches them on demand.
  return EXTENDED_TOOLS.has(name) || name.startsWith("mcp_");
};
export const isConnectorTool = (name: string): boolean => CONNECTOR_TOOLS.has(name);

/**
 * Advertised to the owner agent by default: not extended, not connector-only.
 *
 * Defined in terms of `isExtendedTool` — it used to test `EXTENDED_TOOLS` alone
 * and so missed the `mcp_` prefix rule above, making the two predicates
 * disagree: `list_tools` called an MCP tool "optional, load it with load_tool"
 * while this said it was core. One rule, one answer.
 */
export const isCoreTool = (name: string): boolean =>
  !isExtendedTool(name) && !isConnectorTool(name);
