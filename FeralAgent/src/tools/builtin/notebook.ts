/**
 * notebook — run a cell in this session's persistent JavaScript notebook.
 *
 * This is how the RLM design actually reaches the model. Prime Agent exposes
 * its IPython kernel as "the built-in model tool" rather than as a separate
 * execution mode, and the same shape fits Feral better than an engine swap
 * would: the agent loop, BRSI and FMS are untouched, and the notebook is one
 * more capability the registry gates like any other.
 *
 * One notebook per session, created on first use and kept afterwards — that is
 * what makes variables survive between turns. Sessions are evicted when the map
 * grows past MAX_SESSIONS so a long-lived gateway does not accumulate contexts
 * forever.
 *
 * The registry is passed as a getter because of a cycle: the notebook needs the
 * registry to expose tools, but this tool is itself registered *into* that
 * registry. Resolving it lazily on first call means registration order does not
 * matter. `notebook` excludes itself from the functions it injects, or the model
 * could call the notebook from inside the notebook.
 */

import { Notebook, type SpawnChild } from "../../rlm/repl.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { Tool, ToolManifest } from "../../types.ts";

export const NOTEBOOK_TOOL_NAME = "notebook";

/** Beyond this many live sessions, the least recently used notebook is dropped. */
const MAX_SESSIONS = 32;

const MANIFEST: ToolManifest = {
  name: NOTEBOOK_TOOL_NAME,
  description:
    "Run JavaScript in this session's persistent notebook. Variables, functions and data " +
    "survive between calls, so bind results and reuse them. Every other tool is available " +
    "as an async function — call them with await and one object of arguments, and compose " +
    "them in ordinary code (loops, conditionals, Promise.all). Returns the value of the " +
    "last expression plus anything logged with console.log.",
  // No permissions of its own: everything the notebook can reach is a tool that
  // carries its own, checked by the registry on each call.
  permissions: [],
  networkAccess: false,
};

export interface NotebookToolDeps {
  /** Resolved lazily — this tool lives inside the registry it reads. */
  registry: () => ToolRegistry;
  /** Enables `rlm()` inside the notebook. Omit to leave recursion unavailable. */
  spawn?: SpawnChild;
  maxDepth?: number;
}

export function createNotebookTool(deps: NotebookToolDeps): Tool {
  const books = new Map<string, Notebook>();

  return {
    manifest: MANIFEST,
    parameters: {
      code: {
        type: "string",
        description:
          "JavaScript to run. Top-level await works. The last expression is echoed back; " +
          "end it with ';' to suppress that.",
        required: true,
      },
    },
    async execute(args, ctx) {
      const code = args.code;
      if (typeof code !== "string" || !code.trim()) {
        return { ok: false, content: "", error: "bad_args: `code` must be a non-empty string" };
      }

      const sessionId = ctx.sessionId;
      let book = books.get(sessionId);
      if (!book) {
        if (books.size >= MAX_SESSIONS) books.delete(books.keys().next().value!);
        book = new Notebook({
          registry: deps.registry(),
          sessionId,
          signal: ctx.signal,
          exclude: [NOTEBOOK_TOOL_NAME],
          spawn: deps.spawn,
          maxDepth: deps.maxDepth,
        });
        books.set(sessionId, book);
      }

      const r = await book.run(code);

      // Report shape mirrors a REPL transcript: output first, then the value,
      // then the error. The model reads this, so keep it plain.
      const parts: string[] = [];
      if (r.output) parts.push(r.output);
      if (r.value !== undefined) parts.push(`=> ${r.value}`);
      if (r.error) parts.push(r.error);
      const content = parts.join("\n") || (r.ok ? "(no output)" : "(failed with no message)");

      return {
        ok: r.ok,
        content,
        data: { value: r.value, output: r.output, toolCalls: r.toolCalls },
        ...(r.ok ? {} : { error: "notebook_error" }),
      };
    },
  };
}
