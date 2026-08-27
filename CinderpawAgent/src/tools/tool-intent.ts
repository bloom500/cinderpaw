/**
 * Tool intent — which tools a turn is likely to need, decided before the
 * completion instead of during it.
 *
 * WHY THIS EXISTS. Measured on a live session (see
 * OPUS_CHECKPOINT_20260826_TOKENS.md): tool schemas are 39.2% of everything
 * sent, and the conversation itself is under 6%. The drawer already holds 45
 * of 89 tools back, but the 44 that remain are advertised on every completion
 * of every conversation, including "what is a deadlock".
 *
 * The drawer's routing is done by the MODEL — it must call `list_tools` and
 * `load_tool`, which is two extra completions at ~14.8k tokens each. So the
 * drawer only pays when a tool is genuinely rare; drawer something the model
 * needs often and it costs MORE. tiers.ts records exactly that happening:
 * `file_search` was in the drawer, so the model walked a tree directory by
 * directory — 28 calls for a question worth two.
 *
 * This module is the other half: routing that costs nothing, because it runs
 * on the text before the prompt is built. Darius's framing was Mixture of
 * Experts, and the analogy is precise where it matters — capacity you do not
 * pay for until it is selected — with one honest difference: MoE routes per
 * token with a learned router, this routes per SESSION with regexes.
 *
 * WHY PER SESSION AND NOT PER TURN. The cached prompt prefix contains the tool
 * schemas, and 41.9% of billed input on that same session came from cache. A
 * tool set that changes every turn invalidates the prefix every turn, which
 * would cost more than the schemas save. Selecting once, on the first real
 * message, keeps the prefix stable for the life of the conversation.
 *
 * THREE RULES, in the order they matter:
 *
 *   1. FAIL OPEN. No signal, or any doubt, means the full core set — today's
 *      behaviour exactly. This module can only ever REMOVE tools when it has a
 *      positive reason to believe they are not needed, and the worst case is
 *      what ships today.
 *   2. THE FLOOR IS ALWAYS PRESENT. `list_tools` / `load_tool` are never
 *      withheld, because they are how the model recovers from a wrong guess.
 *      Routing that can strand the agent is worse than no routing.
 *   3. ADDITIVE, not first-match-wins. "read the config and commit it" is
 *      files AND git. The model classifier next door picks one category
 *      because a turn has one best model; a turn can need several toolkits.
 *
 * Pure: no I/O, no LLM call, no side effects — same contract as
 * `brain/task-classifier.ts`, whose boundary discipline this follows too. A
 * naive substring match produces "dysfunction" matching "function"; every
 * pattern here uses `\b`, and the tests pin the specific false positives.
 */

/** The toolkits a turn can call for. Additive — a turn may need several. */
export type ToolIntent =
  | "files"
  | "code"
  | "web"
  | "system"
  | "memory"
  | "introspect"
  | "delegate";

/**
 * Never withheld, whatever the intent.
 *
 * `list_tools` and `load_tool` are the escape hatch: with them the model can
 * always reach anything this classifier failed to predict, at the cost of one
 * round trip. Without them a bad guess is unrecoverable, which turns a
 * cost optimisation into a capability bug.
 *
 * `ask_user` is here for the same reason in the other direction: a turn that
 * cannot ask is a turn that guesses.
 */
export const ALWAYS_TOOLS: readonly string[] = [
  "list_tools",
  "load_tool",
  "ask_user",
  "todo_write",
];

/**
 * Intent → tool names.
 *
 * Names are written out rather than derived from a prefix, because a prefix
 * rule silently changes meaning when someone adds a tool that happens to
 * match. The cost of the explicit list is that a rename breaks it silently —
 * so `tool-intent.test.ts` asserts every name here is a real registered tool.
 * That guard is the reason this list is safe to write by hand.
 */
export const INTENT_TOOLS: Readonly<Record<ToolIntent, readonly string[]>> = {
  files: [
    "read_file",
    "write_file",
    "edit_file",
    "list_directory",
    "file_search",
    "grep",
    "scan_workspace",
  ],
  code: ["git_status", "git_diff", "git_log", "git_commit", "git_branch", "shell_exec"],
  web: ["web_search", "fetch_url", "read_webpage", "deep_research"],
  system: ["shell_exec", "cinderpaw_admin"],
  memory: ["recall", "remember"],
  introspect: [
    "self_describe",
    "self_status",
    "self_health",
    "self_tools",
    "self_subsystem",
    "product_info",
  ],
  delegate: ["delegate_task", "cowork_team", "cowork_send"],
};

/**
 * Patterns per intent. Boundary discipline copied from
 * `brain/task-classifier.ts`, including its reasoning: single tokens get `\b`
 * on both sides, multi-word phrases get one on the right so they can land
 * mid-sentence.
 */
export const INTENT_PATTERNS: Readonly<Record<ToolIntent, readonly RegExp[]>> = {
  files: [
    /\bfiles?\b/i,
    /\bfolders?\b/i,
    /\bdirector(?:y|ies)\b/i,
    /\bread\b/i,
    /\bwrite\b/i,
    /\bedit\b/i,
    /\bsearch\b/i,
    /\bgrep\b/i,
    /\bworkspace\b/i,
    /\.(?:ts|tsx|js|json|md|rs|go|py|css|html|toml|yaml|yml)\b/i,
  ],
  code: [
    /\bgit\b/i,
    /\bcommit\b/i,
    /\bbranch\b/i,
    /\bdiff\b/i,
    /\bmerge\b/i,
    /\brefactor\b/i,
    /\btests?\b/i,
    /\bbuild\b/i,
    /\blint\b/i,
    /```/,
  ],
  web: [
    /\bsearch (?:the )?web\b/i,
    /\bgoogle\b/i,
    /\bonline\b/i,
    /\burl\b/i,
    /https?:\/\//i,
    /\bwebsite\b/i,
    /\bresearch\b/i,
    /\blook up\b/i,
  ],
  system: [/\brun\b/i, /\bcommand\b/i, /\bshell\b/i, /\bterminal\b/i, /\binstall\b/i, /\brestart\b/i],
  memory: [/\bremember\b/i, /\brecall\b/i, /\bforget\b/i, /\bmemor(?:y|ies)\b/i],
  introspect: [
    /\byour(?:self)?\b/i,
    /\bcinderpaw\b/i,
    /\bsubsystems?\b/i,
    /\bhealth\b/i,
    /\bwhat can you do\b/i,
  ],
  delegate: [/\bdelegate\b/i, /\bteammates?\b/i, /\bsubagents?\b/i, /\bcowork\b/i, /\bin parallel\b/i],
};

/**
 * Below this many characters a message is not evidence of anything.
 *
 * "ok", "yes", "do it" carry no intent signal, and treating them as "no tools
 * needed" would strip the toolset on exactly the turn that continues a task.
 * Short input therefore fails open like any other no-signal case.
 */
export const MIN_SIGNAL_CHARS = 12;

/** Which toolkits this text asks for. Empty means "no signal", never "none needed". */
export function classifyToolIntents(text: string): Set<ToolIntent> {
  const found = new Set<ToolIntent>();
  if (typeof text !== "string" || text.trim().length < MIN_SIGNAL_CHARS) return found;
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS) as [
    ToolIntent,
    readonly RegExp[],
  ][]) {
    if (patterns.some((p) => p.test(text))) found.add(intent);
  }
  return found;
}

export interface SelectToolsInput {
  /** The user's first real message of the session. */
  text: string;
  /** Every tool the owner would otherwise be advertised (the core set today). */
  coreTools: readonly string[];
}

/**
 * The tools to advertise for this session.
 *
 * Returns `coreTools` unchanged whenever there is no positive reason to narrow
 * — no signal, or a signal so broad it covers the set anyway. A caller can
 * therefore use the result unconditionally: when routing has nothing to say,
 * it says exactly what happens today.
 */
export function selectTools(input: SelectToolsInput): string[] {
  const core = input.coreTools ?? [];
  const intents = classifyToolIntents(input.text);
  // Rule 1: no signal ⇒ everything, exactly as today.
  if (intents.size === 0) return [...core];

  const wanted = new Set<string>(ALWAYS_TOOLS);
  for (const intent of intents) for (const name of INTENT_TOOLS[intent]) wanted.add(name);

  // Only ever a SUBSET of what the caller would have advertised: this module
  // decides what to leave out, never what to add. A name in ALWAYS_TOOLS or an
  // intent map that is not in `core` (drawered, unregistered, renamed) is
  // dropped here rather than conjured into the prompt.
  const selected = core.filter((name) => wanted.has(name));

  // Rule 1 again, at the other end: a selection that saves nothing worth the
  // risk of being wrong is not worth making. Under a third of the set removed,
  // keep everything — the schema saving is small and a miss costs a round trip.
  const MIN_REMOVED_FRACTION = 0.33;
  if (core.length - selected.length < core.length * MIN_REMOVED_FRACTION) return [...core];

  return selected;
}
