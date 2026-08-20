/**
 * Memory Resume (Sprint 1.5) — get/set round-trip + corruption-resistance.
 *
 * Restart / model / provider / embedding / version / workspace scenarios
 * land in `memory-resilience.test.ts` (Sprint 1.10). Here we pin the
 * minimal contract that the WelcomeBack banner relies on.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { bannerTitle, getCurrentTask, setCurrentTask } from "../src/memory/resume.ts";

describe("memory/resume", () => {
  test("absent meta → getCurrentTask returns null", () => {
    const { raw: db, close } = openDatabase(":memory:");
    expect(getCurrentTask(db)).toBeNull();
    close();
  });

  test("set + get round-trip preserves title and ts", () => {
    const { raw: db, close } = openDatabase(":memory:");
    setCurrentTask(db, {
      title: "Cinderpaw onboarding refactor",
      ts: 1700000000000,
    });
    const back = getCurrentTask(db);
    expect(back?.title).toBe("Cinderpaw onboarding refactor");
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
      title: "settle into Cinderpaw",
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

/**
 * The banner and the TUI row are headings, and stored titles are whole
 * sentences taken from what the user asked for. "Welcome back to <sentence>"
 * rendered as a paragraph in a hero slot.
 */
describe("bannerTitle", () => {
  test("a short title is passed through untouched", () => {
    expect(bannerTitle("fix the login bug")).toBe("fix the login bug");
  });

  test("a whole sentence is cut to a few words, on a word boundary", () => {
    const long =
      "add persistent run state so an unattended run survives a sidecar restart";
    const out = bannerTitle(long);
    expect(out.length).toBeLessThanOrEqual(43); // budget + the ellipsis
    expect(out.endsWith("…")).toBe(true);
    // Never mid-word: it's a prefix of the original AND the original continues
    // with a space, which is what "cut on a word boundary" actually means.
    const head = out.slice(0, -1);
    expect(long.startsWith(head)).toBe(true);
    expect(long.charAt(head.length)).toBe(" ");
  });

  test("trailing punctuation is dropped — a heading is not an interrupted sentence", () => {
    expect(bannerTitle("fix the login bug,")).toBe("fix the login bug");
    expect(bannerTitle("ship the release.")).toBe("ship the release");
  });

  test("newlines and runs of whitespace collapse", () => {
    expect(bannerTitle("fix   the\nlogin\t bug")).toBe("fix the login bug");
  });

  test("one absurdly long word is hard-cut rather than left to overflow", () => {
    const out = bannerTitle("a".repeat(90));
    expect(out.length).toBeLessThanOrEqual(43);
    expect(out.endsWith("…")).toBe(true);
  });

  test("an exactly-at-budget title keeps every word and gains no ellipsis", () => {
    const exact = "x".repeat(42);
    expect(bannerTitle(exact)).toBe(exact);
  });
});
