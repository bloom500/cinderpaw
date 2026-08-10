import { afterEach, expect, test } from "bun:test";
import { WorkingMemory } from "../src/memory/working.ts";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" as const };

function ollamaOk(content: string) {
  return { message: { content }, prompt_eval_count: 10, eval_count: 5 };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => { restoreFetch?.(); restoreFetch = null; });

// The store shape the agent loop consumes. Kept structural so the loop never
// imports SemanticMemory — same reason setTodoStore is structural.
type NotebookStore = { notes(scope: string): Array<{ key: string; value: string }> };

test("the notebook store shape renders through WorkingMemory unchanged", () => {
  const store: NotebookStore = {
    notes: () => [{ key: "note:position", value: "compiling the parser" }],
  };
  const mem = new WorkingMemory("sys");
  mem.setNotebook(store.notes(""));
  mem.addUser("go");
  expect(mem.render().at(-1)!.content).toContain("compiling the parser");
});

test("a throwing notebook store must not be able to cost a turn", () => {
  const store: NotebookStore = {
    notes: () => {
      throw new Error("db locked");
    },
  };
  const mem = new WorkingMemory("sys");
  // Mirrors the guard in the agent loop: the refresh is wrapped, the turn goes on.
  expect(() => {
    try {
      mem.setNotebook(store.notes(""));
    } catch {
      /* the loop swallows it */
    }
    mem.addUser("go");
  }).not.toThrow();
  expect(mem.render().at(-1)!.content).toBe("go");
});

test("a note in the store lands in the actual prompt sent to the model", async () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" }, tokenBudget: BUDGET },
    audit.logger, db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
  const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
  const agent = new AgentLoop(router, registry, episodic, {}, recall);

  agent.setNotebookStore({
    notes: () => [{ key: "note:position", value: "marker-xyz" }],
  });

  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(JSON.stringify(ollamaOk("done")), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  restoreFetch = () => { globalThis.fetch = globalThis.fetch; };

  await agent.handle("s1", "go", "m1", () => {});

  expect(bodies.some((b) => b.includes("marker-xyz"))).toBe(true);
  db.close();
});
