/**
 * tool_forge — the two additions to the create/update path:
 *   1. an update that does not change what EXECUTES skips the smoke run
 *      (spec: "don't run the smoke test for updates if the code hasn't
 *      changed"), and changing `allowed_domains` counts as changing it;
 *   2. the child is told its egress whitelist, so the smoke run happens
 *      through the same network policy as the real calls.
 *
 * Plus the boot-pruning fix: lifetime failure stats must not condemn a tool
 * whose code was just rewritten.
 *
 * The existing gates (consent, smoke-fails-blocks-registration, restore on a
 * failed update) are covered in tool-forge.test.ts — these are the deltas.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolForgeTool, registerPersistedCustomTools } from "../src/tools/builtin/tool-forge.ts";
import { saveCustomTool, transpileToolCode, type CustomToolRecord } from "../src/tools/custom-tools.ts";
import { TOOL_DOMAINS_ENV } from "../src/tools/custom-tool-runner.ts";
import type { AskUserQuestion, Tool, ToolContext } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "cinderpaw-forge-skip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FAKE_RUNTIME = { executable: "C:/fake/cinderpaw-agent.exe", prefix: ["--custom-tool-runner"] };
const CODE = `export default async function (args) { return { ok: true, content: "v1" }; }`;

function makeRegistry() {
  const tools = new Map<string, Tool>();
  return {
    tools,
    register: (t: Tool) => tools.set(t.manifest.name, t),
    unregister: (name: string) => tools.delete(name),
    has: (name: string) => tools.has(name),
  } as unknown as import("../src/tools/registry.ts").ToolRegistry & { tools: Map<string, Tool> };
}

function forge() {
  const registry = makeRegistry();
  const tool = createToolForgeTool({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME });
  const spawns: Array<Record<string, unknown>> = [];
  const asked: AskUserQuestion[] = [];
  const ctx = {
    sessionId: "s",
    process: {
      run: async (_m: unknown, _s: string, options: Record<string, unknown>) => {
        spawns.push(options);
        return {
          exitCode: 0,
          stdout: '{"ok":true,"content":"smoke ok"}',
          stderr: "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      },
    },
    askUser: {
      ask: async (questions: AskUserQuestion[]) => {
        asked.push(...questions);
        return [{ question: questions[0]!.question, selected: ["Allow"] }];
      },
      cancel: () => {},
    },
  } as unknown as ToolContext;
  return { registry, spawns, asked, call: (a: Record<string, unknown>) => tool.execute(a, ctx) };
}

test("an update that changes only the description skips the smoke run", async () => {
  const f = forge();
  const created = await f.call({
    action: "create",
    name: "skip_probe",
    description: "first",
    parameters: {},
    code: CODE,
    test_args: {},
  });
  expect(created.ok).toBe(true);
  expect(f.spawns).toHaveLength(1); // the create was smoke-run

  const updated = await f.call({
    action: "update",
    name: "skip_probe",
    description: "a better description",
  });
  expect(updated.ok).toBe(true);
  expect(f.spawns).toHaveLength(1); // …and the metadata-only update was not
  expect(updated.content).toContain("code unchanged");
});

test("an update with no test_args is accepted when the code is unchanged", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "skip_required",
    description: "d",
    parameters: { who: { type: "string", description: "w", required: true } },
    code: CODE,
    test_args: { who: "x" },
  });
  // No test_args: normally a hard rejection, because there would be a run.
  const updated = await f.call({
    action: "update",
    name: "skip_required",
    description: "renamed",
  });
  expect(updated.ok).toBe(true);
});

test("changing the code re-runs the smoke gate", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "rerun_probe",
    description: "d",
    parameters: {},
    code: CODE,
    test_args: {},
  });
  await f.call({
    action: "update",
    name: "rerun_probe",
    code: `export default async function () { return { ok: true, content: "v2" }; }`,
    test_args: {},
  });
  expect(f.spawns).toHaveLength(2);
});

test("widening allowed_domains re-runs the smoke gate — egress is behaviour", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "net_probe",
    description: "d",
    parameters: {},
    code: CODE,
    test_args: {},
  });
  const updated = await f.call({
    action: "update",
    name: "net_probe",
    allowed_domains: ["api.github.com"],
  });
  expect(updated.ok).toBe(true);
  expect(f.spawns).toHaveLength(2);
  expect(updated.content).not.toContain("code unchanged");
});

test("the smoke run goes through the same egress policy as real calls", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "env_probe",
    description: "d",
    parameters: {},
    code: CODE,
    allowed_domains: ["api.github.com"],
    test_args: {},
  });
  const env = f.spawns[0]!.env as Record<string, string>;
  expect(env[TOOL_DOMAINS_ENV]).toBe("api.github.com");
});

test("a tool that declares no domains spawns with an empty whitelist", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "nonet_probe",
    description: "d",
    parameters: {},
    code: CODE,
    test_args: {},
  });
  const env = f.spawns[0]!.env as Record<string, string>;
  expect(env[TOOL_DOMAINS_ENV]).toBe("");
});

test("a bad allowed_domains entry is rejected before anything is written", async () => {
  const f = forge();
  const res = await f.call({
    action: "create",
    name: "baddom_probe",
    description: "d",
    parameters: {},
    code: CODE,
    allowed_domains: ["https://api.github.com/v3"],
    test_args: {},
  });
  expect(res.ok).toBe(false);
  expect(f.spawns).toHaveLength(0);
  expect(f.asked).toHaveLength(0);
});

// ------------------------------------------------ boot pruning (issue #4)


/** Persist a record whose last edit was `ageMs` ago. */
function persist(name: string, ageMs: number): CustomToolRecord {
  const t = Date.now() - ageMs;
  const record: CustomToolRecord = {
    version: 1,
    name,
    description: "d",
    parameters: {},
    code: CODE,
    createdAt: t,
    updatedAt: t,
  };
  const js = transpileToolCode(CODE);
  saveCustomTool(dir, record, "js" in js ? js.js : "");
  return record;
}

/** Health report saying the tool failed most of its (lifetime) runs. */
const brokenHealth = (name: string) => ({
  buildHealthReport: () => ({ tools: [{ tool: name, totalRuns: 8, successRate: 0.1 }] }),
});

const DAY = 24 * 60 * 60 * 1000;

test("a tool fixed today is not deleted for failures its old code caused", async () => {
  const name = "recent_edit_tool";
  persist(name, 1 * DAY); // rewritten yesterday
  const registry = makeRegistry();
  const registered = registerPersistedCustomTools({
    registry,
    workspaceRoots: [dir],
    dir,
    runtime: FAKE_RUNTIME,
    health: brokenHealth(name),
  });
  expect(registered).toContain(name);
  expect(registry.has(name)).toBe(true);
});

test("a tool that has been failing for weeks without an edit is still pruned", async () => {
  const name = "settled_broken_tool";
  persist(name, 30 * DAY);
  const registry = makeRegistry();
  const registered = registerPersistedCustomTools({
    registry,
    workspaceRoots: [dir],
    dir,
    runtime: FAKE_RUNTIME,
    health: brokenHealth(name),
  });
  expect(registered).not.toContain(name);
  expect(registry.has(name)).toBe(false);
});

// -------------------------------- adversarial no-args probe (self-graded exam)

/**
 * `forge()` above always returns a successful stdout. This variant lets the
 * test decide per-invocation, so a tool can pass the args the MODEL chose and
 * still blow up on the ones it did not.
 */
function forgeWithCrashOnEmptyArgs() {
  const registry = makeRegistry();
  const tool = createToolForgeTool({ registry, workspaceRoots: [dir], dir, runtime: FAKE_RUNTIME });
  const spawns: string[] = [];
  const ctx = {
    sessionId: "s",
    process: {
      run: async (_m: unknown, _s: string, options: Record<string, unknown>) => {
        const stdin = String(options.stdin);
        spawns.push(stdin);
        // Crash (emit nothing) exactly when called with no arguments — the
        // classic `args.who.trim()` on an absent field.
        const crashed = stdin === "{}";
        return {
          exitCode: crashed ? 1 : 0,
          stdout: crashed ? "" : '{"ok":true,"content":"smoke ok"}',
          stderr: crashed ? "TypeError: Cannot read properties of undefined" : "",
          durationMs: 1,
          timedOut: false,
          outputTruncated: false,
        };
      },
    },
    askUser: {
      ask: async (questions: AskUserQuestion[]) => [
        { question: questions[0]!.question, selected: ["Allow"] },
      ],
      cancel: () => {},
    },
  } as unknown as ToolContext;
  return { registry, spawns, call: (a: Record<string, unknown>) => tool.execute(a, ctx) };
}

test("a tool that passes its own test_args but crashes on missing ones is rejected", async () => {
  const f = forgeWithCrashOnEmptyArgs();
  const res = await f.call({
    action: "create",
    name: "fragile_tool",
    description: "d",
    parameters: { who: { type: "string", description: "w", required: true } },
    code: CODE,
    test_args: { who: "alice" },
  });
  expect(res.ok).toBe(false);
  expect(res.error).toBe("smoke_failed");
  expect(res.content).toContain("no arguments");
  expect(f.registry.has("fragile_tool")).toBe(false);
  // It DID pass the exam it set for itself — that is the whole point.
  expect(f.spawns[0]).toContain('"who":"alice"');
  expect(f.spawns[1]).toBe("{}");
});

test("returning ok:false for missing args is fine — only crashing is not", async () => {
  const f = forge(); // always emits a well-formed envelope
  const res = await f.call({
    action: "create",
    name: "polite_tool",
    description: "d",
    parameters: { who: { type: "string", description: "w", required: true } },
    code: CODE,
    test_args: { who: "alice" },
  });
  expect(res.ok).toBe(true);
  expect(f.registry.has("polite_tool")).toBe(true);
});

test("a parameterless tool is not probed twice", async () => {
  const f = forge();
  await f.call({
    action: "create",
    name: "noargs_tool",
    description: "d",
    parameters: {},
    code: CODE,
    test_args: {},
  });
  expect(f.spawns).toHaveLength(1); // the smoke run already WAS the no-args case
});
