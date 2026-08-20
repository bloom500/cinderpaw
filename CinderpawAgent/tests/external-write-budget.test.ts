/**
 * External write budget — the guard for the world OUTSIDE this machine.
 *
 * Every other guard in the sandbox protects the laptop from the agent: the
 * deny wall, the process sandbox, the SSRF check. None of them protect an ad
 * account, a social profile, or a CRM — and those are what people actually
 * want an unattended agent pointed at. A wrong file is rewritten; ad spend is
 * spent, a published post is public, a polluted CRM row is in the CRM.
 *
 * What this buys is bounded and worth stating precisely: it caps the VOLUME of
 * state-changing calls, so a runaway loop stops. It does NOT stop one wrong
 * write — a single request that sets a budget to the wrong number is inside
 * any budget. The tests below pin both halves, including the one it does not
 * solve, so nobody reads this as more protection than it is.
 */

import { describe, expect, test } from "bun:test";
import { EgressProxy, isWriteMethod } from "../src/egress/egress-proxy.ts";
import type { AuditEntry, ToolManifest } from "../src/types.ts";

const manifest: ToolManifest = {
  name: "http_request",
  description: "t",
  permissions: [],
  networkAccess: true,
  allowedDomains: ["example.com"],
};

function proxy(overrides = {}) {
  const audit: AuditEntry[] = [];
  const p = new EgressProxy((e) => audit.push(e), {
    underlyingFetch: async () => new Response("{}", { status: 200 }),
    ...overrides,
  });
  return { p, audit };
}

describe("write-method classification", () => {
  test("reads are reads", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get", "head"]) {
      expect(isWriteMethod(m)).toBe(false);
    }
  });

  test("state-changing verbs are writes", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(isWriteMethod(m)).toBe(true);
    }
  });

  test("an absent method is a GET", () => {
    expect(isWriteMethod(undefined)).toBe(false);
  });

  test("an unknown verb counts as a write — the safe default", () => {
    expect(isWriteMethod("PURGE")).toBe(true);
  });
});

describe("the budget bounds a runaway loop", () => {
  test("writes are allowed up to the budget, then stopped", async () => {
    const { p } = proxy({ externalWriteBudget: 3 });
    const f = p.forTool(manifest, "s");
    for (let i = 0; i < 3; i++) {
      await f("https://example.com/x", { method: "POST" });
    }
    await expect(f("https://example.com/x", { method: "POST" })).rejects.toThrow(
      /external write budget spent/i,
    );
  });

  test("reads are never counted — an agent can keep looking after it stops changing", async () => {
    const { p } = proxy({ externalWriteBudget: 1 });
    const f = p.forTool(manifest, "s");
    await f("https://example.com/x", { method: "POST" });
    // Budget is spent for writes…
    await expect(f("https://example.com/x", { method: "POST" })).rejects.toThrow(/budget spent/i);
    // …but reading still works, so it can report what it did.
    for (let i = 0; i < 5; i++) {
      const res = await f("https://example.com/x");
      expect(res.ok).toBe(true);
    }
  });

  test("the budget is per session — one workload cannot spend another's", async () => {
    const { p } = proxy({ externalWriteBudget: 1 });
    const a = p.forTool(manifest, "session-a");
    const b = p.forTool(manifest, "session-b");
    await a("https://example.com/x", { method: "POST" });
    await expect(a("https://example.com/x", { method: "POST" })).rejects.toThrow(/budget spent/i);
    const res = await b("https://example.com/x", { method: "POST" });
    expect(res.ok).toBe(true);
  });

  test("the stop says it is a safety stop, not a permission denial", async () => {
    const { p } = proxy({ externalWriteBudget: 1 });
    const f = p.forTool(manifest, "s");
    await f("https://example.com/x", { method: "POST" }); // spends it
    try {
      await f("https://example.com/x", { method: "POST" });
      throw new Error("should have been stopped");
    } catch (e) {
      const msg = String(e);
      // The agent has to be able to tell "wait / stop" from "you may never do
      // this", or it retries forever against a wall.
      expect(msg).toMatch(/safety stop/i);
      expect(msg).toMatch(/not a permission denial/i);
      expect(msg).toMatch(/example\.com is allowed/i);
    }
  });

  test("0 disables the cap", async () => {
    // maxRequests raised too: this test is about the write budget, and the
    // per-tool rate limiter would otherwise stop us first and pass for the
    // wrong reason.
    const { p } = proxy({ externalWriteBudget: 0, maxRequests: 500 });
    const f = p.forTool(manifest, "s");
    for (let i = 0; i < 25; i++) {
      const res = await f("https://example.com/x", { method: "POST" });
      expect(res.ok).toBe(true);
    }
  });
});

describe("writes are auditable on their own", () => {
  test("a write is logged as network_write, a read as network", async () => {
    const { p, audit } = proxy({ externalWriteBudget: 10 });
    const f = p.forTool(manifest, "s");
    await f("https://example.com/read");
    await f("https://example.com/write", { method: "POST" });
    const kinds = audit.filter((e) => e.result === "success").map((e) => e.actionType);
    expect(kinds).toEqual(["network", "network_write"]);
  });

  test("a blocked write is audited as blocked, and not counted twice", async () => {
    const { p, audit } = proxy({ externalWriteBudget: 1 });
    const f = p.forTool(manifest, "s");
    await f("https://example.com/x", { method: "POST" });
    await f("https://example.com/x", { method: "POST" }).catch(() => {});
    expect(audit.filter((e) => e.actionType === "network_write")).toHaveLength(1);
    expect(audit.filter((e) => e.result === "blocked")).toHaveLength(1);
  });
});

describe("what the budget does NOT do — pinned so nobody over-reads it", () => {
  test("one wrong write is inside any budget", async () => {
    const { p } = proxy({ externalWriteBudget: 50 });
    const f = p.forTool(manifest, "s");
    // "Set the daily budget to $500000" is a single POST. Nothing here stops
    // it, and nothing here claims to. Severity needs a human or a per-host
    // write allowlist; see the ponytail note in egress-proxy.ts.
    const res = await f("https://example.com/campaigns/x/budget", { method: "POST" });
    expect(res.ok).toBe(true);
  });

  test("a forbidden host is still reported as forbidden, not as a spent budget", async () => {
    const { p } = proxy({ externalWriteBudget: 1 });
    const f = p.forTool(manifest, "s");
    // Ordering matters: the host check runs first, so the agent gets the
    // diagnosis that is actually true.
    await expect(f("https://evil.com/x", { method: "POST" })).rejects.toThrow(
      /not in allowedDomains/i,
    );
    // …and the refused request did not consume the budget either.
    const res = await f("https://example.com/x", { method: "POST" });
    expect(res.ok).toBe(true);
  });
});
