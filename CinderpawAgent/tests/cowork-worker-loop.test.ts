/**
 * Tests for the cowork worker loop (S3) — REAL SQLite + stubbed
 * inference seam. Verifies the two contracts that matter:
 *
 * 1. Visibility: every drain step emits a typed `cowork_event` (the
 *    locked "never log-only" rule).
 * 2. Ownership: handoffs are claimed before running and always driven to
 *    completed|failed — never left `initiated`.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import { CoworkHandoffService } from "../src/cowork/handoff.ts";
import {
  CoworkWorkerLoop,
  type CoworkTickResult,
  type CoworkTurnOutcome,
} from "../src/cowork/worker-loop.ts";
import type { OutboundEvent, CoworkMessage, CoworkHandoff } from "../src/types.ts";

function makeLoop(opts: {
  onMessage?: (msg: CoworkMessage) => Promise<CoworkTurnOutcome>;
  onHandoff?: (h: CoworkHandoff) => Promise<CoworkTurnOutcome>;
}) {
  const { raw, close } = openDatabase(":memory:");
  const mailbox = new CoworkMailboxRepo(raw);
  const handoffs = new CoworkHandoffService(raw);
  const events: OutboundEvent[] = [];
  const loop = new CoworkWorkerLoop(
    {
      mailbox,
      handoffs,
      onMessage: opts.onMessage ?? (async () => ({ ok: true, output: "done" })),
      onHandoff: opts.onHandoff ?? (async () => ({ ok: true, output: "done" })),
    },
    (e) => events.push(e),
  );
  return { loop, mailbox, handoffs, events, close };
}

function coworkEvents(events: OutboundEvent[]) {
  return events.filter((e): e is Extract<OutboundEvent, { type: "cowork_event" }> =>
    e.type === "cowork_event",
  );
}

describe("CoworkWorkerLoop — messages", () => {
  test("empty inbox → zero events, zero counts", async () => {
    const { loop, events, close } = makeLoop({});
    try {
      const result = await loop.tick("agent-a");
      expect(result).toEqual({ processedMessages: 0, handledHandoffs: 0 });
      expect(coworkEvents(events)).toEqual([]);
    } finally {
      close();
    }
  });

  test("pending message → received + processed events, status processed", async () => {
    const { loop, mailbox, events, close } = makeLoop({});
    try {
      const msg = mailbox.send({
        fromAgentId: "chief",
        toAgentId: "worker",
        threadId: "t1",
        body: "Do the thing.",
      });
      const result: CoworkTickResult = await loop.tick("worker");
      expect(result.processedMessages).toBe(1);
      expect(mailbox.get(msg.id)?.status).toBe("processed");

      const evts = coworkEvents(events).map((e) => e.eventType);
      expect(evts).toEqual(["message_received", "message_processed"]);
      const received = coworkEvents(events)[0];
      expect(received.agentId).toBe("worker");
      expect(received.threadId).toBe("t1");
      expect(received.title).toBe("chief → worker");
    } finally {
      close();
    }
  });

  test("handler failure → message rejected + rejection event", async () => {
    const { loop, mailbox, events, close } = makeLoop({
      onMessage: async () => ({ ok: false, output: "model unavailable" }),
    });
    try {
      const msg = mailbox.send({ fromAgentId: "x", toAgentId: "w", body: "hi" });
      await loop.tick("w");
      expect(mailbox.get(msg.id)?.status).toBe("rejected");
      expect(coworkEvents(events).map((e) => e.eventType)).toEqual([
        "message_received",
        "message_rejected",
      ]);
    } finally {
      close();
    }
  });

  test("handler throw → same rejection path as ok:false", async () => {
    const { loop, mailbox, events, close } = makeLoop({
      onMessage: async () => {
        throw new Error("boom");
      },
    });
    try {
      const msg = mailbox.send({ fromAgentId: "x", toAgentId: "w", body: "hi" });
      await loop.tick("w");
      expect(mailbox.get(msg.id)?.status).toBe("rejected");
      const rejected = coworkEvents(events).find(
        (e) => e.eventType === "message_rejected",
      );
      expect(rejected?.data.reason).toBe("boom");
      void msg;
    } finally {
      close();
    }
  });

  test("already-processed messages are not re-drained", async () => {
    const { loop, mailbox, events, close } = makeLoop({});
    try {
      mailbox.send({ fromAgentId: "x", toAgentId: "w", body: "once only" });
      await loop.tick("w");
      const second = await loop.tick("w");
      expect(second.processedMessages).toBe(0);
      expect(coworkEvents(events)).toHaveLength(2); // first tick's pair only
    } finally {
      close();
    }
  });
});

describe("CoworkWorkerLoop — handoffs", () => {
  test("initiated handoff → claim, run, complete with audit trail", async () => {
    const { loop, handoffs, events, close } = makeLoop({});
    try {
      const h = handoffs.initiate({
        fromAgentId: "chief",
        toAgentId: "worker",
        summary: "Fix issue #42.",
      });
      const result = await loop.tick("worker");
      expect(result.handledHandoffs).toBe(1);

      const done = handoffs.get(h.id)!;
      expect(done.status).toBe("completed");
      expect(done.resultSummary).toBe("done");
      expect(done.closedAt).not.toBeNull();

      expect(coworkEvents(events).map((e) => e.eventType)).toEqual([
        "handoff_received",
        "handoff_completed",
      ]);
    } finally {
      close();
    }
  });

  test("handoff handler failure → status failed with reason, event emitted", async () => {
    const { loop, handoffs, events, close } = makeLoop({
      onHandoff: async () => ({ ok: false, output: "upstream blocked" }),
    });
    try {
      const h = handoffs.initiate({
        fromAgentId: "chief",
        toAgentId: "worker",
        summary: "Impossible task.",
      });
      await loop.tick("worker");
      const failed = handoffs.get(h.id)!;
      expect(failed.status).toBe("failed");
      expect(failed.resultSummary).toBe("upstream blocked");
      expect(failed.closedAt).not.toBeNull();
      expect(coworkEvents(events).map((e) => e.eventType)).toEqual([
        "handoff_received",
        "handoff_failed",
      ]);
    } finally {
      close();
    }
  });

  test("a crash mid-run still leaves an owner on record (accepted, not initiated)", async () => {
    const { loop, handoffs, close } = makeLoop({
      onHandoff: async () => {
        throw new Error("process died");
      },
    });
    try {
      const h = handoffs.initiate({
        fromAgentId: "chief",
        toAgentId: "worker",
        summary: "s",
      });
      // Even the fail() bookkeeping is exercised; the invariant under test
      // is that the row never stays 'initiated' after a tick.
      await loop.tick("worker");
      const after = handoffs.get(h.id)!;
      expect(["failed", "completed"]).toContain(after.status);
      expect(after.status).not.toBe("initiated");
    } finally {
      close();
    }
  });

  test("outgoing handoffs (sent BY the agent) are not self-claimed", async () => {
    const { loop, handoffs, close } = makeLoop({});
    try {
      handoffs.initiate({
        fromAgentId: "worker",
        toAgentId: "other-agent",
        summary: "Not mine.",
      });
      const result = await loop.tick("worker");
      expect(result.handledHandoffs).toBe(0);
    } finally {
      close();
    }
  });

  test("mixed tick counts messages and handoffs independently", async () => {
    const { loop, mailbox, handoffs, close } = makeLoop({});
    try {
      mailbox.send({ fromAgentId: "human", toAgentId: "w", body: "hello" });
      handoffs.initiate({ fromAgentId: "chief", toAgentId: "w", summary: "task" });
      const result = await loop.tick("w");
      expect(result).toEqual({ processedMessages: 1, handledHandoffs: 1 });
    } finally {
      close();
    }
  });
});
