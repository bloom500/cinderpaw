/**
 * Tests for the desktop-control bridge and the `computer_use` tool.
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
import { createComputerUseTool, redactArgsForAudit, isRecoverable } from "../src/tools/builtin/computer-use.ts";
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
  /** Receives the confirmation text the user is actually shown. */
  onAsk?: (question: string) => void;
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
    manifest: { name: "computer_use", description: "x", permissions: [], networkAccess: false },
    desktopControl,
    ...(opts.askUserAnswer
      ? {
          askUser: {
            async ask(questions: { question: string }[]) {
              opts.onAsk?.(questions[0]?.question ?? "");
              return [{ question: "q", selected: [opts.askUserAnswer!] }];
            },
            cancel() {},
          },
        }
      : {}),
  } as unknown as ToolContext;
  return { ctx, requests };
}

describe("computer_use tool", () => {
  it("list_windows returns a typed, shaped result", async () => {
    const tool = createComputerUseTool();
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
    const tool = createComputerUseTool();
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
    const tool = createComputerUseTool();
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
    const tool = createComputerUseTool();
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
    const tool = createComputerUseTool();
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
    const tool = createComputerUseTool();

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
    const tool = createComputerUseTool();

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
    const tool = createComputerUseTool();
    const denied = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Deny" });
    const res = await tool.execute(
      { action: "click", element_id: "1:2.3" },
      denied.ctx,
    );
    expect(res.ok).toBe(false);
    // The host must never be asked when the user declined.
    expect(denied.requests).toHaveLength(0);
  });

  it("fails CLOSED on a required confirmation when there is no askUser bridge", async () => {
    const tool = createComputerUseTool();
    // makeCtx without askUserAnswer → no askUser bridge.
    const { ctx, requests } = makeCtx({ onRequest: () => ({ ok: true }) });
    const res = await tool.execute({ action: "click", element_id: "1:2.3" }, ctx);
    expect(res.ok).toBe(false);
    expect(requests).toHaveLength(0); // host never reached without consent
  });

  it("allows prompt-less execution only with the explicit env opt-out", async () => {
    const tool = createComputerUseTool();
    const prev = process.env.CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK;
    process.env.CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK = "true";
    try {
      const { ctx, requests } = makeCtx({ onRequest: () => ({ ok: true }) });
      const res = await tool.execute({ action: "click", element_id: "1:2.3" }, ctx);
      expect(res.ok).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK;
      else process.env.CINDERPAW_DESKTOP_CONTROL_NO_PROMPT_OK = prev;
    }
  });

  it("rejects unknown actions and missing required params", async () => {
    const tool = createComputerUseTool();
    const { ctx } = makeCtx({ onRequest: () => ({}) });
    expect((await tool.execute({ action: "nope" }, ctx)).ok).toBe(false);
    expect((await tool.execute({ action: "get_tree" }, ctx)).ok).toBe(false); // no pid
    expect((await tool.execute({ action: "click" }, ctx)).ok).toBe(false); // no element_id
  });

  it("surfaces host errors as recoverable/unrecoverable structured results", async () => {
    const tool = createComputerUseTool();
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

describe("isRecoverable", () => {
  it("treats transient UI/timing failures as recoverable", () => {
    for (const msg of [
      "desktop control: element_not_found (it may have changed or its window closed)",
      "desktop control: could not bring the target window to the foreground before typing",
      "desktop control: GetFocusedElement failed: COM error",
      "desktop control: SendInput dispatched only 0/6 events",
      "some unexpected error with no keyword at all",
    ]) {
      expect(isRecoverable(msg)).toBe(true);
    }
  });

  it("treats deterministic refusals / config / arg errors as unrecoverable", () => {
    for (const msg of [
      'desktop control: "cmd.exe" is on the security denylist',
      "desktop control: \"foo\" is not in CINDERPAW_DESKTOP_CONTROL_ALLOWED_APPS",
      "desktop control is disabled. Set CINDERPAW_ENABLE_DESKTOP_CONTROL=true",
      'computer_use: action "get_tree" requires a numeric "pid".',
      "desktop control: element does not support setting a value",
      "computer_use: the user declined the \"click\" action.",
    ]) {
      expect(isRecoverable(msg)).toBe(false);
    }
  });

  it("no longer misclassifies 'not invokable' as a policy refusal", () => {
    // Regression: the old `"not in"` substring matched "not invokable" and
    // wrongly marked a transient element state as a permanent refusal.
    expect(isRecoverable("desktop control: element is not invokable (no Invoke or Toggle pattern)")).toBe(false);
    // ^ correctly unrecoverable now via the explicit "not invokable" entry, not by accident.
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

describe("computer_use rename", () => {
  it("is registered under the ecosystem name", () => {
    expect(createComputerUseTool().manifest.name).toBe("computer_use");
  });

  it("lists every action it accepts in the action parameter's own description", () => {
    // The description used to omit send_keys and launch, so the schema denied
    // the existence of the two actions the tool description explains at length.
    const desc = String(
      (createComputerUseTool().parameters as Record<string, { description: string }>).action.description,
    );
    for (const action of [
      "list_windows", "get_tree", "find_elements", "click", "type",
      "send_keys", "get_value", "get_focused", "perform_action", "launch",
    ]) {
      expect(desc).toContain(action);
    }
  });
});

describe("launch confirmation names the launch", () => {
  it("says which application is being started, not 'click'", async () => {
    // `launch` had no branch in the detail chain, so it fell through to the
    // click default with no element_id — the one action in ALWAYS_CONFIRM
    // asked "Allow the agent to click (focused element)?" while starting a
    // process. The user cannot consent to what they are not told.
    let asked = "";
    const tool = createComputerUseTool();
    const { ctx } = makeCtx({
      onRequest: () => ({ ok: true }),
      askUserAnswer: "Allow",
      onAsk: (q) => { asked = q; },
    });

    await tool.execute({ action: "launch", app: "notepad.exe" }, ctx);

    expect(asked).toContain("notepad.exe");
    expect(asked.toLowerCase()).toContain("start");
    expect(asked.toLowerCase()).not.toContain("click");
  });
});

describe("the confirmation names the element, not its id", () => {
  it("an element seen in find_elements is asked about by role and name", async () => {
    const tool = createComputerUseTool();
    let asked = "";
    const { ctx } = makeCtx({
      onRequest: (action) => (action === "find_elements"
        ? [{ id: "2288:42.853402.4.293.8.15505", role: "Button", name: "Send", value: "", automation_id: "", actions: ["press"], is_enabled: true, is_offscreen: false }]
        : { ok: true }),
      askUserAnswer: "Allow",
      onAsk: (q) => { asked = q; },
    });
    await tool.execute({ action: "find_elements", pid: 1, query: { name: "Send" } }, ctx);
    await tool.execute({ action: "click", element_id: "2288:42.853402.4.293.8.15505" }, ctx);
    expect(asked).toContain('the Button "Send"');
    expect(asked).not.toContain("2288:42");
  });

  it("an id it never saw is still shown, marked as found by the agent", async () => {
    const tool = createComputerUseTool();
    let asked = "";
    const { ctx } = makeCtx({ onRequest: () => ({ ok: true }), askUserAnswer: "Allow", onAsk: (q) => { asked = q; } });
    await tool.execute({ action: "click", element_id: "9:1.2.3" }, ctx);
    expect(asked).toContain("an element the agent found (9:1.2.3)");
  });

  it("a tree's nodes are remembered too", async () => {
    const { rememberElements, describeElement } = await import("../src/tools/builtin/computer-use.ts");
    rememberElements({ id: "1:1", role: "Window", name: "Spotify", children: [{ id: "1:2", role: "Button", name: "Play", children: [] }] });
    expect(describeElement("1:2")).toBe('the Button "Play"');
  });
});

describe("find_elements tells the model what it found", () => {
  it("lists each element by id, role and name, since the model reads only the content", async () => {
    const tool = createComputerUseTool();
    const { ctx } = makeCtx({
      onRequest: () => [
        { id: "2288:42.1", role: "Button", name: "Send", value: "", automation_id: "", actions: ["press"], is_enabled: true, is_offscreen: false },
        { id: "2288:42.2", role: "Edit", name: "Password", value: "[REDACTED]", automation_id: "", actions: [], is_enabled: false, is_offscreen: true },
      ],
    });
    const r = await tool.execute({ action: "find_elements", pid: 2288, query: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toContain('2288:42.1  Button "Send"');
    expect(r.content).toContain('2288:42.2  Edit "Password" value="[REDACTED]" (disabled, offscreen)');
  });

  it("caps a long result and says how many more there are", async () => {
    const tool = createComputerUseTool();
    const many = Array.from({ length: 75 }, (_, i) => ({ id: `1:${i}`, role: "ListItem", name: `row ${i}`, value: "", automation_id: "", actions: [], is_enabled: true, is_offscreen: false }));
    const { ctx } = makeCtx({ onRequest: () => many });
    const r = await tool.execute({ action: "find_elements", pid: 1, query: {} }, ctx);
    expect(r.content).toContain("Found 75 element(s):");
    expect(r.content).toContain('1:59  ListItem "row 59"');
    expect(r.content).not.toContain('1:60  ListItem');
    expect(r.content).toContain("and 15 more");
  });
});

describe("find_elements can be scoped to the page", () => {
  it("passes under_role and a list of roles through to the host", async () => {
    const tool = createComputerUseTool();
    let sent: Record<string, unknown> = {};
    const { ctx } = makeCtx({ onRequest: (_a, params) => { sent = params; return []; } });
    await tool.execute({ action: "find_elements", pid: 7, query: { role: "Button,Hyperlink", under_role: "Main,Document" } }, ctx);
    expect(sent.query).toEqual({ role: "Button,Hyperlink", under_role: "Main,Document" });
    expect(JSON.stringify(tool.parameters)).toContain("under_role");
  });
});
