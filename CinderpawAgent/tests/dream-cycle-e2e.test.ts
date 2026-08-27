/**
 * Dream Cycle — end-to-end wiring smoke (audit D2).
 *
 * Drives the REAL stack: a real `RsiSidecar` (faking only the LLM router +
 * RSI bridge, exactly as the sidecar tests do), the real `createDreamCycle`
 * glue, the real `DreamScheduler`, the real `ActivityMonitor`, and a real
 * telemetry-JSONL append to a temp file. Asserts the full path that had no
 * coverage before: idle trigger → `dream_cycle` "started" event → bounded
 * episode runs to completion → run-end telemetry line + "ended" event →
 * cooldown blocks an immediate relaunch.
 *
 * This is the automatable half of D2. The manual half (eyeball the real
 * mascot toast against a loaded model) is in docs/audits + the smoke knobs
 * documented on createDreamCycle.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RsiSidecar } from "../src/rsi/sidecar.ts";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import type { InvokeRouter } from "../src/rsi/infra/invoke-agent.ts";
import { openDatabase } from "../src/db.ts";
import { ActivityMonitor } from "../src/rsi/l1-config/activity-monitor.ts";
import { createDreamCycle } from "../src/rsi/l1-config/dream-cycle.ts";
import type { DreamConfig } from "../src/rsi/l1-config/dream-config.ts";
import type { OutboundEvent } from "../src/types.ts";

class FakeRouter implements InvokeRouter {
  complete() {
    return Promise.resolve({
      content: "OK",
      totalTokens: 5,
      promptTokens: 3,
      completionTokens: 2,
      model: "fake",
      usedFallback: false,
    });
  }
}

/** Bridge that answers every RSI method with a sensible default so a full
 *  episode runs to completion without the test scripting each call. */
class FakeBridge extends RsiBridge {
  private sent = 0;
  /** When true, every ratchet attempt advances → drives a RatchetAdvanced
   *  event so the test can assert the telemetry ratchet count. */
  constructor(private readonly advance = false) {
    super({ send: () => {} });
  }
  private defaultFor(method: string): RsiResponse {
    switch (method) {
      case "rsi_get_tier0_specs":
        return {
          id: "",
          ok: true,
          data: [
            {
              id: "tier0/fake",
              name: "fake",
              description: "fake",
              prompt: "fake?",
              kind: "fact_lookup",
              expected: { type: "fact_lookup", answer: "ok" },
            },
          ],
        };
      case "rsi_score":
        return { id: "", ok: true, data: { score: 50 } };
      case "rsi_commit_genome":
        return { id: "", ok: true, data: { commitHash: "x".repeat(40) } };
      case "rsi_ratchet_attempt":
        return this.advance
          ? {
              id: "",
              ok: true,
              data: { advanced: true, previous_tip: "y".repeat(40), new_tip: "z".repeat(40), candidate_score: 60, prior_score: 50 },
            }
          : {
              id: "",
              ok: true,
              data: { advanced: false, previous_tip: "y".repeat(40), new_tip: null, candidate_score: 50, prior_score: 0 },
            };
      case "rsi_lca":
        return { id: "", ok: true, data: { lca: null } };
      case "rsi_log":
        return { id: "", ok: true, data: [] };
      case "rsi_diff":
        return { id: "", ok: true, data: "" };
      default:
        return { id: "", ok: true, data: null };
    }
  }
  request<T>(method: string, params: unknown): Promise<T> {
    // RsiBridge assigns ids as `rsi-${++seq}`; predict the matching id so the
    // faked response resolves the right pending request.
    const id = `rsi-${++this.sent}`;
    setTimeout(() => this.onResponse({ ...this.defaultFor(method), id }), 0);
    return super.request<T>(method, params);
  }
}

const CONFIG: DreamConfig = {
  idleThresholdMs: 50,
  cooldownMs: 1_000_000, // huge → proves cooldown blocks the next launch
  errorThreshold: 999, // disable the error trigger for this test
  errorWindowMs: 60_000,
  pollMs: 30_000, // unused — we call tick() directly
};

/** Drive one full idle-triggered episode against the real stack and return
 *  the emitted events + the single telemetry record. Cleans up the temp file.
 *  `bridge.advance` controls whether the episode ratchets. */
async function runOneEpisode(bridge: FakeBridge): Promise<{
  events: OutboundEvent[];
  rec: Record<string, unknown>;
  starts: number;
}> {
  const telemetryPath = join(tmpdir(), `cinderpaw-dream-e2e-${Date.now()}-${Math.random()}.jsonl`);
  const events: OutboundEvent[] = [];
  const activityMonitor = new ActivityMonitor({ errorWindowMs: CONFIG.errorWindowMs });
  activityMonitor.recordActivity(Date.now() - 10_000); // idle now

  const dreamCycle = createDreamCycle({
    send: (e) => events.push(e),
    telemetryPath,
    activityMonitor,
    config: CONFIG,
    log: () => {},
  });
  const sidecar = new RsiSidecar({
    bridge,
    db: openDatabase(":memory:"),
    router: new FakeRouter(),
    send: () => {},
    championPath: join(tmpdir(), `cinderpaw-dream-e2e-champ-${Math.random()}.json`),
    championTreePath: join(tmpdir(), `cinderpaw-dream-e2e-tree-${Math.random()}.json`),
    onIdle: dreamCycle.onEpisodeEnd,
  });
  const scheduler = dreamCycle.arm(sidecar, {
    goal: "t",
    maxIterations: 1,
    maxTotalTokens: 1_000,
  } as Parameters<typeof dreamCycle.arm>[1]);

  try {
    await scheduler.tick(); // idle → launch
    for (let i = 0; i < 200 && !events.some((e) => e.type === "dream_cycle" && e.phase === "ended"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await scheduler.tick(); // inside cooldown → must NOT relaunch
    const lines = readFileSync(telemetryPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    return {
      events,
      rec: JSON.parse(lines[0]!) as Record<string, unknown>,
      starts: events.filter((e) => e.type === "dream_cycle" && e.phase === "started").length,
    };
  } finally {
    scheduler.shutdown();
    rmSync(telemetryPath, { force: true });
  }
}

describe("Dream Cycle — end-to-end wiring", () => {
  test("idle → started event → episode → telemetry + ended event → cooldown", async () => {
    const { events, rec, starts } = await runOneEpisode(new FakeBridge());

    const started = events.find((e) => e.type === "dream_cycle" && e.phase === "started");
    expect(started).toBeDefined();
    expect((started as { trigger: string }).trigger).toBe("idle");

    const ended = events.find((e) => e.type === "dream_cycle" && e.phase === "ended");
    expect(ended).toBeDefined();
    expect((ended as { trigger: string }).trigger).toBe("idle");

    expect(rec.trigger).toBe("idle");
    expect(typeof rec.startedAt).toBe("number");
    expect(typeof rec.endedAt).toBe("number");
    expect(typeof rec.stopReason).toBe("string");
    expect(rec.endedAt as number).toBeGreaterThanOrEqual(rec.startedAt as number);

    // Cooldown blocked the second tick → only one episode launched.
    expect(starts).toBe(1);
  });

  test("emits the §2.8 stage sequence in order (wake→observe→evaluate→remember→sleep)", async () => {
    const { events } = await runOneEpisode(new FakeBridge());
    const stages = events
      .filter((e) => e.type === "dream_cycle" && typeof (e as { stage?: string }).stage === "string")
      .map((e) => (e as { stage: string }).stage);
    // Dream/Mutate are subsumed by the opaque engine episode in Faza 1 (surfaced
    // under the `evaluate` bracket), so the observable sequence is 5 stages.
    expect(stages).toEqual(["wake", "observe", "evaluate", "remember", "sleep"]);
  });

  test("a ratchet advance is counted into the telemetry record (Q4/B3)", async () => {
    const { rec, events } = await runOneEpisode(new FakeBridge(true));
    // The real RatchetHandler emitted RatchetAdvanced → the sidecar counted it
    // → it rode the run-end stats into both the telemetry line and the event.
    expect(rec.ratchets as number).toBeGreaterThanOrEqual(1);
    const ended = events.find((e) => e.type === "dream_cycle" && e.phase === "ended") as { ratchets?: number };
    expect(ended.ratchets).toBe(rec.ratchets);
  });
});
