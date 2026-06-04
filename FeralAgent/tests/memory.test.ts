/**
 * Memory layer — recall, semantic, and working memory integration.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/sandbox/audit-log.ts";
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

describe("WorkingMemory.setMemoryContext", () => {
  test("memory context appears in render between system and transcript", () => {
    const mem = new WorkingMemory("You are Feral.");
    mem.setMemoryContext("[Memory context]\nname: Darius\n[End memory context]");
    mem.addUser("hello");

    const rendered = mem.render();
    expect(rendered[0]?.role).toBe("system");
    expect(rendered[0]?.content).toBe("You are Feral.");
    expect(rendered[1]?.role).toBe("system");
    expect(rendered[1]?.content).toContain("name: Darius");
    expect(rendered[2]?.role).toBe("user");
    expect(rendered[2]?.content).toBe("hello");
  });

  test("empty memory context does not add an extra system message", () => {
    const mem = new WorkingMemory("You are Feral.");
    mem.addUser("hello");

    const rendered = mem.render();
    expect(rendered).toHaveLength(2); // system + user only
  });

  test("memory context is replaced, not accumulated, on subsequent calls", () => {
    const mem = new WorkingMemory("sys");
    mem.setMemoryContext("first context");
    mem.setMemoryContext("second context");
    mem.addUser("hi");

    const rendered = mem.render();
    const systemMessages = rendered.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(2); // base + one context
    expect(systemMessages[1]?.content).toBe("second context");
  });
});
