/**
 * The notebook's load-bearing property is not that it evaluates JavaScript —
 * it is that it evaluates JavaScript with NO ambient authority. These tests
 * fail loudly if someone widens the sandbox, which is the mistake that would
 * quietly hand the model every permission at once.
 */

import { describe, expect, it } from "bun:test";
import { Notebook, toIdentifier } from "../src/rlm/repl.ts";
import { buildNotebookPrompt } from "../src/rlm/prompt.ts";
import { buildNotebookAddendum, buildWorkerAddendum } from "../src/core/agent-loop.ts";
import { stripToolsFromSystemPrompt } from "../src/egress/inference-providers.ts";
import {
  ChildRegistry,
  defaultChildName,
  normalizeRequestedName,
  type RunChild,
} from "../src/rlm/children.ts";
import {
  createNotebookTool,
  createNotifyParentTool,
  type ChildRegistries,
} from "../src/tools/builtin/notebook.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool, ToolResult } from "../src/types.ts";

/** Minimal registry stand-in: only `list()` and `call()` are used. */
function fakeRegistry(calls: Array<{ name: string; args: unknown }> = []): ToolRegistry {
  const tools = [
    { manifest: { name: "read_file" } },
    { manifest: { name: "shell-exec" } },
  ] as unknown as Tool[];

  return {
    list: () => tools,
    call: async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
      calls.push({ name, args });
      if (name === "read_file") return { ok: true, content: `contents of ${args.path}` };
      return { ok: false, content: "", error: "boom" };
    },
  } as unknown as ToolRegistry;
}

describe("notebook isolation", () => {
  it("has no ambient network, process or module access", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    for (const expr of ["typeof fetch", "typeof process", "typeof require", "typeof Bun"]) {
      const r = await nb.run(expr);
      expect(r.ok).toBe(true);
      expect(r.value).toBe("undefined");
    }
  });

  // The `.constructor.constructor` walk is the classic vm escape and it is a
  // one-liner a model can produce by accident — it is a common JS idiom. Each
  // route below reached the host realm at some point during development; they
  // stay as regression tests. If any starts returning "object", the notebook is
  // handing out unaudited filesystem and network access.
  it.each([
    ["this", `this.constructor.constructor("return typeof process")()`],
    ["a literal", `({}).constructor.constructor("return typeof process")()`],
    ["an array", `[].constructor.constructor("return typeof process")()`],
    ["a builtin", `JSON.constructor.constructor("return typeof process")()`],
    ["a tool wrapper", `read_file.constructor.constructor("return typeof process")()`],
    ["console", `console.log.constructor.constructor("return typeof process")()`],
    ["a tool result", `(await read_file({path:"/x"})).constructor.constructor("return typeof process")()`],
  ])("cannot reach the host realm via %s", async (_label, source) => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    const r = await nb.run(source);
    // Either the walk throws, or it lands somewhere with no host process.
    expect(r.ok === false || r.value === "undefined").toBe(true);
  });

  it("still exposes the context's own builtins", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    expect((await nb.run(`JSON.stringify({a:1})`)).value).toBe(`{"a":1}`);
    expect((await nb.run(`[3,1,2].sort().join("")`)).value).toBe("123");
    expect((await nb.run(`Math.max(1,9)`)).value).toBe("9");
  });
});

describe("notebook state", () => {
  it("keeps variables across cells — the whole point", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    await nb.run("const findings = []; findings.push('one');");
    await nb.run("findings.push('two');");
    const r = await nb.run("findings.length");
    expect(r.value).toBe("2");
  });

  it("echoes the last expression but leaves statements alone", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    expect((await nb.run("const a = 41; a + 1")).value).toBe("42");
    const decl = await nb.run("const b = 7;");
    expect(decl.ok).toBe(true);
    expect(decl.value).toBeUndefined();
  });

  it("captures console output in order", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    const r = await nb.run("console.log('a'); console.log('b'); 1");
    expect(r.output).toBe("a\nb");
  });
});

describe("tools", () => {
  it("routes every call through the registry and records it", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const nb = new Notebook({ registry: fakeRegistry(calls), sessionId: "s1" });
    const r = await nb.run(`const f = await read_file({ path: "/x" }); f.content`);
    expect(r.value).toBe("contents of /x");
    expect(calls).toEqual([{ name: "read_file", args: { path: "/x" } }]);
    expect(r.toolCalls).toEqual(["read_file"]);
  });

  it("surfaces tool failure as a value, not an exception", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    const r = await nb.run(`const res = await shell_exec({ cmd: "x" }); res.ok`);
    expect(r.ok).toBe(true);
    expect(r.value).toBe("false");
  });

  it("maps awkward tool names to usable identifiers", () => {
    expect(toIdentifier("shell-exec")).toBe("shell_exec");
    expect(toIdentifier("read_file")).toBe("read_file");
    expect(toIdentifier("9lives")).toBe("_9lives");
  });
});

describe("recursion — the R in RLM", () => {
  const runner = (delayMs = 0) =>
    async (task: string, allowedTools?: string[]) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return {
        status: "completed" as const,
        answer: `did: ${task}${allowedTools ? ` [${allowedTools.join(",")}]` : ""}`,
        toolCalls: 1,
        durationMs: 5,
        subagentId: "ignored",
      };
    };

  const nbWith = (run = runner(), extra: Record<string, unknown> = {}) => {
    const children = new ChildRegistry(run);
    return {
      children,
      nb: new Notebook({ registry: fakeRegistry(), sessionId: "s1", children, ...extra }),
    };
  };

  /**
   * Cancellation. Found live: two `rlm()` workers were spawned, Stop was
   * pressed, and nothing reached them — a child runs its own AgentLoop under
   * its own session id, so the parent's abort had no path to it. These pin the
   * path that now exists, because the failure is invisible: a worker nobody
   * can stop looks exactly like a worker that already finished.
   */
  describe("Stop reaches the workers", () => {
    /** A runner that never settles on its own — only cancellation ends it. */
    const hangingRunner =
      (seen: AbortSignal[]): RunChild =>
      (_task, _tools, _onEvent, _id, signal) => {
        seen.push(signal);
        const cancelled = {
          status: "cancelled" as const, answer: "", toolCalls: 0, durationMs: 1, subagentId: "x",
        };
        // Checking `aborted` first is the contract, not defensive noise: a
        // signal that fired before the runner was reached never emits `abort`,
        // so a listen-only implementation hangs forever. Subagent.run has the
        // same check for the same reason.
        if (signal.aborted) return Promise.resolve(cancelled);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(cancelled), { once: true });
        });
      };

    it("aborts a running child when the parent's signal fires", async () => {
      const seen: AbortSignal[] = [];
      const parent = new AbortController();
      const reg = new ChildRegistry(hangingRunner(seen));
      reg.admit("work", { signal: parent.signal });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.aborted).toBe(false);
      parent.abort("user stop");
      expect(seen[0]!.aborted).toBe(true);
      // The child settles rather than hanging forever, which is what makes the
      // registry drainable after a stop.
      await reg.drain();
      expect(reg.list()[0]!.status).toBe("error");
    });

    it("hands an already-stopped parent's child a dead signal, not a live one", async () => {
      // Spawning for a turn the user just stopped would spend money on an
      // answer nobody is waiting for.
      const seen: AbortSignal[] = [];
      const parent = new AbortController();
      parent.abort("user stop");
      const reg = new ChildRegistry(hangingRunner(seen));
      reg.admit("work", { signal: parent.signal });
      expect(seen[0]!.aborted).toBe(true);
      await reg.drain();
    });

    it("keeps siblings alive — one controller per child, not one shared", async () => {
      const seen: AbortSignal[] = [];
      const reg = new ChildRegistry(hangingRunner(seen));
      const a = new AbortController();
      reg.admit("first", { signal: a.signal });
      reg.admit("second"); // no parent signal at all
      a.abort();
      expect(seen[0]!.aborted).toBe(true);
      expect(seen[1]!.aborted).toBe(false);
    });

    it("uses THIS turn's signal, not the one the notebook was born with", async () => {
      // The notebook is per session and outlives any one controller. Reading
      // the constructor's signal meant every cell after the first was
      // unstoppable — the same bug, one layer up.
      const seen: AbortSignal[] = [];
      const turn1 = new AbortController();
      const turn2 = new AbortController();
      const nb = new Notebook({
        registry: fakeRegistry(),
        sessionId: "s1",
        signal: turn1.signal,
        children: new ChildRegistry(hangingRunner(seen)),
      });
      nb.signal = turn2.signal;
      await nb.run(`await rlm("later turn")`);
      turn1.abort(); // the stale one must not reach it
      expect(seen[0]!.aborted).toBe(false);
      turn2.abort();
      expect(seen[0]!.aborted).toBe(true);
    });
  });

  /**
   * Telemetry. A worker had no UI at all: `rlm()` returns instantly, so the
   * turn ends and the child does everything afterwards, with nothing on screen
   * to say it exists. The registry — not the host — emits, because it is the
   * only place that knows both the name (which the caller may have chosen) and
   * the status transitions; deriving either outside would drift from what
   * `rlm.list_subagents()` reports.
   */
  describe("worker telemetry", () => {
    const collect = () => {
      const seen: Array<{ name: string; status: string; detail?: string }> = [];
      return { seen, sink: (e: { name: string; status: string; detail?: string }) => seen.push(e) };
    };

    it("announces the worker the moment it is admitted, not when it finishes", async () => {
      const { seen, sink } = collect();
      const reg = new ChildRegistry(runner(), sink);
      reg.admit("count the files");
      // Synchronous with admit: the whole point is that the UI shows the
      // worker during the minutes it runs, not after.
      expect(seen[0]!.status).toBe("running");
      expect(seen[0]!.detail).toContain("count the files");
      await reg.drain();
      expect(seen.at(-1)!.status).toBe("completed");
    });

    it("carries the caller's chosen name, not a derived one", async () => {
      const { seen, sink } = collect();
      const reg = new ChildRegistry(runner(), sink);
      reg.admit("anything", { name: "api-reviewer" });
      expect(seen[0]!.name).toBe("api-reviewer");
      await reg.drain();
    });

    it("reports a stopped worker as cancelled, not as an error", async () => {
      const { seen, sink } = collect();
      const reg = new ChildRegistry(
        async () => ({
          status: "cancelled" as const, answer: "", toolCalls: 0, durationMs: 1, subagentId: "x",
        }),
        sink,
      );
      reg.admit("work");
      await reg.drain();
      expect(seen.at(-1)!.status).toBe("cancelled");
    });

    it("survives a telemetry sink that throws", async () => {
      // An observer is a UI concern; it must never be able to kill a worker.
      const reg = new ChildRegistry(runner(), () => {
        throw new Error("render blew up");
      });
      expect(() => reg.admit("work")).not.toThrow();
      await reg.drain();
      expect(reg.list()[0]!.status).toBe("completed");
    });
  });

  it("returns a handle immediately, not the answer", async () => {
    const { nb } = nbWith();
    const r = await nb.run(`const h = await rlm("count the files"); JSON.stringify(h)`);
    const h = JSON.parse(r.value!);
    expect(h.status).toBe("running");
    expect(h.name).toContain("count-the-files");
    expect(h.answer).toBeUndefined();
  });

  it("admits a batch without waiting for any of them", async () => {
    const { nb, children } = nbWith(runner(40));
    const started = Date.now();
    const r = await nb.run(`
      const hs = await Promise.all(["a","bb","ccc"].map((p) => rlm(p, { name: p })));
      hs.length
    `);
    // Three 40ms children; admission must not have serialised them.
    expect(Date.now() - started).toBeLessThan(60);
    expect(r.value).toBe("3");
    await children.drain();
  });

  it("collects settled children through list_subagents", async () => {
    const { nb, children } = nbWith();
    await nb.run(`await rlm("summarise", { name: "sum" })`);
    await children.drain();
    const r = await nb.run(`
      const { subagents } = await rlm.list_subagents();
      subagents.map((s) => s.name + ":" + s.status + ":" + s.answer).join("|")
    `);
    expect(r.value).toBe("sum:completed:did: summarise");
  });

  it("shows a child still running as running, with no answer", async () => {
    const { nb, children } = nbWith(runner(200));
    await nb.run(`await rlm("slow one")`);
    const r = await nb.run(`(await rlm.list_subagents()).subagents[0].status`);
    expect(r.value).toBe("running");
    await children.drain();
  });

  it("rejects a duplicate sibling name", async () => {
    const { nb, children } = nbWith();
    await nb.run(`await rlm("one", { name: "dup" })`);
    const r = await nb.run(`await rlm("two", { name: "dup" })`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("already used by a sibling");
    await children.drain();
  });

  it("deletes a settled child but keeps a running one", async () => {
    const { nb, children } = nbWith(runner(150));
    await nb.run(`await rlm("busy", { name: "busy" })`);
    const kept = await nb.run(`(await rlm.delete_subagent("busy")).outcome`);
    expect(kept.value).toBe("skipped_running");
    await children.drain();
    const gone = await nb.run(`(await rlm.delete_subagent("busy")).outcome`);
    expect(gone.value).toBe("deleted");
    expect((await nb.run(`(await rlm.list_subagents()).subagents.length`)).value).toBe("0");
  });

  it("passes a narrowed tool set through", async () => {
    const { nb, children } = nbWith();
    await nb.run(`await rlm("read it", { allowedTools: ["read_file"] })`);
    await children.drain();
    const r = await nb.run(`(await rlm.list_subagents()).subagents[0].answer`);
    expect(r.value).toBe("did: read it [read_file]");
  });

  it("records a failed child as error rather than throwing", async () => {
    const { nb, children } = nbWith(async () => {
      throw new Error("child exploded");
    });
    const admitted = await nb.run(`(await rlm("doomed")).status`);
    expect(admitted.value).toBe("running");
    await children.drain();
    const r = await nb.run(`
      const s = (await rlm.list_subagents()).subagents[0];
      s.status + ":" + s.error
    `);
    expect(r.value).toBe("error:child exploded");
  });

  it("refuses to recurse past the depth limit", async () => {
    const { nb } = nbWith(runner(), { depth: 1 });
    const r = await nb.run(`await rlm("go deeper")`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("depth limit reached");
  });

  it("omits rlm entirely when no registry is wired", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    expect((await nb.run("typeof rlm")).value).toBe("undefined");
  });

  it("rejects an empty task instead of admitting", async () => {
    const { nb } = nbWith();
    const r = await nb.run(`await rlm("   ")`);
    expect(r.ok).toBe(false);
  });

  it("does not let a handle leak the host realm", async () => {
    const { nb, children } = nbWith();
    const r = await nb.run(`(await rlm("x")).constructor.constructor("return typeof process")()`);
    expect(r.ok === false || r.value === "undefined").toBe(true);
    await children.drain();
  });
});

describe("child naming — ported from prime-agent", () => {
  it("slugs the task and keeps it selector-safe", () => {
    expect(defaultChildName("Review the API", "sa-abcd1234")).toBe("subagent-review-the-api-abcd1234");
  });

  it("strips diacritics instead of dropping the words", () => {
    expect(defaultChildName("Verifică rațele", "sa-9x")).toContain("verifica-ratele");
  });

  it("falls back when a task slugs to nothing", () => {
    expect(defaultChildName("!!! ???", "sa-zz")).toContain("worker");
  });

  it("stays within the 64-char selector cap", () => {
    expect(defaultChildName("x".repeat(300), "sa-abcdefgh").length).toBeLessThanOrEqual(64);
  });

  it("applies upstream's name validation", () => {
    expect(() => normalizeRequestedName(42)).toThrow("must be a string");
    expect(() => normalizeRequestedName("  ")).toThrow("must not be empty");
    expect(() => normalizeRequestedName("y".repeat(65))).toThrow("at most 64");
    expect(normalizeRequestedName(undefined)).toBeUndefined();
  });
});

describe("failure handling", () => {
  it("returns the error instead of throwing", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    const r = await nb.run("throw new Error('nope')");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
  });

  it("gives up on a cell that never settles", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", cellTimeoutMs: 60 });
    const r = await nb.run("await new Promise(() => {})");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("timed out");
  });
});

/**
 * Audit against Prime Agent's `core/prompts/rlm.ts` at commit 965941c. Each
 * case pins one instruction that survived the port because it changes model
 * behaviour. If someone trims the prompt, these say which of their findings is
 * being thrown away.
 */
describe("prompt — parity with the audited source", () => {
  const base = { toolIdentifiers: ["read_file", "shell_exec"] };

  it("states the role, the iterate loop and the stop condition", () => {
    const p = buildNotebookPrompt(base);
    expect(p).toContain("solves tasks by writing code");
    expect(p).toContain("iterate one step at a time");
    expect(p).toContain("stop running cells and state your final answer");
  });

  it("keeps the instructions that make the notebook worth having", () => {
    const p = buildNotebookPrompt(base);
    expect(p).toContain("persist across cells");
    expect(p).toContain("bind results to named variables");
    expect(p).toContain("Do not assume the notebook is the native environment");
    expect(p).toContain("its failure is the answer");
  });

  it("guards against invented APIs", () => {
    expect(buildNotebookPrompt(base)).toContain("Do not invent wrappers");
  });

  it("sends the model to `data` when it computes, not to `content`", () => {
    // Found live on the first real RLM run: asked for line counts, the model
    // read `res.content` from shell_exec and counted its three-line header
    // ($ command / cwd / [exit N]) as file content. Every file came back
    // exactly three lines too long — wrong quietly, which is the bad kind.
    const p = buildNotebookPrompt(base);
    expect(p).toContain("`content` is a TRANSCRIPT");
    expect(p).toContain("use `data`");
  });

  it("lists tools deterministically", () => {
    const a = buildNotebookPrompt({ toolIdentifiers: ["b", "a"] });
    const b = buildNotebookPrompt({ toolIdentifiers: ["a", "b"] });
    expect(a).toBe(b);
    expect(a).toContain("a, b");
  });

  it("tells a worker it is one, and the root that it is not", () => {
    const child = buildNotebookPrompt({ ...base, depth: 1 });
    expect(child).toContain("You are a worker spawned by another agent");
    expect(child).toContain("Recursion depth: 1");
    expect(buildNotebookPrompt({ ...base, depth: 0 })).not.toContain("You are a worker");
  });

  it("describes rlm only when recursion is actually available", () => {
    const on = buildNotebookPrompt({ ...base, allowRecursion: true });
    expect(on).toContain("await rlm(");
    // The divergence from Prime Agent: our rlm returns the answer.
    expect(on).toContain("rlm_child_id");

    const off = buildNotebookPrompt({ ...base, allowRecursion: false, depth: 1 });
    expect(off).toContain("`rlm` is not available at this depth");
    expect(off).not.toContain("await rlm(");
  });
});

/**
 * Delivery. The doctrine above is worth nothing until it reaches a model, and
 * for its first three weeks it reached none: `buildNotebookPrompt` was exported,
 * tested, and called from nowhere but this file. The notebook tool shipped with
 * it, so the model got a JavaScript interpreter and no hint that its variables
 * survive — which is the single property the whole design exists for. These
 * tests pin the wiring, not the wording.
 */
describe("the doctrine actually reaches the prompt", () => {
  const withNotebook = (names: string[]) =>
    ({
      list: () => names.map((name) => ({ manifest: { name, description: `Does ${name}.` } })),
    }) as unknown as ToolRegistry;

  it("is silent when the notebook is not registered — the default", () => {
    expect(buildNotebookAddendum(withNotebook(["read_file", "grep"]), "s1")).toBe("");
  });

  it("delivers the doctrine when the notebook IS registered", () => {
    const p = buildNotebookAddendum(withNotebook(["read_file", "notebook"]), "s1");
    expect(p).toContain("## The notebook");
    expect(p).toContain("bind results to named variables");
    expect(p).toContain("persist across cells");
  });

  it("drops upstream's identity framing, which would outrank SOUL.md", () => {
    const p = buildNotebookAddendum(withNotebook(["notebook"]), "s1");
    expect(p).not.toContain("solves tasks by writing code");
    // …but keeps the stop condition, which is about REPLs, not identity.
    expect(p).toContain("stop running cells and state your final answer");
  });

  it("lists the functions the notebook really injects, itself excluded", () => {
    const p = buildNotebookAddendum(withNotebook(["read_file", "shell-exec", "notebook"]), "s1");
    // `shell-exec` is not a JS identifier; the notebook binds it as shell_exec.
    expect(p).toContain("read_file, shell_exec");
    expect(p).not.toContain("notebook,");
  });

  it("promises recursion to a root session and withholds it from a worker", () => {
    const root = buildNotebookAddendum(withNotebook(["notebook"]), "chat-42");
    expect(root).toContain("await rlm(");
    expect(root).toContain("Recursion depth: 0");

    // Matches notebook.ts's own rule: a subagent's notebook binds no `rlm`, so
    // telling it otherwise sends it after a function that does not exist.
    const worker = buildNotebookAddendum(withNotebook(["notebook"]), "subagent:chat-42:sa-1");
    expect(worker).toContain("`rlm` is not available at this depth");
    expect(worker).not.toContain("await rlm(");
    expect(worker).toContain("Recursion depth: 1");
  });

  it("tolerates a registry fake without list()", () => {
    expect(buildNotebookAddendum({ describe: () => "" } as unknown as ToolRegistry, "s1")).toBe("");
  });

  it("tells a worker it is one, whoever spawned it", () => {
    // Not notebook-specific: delegate_task builds its child the same way, so a
    // plain delegation gets this too.
    expect(buildWorkerAddendum("subagent:chat-42:sa-1")).toContain("You are a worker");
    expect(buildWorkerAddendum("subagent:chat-42:sa-1")).toContain("read by that agent");
    expect(buildWorkerAddendum("chat-42")).toBe("");
  });

  it("matches the name the REAL tool registers under", () => {
    // The name is taken from the tool itself rather than typed here, so a
    // rename breaks this test instead of silently switching the doctrine off
    // for everyone — the gap this whole block exists to close.
    const real = createNotebookTool({ registry: () => withNotebook([]) });
    const p = buildNotebookAddendum(withNotebook([real.manifest.name]), "s1");
    expect(p).toContain("## The notebook");
  });

  it("SURVIVES the native-tool prompt strip", () => {
    // Cloud routes with native tool-calling delete the `## Available tools`
    // block. A doctrine that lived inside it would vanish on exactly the
    // providers the notebook is most useful on.
    const prompt = [
      "## Available tools",
      "- read_file(path): reads",
      "",
      "## Rules",
      "- Be concise.",
      "",
      buildNotebookAddendum(withNotebook(["read_file", "notebook"]), "s1"),
    ].join("\n");
    const stripped = stripToolsFromSystemPrompt(prompt);
    expect(stripped).not.toContain("- read_file(path): reads");
    expect(stripped).toContain("bind results to named variables");
  });
});

/**
 * Snapshot/restore. Upstream persists its IPython namespace with dill under a
 * size cap; JavaScript has no dill, so this keeps what JSON round-trips and is
 * honest about the rest. The tests pin that honesty: a closure must not come
 * back as a broken shell, and an injected name must never be overwritten.
 */
describe("snapshot", () => {
  it("round-trips plain data into a fresh notebook", async () => {
    const a = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    await a.run(`const findings = ["x", "y"]; const meta = { n: 2, deep: { ok: true } };`);

    const b = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    const restored = b.restore(a.snapshot());
    expect(restored.sort()).toEqual(["findings", "meta"]);
    expect((await b.run(`findings.join("") + meta.deep.ok + meta.n`)).value).toBe("xytrue2");
  });

  it("skips what cannot be revived honestly, and says so", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    await nb.run(`
      const helper = (x) => x * 2;
      const cyclic = {}; cyclic.self = cyclic;
      const fine = 42;
    `);
    const snap = nb.snapshot();
    expect(Object.keys(snap.vars)).toEqual(["fine"]);
    expect(snap.skipped.sort()).toEqual(["cyclic", "helper"]);
  });

  it("drops a variable above the size cap rather than writing it", async () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    await nb.run(`const big = "z".repeat(5000); const small = 1;`);
    const snap = nb.snapshot(1000);
    expect(snap.skipped).toContain("big");
    expect(snap.vars.small).toBe(1);
  });

  it("never captures or overwrites injected names", async () => {
    const children = new ChildRegistry(async () => ({
      status: "completed" as const, answer: "a", toolCalls: 0, durationMs: 1, subagentId: "x",
    }));
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    const snap = nb.snapshot();
    for (const name of ["read_file", "shell_exec", "rlm", "console"]) {
      expect(Object.keys(snap.vars)).not.toContain(name);
    }
    // A hostile snapshot must not be able to replace a tool with data.
    nb.restore({ vars: { read_file: "pwned", ok: 1 } });
    expect((await nb.run("typeof read_file")).value).toBe("function");
    expect((await nb.run("ok")).value).toBe("1");
  });

  it("survives a missing or malformed snapshot", () => {
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1" });
    expect(nb.restore(null)).toEqual([]);
    expect(nb.restore(undefined)).toEqual([]);
    expect(nb.restore({})).toEqual([]);
  });
});

describe("observe — watching a worker that is still going", () => {
  it("reports the trail while the child is running", async () => {
    let emit!: (k: string, d: string) => void;
    const children = new ChildRegistry(async (_t, _a, onEvent) => {
      emit = onEvent;
      await new Promise((r) => setTimeout(r, 120));
      return { status: "completed" as const, answer: "ok", toolCalls: 2, durationMs: 9, subagentId: "x" };
    });
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });

    await nb.run(`await rlm("dig", { name: "digger" })`);
    emit("tool_start", "read_file");
    emit("tool_done", "read_file");

    const r = await nb.run(`
      const o = await rlm.observe("digger");
      o.status + ":" + o.trail.map((t) => t.kind + "/" + t.detail).join(",")
    `);
    expect(r.value).toBe("running:tool_start/read_file,tool_done/read_file");
    await children.drain();
  });

  it("keeps the trail bounded so a runaway child cannot grow it forever", async () => {
    let emit!: (k: string, d: string) => void;
    const children = new ChildRegistry(async (_t, _a, onEvent) => {
      emit = onEvent;
      await new Promise((r) => setTimeout(r, 80));
      return { status: "completed" as const, answer: "ok", toolCalls: 0, durationMs: 1, subagentId: "x" };
    });
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    await nb.run(`await rlm("noisy", { name: "noisy" })`);
    for (let i = 0; i < 100; i++) emit("tool_done", `call-${i}`);

    const r = await nb.run(`(await rlm.observe("noisy")).trail.length`);
    expect(Number(r.value)).toBeLessThanOrEqual(40);
    const last = await nb.run(`(await rlm.observe("noisy")).trail.at(-1).detail`);
    expect(last.value).toBe("call-99"); // newest kept, oldest dropped
    await children.drain();
  });

  it("errors on an unknown child rather than returning an empty shell", async () => {
    const children = new ChildRegistry(async () => ({
      status: "completed" as const, answer: "", toolCalls: 0, durationMs: 0, subagentId: "x",
    }));
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    const r = await nb.run(`await rlm.observe("ghost")`);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no child matches");
  });
});

describe("mailbox — a worker reporting before it finishes", () => {
  const mk = () => {
    let childId = "";
    const children = new ChildRegistry(async (_t, _a, onEvent) => {
      onEvent("started", "");
      await new Promise((r) => setTimeout(r, 120));
      return { status: "completed" as const, answer: "done", toolCalls: 0, durationMs: 1, subagentId: "x" };
    });
    return { children, id: () => childId };
  };

  it("delivers a running child's message to the parent", async () => {
    const { children } = mk();
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    const h = JSON.parse((await nb.run(`JSON.stringify(await rlm("scan", { name: "scout" }))`)).value!);

    children.post(h.rlm_child_id, "  found three candidates  ");
    const r = await nb.run(`
      const { messages } = await rlm.messages();
      messages.map((m) => m.from + ": " + m.text).join("|")
    `);
    expect(r.value).toBe("scout: found three candidates");
    await children.drain();
  });

  it("drains on read so the parent does not re-act on the same report", async () => {
    const { children } = mk();
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    const h = JSON.parse((await nb.run(`JSON.stringify(await rlm("x"))`)).value!);
    children.post(h.rlm_child_id, "one");

    expect((await nb.run(`(await rlm.pending())`)).value).toBe("1");
    await nb.run(`await rlm.messages()`);
    expect((await nb.run(`(await rlm.messages()).messages.length`)).value).toBe("0");
    expect((await nb.run(`(await rlm.pending())`)).value).toBe("0");
    await children.drain();
  });

  it("refuses a message from a child that is not ours", async () => {
    const { children } = mk();
    expect(() => children.post("sa-nobody", "hi")).toThrow("unknown child");
  });

  it("ignores an empty message and caps a long one", async () => {
    const { children } = mk();
    const nb = new Notebook({ registry: fakeRegistry(), sessionId: "s1", children });
    const h = JSON.parse((await nb.run(`JSON.stringify(await rlm("x"))`)).value!);
    children.post(h.rlm_child_id, "   ");
    expect(children.pending).toBe(0);
    children.post(h.rlm_child_id, "y".repeat(9000));
    expect(children.drainInbox()[0]!.text.length).toBe(4000);
    await children.drain();
  });
});

describe("notify_parent — the child half of the mailbox", () => {
  const setup = () => {
    const registries: ChildRegistries = new Map();
    let seenChildId = "";
    const reg = new ChildRegistry(async (_t, _a, _e, childId) => {
      seenChildId = childId;
      await new Promise((r) => setTimeout(r, 100));
      return { status: "completed" as const, answer: "ok", toolCalls: 0, durationMs: 1, subagentId: childId };
    });
    registries.set("parent-1", reg);
    return { registries, reg, tool: createNotifyParentTool(registries), childId: () => seenChildId };
  };

  it("routes a child's message to the parent that admitted it", async () => {
    const { reg, tool } = setup();
    const h = reg.admit("scan the logs", { name: "scout" });
    const r = await tool.execute(
      { message: "found a bad row early" },
      { sessionId: `subagent:parent-1:${h.rlm_child_id}` } as never,
    );
    expect(r.ok).toBe(true);
    const inbox = reg.drainInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.from).toBe("scout");
    expect(inbox[0]!.text).toBe("found a bad row early");
    await reg.drain();
  });

  it("refuses a caller that is not a spawned worker", async () => {
    const { tool } = setup();
    const r = await tool.execute({ message: "hi" }, { sessionId: "parent-1" } as never);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("only callable by a spawned worker");
  });

  it("refuses a child that its claimed parent never admitted", async () => {
    const { tool } = setup();
    const r = await tool.execute(
      { message: "hi" },
      { sessionId: "subagent:parent-1:sa-forged" } as never,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown child");
  });

  it("refuses a parent session with no inbox", async () => {
    const { tool } = setup();
    const r = await tool.execute(
      { message: "hi" },
      { sessionId: "subagent:someone-else:sa-1" } as never,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("no parent inbox");
  });

  it("rejects an empty message", async () => {
    const { reg, tool } = setup();
    const h = reg.admit("x");
    const r = await tool.execute({ message: "  " }, { sessionId: `subagent:parent-1:${h.rlm_child_id}` } as never);
    expect(r.ok).toBe(false);
    await reg.drain();
  });

  it("keeps a parent session id that itself contains colons intact", async () => {
    const registries: ChildRegistries = new Map();
    const reg = new ChildRegistry(async () => ({
      status: "completed" as const, answer: "", toolCalls: 0, durationMs: 0, subagentId: "x",
    }));
    registries.set("chan:discord:42", reg);
    const tool = createNotifyParentTool(registries);
    const h = reg.admit("t", { name: "w" });
    const r = await tool.execute(
      { message: "hello" },
      { sessionId: `subagent:chan:discord:42:${h.rlm_child_id}` } as never,
    );
    expect(r.ok).toBe(true);
    expect(reg.drainInbox()[0]!.text).toBe("hello");
    await reg.drain();
  });
});
