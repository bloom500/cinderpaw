/**
 * Tests for the desktop-control bridge and the `control_app` tool.
 *
 * The OS accessibility work lives in the Rust host; here we exercise the
 * sidecar-side contract with a mocked bridge:
 *   - the tool builds the correct host request per action and returns a
 *     well-shaped result (list_windows shape);
 *   - secure values (typed text) are redacted in the tool's own audit entry;
 *   - get_tree clamps depth to the 1..=8 range before it reaches the host;
 *   - the bridge correlates request/response by id and rejects on `ok:false`.
 */

import { describe, it, expect } from "bun:test";
import { createControlAppTool, redactArgsForAudit } from "../src/tools/builtin/control-app.ts";
import { DesktopControlBridgeImpl } from "../src/core/desktop-control-bridge.ts";
import type {
  AuditEntry,
  DesktopControlBridge,
  OutboundEvent,
  ToolContext,
} from "../src/types.ts";

/** Build a ToolContext whose desktopControl bridge is a programmable stub. */
function makeCtx(opts: {
  onRequest: (action: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  audit?: (e: AuditEntry) => void;
  askUserAnswer?: string; // "Allow" | "Deny"; omit → no askUser bridge
}): { ctx: ToolContext; requests: Array<{ action: string; params: Record<string, unknown> }> } {
  const requests: Array<{ action: string; params: Record<string, unknown> }> = [];
  const desktopControl: DesktopControlBridge = {
    async request(action, params) {
      requests.push({ action, params });
      return await opts.onRequest(action, params);
    },
  };
  const ctx = {
    sessionId: "test",
    fetch: (async () => {
      throw new Error("no network in test");
    }) as unknown as ToolContext["fetch"],
    audit: opts.audit ?? (() => {}),
    manifest: { name: "control_app", description: "x", permissions: [], networkAccess: false },
    desktopControl,
    ...(opts.askUserAnswer
      ? {
          askUser: {
            async ask() {
              return [{ question: "q", selected: [opts.askUserAnswer!] }];
            },
            cancel() {},
          },
        }
      : {}),
  } as unknown as ToolContext;
  return { ctx, requests };
}

describe("control_app tool", () => {
  it("list_windows returns a typed, shaped result", async () => {
    const tool = createControlAppTool();
    const windows = [
      { pid: 1234, title: "Untitled - Notepad", app_name: "notepad.exe" },
      { pid: 5678, title: "Calculator", app_name: "calc.exe" },
    ];
    const { ctx, requests } = makeCtx({ onRequest: () => windows });
    const res = await tool.execute({ action: "list_windows" }, ctx);

    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.action).toBe("list_windows");
    expect(Array.isArray(res.data)).toBe(true);
    expect((res.data as typeof windows)[0]!.pid).toBe(1234);
    expect(res.content).toContain("notepad.exe");
  });

  it("redacts typed text in the audit entry (password safety)", async () => {
    const tool = createControlAppTool();
    const audited: AuditEntry[] = [];
    const { ctx } = makeCtx({
      onRequest: () => ({ ok: true }),
      audit: (e) => audited.push(e),
      askUserAnswer: "Allow",
    });

    const secret = "hunter2-super-secret";
    const res = await tool.execute(
      { action: "type", element_id: "1234:1.2.3", text: secret },
      ctx,
    );

    expect(res.ok).toBe(true);
    // The tool's own audit entry must never carry the raw secret.
    expect(audited.length).toBeGreaterThan(0);
    const joined = audited.map((e) => e.argsJson ?? "").join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).toContain("[REDACTED]");
  });

  it("send_keys forwards element_id + keys and confirms first", async () => {
    const tool = createControlAppTool();
    const { ctx, requests } = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Allow" });
    const res = await tool.execute(
      { action: "send_keys", element_id: "1234:1.2", keys: "hello Bloom{Enter}" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.action).toBe("send_keys");
    expect(requests[0]!.params.element_id).toBe("1234:1.2");
    expect(requests[0]!.params.keys).toBe("hello Bloom{Enter}");
  });

  it("send_keys requires keys and is a confirmed write action", async () => {
    const tool = createControlAppTool();
    // Missing keys → rejected before any host call.
    const missing = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Allow" });
    const r1 = await tool.execute({ action: "send_keys", element_id: "1:2" }, missing.ctx);
    expect(r1.ok).toBe(false);
    expect(missing.requests).toHaveLength(0);
    // Denied confirmation → never reaches the host.
    const denied = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Deny" });
    const r2 = await tool.execute(
      { action: "send_keys", element_id: "1:2", keys: "x{Enter}" },
      denied.ctx,
    );
    expect(r2.ok).toBe(false);
    expect(denied.requests).toHaveLength(0);
  });

  it("redacts send_keys keystrokes in the audit entry", async () => {
    const tool = createControlAppTool();
    const audited: AuditEntry[] = [];
    const { ctx } = makeCtx({
      onRequest: () => ({ ok: true }),
      audit: (e) => audited.push(e),
      askUserAnswer: "Allow",
    });
    const secret = "my-2fa-code-998877{Enter}";
    const res = await tool.execute(
      { action: "send_keys", element_id: "1:2.3", keys: secret },
      ctx,
    );
    expect(res.ok).toBe(true);
    const joined = audited.map((e) => e.argsJson ?? "").join("\n");
    expect(joined).not.toContain("998877");
    expect(joined).toContain("[REDACTED]");
  });

  it("clamps get_tree depth to the 1..=30 range before calling the host", async () => {
    const tool = createControlAppTool();

    const big = makeCtx({ onRequest: () => ({}) });
    await tool.execute({ action: "get_tree", pid: 1, depth: 999 }, big.ctx);
    expect(big.requests[0]!.params.depth).toBe(30);

    const zero = makeCtx({ onRequest: () => ({}) });
    await tool.execute({ action: "get_tree", pid: 1, depth: 0 }, zero.ctx);
    expect(zero.requests[0]!.params.depth).toBe(1);

    const dflt = makeCtx({ onRequest: () => ({}) });
    await tool.execute({ action: "get_tree", pid: 1 }, dflt.ctx);
    expect(dflt.requests[0]!.params.depth).toBe(4);
  });

  it("forwards window_title to the host for get_tree and find_elements", async () => {
    const tool = createControlAppTool();

    const tree = makeCtx({ onRequest: () => ({}) });
    await tool.execute(
      { action: "get_tree", pid: 1, window_title: "Documents" },
      tree.ctx,
    );
    expect(tree.requests[0]!.params.window_title).toBe("Documents");

    const find = makeCtx({ onRequest: () => [] });
    await tool.execute(
      { action: "find_elements", pid: 1, query: {}, window_title: "  Inbox  " },
      find.ctx,
    );
    // Trimmed before forwarding.
    expect(find.requests[0]!.params.window_title).toBe("Inbox");

    // Omitted → not present in params (host auto-picks the window).
    const none = makeCtx({ onRequest: () => ({}) });
    await tool.execute({ action: "get_tree", pid: 1 }, none.ctx);
    expect(none.requests[0]!.params.window_title).toBeUndefined();
  });

  it("requires a confirmation for write actions and aborts on denial", async () => {
    const tool = createControlAppTool();
    const denied = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Deny" });
    const res = await tool.execute(
      { action: "click", element_id: "1:2.3" },
      denied.ctx,
    );
    expect(res.ok).toBe(false);
    // The host must never be asked when the user declined.
    expect(denied.requests).toHaveLength(0);
  });

  it("rejects unknown actions and missing required params", async () => {
    const tool = createControlAppTool();
    const { ctx } = makeCtx({ onRequest: () => ({}) });
    expect((await tool.execute({ action: "nope" }, ctx)).ok).toBe(false);
    expect((await tool.execute({ action: "get_tree" }, ctx)).ok).toBe(false); // no pid
    expect((await tool.execute({ action: "click" }, ctx)).ok).toBe(false); // no element_id
  });

  it("surfaces host errors as recoverable/unrecoverable structured results", async () => {
    const tool = createControlAppTool();
    const notFound = makeCtx({
      onRequest: () => {
        throw new Error("desktop control: element_not_found (it may have changed)");
      },
    });
    const r1 = await tool.execute({ action: "get_value", element_id: "1:2" }, notFound.ctx);
    expect(r1.ok).toBe(false);
    expect((r1.data as { recoverable: boolean }).recoverable).toBe(true);

    const denied = makeCtx({
      onRequest: () => {
        throw new Error('desktop control: "1password.exe" is on the security denylist');
      },
    });
    const r2 = await tool.execute({ action: "get_value", element_id: "1:2" }, denied.ctx);
    expect(r2.ok).toBe(false);
    expect((r2.data as { recoverable: boolean }).recoverable).toBe(false);
  });
});

describe("redactArgsForAudit", () => {
  it("masks text but leaves other fields intact", () => {
    const out = redactArgsForAudit({ element_id: "1:2", text: "secret" });
    expect(out.text).toBe("[REDACTED]");
    expect(out.element_id).toBe("1:2");
  });

  it("masks send_keys keystrokes too", () => {
    const out = redactArgsForAudit({ element_id: "1:2", keys: "p4ssw0rd{Enter}" });
    expect(out.keys).toBe("[REDACTED]");
    expect(out.element_id).toBe("1:2");
  });
});

describe("DesktopControlBridgeImpl", () => {
  it("emits a desktop_control_request and resolves on matching response", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new DesktopControlBridgeImpl((e) => events.push(e), { timeoutMs: 1000 });
    const p = bridge.request("list_windows", {});
    await Promise.resolve();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("desktop_control_request");
    const id = (ev as { id: string }).id;
    bridge.resolve(id, true, [{ pid: 1 }]);
    await expect(p).resolves.toEqual([{ pid: 1 }]);
  });

  it("rejects when the host reports ok:false", async () => {
    const events: OutboundEvent[] = [];
    const bridge = new DesktopControlBridgeImpl((e) => events.push(e), { timeoutMs: 1000 });
    const p = bridge.request("click", { element_id: "1:2" });
    await Promise.resolve();
    const id = (events[0] as { id: string }).id;
    bridge.resolve(id, false, null, "boom");
    await expect(p).rejects.toThrow("boom");
  });

  it("times out when no response arrives", async () => {
    const bridge = new DesktopControlBridgeImpl(() => {}, { timeoutMs: 20 });
    await expect(bridge.request("list_windows", {})).rejects.toThrow(/timed out/);
  });
});
