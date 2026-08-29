import { test, expect } from "bun:test";
import { createToolDrawerTools } from "../src/tools/builtin/tool-drawer.ts";
import { isCoreTool, isExtendedTool, isConnectorTool } from "../src/tools/tiers.ts";
import type { ToolRegistry } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/types.ts";

// Minimal stub: the drawer tools only ever call registry.list().
const fakeRegistry = {
  list: () => [
    { manifest: { name: "read_file", description: "Read a file (core)." } },
    { manifest: { name: "deep_research", description: "Run a deep research pass." } },
    { manifest: { name: "control_app", description: "Control desktop applications." } },
  ],
} as unknown as ToolRegistry;

const ctx = (sessionId: string): ToolContext => ({ sessionId }) as unknown as ToolContext;

test("tier split: core / extended / connector are mutually exclusive", () => {
  expect(isCoreTool("read_file")).toBe(true);
  expect(isCoreTool("ask_user")).toBe(true);
  expect(isCoreTool("todo_write")).toBe(true);

  expect(isExtendedTool("deep_research")).toBe(true);
  expect(isCoreTool("deep_research")).toBe(false);

  // connector tools are neither core (owner) nor drawer-loadable.
  expect(isConnectorTool("capture_lead")).toBe(true);
  expect(isCoreTool("capture_lead")).toBe(false);
  expect(isExtendedTool("capture_lead")).toBe(false);

  // unknown/new tool defaults to core (never silently hidden).
  expect(isCoreTool("some_new_tool")).toBe(true);
});

test("list_tools lists extended-only, minus already-loaded; load_tool mutates the session set", async () => {
  const loaded = new Map<string, Set<string>>();
  const [listTools, loadTool] = createToolDrawerTools(fakeRegistry, loaded);

  const l1 = await listTools.execute({}, ctx("s1"));
  expect(l1.content).toContain("deep_research");
  expect(l1.content).toContain("control_app");
  expect(l1.content).not.toContain("read_file"); // core never appears

  const r = await loadTool.execute({ names: ["deep_research"] }, ctx("s1"));
  expect(r.ok).toBe(true);
  expect(loaded.get("s1")?.has("deep_research")).toBe(true);
  expect(loaded.get("s2")).toBeUndefined(); // session isolation

  const l2 = await listTools.execute({}, ctx("s1"));
  expect(l2.content).not.toContain("deep_research"); // now hidden for s1
  expect(l2.content).toContain("control_app");
});

test("load_tool tells a core name apart from an unknown one, and records the request either way it can honour", async () => {
  const loaded = new Map<string, Set<string>>();
  const [, loadTool] = createToolDrawerTools(fakeRegistry, loaded);

  // Already core. The model asked for the ability to call it and ALREADY HAS
  // it, so this is a success with nothing to do — not a refusal. Answering
  // false here (and calling it "Not optional/loadable") is what sent a
  // tau2-bench agent hunting for a tool it was holding: it read the failure as
  // "that tool does not exist", called list_tools, and then produced nothing
  // at all for five completions until the turn was written off.
  const r = await loadTool.execute({ names: ["read_file"] }, ctx("s1"));
  expect(r.ok).toBe(true);
  expect(r.content).toMatch(/already available/i);
  // The request IS recorded, even though nothing was in the drawer: the agent
  // loop treats this set as the escape hatch that beats intent selection, so a
  // tool the model explicitly asked for cannot be withheld from it afterwards.
  expect([...(loaded.get("s1") ?? [])]).toContain("read_file");

  // Genuinely unknown stays a failure: there is nothing to call.
  const r2 = await loadTool.execute({ names: ["no_such_tool"] }, ctx("s2"));
  expect(r2.ok).toBe(false);
  expect(r2.content).toMatch(/no such tool/i);
  expect(loaded.get("s2")).toBeUndefined();

  const r3 = await loadTool.execute({ names: [] }, ctx("s1"));
  expect(r3.ok).toBe(false);
});

test("list_tools honours the query filter", async () => {
  const loaded = new Map<string, Set<string>>();
  const [listTools] = createToolDrawerTools(fakeRegistry, loaded);

  const r = await listTools.execute({ query: "desktop" }, ctx("s1"));
  expect(r.content).toContain("control_app");
  expect(r.content).not.toContain("deep_research");
});

test("the drawer is sorted by what a task needs to move forward, not by what is nice to have", () => {
  // Every advertised schema is re-sent on every completion, and a 28-tool turn
  // is 29 completions. This split used to be backwards in the way that costs
  // most: the two tools that answer "how many files / where is X" in ONE call
  // sat in the drawer, so the model walked the tree directory by directory —
  // 28 calls for a question worth two — while the most expensive schema in the
  // whole set rode along on "what is a deadlock".

  // Finding things must never cost a drawer round trip. This is the half that
  // reduces the NUMBER of completions, which multiplies with everything else.
  for (const search of ["file_search", "scan_workspace", "grep", "list_directory"]) {
    expect(isCoreTool(search)).toBe(true);
  }

  // 583 tokens on every call, reached for about once a month. The single
  // clearest example of the rule.
  expect(isExtendedTool("tool_forge")).toBe(true);
  for (const rare of ["pdf_generator", "pdf_report", "git_branch", "git_commit", "git_log"]) {
    expect(isExtendedTool(rare)).toBe(true);
  }

  // Read-only git stays advertised on purpose: cheap, constant in code work,
  // and a drawer round trip would cost more than the schema saves.
  expect(isCoreTool("git_status")).toBe(true);
  expect(isCoreTool("git_diff")).toBe(true);

  // The instruction in the system prompt names these directly ("call
  // list_skills", "call product_info FIRST"). Drawering a tool the prompt tells
  // the model to call by name breaks the instruction instead of saving tokens.
  for (const named of ["list_skills", "read_skill", "product_info", "delegate_task"]) {
    expect(isCoreTool(named)).toBe(true);
  }
});
