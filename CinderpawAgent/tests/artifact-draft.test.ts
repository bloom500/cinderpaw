import { describe, expect, it } from "bun:test";
import {
  createArtifactDraftTracker,
  readPartialJson,
  type DraftUpdate,
} from "../src/core/artifact-draft.ts";

describe("readPartialJson", () => {
  it("keeps an unterminated string", () => {
    expect(readPartialJson('{"title":"Pl')).toEqual({ title: "Pl" });
  });

  it("drops an escape that has not finished arriving", () => {
    expect(readPartialJson('{"content":"a\\')).toEqual({ content: "a" });
    expect(readPartialJson('{"content":"\\u00')).toEqual({ content: "" });
  });

  it("drops half of a surrogate pair until the other half arrives", () => {
    expect(readPartialJson('{"content":"\\ud83d')).toEqual({ content: "" });
    expect(readPartialJson('{"content":"\\ud83d\\ude00')).toEqual({ content: "😀" });
  });

  it("drops an unfinished number, literal or key", () => {
    expect(readPartialJson('{"a":1,"b":tr')).toEqual({ a: 1 });
    expect(readPartialJson('{"a":12')).toEqual({});
    expect(readPartialJson('{"a":"x","ti')).toEqual({ a: "x" });
  });

  it("reads a complete value and ignores what follows it", () => {
    expect(readPartialJson('{"name":"x","args":{"t":"y"}}\n</tool_call>')).toEqual({
      name: "x",
      args: { t: "y" },
    });
  });

  it("decodes escapes and keeps Romanian letters", () => {
    expect(readPartialJson('{"c":"a\\nb \\"q\\" ăîșț"}')).toEqual({ c: 'a\nb "q" ăîșț' });
  });

  it("reads through nested arrays and objects it does not need", () => {
    expect(readPartialJson('{"x":[1,{"y":"z"}],"title":"T"')).toEqual({ x: [1, { y: "z" }], title: "T" });
  });
});

function collect(): { updates: DraftUpdate[]; tracker: ReturnType<typeof createArtifactDraftTracker> } {
  const updates: DraftUpdate[] = [];
  return { updates, tracker: createArtifactDraftTracker("0", (u) => updates.push(u)) };
}

describe("createArtifactDraftTracker", () => {
  it("opens on first sight, then sends only what was added", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", "");
    tracker.fromArgs(0, "artifact_create", '{"kind":"markdown","title":"Plan","content":"Hel');
    tracker.fromArgs(0, "artifact_create", '{"kind":"markdown","title":"Plan","content":"Hello"}');
    expect(updates[0]).toEqual({ draft: "0:0", append: "" });
    expect(updates[1]).toEqual({ draft: "0:0", kind: "markdown", title: "Plan", append: "Hel" });
    expect(updates[2]).toEqual({ draft: "0:0", kind: "markdown", title: "Plan", append: "lo" });
    expect(updates.map((u) => u.append).join("")).toBe("Hello");
  });

  it("says nothing when nothing changed", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", '{"title":"T","content":"ab');
    tracker.fromArgs(0, "artifact_create", '{"title":"T","content":"ab');
    expect(updates).toHaveLength(1);
  });

  it("streams an edit's new text once the text it replaces is known", () => {
    const { updates, tracker } = collect();
    // Nothing while the placeholder being replaced may still be growing.
    tracker.fromArgs(2, "artifact_edit", '{"id":"a1","find":"[[Idea 1');
    expect(updates).toEqual([]);
    tracker.fromArgs(2, "artifact_edit", '{"id":"a1","find":"[[Idea 1]]","replace":"## Pasta\\nBoil');
    tracker.fromArgs(2, "artifact_edit", '{"id":"a1","find":"[[Idea 1]]","replace":"## Pasta\\nBoil water."}');
    expect(updates[0]).toEqual({ draft: "0:2", editOf: "a1", find: "[[Idea 1]]", append: "## Pasta\nBoil" });
    expect(updates[1]).toEqual({ draft: "0:2", editOf: "a1", find: "[[Idea 1]]", append: " water." });
  });

  it("does not stream an edit whose text to replace comes after the new text", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_edit", '{"id":"a1","replace":"New","find":"Ol');
    tracker.fromArgs(0, "artifact_edit", '{"id":"a1","content":"Whole new text"}');
    expect(updates).toEqual([]);
  });

  it("ignores every other tool", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "web_search", '{"query":"x"}');
    tracker.fromText('<tool_call>\n{"name": "web_search", "args": {"query": "x"');
    expect(updates).toEqual([]);
  });

  it("works when the content comes before the title", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(1, "artifact_create", '{"content":"Body","title":"La');
    tracker.fromArgs(1, "artifact_create", '{"content":"Body","title":"Later","kind":"app"}');
    expect(updates[0]).toEqual({ draft: "0:1", title: "La", append: "Body" });
    expect(updates[1]).toEqual({ draft: "0:1", kind: "app", title: "Later", append: "" });
  });

  it("never sends a backslash from an escape split across two deltas", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", '{"content":"a\\');
    tracker.fromArgs(0, "artifact_create", '{"content":"a\\nb');
    expect(updates.map((u) => u.append).join("")).toBe("a\nb");
  });

  it("starts a new draft when the text starts over (a fallback model)", () => {
    const { updates, tracker } = collect();
    tracker.fromArgs(0, "artifact_create", '{"content":"Hello wor');
    tracker.fromArgs(0, "artifact_create", '{"content":"Hi');
    expect(updates[1]).toEqual({ draft: "0:0~1", append: "Hi" });
  });

  it("reads a tool call the model wrote as text", () => {
    const { updates, tracker } = collect();
    tracker.fromText('Sure.<tool_call>\n{"name": "artifact_create", "args": {"kind":"markdown","title":"T","content":"ab');
    tracker.fromText('Sure.<tool_call>\n{"name": "artifact_create", "args": {"kind":"markdown","title":"T","content":"abc"}}\n</tool_call>');
    expect(updates[0]).toEqual({ draft: "0:t0", kind: "markdown", title: "T", append: "ab" });
    expect(updates[1]).toEqual({ draft: "0:t0", kind: "markdown", title: "T", append: "c" });
  });

  it("still opens for a tool-call shape it cannot read", () => {
    const { updates, tracker } = collect();
    tracker.fromText('<invoke name="artifact_create"><parameter name="content">Hel');
    expect(updates).toEqual([{ draft: "0:t0", append: "" }]);
  });
});

// The loop sends the draft to the desktop while the model writes it.
import { AgentLoop } from "../src/core/agent-loop.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { openDatabase } from "../src/db.ts";

async function eventsFor(first: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const originalFetch = globalThis.fetch;
  const events: Array<Record<string, unknown>> = [];
  try {
    let i = 0;
    globalThis.fetch = (async () => {
      const message = i++ === 0 ? first : { content: "Done." };
      return new Response(JSON.stringify({ message, done: true, prompt_eval_count: 10, eval_count: 5 }) + "\n", { status: 200 });
    }) as unknown as typeof fetch;
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const router = new InferenceRouter(
      {
        primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
        tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" },
      },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, new SemanticMemory(db.raw, audit.logger));
    const registry = new ToolRegistry(new EgressProxy(audit.logger), audit, new RealProcessSandbox(audit.logger));
    const agent = new AgentLoop(router, registry, episodic, {}, recall);
    await agent.handle("s1", "write me a plan", "m1", (e: unknown) => events.push(e as Record<string, unknown>));
    return events;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("the agent loop", () => {
  it("emits artifact_draft for a native tool call", async () => {
    const events = await eventsFor({
      content: "",
      tool_calls: [{ function: { name: "artifact_create", arguments: { kind: "markdown", title: "Plan", content: "# Plan\nDay one." } } }],
    });
    const drafts = events.filter((e) => e.type === "artifact_draft");
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts[0]).toMatchObject({ id: "m1", sessionId: "s1", draft: "0:0" });
    expect(drafts.at(-1)).toMatchObject({ title: "Plan", kind: "markdown" });
    expect(drafts.map((d) => d.append).join("")).toBe("# Plan\nDay one.");
  });

  it("emits artifact_draft for a tool call written as text", async () => {
    const events = await eventsFor({
      content: '<tool_call>\n{"name": "artifact_create", "args": {"kind": "markdown", "title": "T", "content": "Hello"}}\n</tool_call>',
    });
    const drafts = events.filter((e) => e.type === "artifact_draft");
    expect(drafts.at(-1)).toMatchObject({ id: "m1", draft: "0:t0", title: "T" });
    expect(drafts.map((d) => d.append).join("")).toBe("Hello");
  });

  it("says nothing for a reply without a document", async () => {
    const events = await eventsFor({ content: "Just an answer." });
    expect(events.some((e) => e.type === "artifact_draft")).toBe(false);
  });
});
