/**
 * Tests for the ask_user bridge and ask_user tool.
 *
 * The bridge is the Promise-based interface for asking the user
 * interactive questions (Claude.ai-style). It:
 *   - Emits an `ask_user` event when ask() is called
 *   - Returns a Promise that resolves when the matching `ask_user_response` arrives
 *   - Times out after a configurable interval
 *   - Supports cancel() to abort a pending question
 *
 * The tool itself:
 *   - Validates the questions (1-4, 2-4 options each)
 *   - Calls the bridge
 *   - Renders the result as a human-readable string
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AskUserBridgeImpl, AskUserTimeoutError } from "../src/core/ask-user-bridge.ts";
import { createAskUserTool } from "../src/tools/builtin/ask-user.ts";
import type {
  AskUserAnswer,
  AskUserQuestion,
  OutboundEvent,
} from "../src/types.ts";

describe("AskUserBridgeImpl", () => {
  let events: OutboundEvent[];
  let emit: (e: OutboundEvent) => void;
  let bridge: AskUserBridgeImpl;

  beforeEach(() => {
    events = [];
    emit = (e) => events.push(e);
    bridge = new AskUserBridgeImpl(emit, { timeoutMs: 1000 });
  });

  afterEach(() => {
    bridge.cancelAll("test cleanup");
  });

  it("emits an ask_user event with the questions and a generated id", async () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Pick a database",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        multiSelect: false,
      },
    ];
    const promise = bridge.ask(questions);
    // Yield so the synchronous emit completes.
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("ask_user");
    if (ev.type === "ask_user") {
      expect(ev.questions).toEqual(questions);
      expect(typeof ev.id).toBe("string");
      expect(ev.id.length).toBeGreaterThan(0);
    }
    // Resolve so the promise does not hang.
    const id = (ev as { id: string }).id;
    bridge.resolve(id, [{ question: questions[0]!.question, selected: ["Postgres"] }]);
    await promise;
  });

  it("resolves the promise when a matching response arrives", async () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Color?",
        options: [{ label: "Red" }, { label: "Blue" }],
        multiSelect: false,
      },
    ];
    const promise = bridge.ask(questions);
    await Promise.resolve();
    const id = (events[0] as { id: string }).id;
    const answers: AskUserAnswer[] = [
      { question: "Color?", selected: ["Blue"] },
    ];
    bridge.resolve(id, answers);
    const result = await promise;
    expect(result).toEqual(answers);
  });

  it("rejects with AskUserTimeoutError when no response arrives", async () => {
    const questions: AskUserQuestion[] = [
      {
        question: "X?",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ];
    const promise = bridge.ask(questions);
    promise.catch(() => {}); // suppress unhandled rejection
    // Use a shorter timeout bridge.
    const shortBridge = new AskUserBridgeImpl(() => {}, { timeoutMs: 50 });
    const p2 = shortBridge.ask(questions);
    p2.catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await expect(p2).rejects.toBeInstanceOf(AskUserTimeoutError);
    bridge.resolve((events[0] as { id: string }).id, [
      { question: "X?", selected: ["A"] },
    ]);
    await promise;
  });

  it("cancel() rejects the promise with a cancellation reason", async () => {
    const questions: AskUserQuestion[] = [
      {
        question: "Y?",
        options: [{ label: "A" }, { label: "B" }],
        multiSelect: false,
      },
    ];
    const promise = bridge.ask(questions);
    await Promise.resolve();
    const id = (events[0] as { id: string }).id;
    bridge.cancel(id, "user navigated away");
    promise.catch(() => {});
    await expect(promise).rejects.toThrow(/user navigated away/);
  });

  it("resolve() with an unknown id is a no-op (no throw)", () => {
    expect(() => bridge.resolve("nonexistent", [])).not.toThrow();
  });
});

describe("createAskUserTool", () => {
  it("registers a tool named 'ask_user'", () => {
    const tool = createAskUserTool();
    expect(tool.manifest.name).toBe("ask_user");
  });

  it("has no permissions (pure, no side effects except event emission)", () => {
    const tool = createAskUserTool();
    expect(tool.manifest.permissions).toEqual([]);
  });

  it("requires a 'questions' array parameter", () => {
    const tool = createAskUserTool();
    expect(tool.parameters.questions).toBeDefined();
    expect(tool.parameters.questions.required).toBe(true);
  });

  it("rejects more than 4 questions", async () => {
    const tool = createAskUserTool();
    const bridge = {
      ask: () => Promise.resolve([]),
      cancel: () => {},
    };
    const questions: AskUserQuestion[] = Array.from({ length: 5 }, (_, i) => ({
      question: `Q${i}?`,
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: false,
    }));
    const result = await tool.execute(
      { questions },
      {
        sessionId: "s",
        manifest: tool.manifest,
        fetch: (() => Promise.reject(new Error("not used"))) as never,
        audit: () => {},
        askUser: bridge,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/too many|1-4/);
  });

  it("rejects a question with fewer than 2 or more than 4 options", async () => {
    const tool = createAskUserTool();
    const bridge = {
      ask: () => Promise.resolve([]),
      cancel: () => {},
    };
    for (const options of [
      [{ label: "only-one" }],
      [
        { label: "1" }, { label: "2" }, { label: "3" },
        { label: "4" }, { label: "5" },
      ],
    ]) {
      const result = await tool.execute(
        { questions: [{ question: "Q?", options, multiSelect: false }] },
        {
          sessionId: "s",
          manifest: tool.manifest,
          fetch: (() => Promise.reject(new Error("not used"))) as never,
          audit: () => {},
          askUser: bridge,
        },
      );
      expect(result.ok).toBe(false);
    }
  });

  it("returns a formatted summary when the user answers", async () => {
    const tool = createAskUserTool();
    const answers: AskUserAnswer[] = [
      { question: "Pick a database", selected: ["Postgres"] },
    ];
    const bridge = {
      ask: () => Promise.resolve(answers),
      cancel: () => {},
    };
    const result = await tool.execute(
      {
        questions: [
          {
            question: "Pick a database",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            multiSelect: false,
          },
        ],
      },
      {
        sessionId: "s",
        manifest: tool.manifest,
        fetch: (() => Promise.reject(new Error("not used"))) as never,
        audit: () => {},
        askUser: bridge,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Postgres");
    expect(result.content).toContain("Pick a database");
  });

  it("returns an error if askUser is not available in the context", async () => {
    const tool = createAskUserTool();
    const result = await tool.execute(
      {
        questions: [
          {
            question: "Q?",
            options: [{ label: "A" }, { label: "B" }],
            multiSelect: false,
          },
        ],
      },
      {
        sessionId: "s",
        manifest: tool.manifest,
        fetch: (() => Promise.reject(new Error("not used"))) as never,
        audit: () => {},
        // no askUser
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no_ask_user_bridge");
  });
});
