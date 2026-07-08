/**
 * Memory Resume (Sprint 1.5) — get/set round-trip + corruption-resistance.
 *
 * Restart / model / provider / embedding / version / workspace scenarios
 * land in `memory-resilience.test.ts` (Sprint 1.10). Here we pin the
 * minimal contract that the WelcomeBack banner relies on.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { getCurrentTask, setCurrentTask } from "../src/memory/resume.ts";

describe("memory/resume", () => {
  test("absent meta → getCurrentTask returns null", () => {
    const { raw: db, close } = openDatabase(":memory:");
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("set + get round-trip preserves title and ts", () => {
    const { raw: db, close } = openDatabase(":memory:");
    setCurrentTask(db, {
      title: "Feral onboarding refactor",
      ts: 1700000000000,
    });
    const back = getCurrentTask(db);
    expect(back?.title).toBe("Feral onboarding refactor");
    expect(back?.ts).toBe(1700000000000);
    close();
  });

  test("set(null) clears the task", () => {
    const { raw: db, close } = openDatabase(":memory:");
    setCurrentTask(db, { title: "anything", ts: 1 });
    expect(getCurrentTask(db)?.title).toBe("anything");
    setCurrentTask(db, null);
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("corrupt JSON value is treated as no task", () => {
    const { raw: db, close } = openDatabase(":memory:");
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run("current_task", "not-json{", Date.now());
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("missing ts is treated as no task", () => {
    const { raw: db, close } = openDatabase(":memory:");
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run("current_task", JSON.stringify({ title: "no-ts" }), Date.now());
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("empty title is treated as no task", () => {
    const { raw: db, close } = openDatabase(":memory:");
    db.prepare("INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)")
      .run("current_task", JSON.stringify({ title: "", ts: 1 }), Date.now());
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("workspaceId round-trips alongside title/ts", () => {
    const { raw: db, close } = openDatabase(":memory:");
    setCurrentTask(db, {
      title: "settle into Feral",
      ts: 1700000000000,
      workspaceId: "ws-uuid-1",
    });
    expect(getCurrentTask(db)?.workspaceId).toBe("ws-uuid-1");
    close();
  });

  test("set overwrites previous task (idempotent on re-set)", () => {
    const { raw: db, close } = openDatabase(":memory:");
    setCurrentTask(db, { title: "first", ts: 1 });
    setCurrentTask(db, { title: "second", ts: 2 });
    expect(getCurrentTask(db)?.title).toBe("second");
    expect(getCurrentTask(db)?.ts).toBe(2);
    close();
  });
});
