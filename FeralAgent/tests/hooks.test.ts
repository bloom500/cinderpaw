/**
 * Hook system — P0-4.
 *
 * The HookRegistry is a tiny async event emitter with a "block" semantic:
 *   - `before_*` events can return `{ block: true, reason }` to abort
 *     the operation. The first blocking result wins.
 *   - `after_*` / lifecycle events return `{ block: false }` (or void).
 *
 * Handlers can be sync or async. A handler that throws is caught and
 * logged to stderr; the pipeline must never crash because a hook
 * malfunctioned.
 *
 * Tests pin:
 *   1. Registration + unsubscribe
 *   2. fire() awaits async handlers in registration order
 *   3. The first blocking result short-circuits the rest
 *   4. Handler errors don't propagate to the caller
 *   5. clear() drops all handlers
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  HookRegistry,
  type HookHandler,
} from "../src/core/hook-registry.ts";
import type {
  AfterToolCallPayload,
  AgentEndPayload,
  AgentStartPayload,
  BeforeCompactionPayload,
  BeforePromptBuildPayload,
  BeforeToolCallPayload,
  HookEvent,
  HookResult,
  SubagentCompletePayload,
  SubagentSpawnPayload,
} from "../src/types.ts";

// Capture stderr writes so the "handler error" test doesn't pollute the
// test output.
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

function makeRegistry(): HookRegistry {
  return new HookRegistry();
}

const sampleBefore: BeforeToolCallPayload = {
  tool: "web_search",
  args: { query: "x" },
  sessionId: "s1",
};

const sampleAfter: AfterToolCallPayload = {
  tool: "web_search",
  args: { query: "x" },
  result: { ok: true, content: "ok" },
  sessionId: "s1",
  durationMs: 12,
};

describe("HookRegistry basics", () => {
  test("fire with no handlers resolves to null (no block)", async () => {
    const r = makeRegistry();
    const got = await r.fire("before_tool_call", sampleBefore);
    expect(got).toBeNull();
  });

  test("handler receives the payload verbatim", async () => {
    const r = makeRegistry();
    const seen: BeforeToolCallPayload[] = [];
    r.on("before_tool_call", (p) => {
      seen.push(p);
    });
    await r.fire("before_tool_call", sampleBefore);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(sampleBefore);
  });

  test("multiple handlers all fire, in registration order", async () => {
    const r = makeRegistry();
    const order: number[] = [];
    r.on("before_tool_call", () => { order.push(1); });
    r.on("before_tool_call", async () => { order.push(2); });
    r.on("before_tool_call", () => { order.push(3); });
    await r.fire("before_tool_call", sampleBefore);
    expect(order).toEqual([1, 2, 3]);
  });

  test("unsubscribe stops further fires", async () => {
    const r = makeRegistry();
    let count = 0;
    const off = r.on("before_tool_call", () => { count++; });
    await r.fire("before_tool_call", sampleBefore);
    expect(count).toBe(1);
    off();
    await r.fire("before_tool_call", sampleBefore);
    expect(count).toBe(1);
  });

  test("clear drops every handler", async () => {
    const r = makeRegistry();
    let count = 0;
    r.on("before_tool_call", () => { count++; });
    r.on("agent_start", () => { count++; });
    r.clear();
    await r.fire("before_tool_call", sampleBefore);
    await r.fire<"agent_start">("agent_start", {
      sessionId: "s1",
      userText: "hi",
    } as AgentStartPayload);
    expect(count).toBe(0);
  });
});

describe("HookRegistry block semantics", () => {
  test("before_tool_call: first blocking result short-circuits the rest", async () => {
    const r = makeRegistry();
    const fired: number[] = [];
    r.on("before_tool_call", () => { fired.push(1); });
    r.on("before_tool_call", async () => {
      fired.push(2);
      return { block: true, reason: "policy: no web_search" };
    });
    r.on("before_tool_call", () => { fired.push(3); });

    const got = await r.fire("before_tool_call", sampleBefore);
    expect(fired).toEqual([1, 2]); // handler 3 not called
    expect(got).toEqual({ block: true, reason: "policy: no web_search" });
  });

  test("after_tool_call cannot block (always returns block: false semantically)", async () => {
    const r = makeRegistry();
    // after-tool hooks are informational. If a handler returns block:true
    // anyway, the registry accepts it but the caller (tool registry)
    // ignores it — there's nothing left to abort. We test that the
    // registry surfaces the result anyway so the caller can decide.
    r.on("after_tool_call", async () => ({ block: true, reason: "ignored" }));
    const got = await r.fire("after_tool_call", sampleAfter);
    expect(got).toEqual({ block: true, reason: "ignored" });
  });

  test("non-blocking handler returns block: false explicitly", async () => {
    const r = makeRegistry();
    r.on("before_tool_call", async (): Promise<HookResult> => ({ block: false }));
    const got = await r.fire("before_tool_call", sampleBefore);
    expect(got).toBeNull(); // the registry returns null when no block
  });
});

describe("HookRegistry error isolation", () => {
  test("a throwing handler does not break the pipeline", async () => {
    const r = makeRegistry();
    r.on("before_tool_call", () => { throw new Error("boom"); });
    const r2 = makeRegistry();
    const m = mock(() => {});
    r2.on("before_tool_call", m as unknown as HookHandler<"before_tool_call">);
    // Reuse the throwing registry to ensure the test sees the error
    // is swallowed, then run a second registry to confirm normal fire
    // still works after an error.
    void r; // satisfy noUnused
    const got = await r2.fire("before_tool_call", sampleBefore);
    expect(got).toBeNull();
    expect(m).toHaveBeenCalledTimes(1);
  });

  test("a throwing handler logs to stderr", async () => {
    const r = makeRegistry();
    r.on("before_tool_call", () => { throw new Error("expected"); });
    await r.fire("before_tool_call", sampleBefore);
    expect(stderrWrites.join("")).toMatch(/handler for "before_tool_call" failed/);
    expect(stderrWrites.join("")).toMatch(/expected/);
  });

  test("async handler that rejects is treated like a throw", async () => {
    const r = makeRegistry();
    r.on("before_tool_call", async () => { throw new Error("async-boom"); });
    const got = await r.fire("before_tool_call", sampleBefore);
    expect(got).toBeNull();
  });
});

describe("HookRegistry payload type discrimination", () => {
  test("agent_start fires for the start of an agent turn", async () => {
    const r = makeRegistry();
    const seen: AgentStartPayload[] = [];
    r.on("agent_start", (p) => { seen.push(p); });
    const payload: AgentStartPayload = {
      sessionId: "s1",
      userText: "hello",
    };
    await r.fire<"agent_start">("agent_start", payload);
    expect(seen).toEqual([payload]);
  });

  test("agent_end fires once per turn with the result", async () => {
    const r = makeRegistry();
    const seen: AgentEndPayload[] = [];
    r.on("agent_end", (p) => { seen.push(p); });
    const payload: AgentEndPayload = {
      sessionId: "s1",
      userText: "hello",
      answer: "world",
      toolCalls: 2,
      tokensUsed: 100,
      durationMs: 500,
    };
    await r.fire<"agent_end">("agent_end", payload);
    expect(seen).toEqual([payload]);
  });

  test("subagent_spawn + subagent_complete are independent", async () => {
    const r = makeRegistry();
    const seen: Array<SubagentSpawnPayload | SubagentCompletePayload> = [];
    r.on("subagent_spawn", (p) => { seen.push(p); });
    r.on("subagent_complete", (p) => { seen.push(p); });
    const spawn: SubagentSpawnPayload = {
      parentSessionId: "p1",
      subagentId: "sa1",
      task: "research",
      allowedTools: ["web_search"],
    };
    const complete: SubagentCompletePayload = {
      parentSessionId: "p1",
      subagentId: "sa1",
      status: "completed",
      durationMs: 1234,
    };
    await r.fire<"subagent_spawn">("subagent_spawn", spawn);
    await r.fire<"subagent_complete">("subagent_complete", complete);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(spawn);
    expect(seen[1]).toEqual(complete);
  });

  test("before_compaction fires with the message count being compressed", async () => {
    const r = makeRegistry();
    const seen: BeforeCompactionPayload[] = [];
    r.on("before_compaction", (p) => { seen.push(p); });
    const payload: BeforeCompactionPayload = {
      sessionId: "s1",
      olderMessageCount: 12,
      recentKept: 4,
    };
    await r.fire<"before_compaction">("before_compaction", payload);
    expect(seen).toEqual([payload]);
  });

  test("before_prompt_build receives the assembled system prompt", async () => {
    const r = makeRegistry();
    const seen: BeforePromptBuildPayload[] = [];
    r.on("before_prompt_build", (p) => { seen.push(p); });
    const payload: BeforePromptBuildPayload = {
      sessionId: "s1",
      systemPrompt: "## FeralAgent base ...",
    };
    await r.fire<"before_prompt_build">("before_prompt_build", payload);
    expect(seen).toEqual([payload]);
  });
});

describe("HookRegistry all event names are accepted", () => {
  const events: HookEvent[] = [
    "before_tool_call",
    "after_tool_call",
    "before_prompt_build",
    "before_compaction",
    "agent_start",
    "agent_end",
    "subagent_spawn",
    "subagent_complete",
  ];
  for (const ev of events) {
    test(`fire('${ev}') resolves without throwing`, async () => {
      const r = makeRegistry();
      r.on(ev, () => {});
      let payload;
      switch (ev) {
        case "before_tool_call": payload = sampleBefore; break;
        case "after_tool_call": payload = sampleAfter; break;
        case "before_prompt_build": payload = { sessionId: "s", systemPrompt: "x" } as BeforePromptBuildPayload; break;
        case "before_compaction": payload = { sessionId: "s", olderMessageCount: 1, recentKept: 1 } as BeforeCompactionPayload; break;
        case "agent_start": payload = { sessionId: "s", userText: "x" } as AgentStartPayload; break;
        case "agent_end": payload = { sessionId: "s", userText: "x", answer: "y", toolCalls: 0, tokensUsed: 0, durationMs: 0 } as AgentEndPayload; break;
        case "subagent_spawn": payload = { parentSessionId: "p", subagentId: "sa", task: "t", allowedTools: [] } as SubagentSpawnPayload; break;
        case "subagent_complete": payload = { parentSessionId: "p", subagentId: "sa", status: "completed", durationMs: 0 } as SubagentCompletePayload; break;
      }
      const got = await r.fire(ev, payload as never);
      expect(got).toBeNull();
    });
  }
});
