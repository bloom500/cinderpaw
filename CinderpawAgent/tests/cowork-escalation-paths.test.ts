/**
 * The two ways a cowork teammate could step around its own guard rails.
 *
 * Both were real and both were invisible in normal use: the gate still fired
 * on a direct call, and the hop cap still held on the automatic reply path.
 * What was missing was the OTHER path in each case.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import {
  CoworkApprovalRepo,
  CoworkApprovalService,
  rootSessionId,
} from "../src/cowork/approval.ts";
import { createCoworkSendTool } from "../src/tools/builtin/cowork.ts";
import type { OutboundEvent } from "../src/types.ts";

describe("rootSessionId — undoing subagent wrapping", () => {
  test("a plain session is its own root", () => {
    expect(rootSessionId("cowork:alice")).toBe("cowork:alice");
    expect(rootSessionId("chat-123")).toBe("chat-123");
  });

  test("one level of delegation still points at the teammate", () => {
    expect(rootSessionId("subagent:cowork:alice:sa1")).toBe("cowork:alice");
  });

  test("nesting works at any depth", () => {
    expect(rootSessionId("subagent:subagent:cowork:alice:sa1:sa2")).toBe("cowork:alice");
  });

  test("an agent id containing colons survives the round trip", () => {
    // The unwind counts segments rather than guessing an id's shape.
    expect(rootSessionId("subagent:cowork:team:alice:sa1")).toBe("cowork:team:alice");
  });

  test("a non-cowork subagent is left alone", () => {
    expect(rootSessionId("subagent:chat-123:sa1")).toBe("chat-123");
  });
});

describe("the approval gate follows delegation", () => {
  function makeService() {
    const { raw, close } = openDatabase(":memory:");
    const events: OutboundEvent[] = [];
    const service = new CoworkApprovalService({
      approvals: new CoworkApprovalRepo(raw),
      agents: new CoworkAgentRepo(raw),
      emitEvent: (e: OutboundEvent) => events.push(e),
      // Short: these cases want the fail-closed expiry, not a five-minute wait.
      timeoutMs: 50,
    });
    return { service, events, close };
  }

  test("a teammate's DELEGATED destructive command is gated, not waved through", async () => {
    // The hole: gate() tested sessionId.startsWith("cowork:") on the raw id.
    // A teammate refused an `rm -rf` could hand it to delegate_task and the
    // child ran as subagent:cowork:… — which failed that test.
    const { service, close } = makeService();
    try {
      const res = await service.gate({
        sessionId: "subagent:cowork:alice:sa1",
        tool: "shell_exec",
        args: { command: "rm -rf build/" },
      });
      expect(res.block).toBe(true);
    } finally {
      close();
    }
  });

  test("an ordinary subagent is still untouched", async () => {
    const { service, close } = makeService();
    try {
      const res = await service.gate({
        sessionId: "subagent:chat-123:sa1",
        tool: "shell_exec",
        args: { command: "rm -rf build/" },
      });
      expect(res.block).toBe(false);
    } finally {
      close();
    }
  });
});

describe("the hop cap holds on the tool path too", () => {
  function makeTool() {
    const { raw, close } = openDatabase(":memory:");
    const agents = new CoworkAgentRepo(raw);
    const mailbox = new CoworkMailboxRepo(raw);
    agents.upsert({ id: "alice", name: "Alice" });
    agents.upsert({ id: "bob", name: "Bob" });
    return { tool: createCoworkSendTool(agents, mailbox), mailbox, close };
  }

  function hopsOf(payloadJson: string | null): number {
    return payloadJson ? (JSON.parse(payloadJson).coworkHops as number) : 0;
  }

  test("a fresh thread starts at hop 1", async () => {
    const { tool, mailbox, close } = makeTool();
    try {
      await tool.execute({ to: "Bob", message: "hi", thread_id: "t1" }, { sessionId: "chat-1" } as never);
      const [msg] = mailbox.inbox("bob");
      expect(hopsOf(msg!.payloadJson)).toBe(1);
    } finally {
      close();
    }
  });

  test("replying through the TOOL advances the count instead of resetting it", async () => {
    // This is the bug: cowork_send never set payloadJson, so every message it
    // wrote read back as hop 0 and two teammates could ping-pong forever.
    const { tool, mailbox, close } = makeTool();
    try {
      await tool.execute({ to: "Bob", message: "1", thread_id: "t1" }, { sessionId: "cowork:alice" } as never);
      await tool.execute({ to: "Alice", message: "2", thread_id: "t1" }, { sessionId: "cowork:bob" } as never);
      await tool.execute({ to: "Bob", message: "3", thread_id: "t1" }, { sessionId: "cowork:alice" } as never);
      expect(mailbox.lastHopsInThread("t1")).toBe(3);
    } finally {
      close();
    }
  });

  test("separate threads do not share a counter", async () => {
    const { tool, mailbox, close } = makeTool();
    try {
      await tool.execute({ to: "Bob", message: "a", thread_id: "t1" }, { sessionId: "cowork:alice" } as never);
      await tool.execute({ to: "Bob", message: "b", thread_id: "t2" }, { sessionId: "cowork:alice" } as never);
      expect(mailbox.lastHopsInThread("t2")).toBe(1);
    } finally {
      close();
    }
  });

  test("a delegated subagent sends as its teammate, not as the human", async () => {
    const { tool, mailbox, close } = makeTool();
    try {
      await tool.execute(
        { to: "Bob", message: "from a subagent", thread_id: "t1" },
        { sessionId: "subagent:cowork:alice:sa1" } as never,
      );
      const [msg] = mailbox.inbox("bob");
      expect(msg!.fromAgentId).toBe("alice");
    } finally {
      close();
    }
  });
});
