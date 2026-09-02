/**
 * Faza 1 — Async RSI Engine: production sidecar wiring.
 *
 * `RsiSidecar` is the singleton the Tauri transport talks to. It owns
 * the live `RsiBridge`, the engine, the taste miner, and the
 * `mirrorEngineEvents` subscription. The transport's `onMessage`
 * switch dispatches to `onResponse` / `start` / `stop` /
 * `setConcurrency`; everything else is the sidecar's responsibility.
 *
 * Tests cover the dispatch contract with a fake bridge + router + db.
 * No live Rust, no live model, no filesystem — the e2e verification
 * is the operator's `cargo tauri dev` + click-Start step.
 */

import { describe, expect, test } from "bun:test";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import {
  RsiSidecar,
  mirrorEngineEvents,
} from "../src/rsi/sidecar.ts";
import type { InvokeRouter } from "../src/rsi/infra/invoke-agent.ts";
import { openDatabase } from "../src/db.ts";
import { EventBus } from "../src/rsi/infra/event-bus.ts";
import type { EvalSpec } from "../src/rsi/infra/eval-spec.ts";
import type { EvalOutcome } from "../src/rsi/infra/eval-worker.ts";
import { resolve } from "node:path";

class FakeRouter implements InvokeRouter {
  complete(): Promise<{ content: string; totalTokens: number; promptTokens: number; completionTokens: number; model: string; usedFallback: boolean }> {
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

/** Bridge that records every request and lets a test enqueue responses.
 *  Falls back to a generic OK response per method so ordering isn't a
 *  test fragility — each well-known method has a sensible default. */
class FakeBridge extends RsiBridge {
  readonly sent: Array<{ method: string; params: unknown }> = [];
  private responses: Array<RsiResponse> = [];

  constructor() {
    super({ send: () => {} });
  }

  enqueue(r: RsiResponse): void {
    this.responses.push(r);
  }

  /** Default per-method response when the test's queue runs out. */
  private defaultFor(method: string): RsiResponse {
    switch (method) {
      case "rsi_get_tier0_specs":
        return TIER0_RESPONSE;
      case "rsi_score":
        return SCORE_RESPONSE;
      case "rsi_commit_genome":
        return COMMIT_RESPONSE;
      case "rsi_ratchet_attempt":
        return RATCHET_NOADV;
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
    const id = `rsi-${this.sent.length + 1}`;
    this.sent.push({ method, params });
    setTimeout(() => {
      const next = this.responses.shift() ?? this.defaultFor(method);
      this.onResponse({ ...next, id });
    }, 0);
    return super.request<T>(method, params);
  }
}

function makeDb() {
  // In-memory DB is fine for tests; the sidecar only writes via
  // commitGenome adapter which is also stubbed by the FakeBridge.
  return openDatabase(":memory:");
}

function buildSidecar(opts: {
  bridge: FakeBridge;
  router?: InvokeRouter;
  historyWindow?: number;
}): { sidecar: RsiSidecar; emitted: Array<Record<string, unknown>>; logs: string[] } {
  const emitted: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const send = (e: Record<string, unknown>) => {
    emitted.push(e);
  };
  const sidecar = new RsiSidecar({
    bridge: opts.bridge,
    db: makeDb(),
    router: opts.router ?? new FakeRouter(),
    send,
    log: (m) => logs.push(m),
    // Hermetic: point at a nonexistent champion path so tests never read
    // the real ~/.cinderpaw/rsi/champion.json (resume seed) from the dev box.
    championPath: resolve(import.meta.dir, `../.tmp-nochampion-${Math.random()}.json`),
    championTreePath: resolve(import.meta.dir, `../.tmp-tree-${Math.random()}.json`),
    ...(opts.historyWindow != null ? { historyWindow: opts.historyWindow } : {}),
  });
  return { sidecar, emitted, logs };
}

/** Helper: build a synthetic `rsi_get_tier0_specs` response. */
const TIER0_RESPONSE: RsiResponse = {
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

/** Helper: a passing scoreGenome response. */
const SCORE_RESPONSE: RsiResponse = {
  id: "",
  ok: true,
  data: { score: 50 },
};

/** Helper: a passing commitGenome response. */
const COMMIT_RESPONSE: RsiResponse = {
  id: "",
  ok: true,
  data: { commitHash: "x".repeat(40) },
};

/** Helper: a passing ratchetAttempt response (no advance). */
const RATCHET_NOADV: RsiResponse = {
  id: "",
  ok: true,
  data: { advanced: false, previous_tip: "y".repeat(40), new_tip: null, candidate_score: 50, prior_score: 0 },
};

/** Helper: a passing ratchetAttempt response (advance). */
function ratchetAdv(hash: string): RsiResponse {
  return {
    id: "",
    ok: true,
    data: {
      advanced: true,
      previous_tip: "y".repeat(40),
      new_tip: hash,
      candidate_score: 60,
      prior_score: 50,
    },
  };
}

describe("RsiSidecar — lifecycle", () => {
  test("start emits a 'started' ack event", async () => {
    const bridge = new FakeBridge();
    bridge.enqueue(TIER0_RESPONSE); // fetchTier0
    bridge.enqueue(COMMIT_RESPONSE);
    bridge.enqueue(RATCHET_NOADV);
    const { sidecar, emitted } = buildSidecar({ bridge });

    await sidecar.start({
      goal: "test",
      maxIterations: 1,
      maxTotalTokens: 1_000,
      concurrency: 1,
    }, "ack-1");

    const started = emitted.find((e) => e.type === "rsi_engine_event" && e.event === "started");
    expect(started).toBeDefined();
    expect(started!.id).toBe("ack-1");
    expect(started!.concurrency).toBe(1);

    // Cleanup so the background run doesn't leak.
    sidecar.stop();
  });

  test("a second start while running is rejected with an error", async () => {
    const bridge = new FakeBridge();
    bridge.enqueue(TIER0_RESPONSE);
    bridge.enqueue(COMMIT_RESPONSE);
    bridge.enqueue(RATCHET_NOADV);
    const { sidecar, emitted } = buildSidecar({ bridge });

    await sidecar.start({ goal: "x", maxIterations: 1, maxTotalTokens: 1_000 }, "ack-1");
    await sidecar.start({ goal: "x", maxIterations: 1, maxTotalTokens: 1_000 }, "ack-2");

    const errs = emitted.filter((e) => e.type === "error");
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toContain("already running");

    sidecar.stop();
  });

  test("a background (no-ackId) start while running logs instead of surfacing a chat error", async () => {
    const bridge = new FakeBridge();
    bridge.enqueue(TIER0_RESPONSE);
    bridge.enqueue(COMMIT_RESPONSE);
    bridge.enqueue(RATCHET_NOADV);
    const { sidecar, emitted, logs } = buildSidecar({ bridge });

    // User starts a run (engine now live)...
    await sidecar.start({ goal: "x", maxIterations: 1, maxTotalTokens: 1_000 }, "ack-1");
    // ...then the Dream Cycle (no ackId) tries to start an idle episode.
    await sidecar.start({ goal: "x", maxIterations: 1, maxTotalTokens: 1_000 });

    // The background collision must NOT become a user-facing error event.
    expect(emitted.filter((e) => e.type === "error")).toHaveLength(0);
    // It goes to the log instead.
    expect(logs.some((m) => /already running/.test(m))).toBe(true);

    sidecar.stop();
  });

  test("stop on an idle engine emits an error", () => {
    const bridge = new FakeBridge();
    const { sidecar, emitted } = buildSidecar({ bridge });
    sidecar.stop("ack");
    expect(emitted.some((e) => e.type === "error" && String(e.message).includes("not running"))).toBe(true);
  });

  test("setConcurrency on an idle engine emits an error", () => {
    const bridge = new FakeBridge();
    const { sidecar, emitted } = buildSidecar({ bridge });
    sidecar.setConcurrency(4, "ack");
    expect(emitted.some((e) => e.type === "error" && String(e.message).includes("not running"))).toBe(true);
  });

  test("onIdle fires after a run ends (passive-supervisor restart hook)", async () => {
    const bridge = new FakeBridge();
    let idleCount = 0;
    const sidecar = new RsiSidecar({
      bridge,
      db: makeDb(),
      router: new FakeRouter(),
      send: () => {},
      championPath: resolve(import.meta.dir, `../.tmp-nochampion-idle-${Math.random()}.json`),
      championTreePath: resolve(import.meta.dir, `../.tmp-tree-idle-${Math.random()}.json`),
      onIdle: () => {
        idleCount += 1;
      },
    });

    await sidecar.start({ goal: "t", maxIterations: 1, maxTotalTokens: 1_000, concurrency: 1 }, "ack");
    for (let i = 0; i < 50 && idleCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(idleCount).toBe(1);
    expect(sidecar.isRunning()).toBe(false);
  });

  test("onResponse routes the message to the bridge", async () => {
    const bridge = new FakeBridge();
    const { sidecar } = buildSidecar({ bridge });
    // No engine is running but the bridge should still receive the
    // response — it's a transport-level routing function.
    const pending = bridge.request<{ ok: boolean }>("rsi_test", {});
    bridge.enqueue({ id: "", ok: true, data: { ok: true } });
    // We need to deliver the response to the matching request id.
    // The bridge assigns id `rsi-1` to the first request.
    const result = await pending;
    expect(result.ok).toBe(true);
    // The sidecar's onResponse just calls bridge.onResponse — verify
    // by sending a second response.
    const p2 = bridge.request<{ v: number }>("rsi_test2", {});
    // Synthesize the response via the bridge directly:
    sidecar.onResponse({ id: "rsi-2", ok: true, data: { v: 42 } });
    const r2 = await p2;
    expect(r2.v).toBe(42);
  });
});

describe("mirrorEngineEvents — outbound emission", () => {
  test("forwards EvalComplete, RatchetAdvanced, GenomeDied as rsi_engine_event progress lines", async () => {
    const bus = new EventBus();
    const emitted: Array<Record<string, unknown>> = [];
    const off = mirrorEngineEvents(bus, (e) => emitted.push(e));

    await bus.emit({ type: "EvalComplete", genomeId: "g1", score: 50, tokenCost: 10 });
    await bus.emit({ type: "RatchetAdvanced", genomeId: "g1", commitHash: "h", score: 50, previousBest: 30, tokenCost: 10 });
    await bus.emit({ type: "GenomeDied", genomeId: "g2", cause: "extinction" });

    expect(emitted.length).toBeGreaterThanOrEqual(3);
    const complete = emitted.find((e) => (e as { genomeId?: string }).genomeId === "g1" && (e as { score?: number }).score === 50);
    expect(complete).toBeDefined();
    const advanced = emitted.find((e) => (e as { ratchet?: boolean }).ratchet === true);
    expect(advanced).toBeDefined();
    const died = emitted.find((e) => (e as { died?: boolean }).died === true);
    expect(died).toBeDefined();

    off();
  });

  test("iteration counter increments on each EvalComplete and is attached to every progress event", async () => {
    // Regression: the iteration counter used to be a static 0 in
    // GenomeBorn events and absent from every other event — Rust's
    // rsi_engine_mirror never updated past 0, so /rsi's iteration
    // badge was stuck at "0 iteratii" while the engine was actively
    // running. Surfaced on the second manual e2e. Each EvalComplete
    // bumps the counter; every subsequent progress event carries
    // the current count.
    const bus = new EventBus();
    const emitted: Array<Record<string, unknown>> = [];
    const off = mirrorEngineEvents(bus, (e) => emitted.push(e));

    await bus.emit({ type: "GenomeBorn", genomeId: "g0", mutationType: "seed" });
    expect(emitted.at(-1)?.iteration).toBe(0);

    await bus.emit({ type: "EvalComplete", genomeId: "g0", score: 50, tokenCost: 10 });
    const after1 = emitted.filter((e) => (e as { score?: number }).score === 50)[0];
    expect(after1?.iteration).toBe(1);

    await bus.emit({ type: "GenomeBorn", genomeId: "g1", mutationType: "parametric" });
    expect(emitted.at(-1)?.iteration).toBe(1);

    await bus.emit({ type: "EvalComplete", genomeId: "g1", score: 60, tokenCost: 10 });
    const after2 = emitted.filter((e) => (e as { score?: number }).score === 60)[0];
    expect(after2?.iteration).toBe(2);

    await bus.emit({ type: "GenomeDied", genomeId: "g2", cause: "extinction" });
    expect(emitted.at(-1)?.iteration).toBe(2);

    await bus.emit({ type: "ExtinctionTriggered", reason: "adaptive", killed: ["g2"] });
    expect(emitted.at(-1)?.iteration).toBe(2);

    off();
  });

  test("forwards PBTSyncTriggered as a pbt_sync event with the credited/next active ids", async () => {
    const bus = new EventBus();
    const emitted: Array<Record<string, unknown>> = [];
    const off = mirrorEngineEvents(bus, (e) => emitted.push(e));

    await bus.emit({
      type: "PBTSyncTriggered",
      creditedId: "s1",
      nextActiveId: "s2",
      replaced: [{ id: "s4", donorId: "s1" }],
    });

    const sync = emitted.find((e) => e.event === "pbt_sync");
    expect(sync).toBeDefined();
    expect(sync!.creditedId).toBe("s1");
    expect(sync!.nextActiveId).toBe("s2");
    expect(Array.isArray(sync!.replaced)).toBe(true);

    off();
  });
});

/** Router that always returns empty content — simulates a misbehaving
 *  local model (wrong chat template, zero-token budget, refusal-to-empty)
 *  so the eval suite scores ~0 while the engine keeps running. */
class EmptyRouter implements InvokeRouter {
  complete(): Promise<{ content: string; totalTokens: number; promptTokens: number; completionTokens: number; model: string; usedFallback: boolean }> {
    return Promise.resolve({
      content: "   ",
      totalTokens: 4,
      promptTokens: 4,
      completionTokens: 0,
      model: "fake",
      usedFallback: false,
    });
  }
}

/** Bridge whose ratchet attempts always ADVANCE — exercises the
 *  champion hook (the Crux) which fires on RatchetAdvanced. */
class AdvancingBridge extends FakeBridge {
  protected defaultFor(method: string): RsiResponse {
    if (method === "rsi_ratchet_attempt") return ratchetAdv("a".repeat(40));
    return super["defaultFor"](method);
  }
}

describe("RsiSidecar — champion hook (the Crux)", () => {
  test("a ratchet fires onChampion with the best genome's config + persists", async () => {
    const bridge = new AdvancingBridge();
    const champions: Array<{ genomeId: string; config: unknown; score: number }> = [];
    const tmp = resolve(import.meta.dir, `../.tmp-champion-${Date.now()}.json`);
    const treeTmp = resolve(import.meta.dir, `../.tmp-tree-champ-${Math.random()}.json`);
    const { rmSync } = require("node:fs") as typeof import("node:fs");
    const sidecar = new RsiSidecar({
      bridge,
      db: makeDb(),
      router: new FakeRouter(),
      send: () => {},
      championPath: tmp,
      championTreePath: treeTmp,
      onChampion: (rec) => champions.push(rec),
    });

    try {
      await sidecar.start({ goal: "t", maxIterations: 1, maxTotalTokens: 1_000, concurrency: 1 }, "ack");
      for (let i = 0; i < 60 && champions.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(champions.length).toBeGreaterThan(0);
      expect(typeof champions[0]!.genomeId).toBe("string");
      expect((champions[0]!.config as { temperature?: number }).temperature).toBeTypeOf("number");
      // It was persisted too.
      const { readChampion } = await import("../src/rsi/l1-config/champion.ts");
      expect(readChampion(tmp)).not.toBeNull();
    } finally {
      rmSync(tmp, { force: true });
      rmSync(treeTmp, { force: true });
    }
  });
});

describe("RsiSidecar — empty-response telemetry", () => {
  test("empty model responses surface a one-time warning + a tally on stopped", async () => {
    // A model that returns empty/whitespace content makes every eval
    // score ~0 (validateOutcome fails) while the engine keeps running —
    // a silent "running but learning nothing" failure. The sidecar must
    // make that observable: exactly one early warning per run plus a
    // final count on the stopped event so the operator's e2e shows
    // immediately that the MODEL, not the engine, is the problem.
    const bridge = new FakeBridge();
    const { sidecar, emitted } = buildSidecar({ bridge, router: new EmptyRouter() });

    await sidecar.start({
      goal: "test",
      maxIterations: 1,
      maxTotalTokens: 1_000,
      concurrency: 1,
    }, "ack");

    for (let i = 0; i < 50 && !emitted.some((e) => e.event === "stopped"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const warnings = emitted.filter(
      (e) => e.event === "warning" && e.warning === "empty_response",
    );
    expect(warnings.length).toBe(1); // one-time, not per-eval flood
    expect(String(warnings[0]!.message)).toContain("empty");

    const stopped = emitted.find((e) => e.event === "stopped");
    expect(stopped).toBeDefined();
    expect((stopped as { emptyResponses?: number }).emptyResponses).toBeGreaterThan(0);
  });

  test("a sustained no-answer rate trips the breaker and stops the episode", async () => {
    // The warning above was already there and was already firing. It was not
    // enough: between June and August 2026 this machine ran 750 episodes and
    // 2207 iterations at a 71% no-answer rate, spent 8.6M tokens, ratcheted 9
    // times, and the one-time warning sat unread in a log the whole time. An
    // engine that cannot measure anything has to STOP, not keep spending.
    const prevSample = process.env.CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE;
    const prevRatio = process.env.CINDERPAW_RSI_MAX_UNANSWERED_RATIO;
    process.env.CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE = "2";
    process.env.CINDERPAW_RSI_MAX_UNANSWERED_RATIO = "0.5";
    try {
      const bridge = new FakeBridge();
      const { sidecar, emitted } = buildSidecar({ bridge, router: new EmptyRouter() });

      await sidecar.start({
        goal: "test",
        maxIterations: 4,
        maxTotalTokens: 100_000,
        concurrency: 1,
      }, "ack");

      for (let i = 0; i < 200 && !emitted.some((e) => e.event === "stopped"); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const aborts = emitted.filter(
        (e) => e.event === "warning" && e.warning === "empty_response_abort",
      );
      expect(aborts.length).toBe(1); // trips once, never a flood
      expect(String(aborts[0]!.message)).toContain("stopping the episode");
      expect(emitted.some((e) => e.event === "stopped")).toBe(true);
    } finally {
      if (prevSample === undefined) delete process.env.CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE;
      else process.env.CINDERPAW_RSI_UNANSWERED_MIN_SAMPLE = prevSample;
      if (prevRatio === undefined) delete process.env.CINDERPAW_RSI_MAX_UNANSWERED_RATIO;
      else process.env.CINDERPAW_RSI_MAX_UNANSWERED_RATIO = prevRatio;
    }
  });

  test("a healthy model emits no empty-response warning and a zero tally", async () => {
    const bridge = new FakeBridge();
    const { sidecar, emitted } = buildSidecar({ bridge }); // default FakeRouter → "OK"

    await sidecar.start({
      goal: "test",
      maxIterations: 1,
      maxTotalTokens: 1_000,
      concurrency: 1,
    }, "ack");

    for (let i = 0; i < 50 && !emitted.some((e) => e.event === "stopped"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(emitted.some((e) => e.event === "warning" && e.warning === "empty_response")).toBe(false);
    const stopped = emitted.find((e) => e.event === "stopped");
    expect((stopped as { emptyResponses?: number }).emptyResponses).toBe(0);
  });
});

describe("RsiSidecar — integration smoke (engine runs to completion)", () => {
  test("a 1-iteration run hits the bridge, returns, and emits stopped", async () => {
    const bridge = new FakeBridge();
    // No responses enqueued — the FakeBridge falls back to per-method
    // defaults so ordering isn't a test fragility.

    const { sidecar, emitted } = buildSidecar({ bridge });

    await sidecar.start({
      goal: "test",
      maxIterations: 1,
      maxTotalTokens: 1_000,
      concurrency: 1,
    }, "ack");

    // Wait for the background run to drain.
    for (let i = 0; i < 50 && !emitted.some((e) => e.type === "rsi_engine_event" && e.event === "stopped"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const stopped = emitted.find((e) => e.type === "rsi_engine_event" && e.event === "stopped");
    expect(stopped).toBeDefined();
    expect(stopped!.id).toBe("ack");
    expect(typeof stopped!.iteration).toBe("number");
    expect(stopped!.iteration).toBeGreaterThanOrEqual(0);

    // The bridge saw at least: rsi_get_tier0_specs, rsi_score,
    // rsi_commit_genome, rsi_ratchet_attempt. We don't pin rsi_log
    // (taste miner may coalesce).
    const seen = new Set(bridge.sent.map((s) => s.method));
    expect(seen.has("rsi_get_tier0_specs")).toBe(true);
    expect(seen.has("rsi_score")).toBe(true);
    expect(seen.has("rsi_commit_genome")).toBe(true);
    expect(seen.has("rsi_ratchet_attempt")).toBe(true);
  });
});
