/**
 * Behavioural parity fixes: durable task list, non-contradictory facts,
 * and a delegation that adjusts instead of giving up.
 *
 * Each test pins a behaviour that was absent, not a refactor:
 *   - the todo list existed as code but was never instantiated, registered,
 *     or rendered, so the agent had no task list at all;
 *   - semantic facts deduped on an exact key, so synonym keys accumulated
 *     as equally-authoritative contradictions;
 *   - a failed delegation returned the failure and stopped.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkingMemory } from "../src/memory/working.ts";
import { canonicalFactKey, sanitizeFact } from "../src/memory/extractor.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { TodoStore, createTodoWriteTool } from "../src/tools/builtin/todo-write.ts";
import { createDelegateTaskTool } from "../src/tools/builtin/delegate-task.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { openDatabase } from "../src/db.ts";
import type { InferenceRouter } from "../src/egress/inference-router.ts";
import type { ToolContext } from "../src/types.ts";

// ─────────────────────────────────────────────── durable task list (S4)

describe("todo list survives compaction", () => {
  test("the todos table exists and the tool round-trips through it", () => {
    const db = openDatabase(":memory:");
    const store = new TodoStore(db.raw);
    const tool = createTodoWriteTool(store);

    // Before the wiring fix this threw: no `todos` table in the schema.
    expect(store.list()).toEqual([]);
    store.add("fix-auth", "repair the login redirect");
    expect(store.list().map((t) => t.id)).toEqual(["fix-auth"]);
    expect(tool.manifest.name).toBe("todo_write");
    db.close();
  });

  test("open items are rendered into every turn; done items are not", () => {
    const memory = new WorkingMemory("SYSTEM");
    memory.addUser("keep going");
    memory.setTodoList([
      { id: "fix-auth", content: "repair the login redirect", status: "in_progress" },
      { id: "add-tests", content: "cover the new branch", status: "todo" },
      { id: "bump-dep", content: "already handled", status: "done" },
    ]);

    const rendered = memory.render();
    const lastUser = rendered[rendered.length - 1]!.content;
    expect(lastUser).toContain("fix-auth");
    expect(lastUser).toContain("add-tests");
    // The whole point: a finished item must not be re-advertised as work.
    expect(lastUser).not.toContain("bump-dep");
    // The static system prompt stays byte-stable (prompt-cache discipline).
    expect(rendered[0]!.content).toBe("SYSTEM");
  });

  test("an empty or all-done list adds nothing to the prompt", () => {
    const memory = new WorkingMemory("SYSTEM");
    memory.addUser("hi");
    const before = memory.render()[1]!.content;
    memory.setTodoList([{ id: "x", content: "done thing", status: "done" }]);
    expect(memory.render()[1]!.content).toBe(before);
  });
});

// ──────────────────────────────────────── non-contradictory facts (S5)

describe("semantic facts collapse synonym keys", () => {
  test("synonyms canonicalise onto the incumbent key", () => {
    expect(canonicalFactKey("user name")).toBe("name");
    expect(canonicalFactKey("speaks")).toBe("language");
    expect(canonicalFactKey("project directory")).toBe("project_dir");
    // Whitespace alone must not create a second fact.
    expect(canonicalFactKey("project dir")).toBe("project_dir");
    // Unknown keys are left alone apart from the space→underscore rule.
    expect(canonicalFactKey("favourite editor")).toBe("favourite_editor");
  });

  test("two phrasings of one fact end up as ONE row, not a contradiction", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const semantic = new SemanticMemory(db.raw, audit.logger);

    // What the extractor would produce across two sessions.
    const first = sanitizeFact("project path", "D:/proiect")!;
    const second = sanitizeFact("project directory", "D:/proiect-v2")!;
    semantic.upsert(first.key, first.value);
    semantic.upsert(second.key, second.value);

    const facts = semantic.all();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe("D:/proiect-v2"); // the update won
    expect(semantic.renderForPrompt()).not.toContain("D:/proiect\n");
    db.close();
  });
});

// ─────────────────────────────────────────── delegation recovery (S6)

function scriptedRouter(responses: string[]): InferenceRouter {
  let i = 0;
  return {
    complete: async () => {
      const content = responses[Math.min(i, responses.length - 1)] ?? "";
      i++;
      return {
        content, promptTokens: 5, completionTokens: 5, totalTokens: 10,
        model: "stub", usedFallback: false,
      };
    },
    abort: () => {}, reconfigure: () => {},
    setBudgetWarningListener: () => {}, setThrottleListener: () => {},
  } as unknown as InferenceRouter;
}

function delegateHarness(responses: string[]) {
  const home = mkdtempSync(join(tmpdir(), "feral-delegate-"));
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const process = new RealProcessSandbox(audit.logger);
  const registry = new ToolRegistry(egress, audit, process);
  const tool = createDelegateTaskTool({
    router: scriptedRouter(responses),
    parentRegistry: registry,
    allTools: [],
    audit,
    egress,
    process,
    observations: null,
    episodic: new EpisodicMemory(db.raw, audit.logger),
    hooks: null,
    parentSessionIdFor: () => "parent",
  });
  const progress: string[] = [];
  const ctx = {
    sessionId: "parent",
    progress: (e: { message: string }) => progress.push(e.message),
  } as unknown as ToolContext;
  return { tool, ctx, progress, cleanup: () => { db.close(); rmSync(home, { recursive: true, force: true }); } };
}

describe("delegate_task recovers instead of surrendering", () => {
  test("the description warns that the default tool set is read-only", () => {
    const h = delegateHarness(["done"]);
    expect(h.tool.manifest.description).toContain("READ-ONLY");
    expect(h.tool.manifest.description).toContain("allowed_tools");
    h.cleanup();
  });

  test("a failed subagent is retried once with its own error fed back", async () => {
    // First run hits the iteration ceiling (no final answer); second answers.
    const h = delegateHarness([
      "I have completed 1 actions but haven't been able to produce a final answer",
      "Found it: the config lives in etc/app.toml",
    ]);
    const r = await h.tool.execute({ task: "locate the config", max_iterations: 1 }, h.ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("etc/app.toml");
    expect(h.progress.some((m) => m.includes("retrying once"))).toBe(true);
    h.cleanup();
  });

  test("when both attempts fail the parent is told what was tried and why", async () => {
    const h = delegateHarness([
      "I have completed 1 actions but haven't been able to produce a final answer",
    ]);
    const r = await h.tool.execute({ task: "write the file", max_iterations: 1 }, h.ctx);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("failed twice");
    expect(r.content).toContain("Attempt 1");
    expect(r.content).toContain("Attempt 2");
    // The parent must be able to see it was a permissions problem, not luck.
    expect(r.content).toContain("had these tools");
    h.cleanup();
  });
});
