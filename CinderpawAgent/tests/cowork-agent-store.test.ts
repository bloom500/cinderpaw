/**
 * Tests for the cowork agent store (Agent Cowork S1).
 *
 * Contract under test:
 * - CRUD over `cowork_agents` with createdAt stability on update,
 * - model pin set AND cleared (undefined ⇒ Brain routes again),
 * - remove() reports whether a row was actually deleted,
 * - a fresh database lists zero agents (fresh-install invisibility).
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CoworkAgentRepo } from "../src/cowork/agent-store.ts";

function makeRepo() {
  const { raw: db, close } = openDatabase(":memory:");
  return { repo: new CoworkAgentRepo(db), close };
}

describe("CoworkAgentRepo", () => {
  test("a fresh database has zero agents", () => {
    const { repo, close } = makeRepo();
    try {
      expect(repo.list()).toEqual([]);
    } finally {
      close();
    }
  });

  test("upsert persists identity fields and assigns an id", () => {
    const { repo, close } = makeRepo();
    try {
      const agent = repo.upsert({
        name: "Bug Fixes",
        role: "triage",
        instructions: "Fix bugs. Report back.",
      });
      expect(agent.id).toBeTruthy();
      expect(agent.name).toBe("Bug Fixes");
      expect(agent.role).toBe("triage");
      expect(agent.instructions).toBe("Fix bugs. Report back.");
      expect(agent.modelPin).toBeUndefined();

      const fetched = repo.get(agent.id);
      expect(fetched).toEqual(agent);
    } finally {
      close();
    }
  });

  test("update keeps id and createdAt, changes the rest", () => {
    const { repo, close } = makeRepo();
    try {
      const created = repo.upsert({ name: "Sales", role: "outbound" });
      const updated = repo.upsert({
        id: created.id,
        name: "Sales Renamed",
        instructions: "New standing prompt.",
      });
      expect(updated.id).toBe(created.id);
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      expect(updated.name).toBe("Sales Renamed");
      // Role not supplied on update ⇒ cleared to default, not stale.
      expect(updated.role).toBe("");
      expect(repo.list().map((a) => a.id)).toEqual([created.id]);
    } finally {
      close();
    }
  });

  test("modelPin can be set and later cleared", () => {
    const { repo, close } = makeRepo();
    try {
      const pinned = repo.upsert({
        name: "Chief of Staff",
        modelPin: "some-brain-model",
      });
      expect(pinned.modelPin).toBe("some-brain-model");

      const unpinned = repo.upsert({ id: pinned.id, name: "Chief of Staff" });
      expect(unpinned.modelPin).toBeUndefined();
      expect(repo.get(pinned.id)?.modelPin).toBeUndefined();
    } finally {
      close();
    }
  });

  test("list orders oldest-first even after updates", () => {
    const { repo, close } = makeRepo();
    try {
      const a = repo.upsert({ name: "First" });
      const b = repo.upsert({ name: "Second" });
      repo.upsert({ id: b.id, name: "Second v2" });
      expect(repo.list().map((x) => x.name)).toEqual(["First", "Second v2"]);
      void a;
    } finally {
      close();
    }
  });

  test("remove returns true once, then false", () => {
    const { repo, close } = makeRepo();
    try {
      const agent = repo.upsert({ name: "Doomed" });
      expect(repo.remove(agent.id)).toBe(true);
      expect(repo.remove(agent.id)).toBe(false);
      expect(repo.get(agent.id)).toBeUndefined();
    } finally {
      close();
    }
  });

  test("remove on unknown id is a clean false", () => {
    const { repo, close } = makeRepo();
    try {
      expect(repo.remove("no-such-id")).toBe(false);
    } finally {
      close();
    }
  });
});
