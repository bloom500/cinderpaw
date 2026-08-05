/**
 * The window between "this run is over" and "the person knows it".
 *
 * Every crash here is simulated the same honest way as in run-lifecycle.test.ts:
 * by NOT performing the next step. A killed process does not run a handler, does
 * not flush a buffer, and does not get to apologise — it simply stops between
 * two statements, and the only thing that can save the report is what is already
 * on disk at that instant.
 *
 * The six scenarios below are the ones the fix was accepted on. Each is written
 * so it FAILS if the ordering in run-delivery.ts is reversed.
 */

import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { RunStore, type RunRow, type StartRunInput } from "../src/core/run-store.ts";
import {
  MAX_DELIVERY_REFUSALS,
  REDELIVERY_NOTE,
  type DeliveryOutcome,
  deliverAndMark,
  drainUndelivered,
} from "../src/core/run-delivery.ts";
import { resumeInterruptedRuns } from "../src/core/run-resume.ts";
import { runAgent, type ConnectorRunHooks } from "../src/transports/connectors.ts";
import type { TurnResult } from "../src/core/agent-loop.ts";
import type { UnattendedResult } from "../src/core/unattended.ts";

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

/**
 * A delivery channel that records what it was asked to send.
 *
 * The three behaviours are the three things that can happen, and the whole
 * retry policy turns on telling the last two apart:
 *   online   — the person got it
 *   offline  — the connector is not up; nothing was asked of anyone
 *   refusing — the connector IS up and the target would not take it
 */
function channel(behaviour: "online" | "offline" | "refusing" | "throws" = "online") {
  const sent: Array<{ runId: string; text: string }> = [];
  return {
    sent,
    deliver: async (run: RunRow, text: string): Promise<DeliveryOutcome> => {
      if (behaviour === "throws") throw new Error("websocket closed");
      if (behaviour === "offline") return "no_channel";
      if (behaviour === "refusing") return "refused";
      sent.push({ runId: run.id, text });
      return "sent";
    },
  };
}

describe("scenario 1 — crash BEFORE finish()", () => {
  test("the run is still `running`, owes nothing, and is the resume pass's problem", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    // …and the process dies mid-turn. No finish(), no report.

    expect(s.undelivered()).toEqual([]);

    // The old crash path is untouched: this is a run to RESUME, not to deliver.
    const resumed: string[] = [];
    await resumeInterruptedRuns(s, NOW, async (r) => { resumed.push(r.id); }, async () => {});
    expect(resumed).toEqual([run.id]);
    close();
  });
});

describe("scenario 2 — crash IMMEDIATELY after finish()", () => {
  test("the report survives on the row and the next boot delivers it exactly once", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "✅ **Done** — 14 files touched.");
    // …and the process dies here, one statement before the message goes out.
    // This is the exact instant the whole feature exists for.

    const owed = s.undelivered();
    expect(owed).toHaveLength(1);
    expect(owed[0]!.report).toContain("14 files touched");
    expect(owed[0]!.deliveredAt).toBeNull();

    const ch = channel("online");
    await drainUndelivered(s, ch.deliver);

    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]!.text).toContain("14 files touched");
    expect(ch.sent[0]!.text).toContain(REDELIVERY_NOTE);
    expect(s.get(run.id)!.deliveredAt).not.toBeNull();

    // Exactly once: a second boot must not send it again.
    await drainUndelivered(s, ch.deliver);
    expect(ch.sent).toHaveLength(1);
    close();
  });

  test("a finished run without a report is not owed anything", () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed");
    expect(s.undelivered()).toEqual([]);
    close();
  });
});

describe("scenario 3 — crash DURING delivery", () => {
  test("a throwing channel leaves the report owed, and the next boot delivers it", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "unfinished", "deadline", "⚠️ **Not finished.**");

    const broken = channel("throws");
    const logs: string[] = [];
    await drainUndelivered(s, broken.deliver, { log: (m) => logs.push(m) });

    // Still owed — and said out loud rather than swallowed.
    expect(s.get(run.id)!.deliveredAt).toBeNull();
    expect(logs.join("\n")).toContain("re-delivery failed");

    const ok = channel("online");
    await drainUndelivered(s, ok.deliver);
    expect(ok.sent).toHaveLength(1);
    expect(s.get(run.id)!.deliveredAt).not.toBeNull();
    close();
  });

  test("marking happens AFTER the send, never before", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "report");
    // The channel inspects the row from inside the send. If the mark were
    // written first, the row would already read as delivered here — which is the
    // reversed ordering this test exists to forbid.
    let deliveredAtDuringSend: number | null = -1;
    await deliverAndMark(s, s.get(run.id)!, "report", async () => {
      deliveredAtDuringSend = s.get(run.id)!.deliveredAt;
      return "sent";
    });
    expect(deliveredAtDuringSend).toBeNull();
    expect(s.get(run.id)!.deliveredAt).not.toBeNull();
    close();
  });
});

describe("scenario 4 — restart with the connector OFFLINE", () => {
  test("an unreachable channel is not a delivery; the report stays owed", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "report");

    const down = channel("offline");
    await drainUndelivered(s, down.deliver);
    expect(down.sent).toEqual([]);
    expect(s.get(run.id)!.deliveredAt).toBeNull();

    // …and it is still owed on the boot after that.
    expect(s.undelivered().map((r) => r.id)).toEqual([run.id]);
    close();
  });

  test("a connector that is merely down is never counted against the report", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "report");

    // Ten boots with the bot offline. Nothing was ever asked of the target, so
    // nothing is evidence about the target — the report must survive all of it.
    const down = channel("offline");
    for (let i = 0; i < 10; i++) await drainUndelivered(s, down.deliver);

    expect(s.get(run.id)!.deliveryAttempts).toBe(0);
    expect(s.get(run.id)!.deliveredAt).toBeNull();
    expect(s.undelivered()).toHaveLength(1);
    close();
  });
});

describe("the retry bound — refusals by the target, not elapsed time", () => {
  test("a refusing target is given up on after MAX_DELIVERY_REFUSALS, and the report lands in the log", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "report nobody would take");

    const logs: string[] = [];
    const gone = channel("refusing");
    for (let i = 0; i < MAX_DELIVERY_REFUSALS; i++) {
      await drainUndelivered(s, gone.deliver, { log: (m) => logs.push(m) });
      // Still owed while there is doubt left.
      expect(s.get(run.id)!.deliveredAt).toBeNull();
    }
    expect(s.get(run.id)!.deliveryAttempts).toBe(MAX_DELIVERY_REFUSALS);

    // The boot after the last refusal concludes it rather than trying again.
    await drainUndelivered(s, gone.deliver, { log: (m) => logs.push(m) });
    expect(logs.join("\n")).toContain("report nobody would take");
    expect(s.get(run.id)!.deliveredAt).not.toBeNull();
    expect(s.undelivered()).toEqual([]);
    close();
  });

  test("a refusal that later succeeds costs nothing — doubt is not a verdict", async () => {
    const { store: s, close } = store();
    const run = seed(s);
    s.finish(run.id, "finished", "completed", "report");

    await drainUndelivered(s, channel("refusing").deliver);
    await drainUndelivered(s, channel("refusing").deliver);
    expect(s.get(run.id)!.deliveryAttempts).toBe(2);

    const back = channel("online");
    await drainUndelivered(s, back.deliver);
    expect(back.sent).toHaveLength(1);
    expect(s.get(run.id)!.deliveredAt).not.toBeNull();
    close();
  });
});

describe("scenario 5 — restart with the connector ONLINE", () => {
  test("the person gets yesterday's conclusion, once, before any new work starts", async () => {
    const { store: s, close } = store();
    const finished = seed(s);
    s.finish(finished.id, "finished", "completed", "✅ **Done**");
    // A second run that died mid-turn: it must be RESUMED, not delivered.
    const interrupted = seed(s, { sessionId: "discord:c1:u2" });

    const ch = channel("online");
    const order: string[] = [];
    await drainUndelivered(s, async (r, t) => {
      order.push(`deliver:${r.id}`);
      return ch.deliver(r, t);
    });
    await resumeInterruptedRuns(
      s,
      NOW,
      async (r) => { order.push(`resume:${r.id}`); },
      async () => {},
    );

    expect(order).toEqual([`deliver:${finished.id}`, `resume:${interrupted.id}`]);
    expect(ch.sent).toHaveLength(1);
    close();
  });
});

describe("scenario 6 — two runs concluded at the same instant", () => {
  test("both are delivered, oldest first, and one dead channel does not cost the other", async () => {
    const { store: s, close } = store();
    const a = seed(s, { sessionId: "discord:c1:uA" });
    const b = seed(s, { sessionId: "discord:c1:uB" });
    s.finish(a.id, "finished", "completed", "report A");
    s.finish(b.id, "finished", "completed", "report B");

    expect(s.undelivered().map((r) => r.id)).toEqual([a.id, b.id]);

    const sent: string[] = [];
    const logs: string[] = [];
    await drainUndelivered(
      s,
      async (r, t): Promise<DeliveryOutcome> => {
        if (r.id === a.id) throw new Error("channel A is gone");
        sent.push(t);
        return "sent";
      },
      { log: (m) => logs.push(m) },
    );

    // B got its report even though A blew up first.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("report B");
    expect(s.get(b.id)!.deliveredAt).not.toBeNull();
    // A is still owed, not lost.
    expect(s.get(a.id)!.deliveredAt).toBeNull();
    expect(logs.join("\n")).toContain("channel A is gone");
    close();
  });
});

// ---------------------------------------------------------------------------
// The live path: the ordering has to hold where the bug actually was.
// ---------------------------------------------------------------------------

function fakeAgent(text: string) {
  return {
    handle: async () => text,
    handleTurn: async (): Promise<TurnResult> => ({
      text,
      outcome: "completed",
      toolCallCount: 2,
      incomplete: false,
    }),
  };
}

describe("the connector seam", () => {
  test("the run is concluded WITH its reply before the connector sends, and marked only after", async () => {
    const { store: s, close } = store();
    const events: string[] = [];
    let concluded: RunRow | null = null;

    const hooks: ConnectorRunHooks = {
      async begin(sessionId, mission, _surface, _target, doneWhen) {
        const row = seed(s, { sessionId, mission, doneWhen });
        return {
          recorder: { record: () => {} },
          done: (_run: UnattendedResult) => null,
          conclude: (reply: string) => {
            events.push("conclude");
            s.finish(row.id, "finished", "completed", reply);
            concluded = s.get(row.id);
          },
          delivered: () => {
            events.push("delivered");
            s.markDelivered(row.id);
          },
        };
      },
    };

    const { reply, markDelivered } = await runAgent(
      fakeAgent("here is the answer"),
      "discord:c1:u1",
      "do the thing",
      "discord-1",
      undefined,
      undefined,
      { hooks, surface: "discord", target: "chan-1" },
    );

    // Concluded before runAgent returned — i.e. before the caller can send.
    expect(events).toEqual(["conclude"]);
    expect(concluded!.report).toBe(reply);
    expect(concluded!.deliveredAt).toBeNull();
    // THIS is the crash window. A process dying now has the report on disk.
    expect(s.undelivered()).toHaveLength(1);

    // The connector sends, then says so.
    markDelivered();
    expect(events).toEqual(["conclude", "delivered"]);
    expect(s.undelivered()).toEqual([]);
    close();
  });

  test("a turn with no durable run behind it still answers, and marking is a no-op", async () => {
    const { store: s, close } = store();
    const { reply, markDelivered } = await runAgent(
      fakeAgent("here is the answer"), "discord:c1:u1", "do the thing", "discord-1",
    );
    expect(reply).toBe("here is the answer");
    expect(() => markDelivered()).not.toThrow();
    expect(s.undelivered()).toEqual([]);
    close();
  });
});
