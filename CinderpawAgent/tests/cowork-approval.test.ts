/**
 * Tests for the cowork approval gates (S4).
 *
 * Contracts under test:
 * - classification is deterministic and narrow (unclassifiable ⇒ allowed),
 * - non-cowork sessions are NEVER gated (zero behaviour change outside
 *   cowork — the fresh-install contract),
 * - a gated call persists an audit row, emits one `approval_requested`
 *   event, and BLOCKS until resolved,
 * - approve lets the tool run; deny/expiry block with a readable reason,
 *   expiry NEVER approving,
 * - resolution from chat is idempotent-safe: unknown or already-terminal
 *   ids are a false return, not a throw.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import {
  classifyToolCall,
  CoworkApprovalRepo,
  CoworkApprovalService,
} from "../src/cowork/approval.ts";
import type { OutboundEvent } from "../src/types.ts";

describe("classifyToolCall (deterministic)", () => {
  test("shell_exec destructive ⇒ delete", () => {
    const c = classifyToolCall("shell_exec", { command: "rm -rf build/" });
    expect(c?.approvalClass).toBe("delete");
    expect(c?.description).toContain("rm -rf build/");
  });

  test("shell_exec read-only ⇒ not gated", () => {
    expect(classifyToolCall("shell_exec", { command: "ls -la" })).toBeNull();
  });

  test("shell_exec with empty command ⇒ not gated", () => {
    expect(classifyToolCall("shell_exec", {})).toBeNull();
  });

  test("http_request mutating method ⇒ send", () => {
    const post = classifyToolCall("http_request", {
      method: "POST",
      url: "https://api.example.com/publish",
    });
    expect(post?.approvalClass).toBe("send");
    expect(post?.description).toContain("https://api.example.com/publish");
    const del = classifyToolCall("http_request", { method: "delete", url: "https://x.y/1" });
    expect(del?.approvalClass).toBe("send");
  });

  test("http_request GET/HEAD ⇒ not gated", () => {
    expect(classifyToolCall("http_request", { method: "GET", url: "https://x.y" })).toBeNull();
    expect(classifyToolCall("http_request", { url: "https://x.y" })).toBeNull();
  });

  test("unknown tools are never gated", () => {
    expect(classifyToolCall("web_search", { query: "anything" })).toBeNull();
    expect(classifyToolCall("read_file", { path: "/etc/hosts" })).toBeNull();
  });
});

function makeService(opts?: { timeoutMs?: number }) {
  const { raw, close } = openDatabase(":memory:");
  const approvals = new CoworkApprovalRepo(raw);
  const agents = new CoworkAgentRepo(raw);
  const events: OutboundEvent[] = [];
  const service = new CoworkApprovalService({
    approvals,
    agents,
    emitEvent: (e: OutboundEvent) => events.push(e),
    timeoutMs: opts?.timeoutMs ?? 5_000,
  });
  return { service, approvals, agents, events, close };
}

/** Pull the requestId out of the single approval_requested event. */
function requestedId(events: OutboundEvent[]): string {
  const ev = events.find(
    (e): e is Extract<OutboundEvent, { type: "cowork_event" }> =>
      e.type === "cowork_event" && e.eventType === "approval_requested",
  );
  if (!ev || typeof ev.data.requestId !== "string") throw new Error("no approval_requested event");
  return ev.data.requestId;
}

describe("CoworkApprovalService.gate", () => {
  test("non-cowork sessions pass through untouched, zero events", async () => {
    const { service, approvals, events, close } = makeService();
    try {
      const result = await service.gate({
        tool: "shell_exec",
        args: { command: "rm -rf /" },
        sessionId: "user-session-123",
      });
      expect(result).toEqual({ block: false });
      expect(events).toEqual([]);
      expect(approvals.get("nonexistent")).toBeUndefined();
    } finally {
      close();
    }
  });

  test("cowork session, unclassifiable call ⇒ allowed, no request created", async () => {
    const { service, events, close } = makeService();
    try {
      const result = await service.gate({
        tool: "web_search",
        args: { query: "rust async books" },
        sessionId: "cowork:some-agent-id",
      });
      expect(result).toEqual({ block: false });
      expect(events).toEqual([]);
    } finally {
      close();
    }
  });

  test("gated call blocks, persists a row, and approve() releases it", async () => {
    const { service, approvals, agents, events, close } = makeService();
    try {
      const agent = agents.upsert({ name: "Shipper", role: "release" });
      const pending = service.gate({
        tool: "shell_exec",
        args: { command: "rm -rf dist/ && echo shipped" },
        sessionId: `cowork:${agent.id}`,
      });

      // Blocked while unresolved…
      let settled = false;
      void pending.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);

      // …with exactly one visible escalation carrying the ids the UI needs.
      const ev = events.find(
        (e): e is Extract<OutboundEvent, { type: "cowork_event" }> =>
          e.type === "cowork_event",
      );
      expect(ev?.eventType).toBe("approval_requested");
      expect(ev?.agentId).toBe(agent.id);
      expect(ev?.title).toContain("Shipper");
      expect(ev?.data.approvalClass).toBe("delete");
      const requestId = requestedId(events);
      const row = approvals.get(requestId);
      expect(row?.status).toBe("pending");
      expect(row?.sessionId).toBe(`cowork:${agent.id}`);

      // Approve from chat → hook unblocks with allow, audit row terminal.
      expect(service.resolveExternal(requestId, true)).toBe(true);
      expect(await pending).toEqual({ block: false });
      expect(approvals.get(requestId)?.status).toBe("approved");
      const done = events.at(-1) as Extract<OutboundEvent, { type: "cowork_event" }>;
      expect(done.eventType).toBe("approval_approved");
    } finally {
      close();
    }
  });

  test("deny blocks with a readable reason", async () => {
    const { service, events, close } = makeService();
    try {
      const pending = service.gate({
        tool: "http_request",
        args: { method: "POST", url: "https://api.example.com/send" },
        sessionId: "cowork:abc",
      });
      const requestId = requestedId(events);
      service.resolveExternal(requestId, false);
      const result = await pending;
      expect(result.block).toBe(true);
      expect(result.block && result.reason).toContain("denied");
      const done = events.at(-1) as Extract<OutboundEvent, { type: "cowork_event" }>;
      expect(done.eventType).toBe("approval_denied");
    } finally {
      close();
    }
  });

  test("expiry fails CLOSED — never approves itself", async () => {
    const { service, approvals, events, close } = makeService({ timeoutMs: 15 });
    try {
      const pending = service.gate({
        tool: "shell_exec",
        args: { command: "del /q important.txt" },
        sessionId: "cowork:abc",
      });
      const result = await pending;
      expect(result.block).toBe(true);
      expect(result.block && result.reason).toContain("expired");
      const requestId = requestedId(events);
      expect(approvals.get(requestId)?.status).toBe("expired");
      const last = events.at(-1) as Extract<OutboundEvent, { type: "cowork_event" }>;
      expect(last.eventType).toBe("approval_expired");
    } finally {
      close();
    }
  });

  test("resolveExternal on unknown / already-terminal ids is a harmless false", async () => {
    const { service, events, close } = makeService();
    try {
      expect(service.resolveExternal("no-such-id", true)).toBe(false);
      const pending = service.gate({
        tool: "http_request",
        args: { method: "PUT", url: "https://x.y" },
        sessionId: "cowork:abc",
      });
      const id = requestedId(events);
      expect(service.resolveExternal(id, true)).toBe(true);
      expect(service.resolveExternal(id, true)).toBe(false);
      expect(await pending).toEqual({ block: false });
    } finally {
      close();
    }
  });
});
