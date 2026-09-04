/**
 * The `--arm agent` runtime: the supervisor, the lessons, the level boundary.
 *
 * Against the REAL cowork mailbox on a real (in-memory) database, because the
 * point of this module is that the primitives are wirable without `boot()`. A
 * faked mailbox would test the wiring against a drawing of the thing it wires.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { createArcAgentRuntime } from "../src/arc/agent-runtime.ts";
import type { PolicyMessage } from "../src/arc/model-policy.ts";

function runtime(over: Parameters<typeof createArcAgentRuntime>[0] extends never ? never : Partial<Parameters<typeof createArcAgentRuntime>[0]> = {}) {
  const db = openDatabase(":memory:");
  const sent: PolicyMessage[][] = [];
  const rt = createArcAgentRuntime({
    db: db.raw,
    complete: async (messages) => {
      sent.push(messages);
      return "Press ACTION6 near the top-left block.";
    },
    reviewEvery: 3,
    ...over,
  });
  return { rt, sent };
}

/** Feed n presses, alternating dead/live, ticking after each. */
async function play(rt: ReturnType<typeof createArcAgentRuntime>, n: number, changed: (i: number) => boolean) {
  for (let i = 1; i <= n; i++) {
    rt.onOutcome({ action: i % 2 === 0 ? "ACTION4" : "ACTION6:1,1", changed: changed(i), presses: i });
    await rt.tick();
  }
}

describe("the supervisor", () => {
  test("says nothing until it has been asked, then holds a note", async () => {
    const { rt } = runtime();
    expect(rt.strategy()).toBeNull();
    await play(rt, 3, () => true);
    expect(rt.strategy()).toBe("Press ACTION6 near the top-left block.");
    expect(rt.stats().reviews).toBe(1);
  });

  test("costs exactly one model call per cadence, and says so", async () => {
    const { rt, sent } = runtime();
    await play(rt, 9, () => true);
    // 9 presses at every-3 is 3 reviews, not 9 and not 4.
    expect(rt.stats().supervisorCalls).toBe(3);
    expect(sent.length).toBe(3);
    // The number a run reports must be the number that was spent.
    expect(rt.stats().reviews).toBe(3);
  });

  test("is told what the presses proved, not just what was pressed", async () => {
    const { rt, sent } = runtime();
    // ACTION4 (even presses) never works; ACTION6 (odd) always does.
    await play(rt, 6, (i) => i % 2 !== 0);
    const prompt = sent[0]!.map((m) => m.content).join("\n");
    expect(prompt).toContain("ACTION4 did nothing in all");
    expect(prompt).toContain("ACTION6 changed the board in all");
  });

  test("a supervisor that fails does not stop play, and is counted", async () => {
    const { rt } = runtime({ complete: async () => { throw new Error("gateway is down"); } });
    await play(rt, 6, () => true);
    expect(rt.stats().supervisorFailures).toBe(2);
    expect(rt.stats().reviews).toBe(0);
    expect(rt.strategy()).toBeNull(); // no note, and no crash
  });

  test("a reply that is only reasoning is not advice", async () => {
    const { rt } = runtime({ complete: async () => "<think>hmm, hard to say</think>   " });
    await play(rt, 3, () => true);
    expect(rt.strategy()).toBeNull();
    expect(rt.stats().supervisorFailures).toBe(1);
  });

  test("the message really goes through the cowork mailbox", async () => {
    const db = openDatabase(":memory:");
    const rt = createArcAgentRuntime({
      db: db.raw,
      complete: async () => "keep clicking",
      reviewEvery: 2,
    });
    await play(rt, 2, () => true);
    const { CoworkMailboxRepo } = await import("../src/cowork/mailbox.ts");
    const box = new CoworkMailboxRepo(db.raw);
    const inbox = box.inbox("arc-supervisor");
    expect(inbox.length).toBe(1);
    // Drained and marked, not left pending — that is the loop doing the work.
    expect(inbox[0]!.status).toBe("processed");
  });
});

describe("lessons carried between games", () => {
  test("are derived from what was measured, and cost no model call", async () => {
    const { rt, sent } = runtime({ reviewEvery: 1000 });
    await play(rt, 8, (i) => i % 2 !== 0);
    expect(sent.length).toBe(0);
    expect(rt.lessons()).toEqual([
      "ACTION6 changed the board in all 4 presses.",
      "ACTION4 did nothing in all 4 presses.",
    ]);
  });

  test("what an earlier game showed reaches the next game's supervisor", async () => {
    const { rt, sent } = runtime({ priorLessons: ["ACTION7 did nothing in all 9 presses."] });
    await play(rt, 3, () => true);
    expect(sent[0]!.map((m) => m.content).join("\n")).toContain("ACTION7 did nothing in all 9 presses.");
  });
});

describe("the level boundary", () => {
  test("reviews immediately instead of waiting for the cadence", async () => {
    const { rt } = runtime({ reviewEvery: 50 });
    await play(rt, 4, () => true);
    expect(rt.stats().reviews).toBe(0); // nowhere near the cadence
    await rt.levelBoundary(1);
    expect(rt.stats().reviews).toBe(1);
    expect(rt.stats().boundaries).toBe(1);
  });

  test("reports the trigger by the name the RSI scheduler uses", async () => {
    const seen: string[] = [];
    const { rt } = runtime({ onBoundary: (trigger) => seen.push(trigger) });
    await rt.levelBoundary(2);
    expect(seen).toEqual(["environment_boundary"]);
  });
});

describe("configuration is checked, not assumed", () => {
  test("a cadence of zero would review on every press forever", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      createArcAgentRuntime({ db: db.raw, complete: async () => "x", reviewEvery: 0 }),
    ).toThrow(/reviewEvery/);
  });
});
