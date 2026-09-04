/**
 * What the last turn learned has to survive the process it learned it in.
 *
 * Memory extraction is deliberately lazy: it waits for the agent to be idle so
 * it never competes with a user's turn. That is right for a desktop session
 * open all afternoon, and wrong for every short-lived process — a cron job, a
 * connector reply, and above all a benchmark task, where the runner sends
 * `shutdown` seconds after the turn ends.
 *
 * The shutdown handler used to close the database and call `process.exit` with
 * the queue still full. On TheAgentCompany that is the entire cross-task
 * story: the agent spends twenty-five minutes working out how a service
 * authenticates, the process dies, and the next task starts from nothing. The
 * loop looks closed in the code and is open in the only place it matters.
 */

import { describe, expect, test } from "bun:test";

import { MemoryExtractor } from "../src/memory/extractor.ts";

/** A router that answers instantly with an extractable fact. */
function fakeRouter(onCall?: () => void) {
  return {
    complete: async () => {
      onCall?.();
      return {
        content: "language: Romanian",
        totalTokens: 12,
        promptTokens: 10,
        completionTokens: 2,
        model: "fake",
        usedFallback: false,
      };
    },
  } as never;
}

/** A router slower than any shutdown budget, so the drain must be the thing
 *  that ends the wait. A real timer rather than a promise that never settles:
 *  a dangling promise leaves the test runner with nothing to wait on and
 *  nothing to clean up, which reads as a hang rather than a result. */
function slowRouter(delayMs = 5000) {
  return {
    complete: () =>
      new Promise((resolve) => {
        const t = setTimeout(
          () => resolve({ content: "language: Romanian", totalTokens: 1, promptTokens: 1, completionTokens: 0, model: "slow", usedFallback: false }),
          delayMs,
        );
        (t as { unref?: () => void }).unref?.();
      }),
  } as never;
}

function stores() {
  const facts: Array<{ key: string; value: string }> = [];
  const semantic = {
    upsert: (key: string, value: string) => { facts.push({ key, value }); },
    all: () => [],
    renderForPrompt: () => "",
  } as never;
  const episodic = { record: () => 1, search: () => [], all: () => [] } as never;
  return { facts, semantic, episodic };
}

const TURNS = [
  { role: "user" as const, content: "GitLab rejects basic auth on the API here." },
  { role: "assistant" as const, content: "Right — a personal access token on PRIVATE-TOKEN works." },
];

describe("MemoryExtractor.drain — the lesson outlives the process", () => {
  test("writes what is queued even though the agent never went idle", async () => {
    const { facts, semantic, episodic } = stores();
    const ex = new MemoryExtractor(fakeRouter(), semantic, episodic);
    // Busy for the whole life of the process, which is the normal shape of a
    // benchmark task: one turn, then shutdown.
    ex.setIdleChecker(() => false);

    ex.extractAsync("s1", TURNS);
    // The lazy path is correctly refusing to run.
    await ex.runPending();
    expect(facts).toHaveLength(0);

    const flushed = await ex.drain(5000);

    // The contract is what reaches DISK, not the counter: the lesson was
    // persisted and nothing was left queued for a process that is about to
    // stop existing. (`written` counts extractions that ran end to end, so a
    // pass that writes its facts and then trips on a later step is honestly
    // not counted — that is why the assertion is on the store.)
    expect(facts.length).toBeGreaterThan(0);
    expect(flushed.pending).toBe(0);
  });

  test("an empty queue drains to nothing, quickly", async () => {
    const { semantic, episodic } = stores();
    let calls = 0;
    const ex = new MemoryExtractor(fakeRouter(() => { calls++; }), semantic, episodic);

    const flushed = await ex.drain(5000);

    expect(flushed).toEqual({ written: 0, pending: 0 });
    expect(calls).toBe(0); // no model call on a shutdown with nothing to say
  });
});
