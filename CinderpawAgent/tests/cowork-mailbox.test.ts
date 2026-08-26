/**
 * Tests for the cowork mailbox (Agent Cowork S2) — REAL SQLite, not a
 * fake db object. The point is to prove schema + SQL correctness, which
 * an in-memory stand-in cannot.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkMailboxRepo } from "../src/cowork/mailbox.ts";

function makeRepo() {
  const { raw, close } = openDatabase(":memory:");
  return {
    repo: new CoworkMailboxRepo(raw),
    raw,
    close,
  };
}

describe("CoworkMailboxRepo", () => {
  test("a fresh database has an empty inbox", () => {
    const { repo, close } = makeRepo();
    try {
      expect(repo.inbox("agent-a")).toEqual([]);
    } finally {
      close();
    }
  });

  test("send delivers to receiver's inbox and sender's outbox", () => {
    const { repo, close } = makeRepo();
    try {
      const msg = repo.send({
        fromAgentId: "chief",
        toAgentId: "bugfixer",
        threadId: "thread-1",
        body: "Please fix issue #42.",
        payloadJson: JSON.stringify({ priority: "high" }),
      });
      expect(msg.status).toBe("pending");
      expect(msg.readAt).toBeNull();

      const inbox = repo.inbox("bugfixer");
      expect(inbox).toHaveLength(1);
      expect(inbox[0].id).toBe(msg.id);
      expect(inbox[0].body).toBe("Please fix issue #42.");

      const outbox = repo.outbox("chief");
      expect(outbox.map((m) => m.id)).toEqual([msg.id]);
      // Not cross-delivered.
      expect(repo.inbox("chief")).toEqual([]);
    } finally {
      close();
    }
  });

  test("inbox status filter returns only matching messages", () => {
    const { repo, close } = makeRepo();
    try {
      const a = repo.send({ fromAgentId: "x", toAgentId: "a", body: "one" });
      repo.send({ fromAgentId: "x", toAgentId: "a", body: "two" });
      repo.updateStatus(a.id, "processed");

      expect(repo.inbox("a", "pending").map((m) => m.body)).toEqual(["two"]);
      expect(repo.inbox("a", "processed").map((m) => m.body)).toEqual(["one"]);
    } finally {
      close();
    }
  });

  test("updateStatus stamps readAt once, on first leave from pending", () => {
    const { repo, close } = makeRepo();
    try {
      const msg = repo.send({ fromAgentId: "x", toAgentId: "a", body: "hi" });
      expect(repo.updateStatus(msg.id, "read")).toBe(true);
      const afterRead = repo.get(msg.id)!;
      expect(afterRead.readAt).not.toBeNull();

      repo.updateStatus(msg.id, "rejected");
      const afterReject = repo.get(msg.id)!;
      // Original read stamp survives later transitions.
      expect(afterReject.readAt).toBe(afterRead.readAt);
      expect(afterReject.status).toBe("rejected");
    } finally {
      close();
    }
  });

  test("updateStatus on unknown id is a clean false", () => {
    const { repo, close } = makeRepo();
    try {
      expect(repo.updateStatus("no-such-id", "read")).toBe(false);
    } finally {
      close();
    }
  });

  test("inbox orders newest-first regardless of insert gaps", () => {
    const { repo, close } = makeRepo();
    try {
      repo.send({ fromAgentId: "x", toAgentId: "a", body: "old" });
      repo.send({ fromAgentId: "x", toAgentId: "a", body: "new" });
      const bodies = repo.inbox("a").map((m) => m.body);
      expect(bodies).toEqual(["new", "old"]);
    } finally {
      close();
    }
  });
});
