import { afterEach, describe, expect, test } from "bun:test";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createSuggestTaskTool } from "../src/tools/builtin/suggest-task.ts";
import type { OutboundEvent } from "../src/types.ts";

const originalFetch = globalThis.fetch;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const db of databases.splice(0)) db.close();
});
const toolCall = (name: string, args: Record<string, unknown> = {}) => `<tool_call>${JSON.stringify({ name, args })}</tool_call>`;
const suggestion = {
  title: "Check the weather", task: "Check the weather in Cluj.", kind: "agent", repeat: "once", in_minutes: 2,
};

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
  let workCalls = 0;
  for (const name of ["web_search", "delegate_task", "vremea_cluj"]) {
    registry.register({
      manifest: { name, description: "Verifică vremea în Cluj și răspunde în română.", permissions: [], networkAccess: false },
      parameters: {},
      async execute() { workCalls++; return { ok: true, content: "În Cluj este soare." }; },
    });
  }
  registry.register(createSuggestTaskTool(undefined, () => new Date(2026, 9, 24, 17, 0)));
  const router = new InferenceRouter({
    primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
    tokenBudget: { perConversation: 500_000, perDay: 5_000_000, onExhausted: "stop" },
  }, audit.logger, db.raw);
  const agent = new AgentLoop(router, registry, new EpisodicMemory(db.raw, audit.logger));
  agent.setMemorySnapshot(() => "Utilizatorul scrie în română. Răspunde în română.");
  const events: OutboundEvent[] = [];
  return { agent, events, requests, workCalls: () => workCalls, inferenceCalls: () => inferenceCalls,
    run: (prompt: string, id = "m1", session = "s-language-policy") => agent.handle(session, prompt, id, e => events.push(e)),
  };
}

describe("turn language and deferred action enforcement", () => {
  test("an English turn streams live and carries the language rule; the reply is never withheld", async () => {
    const f = fixture(["În Cluj este soare azi."]);
    const answer = await f.run("Please tell me the weather in Cluj.");
    // A rule next to the message, not a check that holds the reply back.
    expect(answer).toBe("În Cluj este soare azi.");
    expect(f.inferenceCalls()).toBe(1);
    expect(f.requests[0]).toContain("response language is English");
    expect(f.events.some(e => e.type === "chunk")).toBe(true);
  });

  test("a task card's confirmation uses the computed time, not the model's", async () => {
    const f = fixture([toolCall("suggest_task", suggestion), "Am programat pentru ora 19:45."]);
    const answer = await f.run("Please check the weather in Cluj in 2 minutes.");
    expect(answer).toContain("Today at 17:02");
    expect(answer).not.toContain("19:45");
    expect(answer).toContain("Create");
    expect(f.workCalls()).toBe(0);
  });

  test.each([
    "Check the weather in Cluj in 2 minutes.",
    "În fiecare zi la 9 verifică vremea în Cluj.",
    "At 19:00, check the weather.",
    "Not now, check the weather in 2 minutes.",
  ])("a later request cannot execute tools, even a mixed tool batch: %s", async prompt => {
    const f = fixture([
      toolCall("web_search") + toolCall("delegate_task") + toolCall("suggest_task", suggestion),
      "I checked it already; the task will run at 19:45.",
    ]);
    const answer = await f.run(prompt);
    expect(f.workCalls()).toBe(0);
    expect(answer).toContain("Today at 17:02");
    expect(answer).not.toContain("19:45");
  });

  test("deferred-only parallel delegation is denied before the fan-out branch", async () => {
    const f = fixture([
      toolCall("delegate_task") + toolCall("delegate_task"),
      toolCall("suggest_task", suggestion),
    ]);
    await f.run("Please check the weather in 2 minutes.");
    expect(f.workCalls()).toBe(0);
  });

  test("a confirmed cron task still executes work when its instruction mentions timing", async () => {
    const f = fixture([toolCall("web_search"), "The weather in Cluj is sunny."]);
    await f.run("Check the weather every day at 19:00.", "m1", "cron:confirmed-weather");
    expect(f.workCalls()).toBe(1);
  });

  test("an English email asked for in Romanian is delivered as written", async () => {
    const email = "Hi John, could we move the meeting to Friday? Thanks, Darius";
    const f = fixture([email]);
    expect(await f.run("Te rog scrie-mi un email în engleză pentru John despre întâlnire.")).toBe(email);
    expect(f.inferenceCalls()).toBe(1);
  });

  test("a scheduled run gets no language rule: its message is the English task wrapper", async () => {
    const f = fixture(["Astăzi în Cluj este soare."]);
    const answer = await f.run("You are running as a scheduled background task.\n\nTask: Verifică vremea în Cluj.", "m1", "cron:ro-weather");
    expect(answer).toBe("Astăzi în Cluj este soare.");
    expect(f.requests[0]).not.toContain("Current turn policy");
  });

  test.each([
    ["hello", "response language is English"],
    ["salut", "response language is Romanian"],
  ])("a short greeting sets this turn's language rule: %s", async (prompt, rule) => {
    const f = fixture(["Hi!"]);
    await f.run(prompt);
    expect(f.requests[0]).toContain(rule);
  });

  test("a task-card result is recorded before the turn ends", async () => {
    const f = fixture([toolCall("suggest_task", suggestion), "The weather in Cluj is sunny."]);
    await f.run("Please check the weather in 2 minutes.");
    await f.run("Please tell me the weather in Cluj.", "m2");
    expect(f.requests[1]).toContain("Shown as a card");
  });

  test("an existing task card is acknowledged without fictional failure or re-scheduling", async () => {
    const f = fixture([toolCall("suggest_task", suggestion), toolCall("suggest_task", suggestion)]);
    await f.run("Please check the weather in 2 minutes.");
    const answer = await f.run("Please check the weather in 2 minutes.", "m2");
    expect(answer).toContain("already");
    expect(answer).toContain("Create");
    expect(f.inferenceCalls()).toBe(2);
    expect(f.events.filter(e => e.type === "tool_done" && (e.result.data as any)?.taskSuggestion)).toHaveLength(1);
  });

  test("a deferred request needs a real card rather than a fictional completion", async () => {
    const f = fixture(["I have checked the weather and scheduled it.", toolCall("suggest_task", suggestion)]);
    const answer = await f.run("Please check the weather in 2 minutes.");
    expect(answer).toContain("Today at 17:02");
    expect(f.events.some(e => e.type === "tool_done" && e.tool === "suggest_task" && e.result.ok)).toBe(true);
  });

  test.each([
    "Check the weather now and remind me in 2 minutes.",
    "Find the report and remind me to read it tomorrow.",
    'Explain the phrase "check the weather in 2 minutes".',
    "Do not check the weather later; check it now.",
    "Do not remind me in 2 minutes. Check the weather now.",
    "What is the weather forecast for tomorrow?",
    "Explain why this code uses later initialization.",
    "What did you do at 19:00?",
    "Tell me when Shakespeare was born.",
  ])("immediate, quoted and negated requests still run: %s", async prompt => {
    const f = fixture([toolCall("web_search"), "The weather in Cluj is sunny."]);
    await f.run(prompt);
    expect(f.workCalls()).toBe(1);
  });

  test("language follows the latest message when the same session switches", async () => {
    const f = fixture(["În Cluj este soare.", "The weather in Cluj is sunny."]);
    await f.run("Spune-mi vremea în Cluj.");
    await f.run("Please tell me the weather in Cluj.", "m2");
    expect(f.requests[0]).toContain("response language is Romanian");
    expect(f.requests[1]).toContain("response language is English");
  });

  test.each([
    "Find me a restaurant in Cluj that is open at 10pm.",
    "Find flights from Cluj to London tomorrow at 9:00.",
    "Write a Python script that sends me an email every day at 9:00.",
    "Remind me what we decided about the logo.",
    "Tell me when the next train to Brasov leaves.",
  ])("ordinary work that mentions a time still runs now: %s", async prompt => {
    const f = fixture([toolCall("web_search"), "Done."]);
    await f.run(prompt);
    expect(f.workCalls()).toBe(1);
  });

  test.each([
    ["Please translate 'the weather is sunny' into Romanian.", "Vremea este însorită."],
    ["Please answer in Romanian: what is the weather?", "În Cluj este soare."],
    ["Please answer in Spanish: what is the weather?", "El tiempo es soleado."],
    ["Quel temps fait-il à Cluj ?", "Il fait beau à Cluj."],
  ])("explicit translation and other languages are preserved: %s", async (prompt, expected) => {
    const f = fixture([expected]);
    expect(await f.run(prompt)).toBe(expected);
    expect(f.inferenceCalls()).toBe(1);
  });
});
