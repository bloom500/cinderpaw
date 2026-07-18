/**
 * tool_forge + custom-tools — the agent's self-authored tool surface.
 *
 * Covers: validation, transpile gate, store roundtrip, forge actions
 * (create/update/delete/list/show), builtin protection, hot registry
 * register/unregister, and runner-output parsing. Subprocess execution is
 * exercised through a fake ProcessSandbox capturing the spawn options —
 * the real sandbox pipeline is covered by its own tests.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomTool,
  loadCustomTools,
  parseRunnerResult,
  saveCustomTool,
  transpileToolCode,
  validateCustomTool,
  type CustomToolRecord,
} from "../src/tools/custom-tools.ts";
import { createToolForgeTool, registerPersistedCustomTools } from "../src/tools/builtin/tool-forge.ts";
import type { Tool, ToolContext } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "feral-forge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Minimal structural registry mock (only what the forge touches). */
function makeRegistry() {
  const tools = new Map<string, Tool>();
  return {
    tools,
    register: (t: Tool) => {
      if (tools.has(t.manifest.name)) throw new Error(`duplicate ${t.manifest.name}`);
      tools.set(t.manifest.name, t);
    },
    unregister: (name: string) => tools.delete(name),
    has: (name: string) => tools.has(name),
  } as unknown as import("../src/tools/registry.ts").ToolRegistry & { tools: Map<string, Tool> };
}

const GOOD_CODE = `export default async function (args) {
  return { ok: true, content: "hi " + (args.who ?? "world") };
}`;

function forge(registry = makeRegistry()) {
  const tool = createToolForgeTool({ registry, workspaceRoots: [dir], dir, runtime: "C:/fake/bun.exe" });
  const ctx = {} as ToolContext;
  return { registry, call: (args: Record<string, unknown>) => tool.execute(args, ctx) };
}

// ---------------------------------------------------------------- validation

test("validateCustomTool rejects bad names, empty code, bad params", () => {
  const base = { description: "d", parameters: {}, code: GOOD_CODE };
  expect(validateCustomTool({ name: "Bad-Name", ...base })).toContain("invalid name");
  expect(validateCustomTool({ name: "ab", ...base })).toContain("invalid name");
  expect(validateCustomTool({ name: "tool_forge", ...base })).toContain("reserved");
  expect(validateCustomTool({ name: "ok_tool", ...base, code: "" })).toContain("code is required");
  expect(
    validateCustomTool({
      name: "ok_tool",
      ...base,
      parameters: { p: { type: "banana" as never, description: "x" } },
    }),
  ).toContain("invalid type");
  expect(validateCustomTool({ name: "ok_tool", ...base })).toBeNull();
});

test("transpileToolCode: TS passes, syntax error is caught", () => {
  const ok = transpileToolCode("export default async function (args: { x: number }) { return { ok: true, content: `${args.x}` }; }");
  expect("js" in ok).toBe(true);
  const bad = transpileToolCode("export default function ( {");
  expect("error" in bad).toBe(true);
});

// ---------------------------------------------------------------- store

test("save/load/delete roundtrip skips corrupt files", async () => {
  const record: CustomToolRecord = {
    version: 1,
    name: "greet",
    description: "greets",
    parameters: { who: { type: "string", description: "name", required: false } },
    code: GOOD_CODE,
    createdAt: 1,
    updatedAt: 1,
  };
  saveCustomTool(dir, record, "// js");
  await Bun.write(join(dir, "corrupt.json"), "{not json");
  const loaded = loadCustomTools(dir);
  expect(loaded.map((r) => r.name)).toEqual(["greet"]);
  expect(readdirSync(dir)).toContain("greet.mjs");
});

// ---------------------------------------------------------------- forge actions

test("forge create registers the tool and persists it; update replaces; delete removes", async () => {
  const { registry, call } = forge();
  const created = await call({
    action: "create",
    name: "adder",
    description: "adds two numbers",
    parameters: { a: { type: "number", description: "a" }, b: { type: "number", description: "b" } },
    code: "export default async (args) => ({ ok: true, content: String(args.a + args.b) });",
  });
  expect(created.ok).toBe(true);
  expect(registry.has("adder")).toBe(true);
  expect(loadCustomTools(dir).some((r) => r.name === "adder")).toBe(true);

  const updated = await call({ action: "update", name: "adder", description: "adds numbers v2" });
  expect(updated.ok).toBe(true);
  expect(loadCustomTools(dir).find((r) => r.name === "adder")?.description).toBe("adds numbers v2");
  expect(registry.tools.get("adder")?.manifest.description).toContain("adds numbers v2");

  const listed = await call({ action: "list" });
  expect(listed.ok).toBe(true);
  expect(listed.content).toContain("adder");

  const shown = await call({ action: "show", name: "adder" });
  expect(shown.ok).toBe(true);
  expect(shown.content).toContain("export default");

  const deleted = await call({ action: "delete", name: "adder" });
  expect(deleted.ok).toBe(true);
  expect(registry.has("adder")).toBe(false);
  expect(loadCustomTools(dir).some((r) => r.name === "adder")).toBe(false);
});

test("forge protects builtins from create-shadowing and delete", async () => {
  const registry = makeRegistry();
  registry.register({ manifest: { name: "shell_exec", description: "b", permissions: [], networkAccess: false }, parameters: {}, execute: async () => ({ ok: true, content: "" }) });
  const { call } = forge(registry);
  const shadow = await call({ action: "create", name: "shell_exec", description: "evil", code: GOOD_CODE });
  expect(shadow.ok).toBe(false);
  expect(shadow.error).toBe("name_taken");
  const del = await call({ action: "delete", name: "shell_exec" });
  expect(del.ok).toBe(false);
  expect(del.error).toBe("protected");
});

test("forge rejects syntactically broken code before persisting", async () => {
  const { registry, call } = forge();
  const r = await call({ action: "create", name: "broken_one", description: "d", code: "export default function ( {" });
  expect(r.ok).toBe(false);
  expect(registry.has("broken_one")).toBe(false);
  expect(loadCustomTools(dir).some((x) => x.name === "broken_one")).toBe(false);
});

test("update on a missing tool and unknown action fail cleanly", async () => {
  const { call } = forge();
  expect((await call({ action: "update", name: "nope_missing" })).error).toBe("not_found");
  expect((await call({ action: "frobnicate", name: "x" })).error).toBe("bad_args");
});

// ---------------------------------------------------------------- boot restore

test("registerPersistedCustomTools registers stored tools, never shadows", () => {
  const registry = makeRegistry();
  saveCustomTool(dir, {
    version: 1, name: "greet", description: "greets", parameters: {}, code: GOOD_CODE, createdAt: 1, updatedAt: 1,
  }, "// js");
  const restored = registerPersistedCustomTools({ registry, workspaceRoots: [dir], dir, runtime: "C:/fake/bun.exe" });
  expect(restored).toContain("greet");
  expect(registry.has("greet")).toBe(true);
  // Second call: already registered → skipped, no duplicate-register throw.
  expect(registerPersistedCustomTools({ registry, workspaceRoots: [dir], dir, runtime: "C:/fake/bun.exe" })).toEqual([]);
});

// ---------------------------------------------------------------- execution seam

test("createCustomTool executes via ProcessSandbox with stdin args and parses the result line", async () => {
  const record: CustomToolRecord = {
    version: 1, name: "greet", description: "greets", parameters: {}, code: GOOD_CODE, createdAt: 1, updatedAt: 1,
  };
  let seen: Record<string, unknown> | null = null;
  const fakeProcess = {
    run: async (_m: unknown, _s: string, options: Record<string, unknown>) => {
      seen = options;
      return { exitCode: 0, stdout: 'tool log noise\n{"ok":true,"content":"hi world"}', stderr: "", durationMs: 5, timedOut: false, outputTruncated: false };
    },
  };
  const tool = createCustomTool(record, dir, [dir], "C:/fake/bun.exe");
  const result = await tool.execute({ who: "world" }, { sessionId: "s", process: fakeProcess, manifest: tool.manifest } as unknown as ToolContext);
  expect(result.ok).toBe(true);
  expect(result.content).toBe("hi world");
  expect(seen!.executable).toBe("C:/fake/bun.exe");
  expect(String(seen!.stdin)).toContain('"who":"world"');
  expect((seen!.args as string[])[1]).toContain("greet.mjs");
});

test("parseRunnerResult takes the LAST valid JSON result line; null when absent", () => {
  expect(parseRunnerResult('{"ok":true,"content":"old"}\nnoise\n{"ok":false,"content":"new","error":"tool_error"}')?.content).toBe("new");
  expect(parseRunnerResult("no json here")).toBeNull();
  expect(parseRunnerResult('{"unrelated":1}')).toBeNull();
});
