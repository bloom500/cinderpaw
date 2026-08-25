/**
 * Tests for the cowork handoff service (Agent Cowork S2) — REAL SQLite.
 *
 * The state machine is the contract:
 *   initiated → accepted → completed
 *   initiated|accepted → failed
 * and nothing else. Illegal transitions throw; complete-without-accept
 * is the silent-drop the protocol exists to prevent, so it gets a
 * dedicated test.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkHandoffService } from "../src/cowork/handoff.ts";

function makeService() {
  const { raw, close } = openDatabase(":memory:");
  return { svc: new CoworkHandoffService(raw), close };
}

describe("CoworkHandoffService", () => {
  test("a fresh database has empty history", () => {
    const { svc, close } = makeService();
    try {
      expect(svc.history("agent-a")).toEqual([]);
    } finally {
      close();
    }
  });

  test("full happy path: initiate → accept → complete", () => {
    const { svc, close } = makeService();
    try {
      const h = svc.initiate({
        fromAgentId: "chief",
        toAgentId: "bugfixer",
        threadId: "thread-1",
        summary: "Fix issue #42 and report back.",
        artifactRefs: ["memory://tasks/42"],
      });
      expect(h.status).toBe("initiated");
      expect(h.closedAt).toBeNull();

      const accepted = svc.accept(h.id);
      expect(accepted.status).toBe("accepted");
      expect(accepted.closedAt).toBeNull();

      const done = svc.complete(h.id, "Fixed in commit abc123; tests pass.");
      expect(done.status).toBe("completed");
      expect(done.resultSummary).toBe("Fixed in commit abc123; tests pass.");
      expect(done.closedAt).not.toBeNull();

      // The audit view shows the full lifecycle to either party.
      for (const viewer of ["chief", "bugfixer"]) {
        const entry = svc.history(viewer).find((x) => x.id === h.id);
        expect(entry?.status).toBe("completed");
        expect(entry?.artifactRefs).toEqual(["memory://tasks/42"]);
      }
    } finally {
      close();
    }
  });

  test("complete without accept throws — the silent-drop guard", () => {
    const { svc, close } = makeService();
    try {
      const h = svc.initiate({
        fromAgentId: "chief",
        toAgentId: "bugfixer",
        summary: "Nobody claimed this.",
      });
      expect(() => svc.complete(h.id, "done")).toThrow(
        /cannot move to 'completed'/,
      );
      // State unchanged after the rejected transition.
      expect(svc.get(h.id)?.status).toBe("initiated");
    } finally {
      close();
    }
  });

  test("accept twice is rejected", () => {
    const { svc, close } = makeService();
    try {
      const h = svc.initiate({ fromAgentId: "a", toAgentId: "b", summary: "s" });
      svc.accept(h.id);
      expect(() => svc.accept(h.id)).toThrow(/is 'accepted'/);
    } finally {
      close();
    }
  });

  test("fail works from both initiated and accepted", () => {
    const { svc, close } = makeService();
    try {
      const h1 = svc.initiate({ fromAgentId: "a", toAgentId: "b", summary: "s" });
      const failed = svc.fail(h1.id, "receiver offline");
      expect(failed.status).toBe("failed");
      expect(failed.resultSummary).toBe("receiver offline");
      expect(failed.closedAt).not.toBeNull();

      const h2 = svc.initiate({ fromAgentId: "a", toAgentId: "c", summary: "s" });
      svc.accept(h2.id);
      expect(svc.fail(h2.id, "blocked upstream").status).toBe("failed");
    } finally {
      close();
    }
  });

  test("terminal states are frozen — no fail after complete", () => {
    const { svc, close } = makeService();
    try {
      const h = svc.initiate({ fromAgentId: "a", toAgentId: "b", summary: "s" });
      svc.accept(h.id);
      svc.complete(h.id, "done properly");
      expect(() => svc.fail(h.id, "too late")).toThrow(/already completed/);
    } finally {
      close();
    }
  });

  test("empty result summary / failure reason refused", () => {
    const { svc, close } = makeService();
    try {
      const h = svc.initiate({ fromAgentId: "a", toAgentId: "b", summary: "s" });
      svc.accept(h.id);
      expect(() => svc.complete(h.id, "   ")).toThrow(/non-empty/);

      const h2 = svc.initiate({ fromAgentId: "a", toAgentId: "c", summary: "s" });
      expect(() => svc.fail(h2.id, "")).toThrow(/non-empty/);
    } finally {
      close();
    }
  });

  test("unknown id throws with a clear message", () => {
    const { svc, close } = makeService();
    try {
      expect(() => svc.accept("no-such-id")).toThrow(/unknown handoff/);
    } finally {
      close();
    }
  });

  test("history covers both directions, no duplicates", () => {
    const { svc, close } = makeService();
    try {
      const h1 = svc.initiate({ fromAgentId: "chief", toAgentId: "w1", summary: "1" });
      const h2 = svc.initiate({ fromAgentId: "w2", toAgentId: "chief", summary: "2" });
      const ids = svc.history("chief").map((h) => h.id);
      expect(ids).toContain(h1.id);
      expect(ids).toContain(h2.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      close();
    }
  });
});
