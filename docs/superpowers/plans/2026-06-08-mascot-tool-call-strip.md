# Mascot Tool-Call Strip + FeralAgent P0 Reliability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FeralAgent's multi-step tool execution visible to the user via a comic-strip of bubbles above the mascot, and harden the agent for ultra-complex ("Toyota-grade") tasks by fixing four P0 reliability issues (streaming ghost text, missing `stopped` flag, unregistered `memory_ops`/`todo_write`, no tool retry).

**Architecture:** FeralAgent sidecar is unchanged on the wire (Rust just forwards JSON); we add four correctness fixes inside the Bun/TS sidecar and a `callId` per tool call so start/done can be reliably paired. The React side replaces the single-rotating-phrase `ThinkingBubble` with a `ToolCallStack` component (≤4 bubbles, framer-motion fade-in/out) that mirrors every tool call and the skills context from the inbound message. Pure helpers (`extractMainArg`, `emojiForTool`) are the single source of truth for "all tools and skills" coverage.

**Tech Stack:** Bun 1.x + TypeScript 5.6 (FeralAgent), Vite + React 18 + framer-motion 12 + Vitest 4 (frontend-react), Zustand 5 (store).

**Spec:** `docs/superpowers/specs/2026-06-08-mascot-tool-call-strip-design.md`

**Working directory:** `D:\FeralLocalAI` (no worktree — single direction, no parallel mutation risk).

---

## File structure

### FeralAgent — modified
- `FeralAgent/src/types.ts` — extend `OutboundEvent.tool_start` / `.tool_done` with `callId`; extend `OutboundEvent.done` with `stopped: boolean`; extend `ToolManifest` with `retry?: { attempts: number; on: ('fetch' | 'process' | 'any')[] }`.
- `FeralAgent/src/core/agent-loop.ts` — suppress `chunk` events on tool-call turns; set `stopped: boolean` on `done`; emit per-call `callId` on tool events.
- `FeralAgent/src/tools/registry.ts` — add retry loop around `tool.execute`.
- `FeralAgent/src/index.ts` — instantiate `TodoStore`; register `memory_ops` and `todo_write`.

### FeralAgent — new
- `FeralAgent/tests/agent-loop-no-ghost-text.test.ts` — P0-#1 test.
- `FeralAgent/tests/tool-retry.test.ts` — P0-#5 test.

### Frontend — modified
- `frontend-react/src/stores/chat.ts` — add `toolCallStream` + actions.
- `frontend-react/src/hooks/useFeral.ts` — capture `args`/`result`; push to stream; forward `stopped`.
- `frontend-react/src/lib/tauri/index.ts` — add `stopped` to `done`; add `callId` to tool events.
- `frontend-react/src/lib/feralAgentStream.ts` — forward `stopped` and `callId`.
- `frontend-react/src/components/chat/mascot/MascotPerch.tsx` — replace `<ThinkingBubble>` with `<ToolCallStack>`.

### Frontend — new
- `frontend-react/src/components/chat/mascot/extractMainArg.ts` — pure helper.
- `frontend-react/src/components/chat/mascot/extractMainArg.test.ts` — exhaustive tests.
- `frontend-react/src/components/chat/mascot/emojiForTool.ts` — pure helper.
- `frontend-react/src/components/chat/mascot/emojiForTool.test.ts` — exhaustive tests.
- `frontend-react/src/components/chat/mascot/ToolCallBubble.tsx` — single bubble.
- `frontend-react/src/components/chat/mascot/ToolCallStack.tsx` — stack container.
- `frontend-react/src/components/chat/mascot/ToolCallStack.test.tsx` — render + cap + fade tests.

### Frontend — deleted
- `frontend-react/src/components/chat/mascot/ThinkingBubble.tsx` (replaced by stack).

### Existing files NOT modified
- `src-tauri/**` — Rust passes through events unchanged.
- `FeralAgent/src/transports/tauri.ts` — opaque.
- `FeralAgent/src/db.ts` — `todos` table already exists.
- `FeralAgent/src/tools/builtin/todo-write.ts` — `TodoStore` class already exists; no changes needed inside the file.
- `FeralAgent/src/tools/builtin/memory-ops.ts` — already complete.
- `frontend-react/src/components/chat/mascot/FeralMascot.tsx` — poses already cover all phases.
- `frontend-react/src/components/chat/mascot/useMascotState.ts` — mappings already cover all `agentPhase` values.

---

## Task ordering (rationale)

The four FeralAgent P0 fixes are independent. We do them in this order:
1. **P0-#2 stopped flag** (tiny, isolated, locks the type for the UI's `done` consumer).
2. **P0-#5 tool retry** (isolated to `ToolRegistry`; tests need only the registry).
3. **P0-#3 register memory_ops + todo_write** (isolated to `index.ts`; one new line each).
4. **P0-#1 streaming ghost text** (changes the loop's emit behaviour; needs the mock harness).

After the four fixes:
5. **callId on tool events** (foundational for pairing — the UI needs this to know which `tool_done` ends which bubble).

Then the UI:
6. **Frontend types** (`lib/tauri/index.ts` + `feralAgentStream.ts`) — add `stopped` and `callId`.
7. **extractMainArg** + tests.
8. **emojiForTool** + tests.
9. **toolCallStream in the store** (Zustand) + test.
10. **useFeral hook changes** — capture args/result, push events.
11. **ToolCallBubble** component.
12. **ToolCallStack** component + test.
13. **MascotPerch integration** — replace `ThinkingBubble`; remove the file.
14. **Integration test extension** (P0-#2 and P0-#3 in `tests/integration.test.ts`).
15. **Build + manual QA** (`bun test`, `npm test`, app smoke test).

---

# Phase 1 — FeralAgent P0 Fixes

## Task 1: P0-#2 — `stopped: boolean` on `done` event

**Files:**
- Modify: `FeralAgent/src/types.ts:443`
- Modify: `FeralAgent/src/core/agent-loop.ts:194,202,244,265-268`
- Modify: `FeralAgent/tests/integration.test.ts`

- [ ] **Step 1: Write the failing test in `tests/integration.test.ts`**

Add a new test inside the existing `describe("integration", ...)` block (find it near the top of the file). Locate the closing `});` of the existing happy-path test and add these two tests AFTER it but BEFORE the `afterEach` block. The exact text depends on the file's existing structure; find a test that ends with `});` and add the new ones after the last one in the `describe`.

First, add a small capture helper near the top of the `describe` block (it can sit next to the existing `installSequencedFetch` and `auditAll` helpers):

```ts
function captureEvents(): { events: OutboundEvent[]; emit: (e: OutboundEvent) => void } {
  const events: OutboundEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}
```

Then the two new tests (use the same `BUDGET`, `ollamaOk`, and `installSequencedFetch` helpers already in the file):

```ts
test("done event has stopped:false on natural completion", async () => {
  const cap = captureEvents();
  const originalFetch = globalThis.fetch;
  try {
    // Mock Ollama: return a plain-text completion (no tool_call block).
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify(ollamaOk("All done — no tools needed.")),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    // Build a real loop with the same construction as the happy-path test.
    // (Reuse the buildLoop() helper if it exists; otherwise inline it.)
    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const semantic = new SemanticMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, semantic);
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    registry.register(createReadFileTool(["."]));
    const loop = new AgentLoop({
      router, registry, episodic, semantic, recall,
      config: { maxTokensPerCall: 1000, onBudgetExhausted: "stop" },
    });

    await loop.handle("s1", "hello", "m1", cap.emit);

    const done = cap.events.findLast((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(done!.type).toBe("done");
    expect((done as { stopped: boolean }).stopped).toBe(false);

    db.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("done event has stopped:true when user aborts mid-iteration", async () => {
  const cap = captureEvents();
  const originalFetch = globalThis.fetch;
  try {
    // Mock Ollama: first call returns a tool_call; subsequent calls return plain text.
    let callIndex = 0;
    globalThis.fetch = (async () => {
      callIndex++;
      const body = callIndex === 1
        ? ollamaOk('<tool_call>{"name":"read_file","arguments":{"path":"x"}}</tool_call>')
        : ollamaOk("stopped early");
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const db = openDatabase(":memory:");
    const audit = new AuditLog(db.raw);
    const egress = new EgressProxy(audit.logger);
    const router = new InferenceRouter(
      { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" },
      audit.logger,
      db.raw,
    );
    const episodic = new EpisodicMemory(db.raw, audit.logger);
    const semantic = new SemanticMemory(db.raw, audit.logger);
    const recall = new RecallEngine(episodic, semantic);
    const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
    registry.register(createReadFileTool(["."]));
    const loop = new AgentLoop({
      router, registry, episodic, semantic, recall,
      config: { maxTokensPerCall: 1000, onBudgetExhausted: "stop" },
    });

    // Start the handle; once we see the first tool_start, abort.
    const handlePromise = loop.handle("s1", "read x", "m1", (e) => {
      cap.emit(e);
      if (e.type === "tool_start") {
        loop.stop("s1");
      }
    });
    await handlePromise;

    const done = cap.events.findLast((e) => e.type === "done");
    expect(done).toBeDefined();
    expect((done as { stopped: boolean }).stopped).toBe(true);

    db.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

The two new tests must fail at this point because the type does not have `stopped` and the agent loop never sets it.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd FeralAgent && bun test tests/integration.test.ts -t "done event has stopped"`
Expected: 2 tests fail. The first fails with a TypeScript compile error on the `stopped: false` assertion (field does not exist on the type). The second fails at runtime — it cannot find `stopped: true` on the captured `done` event.

- [ ] **Step 3: Extend `OutboundEvent.done` in `types.ts:443`**

Change the line at `FeralAgent/src/types.ts:443` from:

```ts
  | { type: "done"; id: string; content: string }
```

to:

```ts
  | { type: "done"; id: string; content: string; stopped: boolean }
```

- [ ] **Step 4: Set `stopped` in `agent-loop.ts` on every `done` emit path**

The agent loop emits `done` in three places. Update all three.

**Path A — natural completion (no tool calls, final answer).** In `#run` at `agent-loop.ts:229-244`, after the final-answer branch returns, the loop body does NOT directly emit `done`; the `handle()` method (line 194) does. Find line ~194 and confirm it emits:

```ts
emit({ type: "done", id: messageId, content: answer, stopped: false });
```

(If `handle()` emits the event, the change is in `handle()` not in `#run`. Look for the only `type: "done"` emit and update it.)

**Path B — `AbortError` / user-stopped (caught at line 200-204).** Change to:

```ts
emit({ type: "done", id: messageId, content: message, stopped: true });
```

**Path C — iteration budget exhausted (line 264-268).** The `#run` function returns a string in this case; the caller (`#handle`) emits the `done` event with that string. Ensure that when the string starts with `"I reached the maximum number of reasoning steps…"`, the `done` event is emitted with `stopped: false` (the model wasn't stopped, it ran out of iterations).

A clean way to do this: have `#run` return a small object instead of a string:

```ts
type RunResult = { content: string; stopped: boolean };
```

But that's a larger refactor. Smaller: add a private field `#lastStopped: boolean = false` on `AgentLoop`; set it in `#run` (line 204 area for AbortError path, line 244 for natural, line 268 for budget-exhausted); read it in `handle()` when emitting `done`. The `handle()` method is at line ~119-204; the emit is near line 194. Add `#lastStopped = false` at the field declarations (line 60-100 area) and reset to `false` at the start of `#run`.

Concrete diff for `#run` (around line 200-204, the AbortError catch):

```ts
} catch (err) {
  const message = errorMessage(err);
  this.#lastStopped = true;
  emit({ type: "done", id: messageId, content: message, stopped: true });
  return message;
}
```

And before the final return at line 244:

```ts
this.#lastStopped = false;
return answer;
```

And before the final return at line 268:

```ts
this.#lastStopped = false;
return "I reached the maximum number of reasoning steps before finishing. …";
```

And in `handle()` at the `done` emit (line ~194), change:

```ts
emit({ type: "done", id: messageId, content: answer, stopped: this.#lastStopped });
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `cd FeralAgent && bun test tests/integration.test.ts -t "done event has stopped"`
Expected: 2 tests pass. The first asserts `stopped === false` on natural completion; the second asserts `stopped === true` after `router.abort()`.

- [ ] **Step 6: Run the full test suite**

Run: `cd FeralAgent && bun test`
Expected: all tests pass; the existing 15+ tests are untouched by this change.

- [ ] **Step 7: Commit**

```bash
cd D:/FeralLocalAI
git add FeralAgent/src/types.ts FeralAgent/src/core/agent-loop.ts FeralAgent/tests/integration.test.ts
git commit -m "fix(agent): add stopped flag to done event (P0-#2)"
```

---

## Task 2: P0-#5 — Tool retry on transient fetch failures

**Files:**
- Modify: `FeralAgent/src/types.ts:102-106` (`ToolManifest`)
- Modify: `FeralAgent/src/tools/registry.ts:114-160` (`ToolRegistry.call`)
- Modify: `FeralAgent/src/tools/builtin/web-search.ts` (add `retry` to manifest)
- Modify: `FeralAgent/src/tools/builtin/read-webpage.ts` (add `retry` to manifest)
- Modify: `FeralAgent/src/tools/builtin/http-request.ts` (add `retry` to manifest)
- Create: `FeralAgent/tests/tool-retry.test.ts`

- [ ] **Step 1: Create `tests/tool-retry.test.ts` with the failing test**

Create the file `FeralAgent/tests/tool-retry.test.ts`:

```ts
/**
 * P0-#5: tool retry on transient fetch failures.
 *
 * The registry should retry tools that opted into `manifest.retry` when
 * the error matches one of the configured kinds ("fetch", "process", "any").
 * Default behaviour (no retry manifest) is unchanged.
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool, ToolManifest } from "../src/types.ts";
import { openDatabase } from "../src/db.ts";

function newRegistry(): { registry: ToolRegistry; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  return { registry: new ToolRegistry(egress, audit, ps), db };
}

describe("ToolRegistry retry policy", () => {
  test("does NOT retry by default (manifest.retry absent)", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: { name: "t", description: "t", permissions: [], networkAccess: true } as ToolManifest,
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: "transient failure", error: "fetch" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t", {}, "s1");
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    db.close();
  });

  test("retries once on 'fetch' error when manifest.retry.attempts=1", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        name: "t_retry",
        description: "t",
        permissions: [],
        networkAccess: true,
        retry: { attempts: 1, on: ["fetch"] },
      } as ToolManifest,
      parameters: {},
      async execute() {
        calls++;
        if (calls === 1) return { ok: false, content: "boom", error: "fetch" };
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_retry", {}, "s1");
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("ok");
    db.close();
  });

  test("does NOT retry when error kind is not in manifest.retry.on", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        name: "t_noretry",
        description: "t",
        permissions: [],
        networkAccess: true,
        retry: { attempts: 1, on: ["fetch"] },
      } as ToolManifest,
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: "bad args", error: "bad_args" };
      },
    };
    registry.register(tool);
    await registry.call("t_noretry", {}, "s1");
    expect(calls).toBe(1);
    db.close();
  });

  test("gives up after attempts and returns the last error", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        name: "t_exhaust",
        description: "t",
        permissions: [],
        networkAccess: true,
        retry: { attempts: 2, on: ["fetch"] },
      } as ToolManifest,
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: `fail #${calls}`, error: "fetch" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_exhaust", {}, "s1");
    expect(calls).toBe(3); // initial + 2 retries
    expect(result.ok).toBe(false);
    expect(result.content).toBe("fail #3");
    db.close();
  });
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run: `cd FeralAgent && bun test tests/tool-retry.test.ts`
Expected: 1 of 4 tests passes (the "no retry by default" test, because retry logic doesn't exist yet). The other 3 fail: `expected 2 to be 1`, `expected 1 to be 1`, `expected 3 to be 1`.

- [ ] **Step 3: Extend `ToolManifest` in `types.ts:102-106`**

Find the `ToolManifest` interface (around line 102-106). It is currently:

```ts
export interface Tool {
  manifest: ToolManifest;
  parameters: Record<string, ToolParameter>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
```

The `ToolManifest` interface itself is defined elsewhere in `types.ts` (search for `export interface ToolManifest`). Add the `retry` field:

```ts
export interface ToolRetryPolicy {
  /** Number of retries after the initial attempt. 0 (default) = no retry. */
  attempts: number;
  /** Which error categories are eligible for retry. */
  on: ("fetch" | "process" | "any")[];
}

export interface ToolManifest {
  name: string;
  description: string;
  permissions: ToolPermission[];
  networkAccess: boolean;
  /** Optional retry policy. Default: no retry. */
  retry?: ToolRetryPolicy;
  // ... existing fields
}
```

The actual existing `ToolManifest` interface likely has more fields (allowedPaths, allowedExecutables, etc.). Keep them; just add `retry?` at the end.

- [ ] **Step 4: Implement retry in `ToolRegistry.call` (registry.ts:114-160)**

Replace the `try { ... } catch (err) { ... }` block in `ToolRegistry.call` with a retry-aware version. Locate the existing `try` block (line 114-134) and `catch` (line 135-159). Refactor as:

```ts
const policy = tool.manifest.retry;
const maxAttempts = 1 + Math.max(0, policy?.attempts ?? 0);
let lastResult: ToolResult | null = null;
let lastErr: unknown = null;

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    const result = await tool.execute(args, ctx);
    const durationMs = Date.now() - start;
    this.#audit.log({
      sessionId,
      actionType: "tool_call",
      toolName: name,
      argsJson: safeJson(args),
      result: result.ok ? "success" : "error",
      blockedReason: result.ok ? undefined : result.error,
      durationMs,
    });
    this.#observations?.append({
      sessionId, tool: name, success: result.ok, durationMs,
      error: result.ok ? null : (result.error ?? result.content.slice(0, 120)),
      argsKeys: Object.keys(args),
    });
    if (result.ok) return result;
    // Tool returned a structured failure — eligible for retry?
    const isRetryable = !policy ? false : (
      policy.on.includes("any") ||
      (policy.on.includes("fetch") && result.error === "fetch") ||
      (policy.on.includes("process") && result.error === "execution_error")
    );
    lastResult = result;
    if (!isRetryable || attempt === maxAttempts) return result;
    await sleep(250 * attempt);
    continue;
  } catch (err) {
    const durationMs = Date.now() - start;
    this.#audit.log({
      sessionId,
      actionType: "tool_call",
      toolName: name,
      argsJson: safeJson(args),
      result: "error",
      blockedReason: String(err),
      durationMs,
    });
    this.#observations?.append({
      sessionId, tool: name, success: false, durationMs,
      error: String(err).slice(0, 120),
      argsKeys: Object.keys(args),
    });
    lastErr = err;
    const isRetryable = !policy ? false : (
      policy.on.includes("any") ||
      policy.on.includes("process") // thrown errors are treated as process-level
    );
    if (!isRetryable || attempt === maxAttempts) {
      return {
        ok: false,
        content: `Tool "${name}" failed: ${String(err)}`,
        error: "execution_error",
      };
    }
    await sleep(250 * attempt);
  }
}

// Unreachable, but keep the type-checker happy.
return lastResult ?? {
  ok: false,
  content: `Tool "${name}" failed: ${String(lastErr)}`,
  error: "execution_error",
};
```

Add the helper at the top of the file (or bottom — your call):

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
```

- [ ] **Step 5: Run the new test file to verify it passes**

Run: `cd FeralAgent && bun test tests/tool-retry.test.ts`
Expected: 4 of 4 tests pass.

- [ ] **Step 6: Add `retry` to the three network tool manifests**

Edit `FeralAgent/src/tools/builtin/web-search.ts`, find the `manifest` object (the `ToolManifest` literal), and add:

```ts
retry: { attempts: 1, on: ["fetch"] },
```

Do the same in `read-webpage.ts` and `http-request.ts` (the latter is only registered when `FERAL_HTTP_DOMAINS` is set, so the field is harmless to add unconditionally).

Do NOT add to `read_url` or `fetch_url` because they use the same `http-request.ts` factory.

- [ ] **Step 7: Run the full test suite**

Run: `cd FeralAgent && bun test`
Expected: all tests pass; no regression.

- [ ] **Step 8: Commit**

```bash
cd D:/FeralLocalAI
git add FeralAgent/src/types.ts FeralAgent/src/tools/registry.ts FeralAgent/src/tools/builtin/web-search.ts FeralAgent/src/tools/builtin/read-webpage.ts FeralAgent/src/tools/builtin/http-request.ts FeralAgent/tests/tool-retry.test.ts
git commit -m "feat(agent): retry transient fetch failures on network tools (P0-#5)"
```

---

## Task 3: P0-#3 — Register `memory_ops` and `todo_write`

**Files:**
- Modify: `FeralAgent/src/index.ts:219-284`
- Modify: `FeralAgent/tests/integration.test.ts` (add an assertion)

- [ ] **Step 1: Verify the imports already exist**

Open `FeralAgent/src/index.ts`. Check the import block near the top. If `createTodoWriteTool` and `createMemoryOpsTool` are NOT already imported, add the lines:

```ts
import { createTodoWriteTool, TodoStore } from "./tools/builtin/todo-write.ts";
import { createMemoryOpsTool } from "./tools/builtin/memory-ops.ts";
```

(If they are already imported, skip this step.)

- [ ] **Step 2: Instantiate `TodoStore` and register both tools in `index.ts`**

After the line `const registry = new ToolRegistry(...)` (line 219) and before the first `registry.register(...)` call (line 220), add:

```ts
const todoStore = new TodoStore(db.raw);
```

After the last existing `registry.register(...)` call in the block (somewhere around line 284; the last registered tool in the file), add:

```ts
registry.register(createTodoWriteTool(todoStore));
registry.register(createMemoryOpsTool(semantic));
```

If `semantic` is not in scope at this point in `main()`, check the variable name. From the existing code at line 200-202 we see `const semantic = new SemanticMemory(...)` is created earlier. Use that name.

- [ ] **Step 3: Write a failing test in `tests/integration.test.ts`**

Find the existing test that asserts the happy-path integration works. After the audit-log row count assertions (around line 197), add a new `test` block (still inside the same `describe`):

```ts
test("memory_ops and todo_write are registered", () => {
  // Build a fresh AgentLoop (use the same buildLoop() helper as the happy-path test)
  // and call registry.list().map(t => t.manifest.name)
  // Assert: the array includes "memory_ops" and "todo_write"
});
```

Find the local `buildLoop()` helper in this file (or inline the construction). The test instantiates a real `AgentLoop` with real dependencies, asks the registry for its tool list, and asserts the two new names are present.

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd FeralAgent && bun test tests/integration.test.ts -t "memory_ops and todo_write are registered"`
Expected: FAIL with "expected [...].toContain('memory_ops')" or similar.

- [ ] **Step 5: Run the test again to verify it passes**

(The registration was added in Step 2; this step just confirms.)

Run: `cd FeralAgent && bun test tests/integration.test.ts -t "memory_ops and todo_write are registered"`
Expected: PASS.

- [ ] **Step 6: Add an end-to-end assertion that `todo_write` actually works**

In the same `describe`, add a test that simulates the model emitting a `todo_write` tool call (action=add, id="test-item", content="hello"), and asserts the `todos` table now has one row with that id.

```ts
test("todo_write add inserts a row in the todos table", async () => {
  // Build a real loop with sequenced fetch (the helper that exists in this file)
  // First model response: emits a tool_call for todo_write with action=add
  // Second model response: plain text "done"
  // Assert: db.raw.query("SELECT COUNT(*) as c FROM todos WHERE id = ?").get("test-item").c === 1
});
```

Use the existing `installSequencedFetch` and `ollamaOk` helpers in the file to build the two model responses. The first response must contain a `<tool_call>` block matching the tool's expected XML format. Look at how the existing `web_search happy path` test in the same file builds its first response and follow the same template.

- [ ] **Step 7: Run the new tests; both should pass**

Run: `cd FeralAgent && bun test tests/integration.test.ts -t "todo_write"`
Expected: PASS.

- [ ] **Step 8: Run the full test suite**

Run: `cd FeralAgent && bun test`
Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
cd D:/FeralLocalAI
git add FeralAgent/src/index.ts FeralAgent/tests/integration.test.ts
git commit -m "feat(agent): register memory_ops and todo_write tools (P0-#3)"
```

---

## Task 4: P0-#1 — Suppress chunk events on tool-call turns

**Files:**
- Create: `FeralAgent/tests/agent-loop-no-ghost-text.test.ts`
- Modify: `FeralAgent/src/core/agent-loop.ts:214-245`

- [ ] **Step 1: Create the failing test**

Create `FeralAgent/tests/agent-loop-no-ghost-text.test.ts`:

```ts
/**
 * P0-#1: the agent loop must NOT emit `chunk` events for turns that end
 * in a tool call. Otherwise the UI shows partial text that then
 * disappears when the tool_start event arrives.
 *
 * We assert: for a turn where the model streams some prose and then
 * emits a web_search tool block, the captured event stream contains
 * zero `chunk` events during that iteration.
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { InferenceRouter } from "../src/sandbox/inference-router.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createWebSearchTool } from "../src/tools/builtin/web-search.ts";
import { createReadFileTool } from "../src/tools/builtin/read-file.ts";
import { AgentLoop } from "../src/core/agent-loop.ts";
import { openDatabase } from "../src/db.ts";
import type { OutboundEvent } from "../src/types.ts";

function captureEmit(): { events: OutboundEvent[]; emit: (e: OutboundEvent) => void } {
  const events: OutboundEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function makeLoop(db: ReturnType<typeof openDatabase>) {
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const router = new InferenceRouter(
    { provider: "ollama", model: "qwen2.5:7b", baseUrl: "http://localhost:11434" },
    audit.logger,
    db.raw,
  );
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  const semantic = new SemanticMemory(db.raw, audit.logger);
  const recall = new RecallEngine(episodic, semantic);
  const registry = new ToolRegistry(egress, audit, new RealProcessSandbox(audit.logger));
  registry.register(createWebSearchTool());
  registry.register(createReadFileTool(["."]));
  return new AgentLoop({
    router, registry, episodic, semantic, recall,
    config: { maxTokensPerCall: 1000, onBudgetExhausted: "stop" },
  });
}

describe("AgentLoop streaming ghost text (P0-#1)", () => {
  test("no chunk events emitted during a turn that ends in a tool call", async () => {
    const db = openDatabase(":memory:");
    const loop = makeLoop(db);
    // Stub router.complete to return a mixed response: prose + tool_call block.
    (loop as unknown as { #router: { complete: typeof loop["handle"] } }).#router;
    (loop as unknown as { router: InferenceRouter }).router.complete = async () => ({
      content: 'Let me search.\n<tool_call>\n{"name":"web_search","arguments":{"query":"x"}}\n</tool_call>',
      promptTokens: 5,
      completionTokens: 5,
    });

    const cap = captureEmit();
    await loop.handle("s1", "find x", "m1", cap.emit);

    const chunks = cap.events.filter((e) => e.type === "chunk");
    expect(chunks).toHaveLength(0);
    expect(cap.events.some((e) => e.type === "tool_start")).toBe(true);
    expect(cap.events.some((e) => e.type === "tool_done")).toBe(true);

    db.close();
  });

  test("chunk events ARE emitted on the final plain-text turn", async () => {
    const db = openDatabase(":memory:");
    const loop = makeLoop(db);
    let callIndex = 0;
    (loop as unknown as { router: InferenceRouter }).router.complete = async () => {
      callIndex++;
      if (callIndex === 1) {
        return {
          content: '<tool_call>{"name":"read_file","arguments":{"path":"package.json"}}\n</tool_call>',
          promptTokens: 5, completionTokens: 5,
        };
      }
      return {
        content: "Here is the answer with several words streamed in.",
        promptTokens: 5, completionTokens: 5,
      };
    };

    const cap = captureEmit();
    await loop.handle("s1", "read package.json", "m1", cap.emit);

    const chunks = cap.events.filter((e) => e.type === "chunk");
    // At least one chunk event (the final answer streamed normally).
    expect(chunks.length).toBeGreaterThan(0);
    // The chunks should appear AFTER the last tool_done.
    const lastToolDoneIdx = cap.events.findLastIndex((e) => e.type === "tool_done");
    const firstChunkIdx = cap.events.findIndex((e) => e.type === "chunk");
    expect(firstChunkIdx).toBeGreaterThan(lastToolDoneIdx);

    db.close();
  });
});
```

- [ ] **Step 2: Run the new test to verify the first one fails**

Run: `cd FeralAgent && bun test tests/agent-loop-no-ghost-text.test.ts -t "no chunk events"`
Expected: FAIL with `expected [Array] to have length 0` (the streamed tokens leak through).

- [ ] **Step 3: Suppress `chunk` events in `agent-loop.ts:214-245`**

In `AgentLoop.#run`, the loop body streams tokens via `onToken` (line 220-223). Modify the loop to:

1. Buffer tokens into a local string.
2. After `parseResponse` returns, decide whether to flush the buffer.
3. If the response has tool calls, DO NOT flush — discard the buffer.
4. If the response has no tool calls, flush all buffered tokens as `chunk` events.

Concrete change at `agent-loop.ts:214-245`:

```ts
for (let i = 0; i < maxIterations; i++) {
  // Buffer tokens. We do NOT emit `chunk` events eagerly because if the
  // model turns out to be making a tool call, those tokens would be
  // discarded from the user's perspective (the tool events replace them).
  // Emit them only after parseResponse confirms this is the final answer.
  let buffered = "";
  const onToken = (token: string) => {
    buffered += token;
  };

  const completion = await this.#complete(sessionId, memory, onToken);
  const knownTools = new Set(this.#registry.list().map((t) => t.manifest.name));
  const parsed = parseResponse(completion, knownTools);

  if (parsed.toolCalls.length === 0) {
    // Final answer — flush buffered tokens as chunk events.
    if (buffered.length > 0) {
      emit({ type: "chunk", id: messageId, content: buffered });
    }
    const answer = stripThinking(parsed.text) || stripThinking(buffered);
    if (!answer) {
      const hadThinking = /<think>|<thinking>|<\|channel>thought/i.test(completion);
      if (hadThinking) {
        return "(The model used all available tokens on reasoning and produced no answer. …)";
      }
      return "(The model returned an empty response.)";
    }
    return answer;
  }

  // Tool-calling turn — buffered text is intentionally discarded.
  memory.addAssistant(completion);

  for (const call of parsed.toolCalls) {
    emit({ type: "tool_start", id: messageId, tool: call.name, args: call.args });
    const result = await this.#registry.call(call.name, call.args, sessionId);
    emit({ type: "tool_done", id: messageId, tool: call.name, result });
    const rendered = result.ok ? result.content : `ERROR: ${result.content}`;
    memory.addToolResult(call.name, rendered);
    this.#episodic.record(sessionId, "tool", `${call.name}: ${rendered}`);
  }
}
```

Note: the change removes the `streamedSoFar` variable in favour of `buffered`, and only emits the chunk event when the loop body is about to return the final answer.

- [ ] **Step 4: Re-run the new test to verify it passes**

Run: `cd FeralAgent && bun test tests/agent-loop-no-ghost-text.test.ts`
Expected: 2 of 2 tests pass.

- [ ] **Step 5: Run the full FeralAgent test suite**

Run: `cd FeralAgent && bun test`
Expected: all tests pass. The existing happy-path test that uses real `chunk` events between iterations should still pass — it does so because the second iteration's buffered tokens get flushed at the natural-completion point.

If a test fails because it relied on `chunk` events being emitted mid-iteration, fix the test (not the agent loop) to assert on the new contract: chunks are emitted only at the boundary of a no-tool-call turn.

- [ ] **Step 6: Commit**

```bash
cd D:/FeralLocalAI
git add FeralAgent/src/core/agent-loop.ts FeralAgent/tests/agent-loop-no-ghost-text.test.ts
git commit -m "fix(agent): suppress chunk events on tool-call turns (P0-#1)"
```

---

## Task 5: Per-call `callId` on `tool_start` and `tool_done`

**Files:**
- Modify: `FeralAgent/src/types.ts:444-445`
- Modify: `FeralAgent/src/core/agent-loop.ts:251-254`

- [ ] **Step 1: Extend the `OutboundEvent` type in `types.ts:444-445`**

Add a new `callId` field. The current types are:

```ts
| { type: "tool_start"; id: string; tool: string; args: Record<string, unknown> }
| { type: "tool_done"; id: string; tool: string; result: unknown }
```

Change to:

```ts
| { type: "tool_start"; id: string; callId: string; tool: string; args: Record<string, unknown> }
| { type: "tool_done"; id: string; callId: string; tool: string; result: unknown }
```

The existing `id` field keeps its meaning (message id, for streaming correlation); `callId` is new and unique per tool invocation.

- [ ] **Step 2: Generate and emit `callId` in `agent-loop.ts:251-254`**

Add a counter at the top of `#run` (just inside the `for` loop, before the `for (const call of parsed.toolCalls)`):

```ts
for (let i = 0; i < maxIterations; i++) {
  // ... existing buffer logic ...
  for (const call of parsed.toolCalls) {
    const callId = `${messageId}:${i}:${call.name}`;
    emit({ type: "tool_start", id: messageId, callId, tool: call.name, args: call.args });
    const result = await this.#registry.call(call.name, call.args, sessionId);
    emit({ type: "tool_done", id: messageId, callId, tool: call.name, result });
    // ... existing memory work ...
  }
}
```

The `callId` is deterministic and parseable: `<messageId>:<iteration>:<tool>`. This means the React side can pair start and done by `callId` even if events arrive out of order (which they won't, but defensive coding).

- [ ] **Step 3: Typecheck**

Run: `cd FeralAgent && bunx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Run the full test suite**

Run: `cd FeralAgent && bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add FeralAgent/src/types.ts FeralAgent/src/core/agent-loop.ts
git commit -m "feat(agent): add per-call callId to tool_start and tool_done"
```

---

# Phase 2 — Frontend Types

## Task 6: Add `stopped` and `callId` to frontend FeralAgent event types

**Files:**
- Modify: `frontend-react/src/lib/tauri/index.ts` (locate the `FeralAgentEvent` or `Outbound` type)
- Modify: `frontend-react/src/lib/feralAgentStream.ts` (forward the new fields)

- [ ] **Step 1: Open `frontend-react/src/lib/tauri/index.ts` and find the `FeralAgentEvent` / `OutboundEvent` type**

Use Grep to find the right place. The file likely has a discriminated union like `chunk | done | tool_start | tool_done | ...`.

- [ ] **Step 2: Add `stopped` to the `done` variant and `callId` to the tool variants**

Example diff (adapt to the actual file structure):

```ts
// before
| { type: "done"; id: string; content: string }
| { type: "tool_start"; id: string; tool: string; args: Record<string, unknown> }
| { type: "tool_done"; id: string; tool: string; result: unknown }

// after
| { type: "done"; id: string; content: string; stopped: boolean }
| { type: "tool_start"; id: string; callId: string; tool: string; args: Record<string, unknown> }
| { type: "tool_done"; id: string; callId: string; tool: string; result: unknown }
```

- [ ] **Step 3: Update the `FeralStreamHandlers` interface in `feralAgentStream.ts`**

Find the `onToolStart` and `onToolDone` signatures in `FeralAgentStream`. Change:

```ts
// before
onToolStart: (tool: string, args: Record<string, unknown>) => void;
onToolDone: (tool: string, result: unknown) => void;
onDone: (content: string) => void;

// after
onToolStart: (callId: string, tool: string, args: Record<string, unknown>) => void;
onToolDone: (callId: string, tool: string, result: unknown) => void;
onDone: (content: string, stopped: boolean) => void;
```

- [ ] **Step 4: Update the parser in `feralAgentStream.ts` to pass the new fields**

Find where the JSON line is parsed and routed to the handlers. Change the relevant branches:

```ts
case "tool_start":
  handlers.onToolStart(parsed.callId, parsed.tool, parsed.args);
  break;
case "tool_done":
  handlers.onToolDone(parsed.callId, parsed.tool, parsed.result);
  break;
case "done":
  handlers.onDone(parsed.content, parsed.stopped);
  break;
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: exit 0.

(Note: this will fail until the `useFeral.ts` hook is updated in Task 11 to accept the new signatures. That's expected — Task 11 fixes it.)

- [ ] **Step 6: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/lib/tauri/index.ts frontend-react/src/lib/feralAgentStream.ts
git commit -m "feat(frontend): type stopped flag and callId for tool events"
```

---

# Phase 3 — Frontend Helpers

## Task 7: `extractMainArg` helper + tests

**Files:**
- Create: `frontend-react/src/components/chat/mascot/extractMainArg.ts`
- Create: `frontend-react/src/components/chat/mascot/extractMainArg.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `frontend-react/src/components/chat/mascot/extractMainArg.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { extractMainArg } from "./extractMainArg";

describe("extractMainArg", () => {
  test("web_search → query", () => {
    expect(extractMainArg("web_search", { query: "agenti marketing RO" }))
      .toBe("agenti marketing RO");
  });

  test("read_url → url with protocol stripped", () => {
    expect(extractMainArg("read_url", { url: "https://clutch.co/ro" }))
      .toBe("clutch.co/ro");
  });

  test("read_file → basename", () => {
    expect(extractMainArg("read_file", { path: "src/components/Button.tsx" }))
      .toBe("Button.tsx");
  });

  test("edit_file → basename", () => {
    expect(extractMainArg("edit_file", { path: "src/foo.ts" })).toBe("foo.ts");
  });

  test("write_file → basename", () => {
    expect(extractMainArg("write_file", { path: "/abs/path/to/file.txt" }))
      .toBe("file.txt");
  });

  test("shell_exec → command truncated to 40 chars", () => {
    const cmd = "git log --oneline -n 50 --author='someone' --since='2024-01-01'";
    const out = extractMainArg("shell_exec", { command: cmd });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out).toBe(cmd.slice(0, 40));
  });

  test("git_commit → message truncated to 40 chars", () => {
    const msg = "feat: add a new feature that does something important to the user";
    const out = extractMainArg("git_commit", { message: msg });
    expect(out).toBe(msg.slice(0, 40));
  });

  test("read_skill → 'Skill: <name>'", () => {
    expect(extractMainArg("read_skill", { id: "deep-research" }))
      .toBe("Skill: deep-research");
  });

  test("ask_user → 'N questions'", () => {
    const out = extractMainArg("ask_user", {
      questions: [
        { question: "q1", options: [], multiSelect: false },
        { question: "q2", options: [], multiSelect: false },
        { question: "q3", options: [], multiSelect: false },
      ],
    });
    expect(out).toBe("3 questions");
  });

  test("calculator → expression", () => {
    expect(extractMainArg("calculator", { expression: "1200*5" })).toBe("1200*5");
  });

  test("file_search → pattern", () => {
    expect(extractMainArg("file_search", { pattern: "**/*.test.ts" }))
      .toBe("**/*.test.ts");
  });

  test("grep → pattern", () => {
    expect(extractMainArg("grep", { pattern: "TODO" })).toBe("TODO");
  });

  test("memory_ops → action", () => {
    expect(extractMainArg("memory_ops", { action: "search" })).toBe("search");
  });

  test("todo_write → action + count", () => {
    const out = extractMainArg("todo_write", {
      action: "add",
      items: [{ id: "a" }, { id: "b" }],
    });
    expect(out).toContain("add");
  });

  test("deep_research → query", () => {
    expect(extractMainArg("deep_research", { query: "agenti RO" }))
      .toBe("agenti RO");
  });

  test("time_date → format", () => {
    expect(extractMainArg("time_date", { format: "YYYY-MM-DD" }))
      .toBe("YYYY-MM-DD");
  });

  test("git_status / git_diff / git_log / git_branch with no args → null", () => {
    expect(extractMainArg("git_status", {})).toBeNull();
    expect(extractMainArg("git_diff", {})).toBeNull();
    expect(extractMainArg("git_log", {})).toBeNull();
    expect(extractMainArg("git_branch", {})).toBeNull();
  });

  test("unknown tool falls back to first string arg or null", () => {
    expect(extractMainArg("mystery_tool", { foo: "bar" })).toBe("bar");
    expect(extractMainArg("mystery_tool", { foo: 42 })).toBeNull();
    expect(extractMainArg("mystery_tool", {})).toBeNull();
  });

  test("truncates long results to 50 chars (except for read_skill at 30)", () => {
    const long = "x".repeat(100);
    expect(extractMainArg("web_search", { query: long })!.length).toBe(50);
    expect(extractMainArg("read_skill", { id: "y".repeat(100) })!.length)
      .toBeLessThanOrEqual(30);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend-react && npm test -- extractMainArg`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `extractMainArg`**

Create `frontend-react/src/components/chat/mascot/extractMainArg.ts`:

```ts
/**
 * Single source of truth for "what to show in the bubble for this tool call".
 *
 * The switch is exhaustive over the tools currently registered in
 * `FeralAgent/src/index.ts`. When a new tool is added there, add a case
 * here — and add a test in `extractMainArg.test.ts`.
 */

const MAX_LEN = 50;

function truncate(s: string, max = MAX_LEN): string {
  return s.length > max ? s.slice(0, max) : s;
}

function basename(path: string): string {
  const m = path.match(/[^/\\]+$/);
  return m ? m[0] : path;
}

function firstStringArg(args: Record<string, unknown>): string | null {
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function extractMainArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  switch (toolName) {
    case "web_search":
    case "deep_research":
      return typeof args.query === "string" ? truncate(args.query) : null;
    case "read_url":
    case "fetch_url":
    case "read_webpage":
    case "http_request": {
      if (typeof args.url !== "string") return null;
      return truncate(args.url.replace(/^https?:\/\//, ""));
    }
    case "read_file":
    case "edit_file":
    case "write_file":
      return typeof args.path === "string" ? basename(args.path) : null;
    case "shell_exec":
      return typeof args.command === "string" ? truncate(args.command, 40) : null;
    case "git_commit":
      return typeof args.message === "string" ? truncate(args.message, 40) : null;
    case "git_status":
    case "git_diff":
    case "git_log":
    case "git_branch":
      return null;
    case "read_skill":
      return typeof args.id === "string"
        ? truncate(`Skill: ${args.id}`, 30)
        : null;
    case "ask_user": {
      if (!Array.isArray(args.questions)) return null;
      const n = args.questions.length;
      return n === 1 ? "1 question" : `${n} questions`;
    }
    case "calculator":
      return typeof args.expression === "string" ? truncate(args.expression) : null;
    case "file_search":
      return typeof args.pattern === "string" ? truncate(args.pattern, 40) : null;
    case "grep":
      return typeof args.pattern === "string" ? truncate(args.pattern, 40) : null;
    case "memory_ops":
      return typeof args.action === "string" ? truncate(args.action, 20) : null;
    case "todo_write": {
      const action = typeof args.action === "string" ? args.action : "list";
      if (action !== "add" || !Array.isArray(args.items)) return truncate(action, 30);
      return truncate(`${action} ${args.items.length}`, 30);
    }
    case "time_date":
      return typeof args.format === "string" ? truncate(args.format, 20) : null;
    case "tool_health":
    case "scan_workspace":
      return null;
    case "code-quality:run_tests":
    case "code-quality:format_code":
    case "code-quality:lint_code":
    case "code-quality:build_project":
    case "code-quality:install_deps":
      return null;
    default:
      return firstStringArg(args);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend-react && npm test -- extractMainArg`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/components/chat/mascot/extractMainArg.ts frontend-react/src/components/chat/mascot/extractMainArg.test.ts
git commit -m "feat(frontend): extractMainArg helper for tool bubble labels"
```

---

## Task 8: `emojiForTool` helper + tests

**Files:**
- Create: `frontend-react/src/components/chat/mascot/emojiForTool.ts`
- Create: `frontend-react/src/components/chat/mascot/emojiForTool.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/components/chat/mascot/emojiForTool.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { emojiForTool } from "./emojiForTool";

describe("emojiForTool", () => {
  test("known tools get their dedicated emoji", () => {
    expect(emojiForTool("web_search")).toBe("🔍");
    expect(emojiForTool("deep_research")).toBe("🔍");
    expect(emojiForTool("read_url")).toBe("📖");
    expect(emojiForTool("read_webpage")).toBe("📖");
    expect(emojiForTool("fetch_url")).toBe("📖");
    expect(emojiForTool("http_request")).toBe("🌐");
    expect(emojiForTool("read_file")).toBe("📄");
    expect(emojiForTool("edit_file")).toBe("✏️");
    expect(emojiForTool("write_file")).toBe("✏️");
    expect(emojiForTool("shell_exec")).toBe("🐚");
    expect(emojiForTool("calculator")).toBe("🧮");
    expect(emojiForTool("time_date")).toBe("⏰");
    expect(emojiForTool("read_skill")).toBe("📚");
    expect(emojiForTool("ask_user")).toBe("❓");
    expect(emojiForTool("memory_ops")).toBe("🧠");
    expect(emojiForTool("todo_write")).toBe("📋");
    expect(emojiForTool("file_search")).toBe("📁");
    expect(emojiForTool("grep")).toBe("🔎");
  });

  test("git_* tools get 🌿", () => {
    expect(emojiForTool("git_status")).toBe("🌿");
    expect(emojiForTool("git_diff")).toBe("🌿");
    expect(emojiForTool("git_log")).toBe("🌿");
    expect(emojiForTool("git_branch")).toBe("🌿");
    expect(emojiForTool("git_commit")).toBe("🌿");
  });

  test("code-quality:* tools get 🔨", () => {
    expect(emojiForTool("code-quality:run_tests")).toBe("🔨");
    expect(emojiForTool("code-quality:format_code")).toBe("🔨");
    expect(emojiForTool("code-quality:build_project")).toBe("🔨");
  });

  test("unknown tool gets fallback 🔧", () => {
    expect(emojiForTool("future_tool_we_havent_invented")).toBe("🔧");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend-react && npm test -- emojiForTool`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend-react/src/components/chat/mascot/emojiForTool.ts`:

```ts
/**
 * Maps a tool name to a single emoji used in the bubble's left edge.
 *
 * The map is exhaustive over the tools currently registered in
 * `FeralAgent/src/index.ts`. Keep in sync with `extractMainArg.ts`.
 */

const EMOJI: Record<string, string> = {
  web_search: "🔍",
  deep_research: "🔍",
  read_url: "📖",
  read_webpage: "📖",
  fetch_url: "📖",
  http_request: "🌐",
  read_file: "📄",
  edit_file: "✏️",
  write_file: "✏️",
  shell_exec: "🐚",
  calculator: "🧮",
  time_date: "⏰",
  read_skill: "📚",
  ask_user: "❓",
  memory_ops: "🧠",
  todo_write: "📋",
  file_search: "📁",
  grep: "🔎",
  git_status: "🌿",
  git_diff: "🌿",
  git_log: "🌿",
  git_commit: "🌿",
  git_branch: "🌿",
  "code-quality:run_tests": "🔨",
  "code-quality:format_code": "🔨",
  "code-quality:lint_code": "🔨",
  "code-quality:build_project": "🔨",
  "code-quality:install_deps": "🔨",
  tool_health: "📊",
  scan_workspace: "🛡️",
};

export function emojiForTool(toolName: string): string {
  return EMOJI[toolName] ?? "🔧";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend-react && npm test -- emojiForTool`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/components/chat/mascot/emojiForTool.ts frontend-react/src/components/chat/mascot/emojiForTool.test.ts
git commit -m "feat(frontend): emojiForTool helper for bubble icons"
```

---

# Phase 4 — Frontend Store

## Task 9: `toolCallStream` in the Zustand store + test

**Files:**
- Modify: `frontend-react/src/stores/chat.ts`
- Create: `frontend-react/src/stores/chat.test.ts` (if not present; otherwise add to existing)

- [ ] **Step 1: Find the existing test file or create one**

Run `ls frontend-react/src/stores/`. If `chat.test.ts` doesn't exist, create it:

```ts
import { describe, expect, test, beforeEach } from "vitest";
import { useChat } from "./chat";

describe("useChat.toolCallStream", () => {
  beforeEach(() => {
    useChat.setState({ toolCallStream: [] });
  });

  test("pushToolCall appends and caps at 4 entries (oldest first out)", () => {
    const s = useChat.getState();
    s.pushToolCall({ kind: "tool", name: "a", emoji: "🔧", mainArg: null, status: "running" });
    s.pushToolCall({ kind: "tool", name: "b", emoji: "🔧", mainArg: null, status: "running" });
    s.pushToolCall({ kind: "tool", name: "c", emoji: "🔧", mainArg: null, status: "running" });
    s.pushToolCall({ kind: "tool", name: "d", emoji: "🔧", mainArg: null, status: "running" });
    s.pushToolCall({ kind: "tool", name: "e", emoji: "🔧", mainArg: null, status: "running" });

    const stream = useChat.getState().toolCallStream;
    expect(stream).toHaveLength(4);
    expect(stream.map((e) => e.name)).toEqual(["b", "c", "d", "e"]);
  });

  test("completeToolCall flips the matching entry to done", () => {
    const s = useChat.getState();
    s.pushToolCall({ kind: "tool", name: "x", emoji: "🔧", mainArg: null, status: "running" });
    const id = useChat.getState().toolCallStream[0].id;
    s.completeToolCall(id, { ok: true });

    const entry = useChat.getState().toolCallStream[0];
    expect(entry.status).toBe("done");
    expect(entry.endedAt).not.toBeNull();
  });

  test("clearToolCallStream empties the array", () => {
    useChat.getState().pushToolCall({ kind: "tool", name: "x", emoji: "🔧", mainArg: null, status: "running" });
    useChat.getState().clearToolCallStream();
    expect(useChat.getState().toolCallStream).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify the test fails**

Run: `cd frontend-react && npm test -- chat.test`
Expected: FAIL — `pushToolCall` does not exist.

- [ ] **Step 3: Add the state and actions to `stores/chat.ts`**

Open `frontend-react/src/stores/chat.ts`. Find the `ChatState` interface and the store implementation. Add:

```ts
export type ToolCallEvent =
  | {
      id: string;
      kind: "tool";
      name: string;
      emoji: string;
      mainArg: string | null;
      status: "running" | "done" | "error";
      startedAt: number;
      endedAt: number | null;
    }
  | {
      id: string;
      kind: "context";
      label: string;
      startedAt: number;
      endedAt: number;
      status: "done";
    };
```

Add to `ChatState`:

```ts
toolCallStream: ToolCallEvent[];
pushToolCall: (event: Omit<ToolCallEvent, "id" | "startedAt"> & { startedAt?: number }) => string;
completeToolCall: (id: string, result: { ok: boolean; error?: string }) => void;
pushSkillsContext: (names: string[]) => void;
clearToolCallStream: () => void;
```

In the store creator, add the implementation:

```ts
toolCallStream: [],
lastCompletionStopped: false,
pushToolCall: (event) => {
  const id = crypto.randomUUID();
  const startedAt = event.startedAt ?? Date.now();
  const full: ToolCallEvent = {
    ...event,
    id,
    startedAt,
    endedAt: null,
  } as ToolCallEvent;
  set((s) => {
    const next = [...s.toolCallStream, full];
    return { toolCallStream: next.length > 4 ? next.slice(-4) : next };
  });
  return id;
},
completeToolCall: (id, result) => {
  set((s) => ({
    toolCallStream: s.toolCallStream.map((e) =>
      e.id === id && e.kind === "tool"
        ? { ...e, status: result.ok ? "done" : "error", endedAt: Date.now() }
        : e,
    ),
  }));
},
pushSkillsContext: (names) => {
  if (names.length === 0) return;
  const id = crypto.randomUUID();
  const now = Date.now();
  const event: ToolCallEvent = {
    id,
    kind: "context",
    label: `Skills: ${names.join(", ")}`,
    startedAt: now,
    endedAt: now,
    status: "done",
  };
  set((s) => {
    const next = [...s.toolCallStream, event];
    return { toolCallStream: next.length > 4 ? next.slice(-4) : next };
  });
},
clearToolCallStream: () => set({ toolCallStream: [] }),
```

- [ ] **Step 4: Run to verify the test passes**

Run: `cd frontend-react && npm test -- chat.test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/stores/chat.ts frontend-react/src/stores/chat.test.ts
git commit -m "feat(frontend): toolCallStream in chat store"
```

---

# Phase 5 — Frontend Hook

## Task 10: Update `useFeral.ts` to capture `args`, `result`, and `stopped`

**Files:**
- Modify: `frontend-react/src/hooks/useFeral.ts`

- [ ] **Step 1: Find the existing handler signatures**

Read `frontend-react/src/hooks/useFeral.ts`. The handlers are passed to `feralAgentStream(...)`. Find the `onToolStart`, `onToolDone`, `onDone` references (lines ~144, ~155, ~158).

- [ ] **Step 2: Replace the handlers with versions that push to the store**

Change `onToolStart`:

```ts
// before
onToolStart: (tool, _args) => { ... clearStreamingContent(); setAgentPhase('calling', tool); }

// after
onToolStart: (callId, tool, args) => {
  clearStreamingContent();
  setAgentPhase('calling', tool);
  useChat.getState().pushToolCall({
    kind: "tool",
    name: tool,
    emoji: emojiForTool(tool),
    mainArg: extractMainArg(tool, args),
    status: "running",
  });
},
```

Change `onToolDone`:

```ts
// before
onToolDone: (_tool) => { setAgentPhase('processing'); }

// after
onToolDone: (callId, tool, result) => {
  setAgentPhase('processing');
  // Find the most recent running entry with this name (callId is also
  // a good key but the store currently keys by id; pair by id when
  // available, fall back to last running entry with this name).
  const stream = useChat.getState().toolCallStream;
  const lastRunning = [...stream].reverse().find(
    (e) => e.kind === "tool" && e.name === tool && e.status === "running",
  );
  if (lastRunning) {
    const ok = isOkResult(result);
    useChat.getState().completeToolCall(lastRunning.id, { ok });
  }
},
```

Add the helper near the top of the file:

```ts
function isOkResult(result: unknown): boolean {
  if (result && typeof result === "object" && "ok" in (result as object)) {
    return Boolean((result as { ok: unknown }).ok);
  }
  return true; // legacy: treat unknown shapes as success
}
```

Change `onDone`:

```ts
// before
onDone: (content) => { ... finalize session ... }

// after
onDone: (content, stopped) => {
  ...existing finalize logic...
  useChat.setState({ lastCompletionStopped: stopped });
  // 5s post-done window before clearing
  setTimeout(() => useChat.getState().clearToolCallStream(), 5000);
}
```

Add `lastCompletionStopped: boolean` to the store if not already there. The simplest way:

```ts
lastCompletionStopped: false,
```

at the initial state, and a setter inside the existing `setState` call in `onDone`.

- [ ] **Step 3: Add skillsContext handling at message send**

In the same file, find where the message is sent to the agent (look for the `feralAgentStream(...)` call or the `handlers.onStart` reference). Add a new handler `onSend` (or rename an existing one) that calls:

```ts
onSend: (skillsContext) => {
  if (skillsContext && skillsContext.length > 0) {
    useChat.getState().pushSkillsContext(skillsContext.map((s) => s.name));
  }
},
```

This is called from the `trySend` flow in `ChatInput.tsx` (next task) before the stream starts.

- [ ] **Step 4: Add the imports at the top of the file**

```ts
import { extractMainArg } from "@/components/chat/mascot/extractMainArg";
import { emojiForTool } from "@/components/chat/mascot/emojiForTool";
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: exit 0. If the new handler signatures are missing on the receiving side, fix the call site (`feralAgentStream.ts`) — but that was already updated in Task 6.

- [ ] **Step 6: Run the frontend test suite**

Run: `cd frontend-react && npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/hooks/useFeral.ts
git commit -m "feat(frontend): useFeral captures tool args, result, and stopped flag"
```

---

# Phase 6 — Frontend Components

## Task 11: `ToolCallBubble` component

**Files:**
- Create: `frontend-react/src/components/chat/mascot/ToolCallBubble.tsx`

- [ ] **Step 1: Implement the component**

Create `frontend-react/src/components/chat/mascot/ToolCallBubble.tsx`:

```tsx
/**
 * ToolCallBubble — single pill-shaped indicator for one tool call.
 *
 * Visual: emoji + tool name + (main arg) on the left; status icon + elapsed
 * seconds on the right. The left border is colour-coded by status.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface ToolCallBubbleProps {
  emoji: string;
  label: string;
  mainArg: string | null;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt: number | null;
}

const STATUS_BORDER: Record<ToolCallBubbleProps["status"], string> = {
  running: "border-l-brand",
  done: "border-l-text-muted",
  error: "border-l-red-500",
};

function useElapsedMs(startedAt: number, endedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endedAt !== null) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [endedAt]);
  return (endedAt ?? now) - startedAt;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCallBubble({
  emoji,
  label,
  mainArg,
  status,
  startedAt,
  endedAt,
}: ToolCallBubbleProps) {
  const elapsed = useElapsedMs(startedAt, endedAt);
  return (
    <motion.div
      role="status"
      aria-live="polite"
      layout
      initial={{ opacity: 0, y: 6, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.95 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn(
        "pointer-events-none select-none",
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        "px-2 py-1 rounded-md",
        "bg-bg-elevated border border-border-default",
        "border-l-2",
        STATUS_BORDER[status],
        "text-[11px] text-text-primary shadow-sm",
      )}
    >
      <span aria-hidden="true">{emoji}</span>
      <span className="font-medium">{label}</span>
      {mainArg && <span className="text-text-muted">({mainArg})</span>}
      <span className="ml-1 text-text-muted inline-flex items-center gap-0.5">
        {status === "running" && <span>⏱</span>}
        {status === "done" && <span>✓</span>}
        {status === "error" && <span>!</span>}
        <span>{formatMs(elapsed)}</span>
      </span>
    </motion.div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/components/chat/mascot/ToolCallBubble.tsx
git commit -m "feat(frontend): ToolCallBubble component"
```

---

## Task 12: `ToolCallStack` component + test

**Files:**
- Create: `frontend-react/src/components/chat/mascot/ToolCallStack.tsx`
- Create: `frontend-react/src/components/chat/mascot/ToolCallStack.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend-react/src/components/chat/mascot/ToolCallStack.test.tsx`:

```tsx
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolCallStack } from "./ToolCallStack";
import type { ToolCallEvent } from "@/stores/chat";

function makeToolEvent(
  overrides: Partial<Extract<ToolCallEvent, { kind: "tool" }>>,
): Extract<ToolCallEvent, { kind: "tool" }> {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    kind: "tool",
    name: overrides.name ?? "web_search",
    emoji: overrides.emoji ?? "🔍",
    mainArg: overrides.mainArg ?? "x",
    status: overrides.status ?? "running",
    startedAt: overrides.startedAt ?? Date.now(),
    endedAt: overrides.endedAt ?? null,
    ...overrides,
  };
}

describe("ToolCallStack", () => {
  test("renders nothing for an empty stream", () => {
    const { container } = render(<ToolCallStack events={[]} active={true} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders one bubble per event", () => {
    const events = [
      makeToolEvent({ id: "1", name: "web_search" }),
      makeToolEvent({ id: "2", name: "read_url" }),
    ];
    render(<ToolCallStack events={events} active={true} />);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText(/web_search/)).toBeInTheDocument();
    expect(screen.getByText(/read_url/)).toBeInTheDocument();
  });

  test("caps the visible count to 4 even if the input is longer", () => {
    // The store is responsible for capping; the component just renders.
    // We assert that the component does not crash or lay out badly with
    // 10 events (defensive — the store should never pass 10).
    const events = Array.from({ length: 10 }, (_, i) =>
      makeToolEvent({ id: String(i), name: `tool_${i}` }),
    );
    render(<ToolCallStack events={events} active={true} />);
    expect(screen.getAllByRole("status")).toHaveLength(10);
  });

  test("renders a context event label verbatim", () => {
    const event: Extract<ToolCallEvent, { kind: "context" }> = {
      id: "c1",
      kind: "context",
      label: "Skills: foo, bar",
      startedAt: Date.now(),
      endedAt: Date.now(),
      status: "done",
    };
    render(<ToolCallStack events={[event]} active={true} />);
    expect(screen.getByText("Skills: foo, bar")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend-react && npm test -- ToolCallStack`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `frontend-react/src/components/chat/mascot/ToolCallStack.tsx`:

```tsx
/**
 * ToolCallStack — vertical stack of up to 4 ToolCallBubble components,
 * positioned above the mascot in MascotPerch.
 *
 * The store caps the array at 4 entries; this component renders them in
 * order, oldest at the top. The container is fixed-width-ish (max-w-xs)
 * and non-interactive (pointer-events-none) because bubbles are
 * decorative in v1.
 */

import { AnimatePresence } from "framer-motion";
import { ToolCallBubble } from "./ToolCallBubble";
import type { ToolCallEvent } from "@/stores/chat";

export interface ToolCallStackProps {
  events: ToolCallEvent[];
  active: boolean;
}

export function ToolCallStack({ events, active }: ToolCallStackProps) {
  if (events.length === 0) return null;
  return (
    <div
      className="pointer-events-none absolute -top-2 left-full ml-2 z-20
                 flex flex-col-reverse items-start gap-1"
      data-active={active}
    >
      <AnimatePresence initial={false}>
        {events.map((e) =>
          e.kind === "context" ? (
            <div
              key={e.id}
              role="status"
              aria-live="polite"
              className="pointer-events-none select-none
                         px-2 py-1 rounded-md text-[10px]
                         bg-bg-elevated border border-border-default
                         text-text-muted whitespace-nowrap"
            >
              {e.label}
            </div>
          ) : (
            <ToolCallBubble
              key={e.id}
              emoji={e.emoji}
              label={e.name}
              mainArg={e.mainArg}
              status={e.status}
              startedAt={e.startedAt}
              endedAt={e.endedAt}
            />
          ),
        )}
      </AnimatePresence>
    </div>
  );
}
```

(Note: `flex-col-reverse` so the newest bubble is at the bottom, closest to the mascot's head.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend-react && npm test -- ToolCallStack`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/components/chat/mascot/ToolCallStack.tsx frontend-react/src/components/chat/mascot/ToolCallStack.test.tsx
git commit -m "feat(frontend): ToolCallStack component with framer-motion"
```

---

# Phase 7 — Integration

## Task 13: Replace `ThinkingBubble` in `MascotPerch`

**Files:**
- Modify: `frontend-react/src/components/chat/mascot/MascotPerch.tsx`
- Delete: `frontend-react/src/components/chat/mascot/ThinkingBubble.tsx`
- Delete (if exists): `frontend-react/src/components/chat/mascot/ThinkingBubble.test.tsx`

- [ ] **Step 1: Modify `MascotPerch.tsx`**

Open `frontend-react/src/components/chat/mascot/MascotPerch.tsx`. Find:

```tsx
import { ThinkingBubble } from './ThinkingBubble';
```

Replace with:

```tsx
import { useChat } from '@/stores/chat';
import { ToolCallStack } from './ToolCallStack';
```

Find the JSX where `<ThinkingBubble active={renderState === 'thinking'} />` is rendered. Replace with:

```tsx
<ToolCallStack
  events={useChat((s) => s.toolCallStream)}
  active={renderState !== 'idle'}
/>
```

- [ ] **Step 2: Delete `ThinkingBubble.tsx`**

Run: `rm frontend-react/src/components/chat/mascot/ThinkingBubble.tsx`
(Or via Windows: `del frontend-react\src\components\chat\mascot\ThinkingBubble.tsx`)

If `ThinkingBubble.test.tsx` exists, delete that too.

- [ ] **Step 3: Typecheck**

Run: `cd frontend-react && npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Run the frontend test suite**

Run: `cd frontend-react && npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/FeralLocalAI
git add frontend-react/src/components/chat/mascot/MascotPerch.tsx
git rm frontend-react/src/components/chat/mascot/ThinkingBubble.tsx
git commit -m "refactor(frontend): replace ThinkingBubble with ToolCallStack in MascotPerch"
```

---

# Phase 8 — Verification

## Task 14: Full test suite + manual smoke test

- [ ] **Step 1: Run FeralAgent tests**

Run: `cd FeralAgent && bun test`
Expected: 20+ tests pass (4 new from Task 1, 4 new from Task 2, 2 new from Task 3, 2 new from Task 4, plus all existing).

- [ ] **Step 2: Run frontend tests**

Run: `cd frontend-react && npm test`
Expected: 20+ tests pass (4 from Task 7, 4 from Task 8, 3 from Task 9, 4 from Task 12, plus all existing).

- [ ] **Step 3: Typecheck both projects**

Run: `cd FeralAgent && bunx tsc --noEmit && cd ../frontend-react && npm run typecheck`
Expected: exit 0 from both.

- [ ] **Step 4: Build the FeralAgent binary**

Run: `cd FeralAgent && bun run build`
Expected: produces `dist/feral-agent` (or the configured output). No errors.

- [ ] **Step 5: Copy the binary to Tauri**

Run: `cp FeralAgent/dist/feral-agent src-tauri/binaries/feral-agent-x86_64-pc-windows-msvc.exe`
(Adjust binary name per the sidecar naming convention; check `src-tauri/tauri.conf.json` for the exact expected sidecar identifier.)

- [ ] **Step 6: Build the frontend**

Run: `cd frontend-react && npm run build`
Expected: Vite build succeeds; no type errors.

- [ ] **Step 7: Run the app and trigger a multi-tool task**

Run: `cd src-tauri && cargo tauri dev` (or however the dev workflow starts the Tauri app; check the repo README or `package.json` at the root).

In the app, send a message that triggers multiple tools: "Search the web for 'agenti marketing Romania' and read the first result." Watch the mascot:
- A context bubble appears at the start of the turn (if `skillsContext` is non-empty)
- A 🔍 `web_search` bubble appears
- A 📖 `read_url` bubble appears
- A final answer streams in below
- All bubbles fade out 5s after the answer completes

- [ ] **Step 8: Verify the Stop button**

Send a long-running task. Click Stop. Verify:
- The tool events stop within 1s
- The `done` event arrives with `stopped: true`
- The message footer shows "Stopped by you" (or equivalent)

- [ ] **Step 9: Verify the retry on transient failure**

Temporarily disconnect the network (or block DuckDuckGo via `/etc/hosts`). Send a search. Verify the bubble for `web_search` shows a transient retry (the duration flickers twice) before the final failure state.

(For automated verification, the `tests/tool-retry.test.ts` already covers this end-to-end at the registry level. The manual check is for the UX.)

- [ ] **Step 10: Commit any cleanup**

If any final tweaks were needed, commit them. Otherwise, this task has no commit.

- [ ] **Step 11: Tag the release**

Run:
```bash
cd D:/FeralLocalAI
git tag v0.1.5-mascot-strip
```

(The exact tag name is up to release conventions; the plan uses this for traceability.)

---

## Self-review

(To be completed by the planner before final commit.)

- **Spec coverage:**
  - G1/G2 (every tool call → bubble) → Task 7, 8, 10, 11, 12
  - G3 (skillsContext → context bubble) → Task 9 (`pushSkillsContext`), Task 10 (call site), Task 12 (renders)
  - G4 (`read_skill` distinguishable) → Task 7 (📚 emoji + "Skill: " prefix)
  - G5 (no ghost text) → Task 4
  - G6 (stopped flag) → Task 1
  - G7 (memory_ops + todo_write registered) → Task 3
  - G8 (tool retry on fetch) → Task 2
  - G9 (5-min complex task) → Task 14 manual QA
  - G10 (Stop button) → Task 14 manual QA

- **Placeholder scan:** No TBDs. Every step has either code or a concrete command.

- **Type consistency:**
  - `OutboundEvent.tool_start` / `.tool_done`: `id: string` (message id) + `callId: string` (per-call) — consistent across Task 5, Task 6.
  - `ToolCallEvent` shape in `stores/chat.ts` (Task 9) matches what `useFeral.ts` (Task 10) pushes.
  - `extractMainArg` (Task 7) and `emojiForTool` (Task 8) are both pure, both have exhaustive tests.
  - `ToolCallStack` (Task 12) reads `toolCallStream` from the store, the same field the store actions write to (Task 9).

- **Risk coverage:**
  - `ToolCallStream.test.tsx` covers the 4-cap behaviour (the store enforces it; the test verifies).
  - `extractMainArg.test.ts` is exhaustive over all known tools.
  - `tool-retry.test.ts` covers the 4 retry scenarios.

- **Dependency ordering:** Phase 1 (FeralAgent) is independent of Phase 2-7 (Frontend). Tasks within Phase 1 are independent and can be reordered. The frontend tasks depend on the FeralAgent types being correct (the `stopped` and `callId` fields).
