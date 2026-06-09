/**
 * P2-#2: per-tool circuit breaker.
 *
 * After `failureThreshold` consecutive failures in `windowMs`, the
 * breaker trips and short-circuits subsequent calls with a structured
 * `circuit_open` error. After `cooldownMs`, a single probe is allowed
 * (HALF_OPEN). A successful probe resets the breaker; a failed probe
 * re-opens it.
 */

import { describe, expect, test } from "bun:test";
import { AuditLog } from "../src/sandbox/audit-log.ts";
import { CircuitBreaker } from "../src/sandbox/circuit-breaker.ts";
import { EgressProxy } from "../src/sandbox/egress-proxy.ts";
import { RealProcessSandbox } from "../src/sandbox/process-sandbox.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool, ToolManifest, ToolResult } from "../src/types.ts";
import { openDatabase } from "../src/db.ts";

const BUDGET = { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" as const };

function newRegistryWithBreaker(opts: { failureThreshold?: number; windowMs?: number; cooldownMs?: number } = {}): {
  registry: ToolRegistry;
  breaker: CircuitBreaker;
  db: ReturnType<typeof openDatabase>;
} {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const egress = new EgressProxy(audit.logger);
  const ps = new RealProcessSandbox(audit.logger);
  const breaker = new CircuitBreaker(opts);
  const registry = new ToolRegistry(egress, audit, ps, undefined, undefined, breaker);
  return { registry, breaker, db };
}

function makeBaseManifest(name: string): ToolManifest {
  return { name, description: "test", permissions: [], networkAccess: false };
}

describe("CircuitBreaker (P2-#2)", () => {
  test("starts CLOSED for unseen tools", () => {
    const { breaker, db } = newRegistryWithBreaker();
    expect(breaker.stateOf("any-tool")).toBe("closed");
    expect(breaker.failureCount("any-tool")).toBe(0);
    db.close();
  });

  test("trips OPEN after failureThreshold consecutive failures", () => {
    const { breaker, db } = newRegistryWithBreaker({ failureThreshold: 3 });
    breaker.recordFailure("a");
    expect(breaker.stateOf("a")).toBe("closed");
    breaker.recordFailure("a");
    expect(breaker.stateOf("a")).toBe("closed");
    breaker.recordFailure("a");
    expect(breaker.stateOf("a")).toBe("open");
    expect(breaker.failureCount("a")).toBe(3);
    db.close();
  });

  test("OPEN check returns allow:false with a clear reason", () => {
    const { breaker, db } = newRegistryWithBreaker({ failureThreshold: 1 });
    breaker.recordFailure("a");
    const check = breaker.check("a");
    expect(check.allow).toBe(false);
    expect(check.state).toBe("open");
    expect(check.reason).toMatch(/circuit_open/);
    db.close();
  });

  test("successes RESET the failure log", () => {
    const { breaker, db } = newRegistryWithBreaker({ failureThreshold: 3 });
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    expect(breaker.failureCount("a")).toBe(2);
    breaker.recordSuccess("a");
    expect(breaker.failureCount("a")).toBe(0);
    // Need 3 MORE failures to trip now.
    breaker.recordFailure("a");
    expect(breaker.stateOf("a")).toBe("closed");
    db.close();
  });

  test("HALF_OPEN allows ONE probe after cooldownMs elapses", async () => {
    const { breaker, db } = newRegistryWithBreaker({ failureThreshold: 1, cooldownMs: 30 });
    breaker.recordFailure("a");
    expect(breaker.check("a").allow).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    const probe = breaker.check("a");
    expect(probe.allow).toBe(true);
    expect(probe.state).toBe("half_open");
    // A second concurrent call should be blocked (probe in flight).
    const second = breaker.check("a");
    expect(second.allow).toBe(false);
    db.close();
  });

  test("successful probe resets to CLOSED; failed probe re-opens", async () => {
    const { breaker, db } = newRegistryWithBreaker({ failureThreshold: 1, cooldownMs: 30 });
    breaker.recordFailure("a");
    await new Promise((r) => setTimeout(r, 40));
    const probe = breaker.check("a"); // half-open, allow: true
    expect(probe.allow).toBe(true);
    // Simulate the probe succeeding:
    breaker.recordSuccess("a");
    expect(breaker.stateOf("a")).toBe("closed");
    // Now trip again, half-open, simulate the probe FAILING:
    breaker.recordFailure("a");
    await new Promise((r) => setTimeout(r, 40));
    const probe2 = breaker.check("a");
    expect(probe2.allow).toBe(true);
    breaker.recordFailure("a"); // probe failed
    expect(breaker.stateOf("a")).toBe("open");
    db.close();
  });
});

describe("ToolRegistry integrates circuit breaker (P2-#2)", () => {
  test("short-circuits with circuit_open after 3 consecutive failures", async () => {
    const { registry, breaker, db } = newRegistryWithBreaker({ failureThreshold: 3 });
    let calls = 0;
    const tool: Tool = {
      manifest: makeBaseManifest("flaky"),
      parameters: {},
      async execute() {
        calls++;
        return { ok: false, content: "fail", error: "http_error" } satisfies ToolResult;
      },
    };
    registry.register(tool);

    // 3 calls, all fail — trips the breaker.
    const r1 = await registry.call("flaky", {}, "s1");
    const r2 = await registry.call("flaky", {}, "s1");
    const r3 = await registry.call("flaky", {}, "s1");
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(registry.breakerStateOf("flaky")).toBe("open");

    // 4th call is short-circuited — tool NOT invoked.
    const r4 = await registry.call("flaky", {}, "s1");
    expect(r4.ok).toBe(false);
    expect(r4.error).toBe("circuit_open");
    expect(calls).toBe(3); // critical: tool was NOT called the 4th time
    db.close();
  });

  test("does NOT trip on a single success after failures", async () => {
    const { registry, db } = newRegistryWithBreaker({ failureThreshold: 3 });
    let calls = 0;
    const tool: Tool = {
      manifest: makeBaseManifest("intermittent"),
      parameters: {},
      async execute() {
        calls++;
        if (calls === 1) return { ok: false, content: "f1", error: "http_error" };
        if (calls === 2) return { ok: false, content: "f2", error: "http_error" };
        return { ok: true, content: "ok" };
      },
    };
    registry.register(tool);

    await registry.call("intermittent", {}, "s1");
    await registry.call("intermittent", {}, "s1");
    await registry.call("intermittent", {}, "s1"); // success resets
    expect(registry.breakerStateOf("intermittent")).toBe("closed");
    db.close();
  });

  test("trips on thrown errors too (process-spawn failures, etc.)", async () => {
    const { registry, db } = newRegistryWithBreaker({ failureThreshold: 2 });
    const tool: Tool = {
      manifest: makeBaseManifest("crashy"),
      parameters: {},
      async execute() {
        throw new Error("spawn failed");
      },
    };
    registry.register(tool);

    await registry.call("crashy", {}, "s1");
    await registry.call("crashy", {}, "s1");
    expect(registry.breakerStateOf("crashy")).toBe("open");

    // 3rd call short-circuits.
    const r3 = await registry.call("crashy", {}, "s1");
    expect(r3.error).toBe("circuit_open");
    db.close();
  });
});
