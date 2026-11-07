/**
 * The next-step card closes a finished reply (31 Oct). Asking the model again
 * after it got the answer written twice on Haiku: told to stop, it went quiet,
 * and the empty reply was nudged with "state what you did".
 */
import { afterEach, expect, test } from "bun:test";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createShowWidgetTool } from "../src/tools/builtin/show-widget.ts";
import { createHeadsUpTool } from "../src/tools/builtin/heads-up.ts";

const originalFetch = globalThis.fetch;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of databases.splice(0)) db.close();
});
const toolCall = (name: string, args: Record<string, unknown> = {}) => `<tool_call>${JSON.stringify({ name, args })}</tool_call>`;
const card = { kind: "followups", ask: "Should I send it to Ana?", next: ["Yes, send it", "Not now"] };

function fixture(script: string[]) {
  let inferenceCalls = 0;
  const requests: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(String(init?.body));
    const content = script[inferenceCalls++] ?? "Done.";
    return new Response(JSON.stringify({ message: { content }, prompt_eval_count: 1, eval_count: 1 }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const db = openDatabase(":memory:");
  databases.push(db);
  const audit = new AuditLog(db.raw);
  const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
  registry.register(createShowWidgetTool());
  registry.register(createHeadsUpTool());
  registry.register({
    manifest: { name: "read_file", description: "Read a file.", permissions: [], networkAccess: false },
    parameters: {},
    async execute() { return { ok: false, content: "ENOENT: no such file, invoice.pdf" }; },
  });
  const router = new InferenceRouter({
    primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
    tokenBudget: { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" },
  }, audit.logger, db.raw);
  // Room for the real tool descriptions: at the default 8K the turn compacts and eats the script.
  router.setContextWindow(64_000);
  const agent = new AgentLoop(router, registry, new EpisodicMemory(db.raw, audit.logger));
  return { requests, inferenceCalls: () => inferenceCalls, run: (prompt: string) => agent.handle("s-card", prompt, "m1", () => {}) };
}

// 31 Oct: Heads Up was called once in 9,647 tool calls. It is now reminded at
// the moment it is useful, the way a harness reminds Claude, once a turn.
test("a failed step reminds the model of heads_up, once a turn", async () => {
  const f = fixture([toolCall("read_file", { path: "a" }), toolCall("read_file", { path: "b" }), "I could not find the invoice."]);
  await f.run("Sum up invoice.pdf.");
  const nudge = "tell them now with heads_up";
  expect(f.requests[1]).toContain(nudge);
  expect(f.requests[2].split(nudge).length - 1).toBe(1);
});

test("the reply that comes with the card is the answer, and the model is not asked again", async () => {
  const f = fixture([`The note for Ana is ready.\n${toolCall("show_widget", card)}`, "The note for Ana is ready. I wrote it above."]);
  expect(await f.run("Write a short note to Ana.")).toBe("The note for Ana is ready.");
  expect(f.inferenceCalls()).toBe(1);
});

test("a card that came alone, with no reply beside it, lets the model write the reply", async () => {
  const f = fixture([toolCall("show_widget", card), "The note for Ana is ready."]);
  expect(await f.run("Write a short note to Ana.")).toBe("The note for Ana is ready.");
  expect(f.inferenceCalls()).toBe(2);
});
