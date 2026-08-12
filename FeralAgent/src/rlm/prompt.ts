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
 * like any other capability. Their recursion clause is dropped for now: it is
 * `rlm()` spawning child sessions, which we do not have yet.
 */

export interface NotebookPromptOptions {
  /** Identifiers the notebook exposes, one per registered tool. */
  toolIdentifiers: string[];
  /** Where the session's files live, when the model should know. */
  cwd?: string;
}

const DOCTRINE = [
  "You have a long-lived JavaScript notebook. It is not a scratchpad that resets: variables, helper functions, imports of your own making, parsed data and notes all persist across cells and across turns, including after context compaction. Treat it as working memory you can revisit rather than something to rebuild each turn.",
  "",
  "Always bind results to named variables. A tool result you did not assign is a tool call you will have to make again; a tool result you did assign can be sliced, filtered, counted and re-read for free.",
  "",
  "Tools are async functions in the notebook. Call them with `await`, pass one object of arguments, and compose them as ordinary program logic — loops, conditionals, helper functions. Prefer one cell that does five related calls and prints a summary over five turns that each do one call.",
  "",
  "Every tool returns `{ ok, content, data?, error? }`. Check `ok` before trusting `content`. Tool calls never throw, so a failure will not kill your cell — branch on it.",
  "",
  "Do not assume the notebook is the native environment of whatever you are investigating. A repository, service, dataset or API has its own interface and its own way of being run. Drive that thing through its own interface — via `shell_exec` where a command is the right answer — and use the notebook to coordinate the work and analyse what comes back.",
  "",
  "The notebook has no filesystem, network or process access of its own. There is no `fetch`, no `require`, no `process`. Every capability you have is one of the tool functions listed below, and each one is permission-checked and audited. This is not a limitation to work around; it is the only way to act, so reach for the right tool rather than trying to improvise access.",
  "",
  "The value of a cell's last expression is echoed back to you, so a bare `notes` or `results.length` on the final line is a cheap way to inspect state without printing everything.",
].join("\n");

export function buildNotebookPrompt(options: NotebookPromptOptions): string {
  const parts = [DOCTRINE];

  if (options.toolIdentifiers.length > 0) {
    parts.push(
      "",
      `Tool functions available in the notebook: ${options.toolIdentifiers.slice().sort().join(", ")}.`,
    );
  }
  if (options.cwd) {
    parts.push("", `Session files live under ${options.cwd}.`);
  }
  return parts.join("\n");
}
