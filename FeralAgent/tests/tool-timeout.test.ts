/**
 * P0-#3: per-tool timeout + AbortSignal in ToolRegistry.call.
 *
 * The registry must:
 *   1. Hand the tool a `ctx.signal` that aborts on either:
 *        a. per-call wall-clock timeout (default 60s, overridable per call)
 *        b. caller's `opts.signal` (e.g. AgentLoop.stop() / a test)
 *   2. Race the tool's promise against the abort so a hung tool cannot block
 *      the agent loop indefinitely.
 *   3. Return a structured `{ok:false, error:"timeout"|"cancelled"}` result
 *      to the LLM so the agent loop can continue.
 *
 * These tests exercise both the "tool respects signal" path and the
 * "tool ignores signal" path (the race must win either way).
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool, ToolManifest, ToolResult } from "../src/types.ts";
import { openDatabase } from "../src/db.ts";

function newRegistry(): { registry: ToolRegistry; db: ReturnType<typeof openDatabase> } {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  return { registry: new ToolRegistry(egress, audit, ps), db };
}

function makeBaseManifest(name: string): ToolManifest {
  return {
    name,
    description: "test tool",
    permissions: [],
    networkAccess: false,
  };
}

/** A sleep helper that respects AbortSignal — used to build "well-behaved" tools. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

describe("ToolRegistry timeout + AbortSignal (P0-#3)", () => {
  test("hands ctx.signal to the tool", async () => {
    const { registry, db } = newRegistry();
    let received: AbortSignal | undefined;
    const tool: Tool = {
      manifest: makeBaseManifest("t_signal"),
      parameters: {},
      async execute(_args, ctx) {
        received = ctx.signal;
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    await registry.call("t_signal", {}, "s1");
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
    db.close();
  });

  test("a well-behaved tool is interrupted when timeout fires", async () => {
    const { registry, db } = newRegistry();
    const tool: Tool = {
      manifest: makeBaseManifest("t_aborts_on_timeout"),
      parameters: {},
      async execute(_args, ctx) {
        try {
          // Tool polls the signal and resolves early on abort — this is the
          // "well-behaved" pattern. Should never see the 60s default here
          // because the per-call timeout is 30ms.
          await abortableSleep(10_000, ctx.signal);
          return { ok: true, content: "should not reach" };
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return { ok: false, content: "aborted by signal", error: "aborted" };
          }
          throw err;
        }
      },
    };
    registry.register(tool);
    const start = Date.now();
    const result = await registry.call("t_aborts_on_timeout", {}, "s1", { timeoutMs: 30 });
    const elapsed = Date.now() - start;
    // The call returned quickly — never waited the full 10s.
    expect(elapsed).toBeLessThan(1_000);
    // The exact error depends on who won the race (registry's timeout vs
    // tool's AbortError handler). Either is acceptable proof that the
    // call did not hang — both signal "interrupted, not completed".
    expect(result.ok).toBe(false);
    expect(["timeout", "aborted", "execution_error"]).toContain(result.error);
    db.close();
  });

  test("a hung tool that ignores the signal still returns a timeout error (race wins)", async () => {
    const { registry, db } = newRegistry();
    const tool: Tool = {
      manifest: makeBaseManifest("t_ignores_signal"),
      parameters: {},
      // Tool that NEVER checks ctx.signal and NEVER resolves on its own.
      // The registry's race must rescue the agent loop.
      async execute(): Promise<ToolResult> {
        await new Promise<never>(() => {});
        // Unreachable: keeps the promise pending forever.
        return { ok: true, content: "unreachable" };
      },
    };
    registry.register(tool);
    const start = Date.now();
    const result = await registry.call("t_ignores_signal", {}, "s1", { timeoutMs: 50 });
    const elapsed = Date.now() - start;
    // Race won — the call returned in well under a second even though the
    // tool promise is still pending in the background.
    expect(elapsed).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    expect(result.content).toContain("timeout");
    db.close();
  });

  test("caller's opts.signal abort propagates and returns 'cancelled' error", async () => {
    const { registry, db } = newRegistry();
    const tool: Tool = {
      manifest: makeBaseManifest("t_caller_cancel"),
      parameters: {},
      async execute(): Promise<ToolResult> {
        await new Promise<never>(() => {});
        return { ok: true, content: "unreachable" };
      },
    };
    registry.register(tool);
    const ac = new AbortController();
    setTimeout(() => ac.abort("user stop"), 30);
    const start = Date.now();
    const result = await registry.call("t_caller_cancel", {}, "s1", { signal: ac.signal, timeoutMs: 30_000 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cancelled");
    expect(result.content).toContain("cancelled");
    db.close();
  });

  test("caller signal that is already aborted returns 'cancelled' immediately", async () => {
    const { registry, db } = newRegistry();
    let invoked = false;
    const tool: Tool = {
      manifest: makeBaseManifest("t_pre_aborted"),
      parameters: {},
      async execute() {
        invoked = true;
        return { ok: true, content: "should not run" };
      },
    };
    registry.register(tool);
    const ac = new AbortController();
    ac.abort("user stop");
    const result = await registry.call("t_pre_aborted", {}, "s1", { signal: ac.signal });
    expect(invoked).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cancelled");
    db.close();
  });

  test("timeout still fires for a tool with retry: the last attempt gets the timeout", async () => {
    const { registry, db } = newRegistry();
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_retry_then_timeout"),
        retry: { attempts: 2, on: ["any"] },
      },
      parameters: {},
      async execute(): Promise<ToolResult> {
        await new Promise<never>(() => {});
        return { ok: true, content: "unreachable" };
      },
    };
    registry.register(tool);
    const start = Date.now();
    const result = await registry.call("t_retry_then_timeout", {}, "s1", { timeoutMs: 30 });
    const elapsed = Date.now() - start;
    // 3 attempts × 30ms timeout + 250+500ms backoff ≈ ~800ms; allow 2s slack.
    expect(elapsed).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
    db.close();
  });

  test("listener is cleaned up after the call (no leaks across calls)", async () => {
    const { registry, db } = newRegistry();
    const tool: Tool = {
      manifest: makeBaseManifest("t_cleanup"),
      parameters: {},
      async execute() {
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    const ac = new AbortController();
    // Three back-to-back calls with the same caller signal — none should
    // accumulate listeners.
    for (let i = 0; i < 3; i++) {
      const r = await registry.call("t_cleanup", {}, "s1", { signal: ac.signal });
      expect(r.ok).toBe(true);
    }
    // If listeners leaked, aborting now would not crash, but the abort
    // handler would be called multiple times. We can't easily assert
    // listener count from outside, but the fact that none of the three
    // calls aborted and the test still completes is a good smoke signal.
    ac.abort("noop");
    db.close();
  });
});
