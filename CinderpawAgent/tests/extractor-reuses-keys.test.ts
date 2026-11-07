/**
 * One fact, one key.
 *
 * Darius's store held 745 facts on 28 Oct 2026, among them ~22 keys for his
 * language (`language`, `limba`, `limba_preferată`, `communication_language`,
 * `user_language`, ...) and ~10 for his name (`name`, `nume`, `user_name`,
 * `name_used_by_assistant`, ...). Two causes: the extractor named every fact
 * blind, never shown the keys already in use, and in any language it liked;
 * and the alias table only matched spaced keys, so `user_name` slipped past
 * `user name` -> `name`.
 */
import { describe, expect, it } from "bun:test";
import { MemoryExtractor, canonicalFactKey } from "../src/memory/extractor.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { openDatabase } from "../src/db.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";

describe("canonicalFactKey", () => {
  it("treats underscores and hyphens like the spaces the aliases are written with", () => {
    expect(canonicalFactKey("user_name")).toBe("name");
    expect(canonicalFactKey("user-name")).toBe("name");
    expect(canonicalFactKey("preferred_language")).toBe("language");
  });

  it("folds the language and system variants that piled up onto one key", () => {
    for (const k of ["communication language", "chat language", "user language", "language preference", "user language preference", "response language"]) {
      expect(canonicalFactKey(k)).toBe("language");
    }
    expect(canonicalFactKey("operating_system")).toBe("os");
  });

  it("leaves a language that is about something else alone", () => {
    // Posts in English while chatting in Romanian is two facts, not one.
    expect(canonicalFactKey("social post language")).toBe("social_post_language");
    expect(canonicalFactKey("document_language")).toBe("document_language");
  });
});

describe("MemoryExtractor names facts with the keys already in use", () => {
  it("shows the model the keys it already wrote, and asks for English keys", async () => {
    const sent: ChatMessage[][] = [];
    const router = {
      complete: async (req: { messages: ChatMessage[] }) => {
        sent.push(req.messages);
        return { content: "=== FACTS ===\nNONE\n=== NOTES ===\nNONE" };
      },
      evictSession: () => {},
    } as unknown as InferenceRouter;
    const db = openDatabase(":memory:");
    const semantic = new SemanticMemory(db.raw, () => {});
    // Newest first in the list, so the times are set rather than raced.
    semantic.upsert("name", "Darius", "", "fact", 2_000);
    semantic.upsert("language", "română", "", "preference", 1_000);
    const extractor = new MemoryExtractor(router, semantic);

    extractor.extractAsync("s1", [
      { role: "user", content: "Ma numesc Darius si vorbesc romana" },
      { role: "assistant", content: "Salut, Darius!" },
    ]);
    await extractor.drain(2000);

    expect(sent).toHaveLength(1);
    const [system, user] = sent[0]!;
    expect(user!.content).toContain("Keys already in use: name, language");
    expect(system!.content).toMatch(/English snake_case/);
    expect(system!.content).toMatch(/reuse that exact key/i);
    db.close();
  });

  it("says so when nothing is known yet, instead of an empty list", async () => {
    const sent: ChatMessage[][] = [];
    const router = {
      complete: async (req: { messages: ChatMessage[] }) => {
        sent.push(req.messages);
        return { content: "=== FACTS ===\nNONE\n=== NOTES ===\nNONE" };
      },
      evictSession: () => {},
    } as unknown as InferenceRouter;
    const db = openDatabase(":memory:");
    const extractor = new MemoryExtractor(router, new SemanticMemory(db.raw, () => {}));
    extractor.extractAsync("s1", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    await extractor.drain(2000);
    expect(sent[0]![1]!.content).toContain("Keys already in use: (none yet)");
    db.close();
  });
});
