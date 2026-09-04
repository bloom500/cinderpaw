/**
 * MemoryExtractor fires after_memory_write — Pathway 3 step 2 Task 1.
 *
 * Pins the extractor-side integration with the new hook event. The
 * extractor fires once per fact line on the FACTS path and once per
 * observation on the OBSERVATION path. It does NOT fire on NONE / SKIP
 * (no junk events).
 *
 * The Reconciler (Task 2) is the first real subscriber. This test uses
 * a counting handler to verify the fire pattern is correct.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { openDatabase } from "../src/db.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";
import type { AfterMemoryWritePayload } from "../src/types.ts";

// Capture stderr writes so the "handler error" path doesn't pollute
// test output (same pattern as hooks.test.ts / memory-write-hook.test.ts).
let stderrWrites: string[];
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stderrWrites = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origStderrWrite;
});

/** Build a router stub that returns the given model response verbatim. */
function routerStub(response: string): InferenceRouter {
  return {
    complete: async () => ({ content: response }),
    evictSession: () => {},
  } as unknown as InferenceRouter;
}

function makeMemory() {
  const db = openDatabase(":memory:");
  const semantic = new SemanticMemory(db.raw, () => {});
  const episodic = new EpisodicMemory(db.raw, () => {});
  const close = () => db.close();
  return { semantic, episodic, close };
}

function threeAssistantTurns(content = ""): ChatMessage[] {
  return [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: content },
    { role: "assistant", content: "OK" },
    { role: "user", content: "Anything else?" },
    { role: "assistant", content: "Sure" },
  ];
}

describe("MemoryExtractor fires after_memory_write", () => {
  test("fires once per fact line on the FACTS path", async () => {
    const { semantic, episodic, close } = makeMemory();
    const hooks = new HookRegistry();
    const seen: AfterMemoryWritePayload[] = [];
    hooks.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    const router = routerStub(
      "=== FACTS ===\nname: Alice\nlanguage: ro\n=== OBSERVATION ===\nSKIP",
    );
    const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
    // Start NOT idle so extractAsync's internal runPending() does not
    // drain the queue before our awaits are wired up. Flip idle to
    // true exactly once, then await runPending().
    let isIdle = false;
    extractor.setIdleChecker(() => isIdle);

    try {
      extractor.extractAsync("session-1", threeAssistantTurns());
      isIdle = true;
      await extractor.runPending();
      const factEvents = seen.filter((s) => s.kind === "fact");
      expect(factEvents).toHaveLength(2);
      expect(factEvents[0]).toMatchObject({ kind: "fact", key: "name", value: "Alice" });
      expect(factEvents[1]).toMatchObject({ kind: "fact", key: "language", value: "ro" });
      for (const ev of factEvents) {
        expect(typeof ev.ts).toBe("number");
        expect(ev.sessionId).toBe("session-1");
      }
    } finally {
      close();
    }
  });

  test("fires once per observation on the OBSERVATION path", async () => {
    const { semantic, episodic, close } = makeMemory();
    const hooks = new HookRegistry();
    const seen: AfterMemoryWritePayload[] = [];
    hooks.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    const router = routerStub(
      "=== FACTS ===\nNONE\n=== OBSERVATION ===\n" +
        "type: preference\ntitle: prefers dark mode\n" +
        "facts:\n- dark theme\n- no animations\n" +
        "concepts: ui, theme",
    );
    const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
    let isIdle = false;
    extractor.setIdleChecker(() => isIdle);

    try {
      extractor.extractAsync("session-1", threeAssistantTurns());
      isIdle = true;
      await extractor.runPending();
      const obsEvents = seen.filter((s) => s.kind === "observation");
      expect(obsEvents).toHaveLength(1);
      const ev = obsEvents[0];
      if (ev?.kind !== "observation") throw new Error("expected observation event");
      expect(ev.obsType).toBe("preference");
      expect(ev.title).toBe("prefers dark mode");
      expect(ev.concepts).toEqual(["ui", "theme"]);
    } finally {
      close();
    }
  });

  test("does NOT fire when the response is NONE / SKIP", async () => {
    const { semantic, episodic, close } = makeMemory();
    const hooks = new HookRegistry();
    const seen: AfterMemoryWritePayload[] = [];
    hooks.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    const router = routerStub("=== FACTS ===\nNONE\n=== OBSERVATION ===\nSKIP");
    const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
    let isIdle = false;
    extractor.setIdleChecker(() => isIdle);

    try {
      extractor.extractAsync("session-1", threeAssistantTurns());
      isIdle = true;
      await extractor.runPending();
      expect(seen).toHaveLength(0);
    } finally {
      close();
    }
  });

  test("a misbehaving handler does not crash the extraction pipeline", async () => {
    const { semantic, episodic, close } = makeMemory();
    const hooks = new HookRegistry();
    hooks.on("after_memory_write", () => {
      throw new Error("reconciler bug");
    });
    const router = routerStub("=== FACTS ===\nname: Bob\n=== OBSERVATION ===\nSKIP");
    const extractor = new MemoryExtractor(router, semantic, episodic, hooks);
    let isIdle = false;
    extractor.setIdleChecker(() => isIdle);

    try {
      extractor.extractAsync("session-1", threeAssistantTurns());
      isIdle = true;
      // runPending must not reject even though the handler throws.
      await extractor.runPending();
      // The fact DID land in semantic memory (the write happened
      // before the hook fire) — the hook failure is observable in
      // the stderr capture only.
      expect(semantic.get("name")?.value).toBe("Bob");
      expect(stderrWrites.some((s) => s.includes("after_memory_write"))).toBe(true);
    } finally {
      close();
    }
  });
});
