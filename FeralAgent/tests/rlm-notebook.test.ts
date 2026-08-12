/**
 * The notebook's load-bearing property is not that it evaluates JavaScript —
 * it is that it evaluates JavaScript with NO ambient authority. These tests
 * fail loudly if someone widens the sandbox, which is the mistake that would
 * quietly hand the model every permission at once.
 */

import { describe, expect, it } from "bun:test";
import { Notebook, toIdentifier } from "../src/rlm/repl.ts";
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
