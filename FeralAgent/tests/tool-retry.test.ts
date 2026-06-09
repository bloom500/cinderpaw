/**
 * P0-#5: tool retry on transient fetch failures.
 *
 * The registry should retry tools that opted into `manifest.retry` when
 * the error matches one of the configured kinds. Default behaviour
 * (no retry manifest) is unchanged.
 *
 * The error categories the registry understands:
 *   - "http"     → tool returned { ok: false, error: "http_error" } or "network_error"
 *   - "process"  → tool.execute threw (ProcessSandbox errors, etc.)
 *   - "any"      → retry on any non-ok result or thrown error
 *
 * The test uses simple stub tools so we don't need a real network or process.
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

describe("ToolRegistry retry policy (P0-#5)", () => {
  test("does NOT retry by default (manifest.retry absent)", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: makeBaseManifest("t_default"),
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: "transient failure", error: "http_error" } satisfies ToolResult;
      },
    };
    registry.register(tool);
    const result = await registry.call("t_default", {}, "s1");
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    db.close();
  });

  test("retries once on 'http' error when manifest.retry.attempts=1", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_retry_http"),
        retry: { attempts: 1, on: ["http"] },
      },
      parameters: {},
      async execute() {
        calls++;
        if (calls === 1) {
          return { ok: false, content: "boom", error: "http_error" };
        }
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_retry_http", {}, "s1");
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("ok");
    db.close();
  });

  test("retries once on thrown error when on includes 'process'", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_retry_throw"),
        retry: { attempts: 1, on: ["process"] },
      },
      parameters: {},
      async execute() {
        calls++;
        if (calls === 1) throw new Error("transient spawn failure");
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_retry_throw", {}, "s1");
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    db.close();
  });

  test("does NOT retry when error kind is not in manifest.retry.on", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_no_retry"),
        retry: { attempts: 1, on: ["http"] },
      },
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: "bad args", error: "bad_args" };
      },
    };
    registry.register(tool);
    await registry.call("t_no_retry", {}, "s1");
    expect(calls).toBe(1);
    db.close();
  });

  test("does NOT retry thrown errors when on only lists 'http'", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_throw_only_http"),
        retry: { attempts: 1, on: ["http"] },
      },
      parameters: {},
      async execute() {
        calls++;
        throw new Error("boom");
      },
    };
    registry.register(tool);
    await registry.call("t_throw_only_http", {}, "s1");
    expect(calls).toBe(1);
    db.close();
  });

  test("gives up after attempts and returns the last error", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_exhaust"),
        retry: { attempts: 2, on: ["http"] },
      },
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: `fail #${calls}`, error: "http_error" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_exhaust", {}, "s1");
    expect(calls).toBe(3); // initial + 2 retries
    expect(result.ok).toBe(false);
    expect(result.content).toBe("fail #3");
    db.close();
  });

  test("'any' category retries both http and process errors", async () => {
    const { registry, db } = newRegistry();
    let calls = 0;
    const tool: Tool = {
      manifest: {
        ...makeBaseManifest("t_any"),
        retry: { attempts: 1, on: ["any"] },
      },
      parameters: {},
      async execute() {
        calls++;
        if (calls === 1) throw new Error("first attempt boom");
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);
    const result = await registry.call("t_any", {}, "s1");
    expect(calls).toBe(2);
    expect(result.ok).toBe(true);
    db.close();
  });
});
