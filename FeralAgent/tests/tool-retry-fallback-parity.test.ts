/**
 * Pre-release hardening (2026-07-31) — regression tests for two defects where the
 * registry's RETRY path and its FAST path disagree about the post-execution
 * pipeline.
 *
 * `ToolRegistry.call()` has two shapes:
 *   - fast path  (no `manifest.retry`)  → execute → after_tool_call hook → fallback chain
 *   - retry path (`manifest.retry` set) → execute → [early returns] → ... → hook → fallback
 *
 * The retry path's early returns (success, and non-retryable failure) bypass both
 * the `after_tool_call` hook and `#tryFallbackChain`. Only the "retries fully
 * exhausted" tail runs them.
 *
 * R1 — `src/types.ts` documents `manifest.fallback` as "tried when this tool returns
 *      a NON-RETRYABLE failure". That is exactly the case the retry path skips, so a
 *      tool declaring both `retry` and `fallback` never fails over.
 *
 * R2 — `after_tool_call` is documented as informational-but-always-run. A tool with a
 *      retry policy that SUCCEEDS never fires it, so audit/telemetry handlers silently
 *      miss those calls.
 *
 * Both are cross-path parity bugs: the observable behaviour of a tool must not depend
 * on whether it happens to declare a retry policy.
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EgressProxy } from "../src/egress/egress-proxy.ts";
import { RealProcessSandbox } from "../src/egress/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import type { Tool, ToolManifest } from "../src/types.ts";
import { openDatabase } from "../src/db.ts";

function newRegistry(hooks?: HookRegistry) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  const registry = new ToolRegistry(
    egress,
    audit,
    ps,
    undefined,
    undefined,
    undefined,
    hooks,
  );
  return { registry, db };
}

function manifest(name: string, extra: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name,
    description: "test tool",
    permissions: [],
    networkAccess: false,
    ...extra,
  } as ToolManifest;
}

/** A tool that always fails with a NON-retryable error code. */
function failingTool(name: string, extra: Partial<ToolManifest> = {}): Tool {
  return {
    manifest: manifest(name, extra),
    parameters: {},
    execute: async () => ({ ok: false, content: "primary is down", error: "not_found" }),
  } as Tool;
}

function okTool(name: string, content: string, extra: Partial<ToolManifest> = {}): Tool {
  return {
    manifest: manifest(name, extra),
    parameters: {},
    execute: async () => ({ ok: true, content }),
  } as Tool;
}

describe("R1: fallback chain must run regardless of retry policy", () => {
  test("control — tool WITHOUT a retry policy fails over to its fallback", async () => {
    const { registry, db } = newRegistry();
    registry.register(failingTool("r1_plain", { fallback: ["r1_plain_backup"] }));
    registry.register(okTool("r1_plain_backup", "served by backup"));

    const result = await registry.call("r1_plain", {}, "s1");

    expect(result.ok).toBe(true);
    expect(result.content).toBe("served by backup");
    db.close();
  });

  test("tool WITH a retry policy also fails over on a non-retryable failure", async () => {
    const { registry, db } = newRegistry();
    // `on: ["http"]` + error `not_found` → non-retryable, so the retry loop
    // returns immediately. The fallback must still be attempted.
    registry.register(
      failingTool("r1_retry", {
        fallback: ["r1_retry_backup"],
        retry: { attempts: 2, on: ["http"] },
      }),
    );
    registry.register(okTool("r1_retry_backup", "served by backup"));

    const result = await registry.call("r1_retry", {}, "s1");

    expect(result.ok).toBe(true);
    expect(result.content).toBe("served by backup");
    db.close();
  });

  test("fallback still runs after retries are genuinely exhausted", async () => {
    const { registry, db } = newRegistry();
    let attempts = 0;
    registry.register({
      manifest: manifest("r1_exhaust", {
        fallback: ["r1_exhaust_backup"],
        retry: { attempts: 1, on: ["http"] },
      }),
      parameters: {},
      execute: async () => {
        attempts++;
        return { ok: false, content: "502", error: "http_error" };
      },
    } as Tool);
    registry.register(okTool("r1_exhaust_backup", "served by backup"));

    const result = await registry.call("r1_exhaust", {}, "s1");

    expect(attempts).toBe(2); // initial + 1 retry
    expect(result.ok).toBe(true);
    expect(result.content).toBe("served by backup");
    db.close();
  });
});

describe("R2: after_tool_call must fire on every completed call", () => {
  test("control — hook fires for a succeeding tool with no retry policy", async () => {
    const hooks = new HookRegistry();
    const fired: string[] = [];
    hooks.on("after_tool_call", (p) => {
      fired.push(p.tool);
      return {};
    });
    const { registry, db } = newRegistry(hooks);
    registry.register(okTool("r2_plain", "fine"));

    await registry.call("r2_plain", {}, "s1");

    expect(fired).toEqual(["r2_plain"]);
    db.close();
  });

  test("hook fires for a succeeding tool that declares a retry policy", async () => {
    const hooks = new HookRegistry();
    const fired: string[] = [];
    hooks.on("after_tool_call", (p) => {
      fired.push(p.tool);
      return {};
    });
    const { registry, db } = newRegistry(hooks);
    registry.register(okTool("r2_retry", "fine", { retry: { attempts: 2, on: ["http"] } }));

    await registry.call("r2_retry", {}, "s1");

    expect(fired).toEqual(["r2_retry"]);
    db.close();
  });

  test("hook fires for a non-retryable failure under a retry policy", async () => {
    const hooks = new HookRegistry();
    const seen: Array<{ tool: string; ok: boolean }> = [];
    hooks.on("after_tool_call", (p) => {
      seen.push({ tool: p.tool, ok: p.result.ok });
      return {};
    });
    const { registry, db } = newRegistry(hooks);
    registry.register(failingTool("r2_retry_fail", { retry: { attempts: 2, on: ["http"] } }));

    await registry.call("r2_retry_fail", {}, "s1");

    expect(seen).toEqual([{ tool: "r2_retry_fail", ok: false }]);
    db.close();
  });
});
