/**
 * A turn that declares itself finished while the work plainly is not.
 *
 * Observed live: asked to inventory ~250 files, the agent did 9, wrote them up
 * correctly, and ended by offering to continue. Nothing was cut off, so the
 * outcome was `completed`, so no continuation fired, and 4% of a task was
 * delivered as an answer. Every existing defence here guards against a turn
 * being INTERRUPTED; none guarded against one stopping of its own accord.
 *
 * The completion check already existed and already knew the answer — it just
 * ran after everything had stopped, to write a verdict nobody could act on.
 */
import { expect, test } from "bun:test";
import { maxContinuations, runUnattended } from "../src/core/unattended.ts";
import type { TurnResult } from "../src/core/agent-loop.ts";

const done = (text: string): TurnResult => ({
  text,
  outcome: "completed",
  toolCallCount: 1,
  incomplete: false,
});

test("a completed turn is sent back when the assertion says it is not done", async () => {
  const prompts: string[] = [];
  // Starts empty, and each turn writes another 9 — the live shape exactly.
  // `verify` runs AFTER a turn, so the first check sees 9, not 0.
  let entries = 0;

  const run = await runUnattended(
    async (userText) => {
      prompts.push(userText);
      entries += 9; // each continuation actually adds work
      return done(`inventoried up to ${entries}`);
    },
    "inventory every file",
    "m1",
    {
      verify: async () => ({
        passed: entries >= 27,
        detail: `inventory.md has ${entries} entries, needs 27`,
      }),
    },
  );

  expect(run.finished).toBe(true);
  // One original turn plus the continuations the check forced.
  expect(prompts).toHaveLength(3);
  // The failure is quoted at the model, not paraphrased into "you are not done".
  expect(prompts[1]).toContain("inventory.md has 9 entries");
  // And the specific behaviour that ended the live run is named.
  expect(prompts[1]).toMatch(/do not ask/i);
});

test("a passing assertion costs exactly one turn", async () => {
  let turns = 0;
  const run = await runUnattended(
    async () => {
      turns++;
      return done("all 27 done");
    },
    "task",
    "m1",
    { verify: async () => ({ passed: true, detail: "27 entries, needs 27" }) },
  );
  expect(turns).toBe(1);
  expect(run.stoppedBecause).toBe("completed");
});

test("no assertion means the agent's word still stands", async () => {
  // The overwhelming majority of turns. Adding a gate here must not turn every
  // ordinary chat reply into a second completion.
  let turns = 0;
  const run = await runUnattended(
    async () => {
      turns++;
      return done("answered");
    },
    "what time is it",
    "m1",
    {},
  );
  expect(turns).toBe(1);
  expect(run.stoppedBecause).toBe("completed");
});

test("an assertion that can never pass costs a budget, not a night", async () => {
  let turns = 0;
  const run = await runUnattended(
    async () => {
      turns++;
      return done("still claiming done");
    },
    "impossible task",
    "m1",
    { verify: async () => ({ passed: false, detail: "never satisfiable" }) },
  );
  // Bounded by the same continuation budget as everything else in this module.
  // Asserted against the budget itself, not a number: this used to say `< 20`,
  // which was a stand-in for a default of 3 and quietly became a claim about
  // the default the day it was raised. The property is "bounded", not "twenty".
  expect(turns).toBeGreaterThan(1);
  expect(turns).toBeLessThanOrEqual(maxContinuations() + 1);
  expect(run.stoppedBecause).toBe("completed");
});

test("a check that cannot be evaluated is not a failing check", async () => {
  // `verifyIfAsserted` returns null for an assertion it could not run. If that
  // were treated as failure, one bad path would trap a finished run in a loop
  // it has no way to escape.
  let turns = 0;
  await runUnattended(
    async () => {
      turns++;
      return done("done");
    },
    "task",
    "m1",
    { verify: async () => null },
  );
  expect(turns).toBe(1);
});

test("the deadline still wins over an unsatisfied assertion", async () => {
  let turns = 0;
  const run = await runUnattended(
    async () => {
      turns++;
      return done("claiming done");
    },
    "task",
    "m1",
    { deadlineMs: -1, verify: async () => ({ passed: false, detail: "not done" }) },
  );
  // Past the deadline there is no time to spend on another attempt.
  expect(turns).toBe(1);
  expect(run.finished).toBe(true);
});
