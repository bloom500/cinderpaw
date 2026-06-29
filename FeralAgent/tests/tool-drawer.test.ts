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

test("load_tool rejects core/unknown names and does not mutate state", async () => {
  const loaded = new Map<string, Set<string>>();
  const [, loadTool] = createToolDrawerTools(fakeRegistry, loaded);

  const r = await loadTool.execute({ names: ["read_file"] }, ctx("s1")); // core, not loadable
  expect(r.ok).toBe(false);
  expect(loaded.get("s1")).toBeUndefined();

  const r2 = await loadTool.execute({ names: [] }, ctx("s1"));
  expect(r2.ok).toBe(false);
});

test("list_tools honours the query filter", async () => {
  const loaded = new Map<string, Set<string>>();
  const [listTools] = createToolDrawerTools(fakeRegistry, loaded);

  const r = await listTools.execute({ query: "desktop" }, ctx("s1"));
  expect(r.content).toContain("control_app");
  expect(r.content).not.toContain("deep_research");
});
