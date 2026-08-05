/**
 * The whole point, end to end: a run dies with the process, and the next boot
 * picks it up instead of leaving the user with nothing.
 *
 * Process death is simulated the honest way — by NOT writing a terminal status,
 * which is exactly what a killed process does. Nothing here mocks a signal,
 * because the design deliberately does not catch any.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { RunStore, type StartRunInput } from "../src/core/run-store.ts";
import { resumeInterruptedRuns, DEFAULT_MAX_RESUMES } from "../src/core/run-resume.ts";
import { renderDigest } from "../src/core/digest.ts";
import { ChannelAskRouter } from "../src/core/ask-user-channel.ts";
import { runAgent, type ConnectorRunHooks } from "../src/transports/connectors.ts";
import type { UnattendedResult } from "../src/core/unattended.ts";
import type { ChangeSummary } from "../src/core/safety-point.ts";
import type { TurnOutcome, TurnResult } from "../src/core/agent-loop.ts";

const NOW = 1_800_000_000_000;

function store() {
  const { raw, close } = openDatabase(":memory:");
  return { store: new RunStore(raw), close };
}

function seed(s: RunStore, over: Partial<StartRunInput> = {}) {
  return s.startRun({
    sessionId: "discord:c1:u1",
    mission: "add a --json flag",
    deadlineAt: NOW + 3_600_000,
    continuationBudget: 4,
    safetyRoot: null,
    safetyBefore: null,
    safetyGitDir: null,
    doneWhen: null,
    delivery: { kind: "discord", target: "chan-1", sessionId: "discord:c1:u1" },
    ...over,
  })!;
}

function turnOn(s: RunStore, runId: string, over: Record<string, unknown> = {}) {
  s.appendTurn({
    runId, startedAt: NOW - 5000, durationMs: 1000, outcome: "out_of_time",
    toolCalls: 4, continuation: false, replan: false, tokens: 500,
    filesChanged: 2, todosClosed: 1, doneWhenPass: null,
    ...over,
  } as Parameters<RunStore["appendTurn"]>[0]);
}

describe("resumeInterruptedRuns", () => {
  test("a run left running is resumed, and the resume is recorded", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    turnOn(s, run.id);
    // …and then the process dies: no finish() call. That is the whole simulation.

    const resumed: string[] = [];
    await resumeInterruptedRuns(s, NOW, async (r) => { resumed.push(r.id); }, async () => {});

    expect(resumed).toEqual([run.id]);
    const back = s.get(run.id)!;
    expect(back.resumes).toBe(1);
    // Resumed from after the last recorded turn, so "did this resume achieve
    // anything" is answerable next time.
    expect(back.lastResumeSeq).toBe(2);
    // Still running: it was handed back to the agent, not concluded.
    expect(back.status).toBe("running");
    close();
  });

  test("a run past its deadline is given up and delivered, never left silent", async () => {
    const { store: s, close } = store();
    const run = seed(s, { deadlineAt: NOW - 1 });
    const delivered: string[] = [];
    await resumeInterruptedRuns(s, NOW, async () => {}, async (r, d) => {
      delivered.push(`${r.id}:${d.reason}`);
    });
    expect(delivered).toEqual([`${run.id}:process_died`]);
    expect(s.get(run.id)!.status).toBe("unfinished");
    expect(s.runningRuns()).toHaveLength(0);
    close();
  });

  test("a finished run is never touched by the resume pass", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed");
    let touched = 0;
    await resumeInterruptedRuns(s, NOW, async () => { touched++; }, async () => { touched++; });
    expect(touched).toBe(0);
    close();
  });

  test("a run at the resume cap is given up as needing attention", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    for (let i = 0; i < DEFAULT_MAX_RESUMES; i++) s.markResumed(run.id, 1);
    const reasons: string[] = [];
    await resumeInterruptedRuns(s, NOW, async () => {}, async (_r, d) => { reasons.push(d.reason); });
    expect(reasons).toEqual(["resume_cap"]);
    expect(s.get(run.id)!.status).toBe("needs_attention");
    close();
  });

  test("a delivery that throws still leaves the run concluded, not running", async () => {
    // Otherwise the next boot picks it up again for the same doomed reason,
    // forever.
    const { store: s, close } = store();
    const run = seed(s, { deadlineAt: NOW - 1 });
    await resumeInterruptedRuns(s, NOW, async () => {}, async () => {
      throw new Error("channel is gone");
    });
    expect(s.get(run.id)!.status).toBe("unfinished");
    close();
  });

  test("one run failing does not abandon the others", async () => {
    const { store: s, close } = store();
    const first = seed(s, { sessionId: "s1" });
    const second = seed(s, { sessionId: "s2" });
    const seen: string[] = [];
    await resumeInterruptedRuns(s, NOW, async (r) => {
      seen.push(r.id);
      if (r.id === first.id) throw new Error("boom");
    }, async () => {});
    expect(seen).toEqual([first.id, second.id]);
    close();
  });
});

describe("renderDigest run-level reason", () => {
  const result: UnattendedResult = {
    text: "partial",
    outcome: "out_of_time",
    finished: false,
    turns: [{ outcome: "out_of_time", toolCalls: 2, durationMs: 1000, continuation: false }],
    stoppedBecause: "continuation_budget",
  };
  const changes: ChangeSummary = {
    available: true, files: [], insertions: 0, deletions: 0, restoreHint: null,
  };
  const check = { passed: true, checked: false, detail: "d" };

  test("a run-level reason is shown when there is one", () => {
    const out = renderDigest(result, changes, check, null,
      "the process running it stopped, and its deadline has since passed");
    expect(out).toContain("deadline has since passed");
  });

  test("without one, the digest is byte-identical to before", () => {
    expect(renderDigest(result, changes, check, null)).toBe(
      renderDigest(result, changes, check, null, undefined),
    );
  });
});

describe("a connector turn becomes a durable run", () => {
  /** An agent whose turn ends with a scripted outcome. */
  function fakeAgent(outcome: TurnOutcome) {
    return {
      handle: async () => "unused",
      handleTurn: async (): Promise<TurnResult> => ({
        text: "done",
        outcome,
        toolCallCount: 2,
        incomplete: false,
      }),
    };
  }

  function fakeHooks() {
    const began: Array<{ sessionId: string; mission: string; surface: string; target: string }> = [];
    const finished: UnattendedResult[] = [];
    const recorded: number[] = [];
    const hooks: ConnectorRunHooks = {
      begin: async (sessionId, mission, surface, target) => {
        began.push({ sessionId, mission, surface, target });
        return {
          recorder: { record: (t) => { recorded.push(t.durationMs); } },
          done: (run) => { finished.push(run); },
        };
      },
    };
    return { hooks, began, finished, recorded };
  }

  test("the run is begun with the surface and channel it came from, and closed out", async () => {
    const { hooks, began, finished, recorded } = fakeHooks();
    const reply = await runAgent(
      fakeAgent("completed"), "discord:c1:u1", "add a --json flag", "discord-42",
      undefined, undefined, { hooks, surface: "discord", target: "c1" },
    );

    expect(reply).toBe("done");
    expect(began).toEqual([
      { sessionId: "discord:c1:u1", mission: "add a --json flag", surface: "discord", target: "c1" },
    ]);
    // Every turn reached the recorder, and the run was concluded — not left
    // `running` for a later boot to pick up as a phantom crash.
    expect(recorded).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.finished).toBe(true);
  });

  test("an unfinished turn is closed out as unfinished, not quietly as done", async () => {
    const { hooks, finished } = fakeHooks();
    await runAgent(
      fakeAgent("no_answer"), "discord:c1:u1", "task", "discord-42",
      undefined, undefined, { hooks, surface: "discord", target: "c1" },
    );
    expect(finished[0]!.finished).toBe(false);
  });

  test("begin returning null (a run already in flight) still answers the message", async () => {
    // Refusing the second RUN must not refuse the reply — the person is waiting.
    const hooks: ConnectorRunHooks = { begin: async () => null };
    const reply = await runAgent(
      fakeAgent("completed"), "discord:c1:u1", "task", "discord-42",
      undefined, undefined, { hooks, surface: "discord", target: "c1" },
    );
    expect(reply).toBe("done");
  });

  test("no hooks at all behaves exactly as before", async () => {
    const reply = await runAgent(fakeAgent("completed"), "discord:c1:u1", "task", "discord-42");
    expect(reply).toBe("done");
  });
});

describe("ChannelAskRouter.notify", () => {
  test("a digest reaches the chat behind a session", async () => {
    // The out-of-band path a resumed run needs: nobody is mid-turn, so there is
    // no reply to ride along with.
    const router = new ChannelAskRouter();
    const sent: Array<{ sessionId: string; text: string }> = [];
    router.registerSender("discord", async (sessionId, text) => { sent.push({ sessionId, text }); });

    expect(await router.notify("discord:c1:u1", "✅ Done — and verified.")).toBe(true);
    expect(sent).toEqual([{ sessionId: "discord:c1:u1", text: "✅ Done — and verified." }]);
  });

  test("no sender for that surface reports false rather than throwing", async () => {
    // A connector that is disabled or not yet connected must not take down the
    // boot resume pass.
    const router = new ChannelAskRouter();
    expect(await router.notify("discord:c1:u1", "hi")).toBe(false);
  });

  test("a sender that throws reports false, and the failure does not escape", async () => {
    const router = new ChannelAskRouter();
    router.registerSender("discord", async () => { throw new Error("401"); });
    expect(await router.notify("discord:c1:u1", "hi")).toBe(false);
  });
});
