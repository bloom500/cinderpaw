/**
 * Memory layer — recall, semantic, and working memory integration.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { WorkingMemory } from "../src/memory/working.ts";

describe("SemanticMemory", () => {
  test("upsert and retrieve a fact", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("name", "Darius");
    const fact = sem.get("name");
    expect(fact?.value).toBe("Darius");
    db.close();
  });

  test("key is normalized to lowercase", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("Language", "Romanian");
    expect(sem.get("language")?.value).toBe("Romanian");
    db.close();
  });

  test("upsert overwrites existing value", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("city", "Bucharest");
    sem.upsert("city", "Cluj");
    expect(sem.get("city")?.value).toBe("Cluj");
    expect(sem.all()).toHaveLength(1);
    db.close();
  });

  test("delete removes a fact", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("temp", "x");
    sem.delete("temp");
    expect(sem.get("temp")).toBeUndefined();
    db.close();
  });

  test("renderForPrompt returns empty string with no facts", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);
    expect(sem.renderForPrompt()).toBe("");
    db.close();
  });

  test("renderForPrompt lists all facts", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const sem = new SemanticMemory(db.raw, audit.logger);

    sem.upsert("name", "Darius");
    sem.upsert("language", "Romanian");
    const rendered = sem.renderForPrompt();
    expect(rendered).toContain("name: Darius");
    expect(rendered).toContain("language: Romanian");
    db.close();
  });
});

describe("RecallEngine", () => {
  test("returns empty context when no episodic history exists", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, sem);

    const result = recall.recall("hello", "s1");
    expect(result.context).toBe("");
    expect(result.episodicHits).toBe(0);
    expect(result.semanticFacts).toBe(0);
    db.close();
  });

  test("surfaces semantic facts even without episodic matches", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    sem.upsert("name", "Darius");
    const recall = new RecallEngine(episodic, sem);

    const result = recall.recall("hello", "s1");
    expect(result.context).toContain("name: Darius");
    expect(result.semanticFacts).toBe(1);
    db.close();
  });

  test("excludes current session from episodic results by default", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);

    // Record in current session AND a past session.
    episodic.record("current", "user", "dinosaur facts are interesting");
    episodic.record("past",    "user", "dinosaur facts are interesting");

    const recall = new RecallEngine(episodic, sem);
    const result = recall.recall("dinosaur", "current");

    // Only the past session event should appear.
    expect(result.episodicHits).toBe(1);
    expect(result.context).not.toContain("[current]");
    db.close();
  });

  test("wraps context in memory markers when results exist", () => {
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const sem = new SemanticMemory(db.raw, audit.logger);
    sem.upsert("topic", "AI");

    const recall = new RecallEngine(episodic, sem);
    const result = recall.recall("AI agents", "s1");

    expect(result.context).toMatch(/^\[Memory context\]/);
    expect(result.context).toMatch(/\[End memory context\]$/);
    db.close();
  });
});

describe("WorkingMemory.render — P1 prompt-cache layout", () => {
  // P1: the dynamic per-turn context (skill menu, memory recall) is appended
  // to the LAST user message rather than injected as its own system message
  // between the static system prompt and the transcript. The system prompt
  // is now the only system role in the rendered output, so its tokenized
  // form is byte-stable across turns and llama.cpp's KV cache can be reused.

  const sampleSkill = {
    id: "x",
    name: "X",
    description: "X tool",
    author: "a",
    version: "1",
    license: "MIT",
    tags: [] as string[],
    source_provider: "local",
    source_url: null,
    content_url: null,
    install_status: "installed",
    trust_label: "verified",
    last_updated: null,
  };

  test("system prompt is the only system message; dynamic context rides on the last user message", () => {
    const mem = new WorkingMemory("You are Feral.");
    mem.setMemoryContext("[Memory context]\nname: Darius\n[End memory context]");
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("hello");

    const rendered = mem.render();
    // Exactly one system role — the static base prompt. No dynamic system messages.
    const systemMessages = rendered.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toBe("You are Feral.");
    // The user message carries the dynamic blocks at the tail.
    const last = rendered[rendered.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("hello");
    expect(last.content).toContain("name: Darius");
    expect(last.content).toContain("Available skills");
  });

  test("no dynamic context → system prompt is the only system message and user content is untouched", () => {
    const mem = new WorkingMemory("You are Feral.");
    mem.addUser("hello");
    const rendered = mem.render();
    expect(rendered.filter((m) => m.role === "system")).toHaveLength(1);
    expect(rendered[rendered.length - 1]?.content).toBe("hello");
  });

  test("memory context is replaced, not accumulated, on subsequent calls", () => {
    const mem = new WorkingMemory("sys");
    mem.setMemoryContext("first context");
    mem.setMemoryContext("second context");
    mem.addUser("hi");
    const rendered = mem.render();
    const last = rendered[rendered.length - 1]!;
    expect(last.content).toContain("second context");
    expect(last.content).not.toContain("first context");
  });

  test("static system prompt is byte-identical across renders with different dynamic context", () => {
    // The crux of P1: the system prompt tokenizes the same way every turn,
    // regardless of what skill menu / memory context the agent loop set. The
    // prefix [system, …, last-user-message-start] stays identical so the
    // KV cache for the static prefix stays valid.
    const mem = new WorkingMemory("You are Feral.\n## Tools\n- read_file\n");
    mem.setMemoryContext("ctx1");
    mem.addUser("u1");
    const sys1 = mem.render()[0]?.content;

    mem.setMemoryContext("ctx2 — completely different");
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("u2");
    const sys2 = mem.render()[0]?.content;

    expect(sys1).toBe(sys2);
  });

  test("user message at index of last user-role message is the only one mutated", () => {
    // After a tool-call iteration the transcript is e.g.
    //   [user, assistant, tool]
    // The user message (the only one) is the one that receives the
    // dynamic context block. (P4 fix: the agent loop no longer appends
    // a synthetic continuation nudge after a tool result, so the
    // transcript after a tool turn is exactly
    // `[user, assistant, tool]` rather than `[user, assistant, tool, user]`.)
    const mem = new WorkingMemory("sys");
    mem.addUser("original question");
    mem.addAssistant("ok");
    mem.addToolResult("foo", "result");
    mem.setMemoryContext("RECALL BLOCK");

    const rendered = mem.render();
    const userMessages = rendered.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    // The dynamic RECALL BLOCK is appended to the original user message
    // (P1 prompt-cache layout — see `render()`).
    expect(userMessages[0]?.content).toContain("original question");
    expect(userMessages[0]?.content).toContain("RECALL BLOCK");
  });

  test("estimatedTokens still counts the dynamic context toward the budget", () => {
    // Sanity: the dynamic blocks must still count toward maybeCompress's
    // budget, otherwise we'd lose compression triggers on memory-heavy turns.
    const mem = new WorkingMemory("sys");
    mem.setMemoryContext("x".repeat(400));
    mem.setSkillMenu([sampleSkill]);
    mem.addUser("z".repeat(100));
    const tokens = mem.estimatedTokens();
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("WorkingMemory.maybeCompress — context-window safety", () => {
  const summarize = async (msgs: { content: string }[]) =>
    `(${msgs.length} earlier turns)`;

  test("no-op while under the target budget", async () => {
    const mem = new WorkingMemory("sys");
    mem.addUser("hi");
    mem.addAssistant("hello");
    const changed = await mem.maybeCompress(summarize, 10_000);
    expect(changed).toBe(false);
    expect(mem.turns).toHaveLength(2);
  });

  test("compacts to fit a small budget: older turns summarized, recent kept", async () => {
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 20; i++) {
      mem.addUser(`question ${i} ` + "w".repeat(200));
      mem.addAssistant(`answer ${i} ` + "a".repeat(200));
    }
    const before = mem.estimatedTokens();
    const budget = 800;
    const changed = await mem.maybeCompress(summarize, budget);
    expect(changed).toBe(true);
    // Result fits the budget (this is the whole point — no KV overflow).
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(budget);
    expect(mem.estimatedTokens()).toBeLessThan(before);
    // A summary system note was prepended.
    expect(mem.turns[0]?.role).toBe("system");
    expect(mem.turns[0]?.content).toContain("Summary of earlier conversation");
  });

  test("a single fat tool output can't survive into an overflowing prompt", async () => {
    // The complex-task crash: one huge tool result keeps the prompt over the
    // model context even after older turns are summarized. Token-bounded
    // retention must truncate it so the prompt still fits.
    const mem = new WorkingMemory("sys");
    mem.addUser("run the thing");
    mem.addAssistant("ok");
    mem.addToolResult("read_file", "DATA ".repeat(5_000)); // ~thousands of tokens
    const budget = 600;
    const changed = await mem.maybeCompress(summarize, budget);
    expect(changed).toBe(true);
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(budget);
  });

  test("falls back to a truncation note when the summarizer throws", async () => {
    const mem = new WorkingMemory("sys");
    for (let i = 0; i < 10; i++) {
      mem.addUser("q " + "w".repeat(200));
      mem.addAssistant("a " + "a".repeat(200));
    }
    const boom = async () => {
      throw new Error("summarizer down");
    };
    const changed = await mem.maybeCompress(boom, 700);
    expect(changed).toBe(true);
    expect(mem.estimatedTokens()).toBeLessThanOrEqual(700);
    expect(mem.turns[0]?.content).toContain("earlier turns omitted");
  });
});
