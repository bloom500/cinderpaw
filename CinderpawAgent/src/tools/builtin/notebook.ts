/**
 * notebook — run a cell in this session's persistent JavaScript notebook.
 *
 * This is how the RLM design actually reaches the model. Prime Agent exposes
 * its IPython kernel as "the built-in model tool" rather than as a separate
 * execution mode, and the same shape fits Cinderpaw better than an engine swap
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

import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../../atomic-write.ts";
import { join } from "node:path";
import { Notebook } from "../../rlm/repl.ts";
import { ChildRegistry, type ChildTelemetry, type RunChild } from "../../rlm/children.ts";
import type { ToolRegistry } from "../../tools/registry.ts";
import type { Tool, ToolManifest } from "../../types.ts";
import { hostToolNames } from "../tiers.ts";

export const NOTEBOOK_TOOL_NAME = "notebook";

/**
 * What a worker spawned by `rlm()` may touch when the caller does not say.
 * Deliberately identical to delegate_task's default — read-only. Code that
 * spawns workers must not be a side door to write access the parent never
 * granted; a caller that needs more passes it explicitly.
 */
export const NOTEBOOK_CHILD_TOOLS: string[] = [
  "read_file",
  "list_directory",
  "grep",
  "file_search",
  "web_search",
  "read_webpage",
  "fetch_url",
  "time_date",
  "calculator",
  "recall",
  "read_skill",
];

/** Beyond this many live sessions, the least recently used notebook is dropped. */
const MAX_SESSIONS = 32;

/** Upstream debounces its auto-snapshot by 1500ms; same window here. */
const PERSIST_DEBOUNCE_MS = 1_500;

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
  /**
   * Runs one child to completion. Wrapped in a per-session ChildRegistry, which
   * is what gives `rlm()` its instant admission — this function is allowed to
   * take minutes; nobody awaits it inline.
   */
  runChild?: (
    task: string,
    allowedTools: string[] | undefined,
    sessionId: string,
    onEvent: (kind: string, detail: string) => void,
    childId: string,
    signal: AbortSignal,
  ) => ReturnType<RunChild>;
  /**
   * Live worker telemetry, tagged with the session that spawned it. The host
   * turns this into an `rlm_child` event; omit it and workers run silently as
   * before.
   */
  onChildEvent?: (e: Parameters<ChildTelemetry>[0] & { sessionId: string }) => void;
  maxDepth?: number;
  /** Where per-session snapshots live. Omit to keep notebooks in memory only. */
  stateDir?: string;
  /** Shared with createNotifyParentTool so a child can reach its parent. */
  registries?: ChildRegistries;
}

/**
 * Parent session id -> that parent's children. Shared with `notify_parent`,
 * which is called by a CHILD and has to find the registry that admitted it.
 * Keyed by the parent's session because that is what a child's session id
 * carries: `subagent:<parentSessionId>:<childId>`.
 */
export type ChildRegistries = Map<string, ChildRegistry>;

export function createNotebookTool(deps: NotebookToolDeps): Tool {
  const books = new Map<string, Notebook>();
  const registries: ChildRegistries = deps.registries ?? new Map();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const file = (sessionId: string) =>
    join(deps.stateDir!, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

  /**
   * Debounced write, mirroring upstream's auto-snapshot (their default window
   * is 1500ms). A cell that assigns in a loop would otherwise write the whole
   * namespace once per assignment.
   */
  function schedulePersist(sessionId: string, book: Notebook) {
    if (!deps.stateDir) return;
    clearTimeout(timers.get(sessionId));
    const t = setTimeout(() => {
      try {
        mkdirSync(deps.stateDir!, { recursive: true });
        atomicWriteFileSync(file(sessionId), JSON.stringify(book.snapshot()));
      } catch {
        // A notebook that cannot persist is still a working notebook; losing
        // state on restart is not worth failing the user's cell over.
      }
    }, PERSIST_DEBOUNCE_MS);
    t.unref?.(); // never hold the process open for a pending snapshot
    timers.set(sessionId, t);
  }

  /** One registry per parent session, created once and shared with the tool. */
  function childrenFor(sessionId: string): ChildRegistry {
    let reg = registries.get(sessionId);
    if (!reg) {
      reg = new ChildRegistry(
        (task, allowedTools, onEvent, childId, signal) =>
          deps.runChild!(task, allowedTools, sessionId, onEvent, childId, signal),
        // The registry is per session, so the tag is closed over here rather
        // than threaded through every telemetry call.
        deps.onChildEvent ? (e) => deps.onChildEvent!({ ...e, sessionId }) : undefined,
      );
      registries.set(sessionId, reg);
    }
    return reg;
  }

  function loadInto(sessionId: string, book: Notebook) {
    if (!deps.stateDir) return;
    try {
      book.restore(JSON.parse(readFileSync(file(sessionId), "utf8")));
    } catch {
      // No snapshot yet, or an unreadable one — start clean.
    }
  }

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
          // Host-owned tools are excluded alongside the notebook itself, and
          // for a stronger reason than tidiness: they CANNOT work in here.
          //
          // A host tool suspends the call and waits for the host to answer over
          // stdout/stdin. The host can only answer after the agent loop yields
          // — in tau2-bench, after the orchestrator has been handed the tool
          // call, executed it and called back. None of that can happen while a
          // cell is still running inside a single tool call, so the await never
          // resolves and the registry kills the notebook at its 60s timeout.
          //
          // Observed exactly that: the model loaded the notebook, wrote three
          // domain calls into one cell — good instinct, it is what the notebook
          // is FOR — and every turn died on "Tool aborted: timeout" with no
          // answer and no tool call the harness could see. The two mechanisms
          // want opposite things: the notebook composes many calls into one
          // completion, a host tool needs one call per round trip. Excluding
          // them here keeps the notebook useful for computation and forces the
          // domain calls out through the loop, where the host can answer them.
          exclude: [NOTEBOOK_TOOL_NAME, ...hostToolNames()],
          // One registry per session, so `list_subagents()` only ever shows a
          // parent its own direct children — upstream's rule.
          children: deps.runChild ? childrenFor(sessionId) : undefined,
          // A notebook running inside a subagent is already one level down, so
          // its `rlm()` must be gone — otherwise the depth cap counts from zero
          // again and recursion is unbounded in practice.
          depth: sessionId.startsWith("subagent:") ? 1 : 0,
          maxDepth: deps.maxDepth,
        });
        loadInto(sessionId, book);
        books.set(sessionId, book);
      }

      // Point the notebook at THIS turn's abort before running. The notebook
      // is per session and outlives any one controller, so without this a cell
      // from turn 2 onwards ran with turn 1's dead signal and could not be
      // stopped — nor could the workers it spawned.
      book.signal = ctx.signal;

      const r = await book.run(code);
      schedulePersist(sessionId, book);

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

/** Name the child sees. Kept short — it goes in a filtered tool list. */
export const NOTIFY_PARENT_TOOL_NAME = "notify_parent";

/**
 * `notify_parent` — the child half of the mailbox.
 *
 * A worker runs the ordinary agent loop, not a notebook, so it needs a real
 * tool to report something before it finishes. Routing works because the
 * child's session id is `subagent:<parentSessionId>:<childId>` and the child id
 * is the one its parent's ChildRegistry admitted it under — that is the whole
 * reason SubagentConfig now takes a caller-supplied id.
 *
 * A child that is not in its claimed parent's registry is refused rather than
 * silently dropped: posting to a stranger's inbox is exactly the failure worth
 * making loud.
 */
export function createNotifyParentTool(registries: ChildRegistries): Tool {
  return {
    manifest: {
      name: NOTIFY_PARENT_TOOL_NAME,
      description:
        "Send a short message to the agent that spawned you, without waiting to finish. " +
        "Use it when you find something worth acting on early, or when you are blocked " +
        "and the answer changes what you should do next. Your final answer is still " +
        "reported separately when you are done.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {
      message: { type: "string", description: "What to tell the parent.", required: true },
    },
    async execute(args, ctx) {
      const message = args.message;
      if (typeof message !== "string" || !message.trim()) {
        return { ok: false, content: "", error: "bad_args: `message` must be a non-empty string" };
      }
      const parts = ctx.sessionId.split(":");
      if (parts[0] !== "subagent" || parts.length < 3) {
        return { ok: false, content: "", error: "notify_parent is only callable by a spawned worker" };
      }
      const parentSessionId = parts.slice(1, -1).join(":");
      const childId = parts.at(-1)!;
      const reg = registries.get(parentSessionId);
      if (!reg) {
        return { ok: false, content: "", error: "no parent inbox for this session" };
      }
      try {
        reg.post(childId, message);
      } catch (e) {
        return { ok: false, content: "", error: e instanceof Error ? e.message : String(e) };
      }
      return { ok: true, content: "delivered" };
    },
  };
}
