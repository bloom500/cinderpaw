/**
 * tool_forge + custom-tools — the agent's self-authored tool surface.
 *
 * Covers: validation, transpile gate, the CONSENT and SMOKE gates that
 * stand between "the model wrote code" and "the code is registered",
 * store roundtrip, forge actions (create/update/delete/list/show),
 * builtin protection, hot registry register/unregister, and runner-output
 * parsing. Subprocess execution is exercised through a fake ProcessSandbox
 * capturing the spawn options — the real sandbox pipeline is covered by
 * its own tests.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomTool,
  loadCustomTools,
  parseRunnerResult,
  QUARANTINE_CALLS,
  resolveToolRuntime,
  saveCustomTool,
  transpileToolCode,
  validateCustomTool,
  type CustomToolRecord,
} from "../src/tools/custom-tools.ts";
import { createToolForgeTool, registerPersistedCustomTools } from "../src/tools/builtin/tool-forge.ts";
import type { AskUserQuestion, Tool, ToolContext } from "../src/types.ts";

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

/** Stands in for `resolveToolRuntime()` — the real one returns this
 *  process, which would make the fake sandbox assertions meaningless. */
const FAKE_RUNTIME = { executable: "C:/fake/feral-agent.exe", prefix: ["--custom-tool-runner"] };

/**
 * A forge wired to a fake sandbox + askUser bridge. `state` drives the two
 * gates: `approve` is the owner's answer, `smokeOk` is whether the one
 * verification run succeeds. `asked` records the prompts so a test can
 * assert the user was actually consulted.
 */
function forge(registry = makeRegistry()) {
  const tool = createToolForgeTool({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME });
  const state = { approve: true, smokeOk: true, asked: [] as AskUserQuestion[], smokeStdin: [] as string[] };
  const ctx = {
    sessionId: "s",
    process: {
      run: async (_m: unknown, _s: string, options: Record<string, unknown>) => {
        state.smokeStdin.push(String(options.stdin));
        return {
          exitCode: 0,
          stdout: state.smokeOk
            ? '{"ok":true,"content":"smoke ok"}'
            : '{"ok":false,"content":"boom","error":"tool_error"}',
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      },
    },
    askUser: {
      ask: async (questions: AskUserQuestion[]) => {
        state.asked.push(...questions);
        return [{ question: questions[0]!.question, selected: [state.approve ? "Allow" : "Deny"] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
  return { registry, state, call: (args: Record<string, unknown>) => tool.execute(args, ctx) };
}

/** Same forge, but on a transport with no way to ask the user. */
function forgeWithoutBridge(registry = makeRegistry()) {
  const tool = createToolForgeTool({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME });
  const ctx = {
    sessionId: "s",
    process: {
      run: async () => ({ exitCode: 0, stdout: '{"ok":true,"content":"smoke ok"}', stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }),
    },
  } as unknown as ToolContext;
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
  const { registry, call, state } = forge();
  const created = await call({
    action: "create",
    name: "adder",
    description: "adds two numbers",
    parameters: { a: { type: "number", description: "a" }, b: { type: "number", description: "b" } },
    code: "export default async (args) => ({ ok: true, content: String(args.a + args.b) });",
    test_args: { a: 2, b: 3 },
  });
  expect(created.ok).toBe(true);
  expect(registry.has("adder")).toBe(true);
  expect(loadCustomTools(dir).some((r) => r.name === "adder")).toBe(true);
  // The gates ran: the owner was asked, and the smoke run got the test args.
  expect(state.asked).toHaveLength(1);
  expect(state.smokeStdin.at(-1)).toContain('"a":2');

  const updated = await call({ action: "update", name: "adder", description: "adds numbers v2", test_args: { a: 1, b: 1 } });
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

// ---------------------------------------------------------------- gates

test("create demands test_args covering every required parameter", async () => {
  const { registry, call } = forge();
  const r = await call({
    action: "create",
    name: "needs_args",
    description: "d",
    parameters: { path: { type: "string", description: "p" } },
    code: GOOD_CODE,
  });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("bad_args");
  expect(r.content).toContain("path");
  expect(registry.has("needs_args")).toBe(false);
  expect(loadCustomTools(dir).some((x) => x.name === "needs_args")).toBe(false);
});

test("a denied prompt writes nothing and runs nothing", async () => {
  const { registry, call, state } = forge();
  state.approve = false;
  const r = await call({ action: "create", name: "denied_tool", description: "d", code: GOOD_CODE });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("denied");
  expect(state.asked).toHaveLength(1);
  expect(state.smokeStdin).toHaveLength(0); // never executed
  expect(registry.has("denied_tool")).toBe(false);
  expect(loadCustomTools(dir).some((x) => x.name === "denied_tool")).toBe(false);
});

test("no askUser bridge fails CLOSED", async () => {
  const { registry, call } = forgeWithoutBridge();
  const r = await call({ action: "create", name: "headless_tool", description: "d", code: GOOD_CODE });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("denied");
  expect(registry.has("headless_tool")).toBe(false);
});

test("a tool that fails its smoke run is not registered and leaves no trace", async () => {
  const { registry, call, state } = forge();
  state.smokeOk = false;
  const r = await call({ action: "create", name: "broken_smoke", description: "d", code: GOOD_CODE });
  expect(r.ok).toBe(false);
  expect(r.error).toBe("smoke_failed");
  expect(r.content).toContain("boom");
  expect(registry.has("broken_smoke")).toBe(false);
  expect(loadCustomTools(dir).some((x) => x.name === "broken_smoke")).toBe(false);
  expect(readdirSync(dir)).not.toContain("broken_smoke.mjs");
});

test("an update whose smoke run fails restores the previous version", async () => {
  const { registry, call, state } = forge();
  const created = await call({ action: "create", name: "v_tool", description: "version one", code: GOOD_CODE });
  expect(created.ok).toBe(true);

  state.smokeOk = false;
  const bad = await call({
    action: "update",
    name: "v_tool",
    description: "version two",
    code: "export default async () => ({ ok: false, content: 'regressed' });",
  });
  expect(bad.ok).toBe(false);
  expect(bad.error).toBe("smoke_failed");
  expect(bad.content).toContain("previous version is untouched");

  const stored = loadCustomTools(dir).find((x) => x.name === "v_tool")!;
  expect(stored.description).toBe("version one");
  expect(stored.code).toBe(GOOD_CODE);
  expect(registry.has("v_tool")).toBe(true);
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
  const restored = registerPersistedCustomTools({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME });
  expect(restored).toContain("greet");
  expect(registry.has("greet")).toBe(true);
  // Second call: already registered → skipped, no duplicate-register throw.
  expect(registerPersistedCustomTools({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME })).toEqual([]);
});

// ---------------------------------------------------------------- execution seam

test("createCustomTool executes via ProcessSandbox with stdin args and parses the result line", async () => {
  const record: CustomToolRecord = {
    // calls at the quarantine ceiling = a graduated tool, so this test
    // exercises the execution seam and not the confirmation gate.
    version: 1, name: "greet", description: "greets", parameters: {}, code: GOOD_CODE,
    calls: QUARANTINE_CALLS, createdAt: 1, updatedAt: 1,
  };
  let seen: Record<string, unknown> | null = null;
  const fakeProcess = {
    run: async (_m: unknown, _s: string, options: Record<string, unknown>) => {
      seen = options;
      return { exitCode: 0, stdout: 'tool log noise\n{"ok":true,"content":"hi world"}', stderr: "", durationMs: 5, timedOut: false, outputTruncated: false };
    },
  };
  const tool = createCustomTool(record, dir, [dir], FAKE_RUNTIME);
  const result = await tool.execute({ who: "world" }, { sessionId: "s", process: fakeProcess, manifest: tool.manifest } as unknown as ToolContext);
  expect(result.ok).toBe(true);
  expect(result.content).toBe("hi world");
  // The spawn is THIS binary re-invoked as the runner, not a bun/node on PATH.
  expect(seen!.executable).toBe(FAKE_RUNTIME.executable);
  expect(tool.manifest.allowedExecutables).toEqual([FAKE_RUNTIME.executable]);
  expect(String(seen!.stdin)).toContain('"who":"world"');
  expect(seen!.args).toEqual(["--custom-tool-runner", join(dir, "greet.mjs")]);
});

test("resolveToolRuntime always resolves — no bun/node on PATH required", () => {
  const runtime = resolveToolRuntime();
  expect(runtime.executable).toBe(process.execPath);
  // Last prefix entry is always the flag, so the module path follows it.
  expect(runtime.prefix.at(-1)).toBe("--custom-tool-runner");
  // Under a bun interpreter (how the test suite itself runs) the entry
  // script must be passed too, or bun would eat the flag as its own.
  expect(runtime.prefix[0]).toBe(Bun.main);
});

test("the runner executes a module and emits the result as the last stdout line", async () => {
  const modulePath = join(dir, "runner_probe.mjs");
  await Bun.write(modulePath, 'console.log("chatty tool");\nexport default async (args) => ({ ok: true, content: "got " + args.x });');
  // Spawn the real entry point. `resolveToolRuntime()` cannot be used here:
  // it derives the script from `Bun.main`, which under `bun test` is this
  // test file rather than src/index.ts.
  const entry = join(import.meta.dir, "..", "src", "index.ts");
  const proc = Bun.spawn([process.execPath, entry, "--custom-tool-runner", modulePath], {
    stdin: new TextEncoder().encode(JSON.stringify({ x: 42 })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  expect(parseRunnerResult(stdout)).toEqual({ ok: true, content: "got 42" });
});

// ---------------------------------------------------------------- quarantine

/** A graduated-or-not custom tool plus a scripted owner. */
function quarantined(answer: string, calls = 0) {
  const name = `q_${Math.random().toString(36).slice(2, 8)}`;
  const record: CustomToolRecord = {
    version: 1, name, description: "does a thing", parameters: {}, code: GOOD_CODE,
    calls, createdAt: 1, updatedAt: 1,
  };
  saveCustomTool(dir, record, "// js");
  let spawns = 0;
  const asked: AskUserQuestion[] = [];
  const ctx = {
    sessionId: "s",
    process: {
      run: async () => {
        spawns++;
        return { exitCode: 0, stdout: '{"ok":true,"content":"ran"}', stderr: "", durationMs: 1, timedOut: false, outputTruncated: false };
      },
    },
    askUser: {
      ask: async (questions: AskUserQuestion[]) => {
        asked.push(...questions);
        return [{ question: questions[0]!.question, selected: [answer] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
  const tool = createCustomTool(record, dir, [dir], FAKE_RUNTIME);
  return {
    name, asked,
    spawns: () => spawns,
    storedCalls: () => loadCustomTools(dir).find((r) => r.name === name)?.calls ?? 0,
    run: () => tool.execute({}, ctx),
  };
}

test("an experimental tool asks before each call and counts approvals", async () => {
  const t = quarantined("Allow once");
  expect((await t.run()).ok).toBe(true);
  expect(t.asked).toHaveLength(1);
  expect(t.asked[0]!.question).toContain(`1 of ${QUARANTINE_CALLS}`);
  expect(t.storedCalls()).toBe(1);

  expect((await t.run()).ok).toBe(true);
  expect(t.asked).toHaveLength(2);
  expect(t.storedCalls()).toBe(2);
  expect(t.spawns()).toBe(2);
});

test("a denied call never reaches the sandbox", async () => {
  const t = quarantined("Deny");
  const r = await t.run();
  expect(r.ok).toBe(false);
  expect(r.error).toBe("denied");
  expect(t.spawns()).toBe(0);
  expect(t.storedCalls()).toBe(0); // a refusal does not count as an approval
});

test("\"Always allow\" graduates the tool and stops the prompts", async () => {
  const t = quarantined("Always allow");
  expect((await t.run()).ok).toBe(true);
  expect(t.storedCalls()).toBe(QUARANTINE_CALLS);
  expect((await t.run()).ok).toBe(true);
  expect((await t.run()).ok).toBe(true);
  expect(t.asked).toHaveLength(1); // asked once, never again
  expect(t.spawns()).toBe(3);
});

test("a graduated tool runs unattended; no bridge fails CLOSED", async () => {
  const graduated = quarantined("Deny", QUARANTINE_CALLS);
  expect((await graduated.run()).ok).toBe(true);
  expect(graduated.asked).toHaveLength(0);

  const record: CustomToolRecord = {
    version: 1, name: "no_bridge_tool", description: "d", parameters: {}, code: GOOD_CODE,
    calls: 0, createdAt: 1, updatedAt: 1,
  };
  saveCustomTool(dir, record, "// js");
  const tool = createCustomTool(record, dir, [dir], FAKE_RUNTIME);
  const r = await tool.execute({}, {
    sessionId: "s",
    process: { run: async () => ({ exitCode: 0, stdout: '{"ok":true,"content":"ran"}', stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }) },
  } as unknown as ToolContext);
  expect(r.ok).toBe(false);
  expect(r.error).toBe("denied");
});

test("parseRunnerResult takes the LAST valid JSON result line; null when absent", () => {
  expect(parseRunnerResult('{"ok":true,"content":"old"}\nnoise\n{"ok":false,"content":"new","error":"tool_error"}')?.content).toBe("new");
  expect(parseRunnerResult("no json here")).toBeNull();
  expect(parseRunnerResult('{"unrelated":1}')).toBeNull();
});
