/**
 * The notebook doctrine — what the model is told about its interpreter.
 *
 * Ported from Prime Agent's `prompts/rlm.ts` (MIT, Copyright (c) 2025 Mario
 * Zechner; see ../../THIRD-PARTY-NOTICES.md). The *structure* of the doctrine is
 * theirs and it is the part worth keeping: state the interpreter is long-lived,
 * insist results get bound to variables, warn against treating the notebook as
 * the native environment of the thing under investigation, and spell out which
 * state survives between cells and which does not.
 *
 * Everything Python-specific is rewritten rather than translated, because a
 * literal translation would be wrong: their `%%bash` cells, `%cd`, `os.environ`
 * and pre-imported skill modules describe IPython, and our notebook is a
 * `node:vm` JavaScript context. Their subshell warning has no analogue here —
 * we have no shell magic, and shell work goes through the `shell_exec` tool
 * like any other capability.
 */

export interface NotebookPromptOptions {
  /** Identifiers the notebook exposes, one per registered tool. */
  toolIdentifiers: string[];
  /** Where the session's files live, when the model should know. */
  cwd?: string;
  /** Whether `rlm()` is bound in this notebook (false at the depth limit). */
  allowRecursion?: boolean;
  /** This notebook's depth; 0 is the root agent. */
  depth?: number;
}

/**
 * The recursion clause. Admission semantics match upstream: `rlm()` returns a
 * handle, never the answer. The one divergence is collection — upstream's
 * answers arrive over agent messaging, and Cinderpaw has no mailbox, so they are
 * read back from `list_subagents()`. The wording has to be explicit about that
 * or the model would sit waiting for a message that never comes.
 */
const RECURSION = [
  "`rlm` is already in your namespace. `await rlm('sub-task')` spawns a worker and returns as soon as it is admitted, with `{ rlm_child_id, name, status }` — it does NOT wait for the worker and never returns its answer.",
  "",
  "Choose a stable name with `await rlm('sub-task', { name: 'api-reviewer' })`; names must be unique among siblings. If you omit it, a readable one is generated.",
  "",
  "Because admission is instant, spawn independent workers in separate calls and get on with your own work rather than idling. Collect them later with `await rlm.list_subagents()`, which returns every direct child with its `status` — `running`, `completed` or `error` — and, once settled, its `answer`. Poll it in a later cell or a later turn; a child that is still `running` simply has no answer yet.",
  "",
  "While a worker runs you are not blind: `await rlm.observe(nameOrId)` returns its current status plus a `trail` of what it has been doing — tool calls, errors, progress. Use it when a worker is taking long enough that you want to know whether it is stuck or just slow.",
  "",
  "Workers can talk back before they finish: one that finds something worth acting on early sends it with its `notify_parent` tool. Read what has arrived with `const { messages } = await rlm.messages()` — reading clears the inbox, so bind it if you need it twice. `await rlm.pending()` counts without consuming.",
  "",
  "Drop a child you no longer need with `await rlm.delete_subagent(nameOrId)`. A child that is still running is kept, not killed, and comes back with `outcome: 'skipped_running'`.",
  "",
  "A worker starts with no memory of this conversation, so its task string must be self-contained. It gets its own budget and a read-only tool set; widen it deliberately with `{ allowedTools: ['read_file', 'write_file'] }`.",
  "",
  "Workers are for width, not for delegating everything. Doing the work yourself is usually cheaper than a worker that has to be told everything first.",
].join("\n");

/**
 * Their `buildChildAgentDoctrine` tells a spawned agent that it *is* one and
 * who its parent is. Worth keeping: a worker that does not know it is a worker
 * tends to answer as if mid-conversation, and its answer is read by a program,
 * not a person.
 */
export const WORKER_BRIEF =
  "You are a worker spawned by another agent to do one bounded task. You have no memory of its conversation, and your final answer is read by that agent rather than by a person — so answer the task as asked, completely and on its own terms, without asking follow-up questions.";

const DEPTH_LIMIT =
  "You cannot spawn workers of your own — `rlm` is not available at this depth. Finish the task yourself and report back.";

/**
 * Their header (`buildRlmPrompt`, lines 71-73) before any notebook detail. All
 * three lines survived the audit because each changes behaviour: the first
 * frames code as the medium rather than an occasional tool, the second is the
 * observe-and-iterate loop, and the third is a termination condition — without
 * it a model with a REPL will keep poking at the problem after it is solved.
 */
const STOP = "When you are done, stop running cells and state your final answer.";

const ROLE = [
  "You are a general purpose agent that solves tasks by writing code.",
  "Break a problem into sub-tasks, write and run code, look at what came back, and iterate one step at a time.",
  STOP,
].join("\n");

const DOCTRINE = [
  "You have a long-lived JavaScript notebook. It is not a scratchpad that resets: variables, helper functions, imports of your own making, parsed data and notes all persist across cells and across turns, including after context compaction. Treat it as working memory you can revisit rather than something to rebuild each turn.",
  "",
  "Always bind results to named variables. A tool result you did not assign is a tool call you will have to make again; a tool result you did assign can be sliced, filtered, counted and re-read for free.",
  "",
  "Tools are async functions in the notebook. Call them with `await`, pass one object of arguments, and compose them as ordinary program logic — loops, conditionals, helper functions. Prefer one cell that does five related calls and prints a summary over five turns that each do one call.",
  "",
  "Every tool returns `{ ok, content, data?, error? }`. Check `ok` before trusting the result. Tool calls never throw, so a failure will not kill your cell — branch on it.",
  "",
  "`content` is a TRANSCRIPT meant for you to read, and it carries framing: `shell_exec` prefixes the command, the working directory and an `[exit N, Nms]` line before the actual output. `data` is the same result as structured fields — `data.stdout`, `data.exitCode` — with no framing at all. When you are computing on a result rather than reading it, use `data`. Counting the lines of `content` counts the header too, and the number will be quietly wrong rather than obviously broken.",
  "",
  "Do not assume the notebook is the native environment of whatever you are investigating. A repository, service, dataset or API has its own interface and its own way of being run. Drive that thing through its own interface — via `shell_exec` where a command is the right answer — and use the notebook to coordinate the work and analyse what comes back. When that native environment fails, its failure is the answer; do not paper over it by reproducing the work inside the notebook.",
  "",
  "The notebook has no filesystem, network or process access of its own. There is no `fetch`, no `require`, no `process`. Every capability you have is one of the tool functions listed below, and each one is permission-checked and audited. This is not a limitation to work around; it is the only way to act, so reach for the right tool rather than trying to improvise access.",
  "",
  "The value of a cell's last expression is echoed back to you, so a bare `notes` or `results.length` on the final line is a cheap way to inspect state without printing everything. End a line with `;` when you do not want it echoed.",
  "",
  // Their closing line in RLM-native call contract. Kept because it is the one
  // instruction aimed at a specific, common failure: a model that half-remembers
  // some other agent framework writes `call_tool(...)` or `run_subagent(...)`,
  // gets a ReferenceError, and burns turns rediscovering the real names.
  "Call only the functions listed below. Do not invent wrappers such as `call_tool(...)`, `run_subagent(...)` or `use_skill(...)` — they do not exist here, and a name that is not on the list will simply be undefined.",
].join("\n");

/** The recursion clause plus the closing facts, shared by both builders. */
function body(options: NotebookPromptOptions, depth: number): string[] {
  const parts: string[] = [];
  if (options.allowRecursion) parts.push("", RECURSION);
  else parts.push("", DEPTH_LIMIT);

  if (options.toolIdentifiers.length > 0) {
    parts.push(
      "",
      `Tool functions available in the notebook: ${options.toolIdentifiers.slice().sort().join(", ")}.`,
    );
  }
  if (options.cwd) parts.push("", `Session files live under ${options.cwd}.`);
  parts.push(`Recursion depth: ${depth}.`);
  return parts;
}

export function buildNotebookPrompt(options: NotebookPromptOptions): string {
  const depth = options.depth ?? 0;
  const parts = [ROLE];

  // They state the depth unconditionally; a model that knows it is at depth 0
  // reads the recursion clause differently from one that knows it is a worker.
  if (depth > 0) parts.push("", WORKER_BRIEF);
  parts.push("", DOCTRINE, ...body(options, depth));
  return parts.join("\n");
}

/**
 * The same doctrine as a SECTION of Cinderpaw's system prompt, rather than as the
 * whole of it.
 *
 * `buildNotebookPrompt` is upstream's shape, where the notebook IS the
 * execution mode and so the prompt may open with "you solve tasks by writing
 * code". Here the notebook is one tool among forty-odd, sitting underneath the
 * CinderpawAgent base and the user's SOUL.md — pasting that framing in would tell
 * the agent to route "what time is it" through a JS interpreter, and it would
 * contradict two higher-priority layers while doing it.
 *
 * So `ROLE` and `CHILD` are dropped (identity is not this section's business)
 * and everything that describes the *interpreter* is kept verbatim, including
 * the stop condition — the one ROLE line that is about REPLs rather than about
 * who the agent is, and the one that keeps a model from poking at a solved
 * problem.
 */
export function buildNotebookSection(options: NotebookPromptOptions): string {
  const depth = options.depth ?? 0;
  return [
    "## The notebook",
    "",
    "Run a cell by calling the `notebook` tool with your JavaScript in `code`.",
    "",
    DOCTRINE,
    "",
    STOP,
    ...body(options, depth),
  ].join("\n");
}
