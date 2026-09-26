/**
 * Tests for the cowork runtime (S3.5) — REAL SQLite, stubbed turn runner.
 *
 * Contracts under test:
 * - zero agents ⇒ tick is a no-op (fresh-install invisibility),
 * - a pending message becomes a turn with the agent's identity in the
 *   prompt and the agent's persistent session id,
 * - an agent-to-agent reply flows back through the mailbox with an
 *   incremented hop counter; hop limit stops the ping-pong,
 * - replies to "human" are stored for the person and never drained,
 * - unfinished turns are rejected, not delivered as answers.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";
import { CoworkHandoffService } from "../src/cowork/handoff.ts";
import {
  CoworkRuntime,
  DEFAULT_MAX_REPLY_HOPS,
  HUMAN,
  withHumanReplies,
} from "../src/cowork/runtime.ts";
import type { OutboundEvent } from "../src/types.ts";

function makeRuntime(opts?: {
  runTurn?: (
    agent: { name: string },
    prompt: string,
    sessionId: string,
  ) => Promise<{ text: string; finished: boolean }>;
}) {
  const { raw, close } = openDatabase(":memory:");
  const agents = new CoworkAgentRepo(raw);
  const mailbox = new CoworkMailboxRepo(raw);
  const handoffs = new CoworkHandoffService(raw);
  const events: OutboundEvent[] = [];
  const calls: Array<{ agentName: string; prompt: string; sessionId: string }> = [];
  const runtime = new CoworkRuntime({
    agents,
    mailbox,
    handoffs,
    emitEvent: (e: OutboundEvent) => events.push(e),
    runTurn:
      opts?.runTurn ??
      (async (agent, prompt, sessionId) => {
        calls.push({ agentName: agent.name, prompt, sessionId });
        return { text: `answer from ${agent.name}`, finished: true };
      }),
  });
  return { runtime, agents, mailbox, handoffs, events, calls, close };
}

describe("CoworkRuntime", () => {
  test("zero agents ⇒ silent no-op tick", async () => {
    const { runtime, events, close } = makeRuntime();
    try {
      await runtime.tick();
      expect(events).toEqual([]);
    } finally {
      close();
    }
  });

  test("pending message → turn with identity prompt + persistent session", async () => {
    const { runtime, agents, mailbox, calls, close } = makeRuntime();
    try {
      const agent = agents.upsert({
        name: "Bugfixer",
        role: "triage",
        instructions: "Always check tests first.",
      });
      mailbox.send({ fromAgentId: "human", toAgentId: agent.id, body: "Fix bug #1." });

      await runtime.tick();
      expect(calls).toHaveLength(1);
      expect(calls[0].sessionId).toBe(`cowork:${agent.id}`);
      expect(calls[0].prompt).toContain('"Bugfixer"');
      expect(calls[0].prompt).toContain("Always check tests first.");
      expect(calls[0].prompt).toContain("The user writes:");
      expect(calls[0].prompt).toContain("Fix bug #1.");
    } finally {
      close();
    }
  });

  test("A→B message produces B's reply into A's inbox with hops+1", async () => {
    const { runtime, agents, mailbox, close } = makeRuntime();
    try {
      const a = agents.upsert({ name: "Alice" });
      const b = agents.upsert({ name: "Bob" });
      mailbox.send({ fromAgentId: a.id, toAgentId: b.id, body: "ping", threadId: "t1" });

      await runtime.tick();
      const replies = mailbox.inbox(a.id);
      expect(replies).toHaveLength(1);
      expect(replies[0].fromAgentId).toBe(b.id);
      expect(replies[0].threadId).toBe("t1");
      expect(replies[0].body).toBe("answer from Bob");
      expect(JSON.parse(replies[0].payloadJson ?? "{}")).toEqual({ coworkHops: 1 });
    } finally {
      close();
    }
  });

  test("hop counter stops the ping-pong at the configured limit", async () => {
    const { runtime, agents, mailbox, close } = makeRuntime();
    try {
      const a = agents.upsert({ name: "Alice" });
      const b = agents.upsert({ name: "Bob" });
      // Seed a thread already AT the hop limit.
      mailbox.send({
        fromAgentId: a.id,
        toAgentId: b.id,
        body: "ping",
        payloadJson: JSON.stringify({ coworkHops: DEFAULT_MAX_REPLY_HOPS }),
      });

      await runtime.tick();
      // Bob still processed it, but his reply is dropped.
      expect(mailbox.inbox(a.id)).toEqual([]);
      expect(mailbox.outbox(b.id)).toEqual([]);
    } finally {
      close();
    }
  });

  test("a reply to the person is stored for them, not delivered to any teammate", async () => {
    // It used to live only in the live event: a reopened chat showed the
    // question with no answer, and the main agent could never read it.
    const { runtime, agents, mailbox, calls, close } = makeRuntime();
    try {
      const b = agents.upsert({ name: "Bob" });
      const asked = mailbox.send({ fromAgentId: "human", toAgentId: b.id, body: "hello", threadId: "t1" });
      await runtime.tick();
      const stored = mailbox.inbox(HUMAN);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ fromAgentId: b.id, threadId: "t1", body: "answer from Bob" });
      expect(JSON.parse(stored[0].payloadJson ?? "{}")).toEqual({ coworkHops: 0, replyTo: asked.id });
      // No loop: one turn, and nothing is left for anyone to drain.
      await runtime.tick();
      expect(calls).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("when a teammate cannot answer the person, the reason is stored too", async () => {
    const { runtime, agents, mailbox, close } = makeRuntime({
      runTurn: async () => {
        throw new Error("model is down");
      },
    });
    try {
      const b = agents.upsert({ name: "Bob" });
      mailbox.send({ fromAgentId: "human", toAgentId: b.id, body: "hello", threadId: "t1" });
      await runtime.tick();
      const [stored] = mailbox.inbox(HUMAN);
      expect(stored?.body).toBe("model is down");
      expect(JSON.parse(stored?.payloadJson ?? "{}").failed).toBe(true);
    } finally {
      close();
    }
  });

  test("history folds each stored answer into the question it answers", () => {
    const { agents, mailbox, close } = makeRuntime();
    try {
      const b = agents.upsert({ name: "Bob" });
      const q = mailbox.send({ fromAgentId: "human", toAgentId: b.id, body: "hello", threadId: "t1" });
      mailbox.send({
        fromAgentId: b.id, toAgentId: HUMAN, threadId: "t1", body: "hi there",
        payloadJson: JSON.stringify({ coworkHops: 0, replyTo: q.id }),
      });
      const rows = withHumanReplies(mailbox.byThread("t1"));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: q.id, body: "hello", reply: "hi there", replyFailed: false });
    } finally {
      close();
    }
  });

  test("a message is picked up at once, not at the next tick", async () => {
    const { agents, mailbox, handoffs, close } = makeRuntime();
    const seen: string[] = [];
    const runtime = new CoworkRuntime({
      agents, mailbox, handoffs, emitEvent: () => {},
      // Far longer than the test: only the wake can have started the turn.
      tickIntervalMs: 60_000,
      runTurn: async (agent) => {
        seen.push(agent.name);
        return { text: "ok", finished: true };
      },
    });
    try {
      const b = agents.upsert({ name: "Bob" });
      runtime.start();
      mailbox.send({ fromAgentId: "human", toAgentId: b.id, body: "now please" });
      for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(seen).toEqual(["Bob"]);
    } finally {
      runtime.stop();
      close();
    }
  });

  test("one slow teammate does not hold another's inbox shut", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const { runtime, agents, mailbox, close } = makeRuntime({
      runTurn: async (agent) => {
        if (agent.name === "Slow") await gate;
        done.push(agent.name);
        return { text: "ok", finished: true };
      },
    });
    try {
      const slow = agents.upsert({ name: "Slow" });
      const quick = agents.upsert({ name: "Quick" });
      mailbox.send({ fromAgentId: "human", toAgentId: slow.id, body: "long job" });
      const first = runtime.tick();
      await new Promise((r) => setTimeout(r, 10));
      // Arrives while Slow is still mid-turn. The old whole-tick flag made this
      // tick a no-op, so Quick waited for Slow to finish.
      mailbox.send({ fromAgentId: "human", toAgentId: quick.id, body: "quick one" });
      await runtime.tick();
      expect(done).toEqual(["Quick"]);
      release();
      await first;
      expect(done).toEqual(["Quick", "Slow"]);
    } finally {
      close();
    }
  });

  test("unfinished turns are rejected with a clear reason event", async () => {
    const { runtime, agents, mailbox, events, close } = makeRuntime({
      runTurn: async () => ({ text: "partial", finished: false }),
    });
    try {
      const b = agents.upsert({ name: "Bob" });
      const msg = mailbox.send({ fromAgentId: "human", toAgentId: b.id, body: "big task" });
      await runtime.tick();

      const stored = mailbox.get(msg.id);
      expect(stored?.status).toBe("rejected");
      const rejected = events.find(
        (e): e is Extract<OutboundEvent, { type: "cowork_event" }> =>
          e.type === "cowork_event" && e.eventType === "message_rejected",
      );
      expect(rejected?.data.reason).toContain("unfinished");
    } finally {
      close();
    }
  });

  test("handoff → claimed turn → result mailed back to sender", async () => {
    const { runtime, agents, mailbox, handoffs, calls, close } = makeRuntime();
    try {
      const a = agents.upsert({ name: "Chief" });
      const b = agents.upsert({ name: "Worker" });
      handoffs.initiate({
        fromAgentId: a.id,
        toAgentId: b.id,
        threadId: "t9",
        summary: "Sweep the floor.",
        artifactRefs: ["memory://chores/1"],
      });

      await runtime.tick();
      expect(calls[0].sessionId).toBe(`cowork:${b.id}`);
      expect(calls[0].prompt).toContain("handed this task to you");
      expect(calls[0].prompt).toContain("memory://chores/1");

      // Sender got the result by mail; the handoff is completed.
      const results = mailbox.inbox(a.id);
      expect(results).toHaveLength(1);
      expect(results[0].body).toContain("[handoff result]");
      const h = handoffs.history(b.id)[0];
      expect(h.status).toBe("completed");
    } finally {
      close();
    }
  });

  test("start() is idempotent and stop() halts scheduling", async () => {
    const { runtime, close } = makeRuntime();
    try {
      runtime.start();
      runtime.start(); // second call must not stack timers
      runtime.stop();
      runtime.stop(); // double-stop safe
      // No direct assertion possible on private timer without exposing it;
      // the contract exercised here is "does not throw".
      expect(true).toBe(true);
    } finally {
      close();
    }
  });
});
