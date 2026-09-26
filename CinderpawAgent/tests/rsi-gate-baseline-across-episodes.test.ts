/**
 * INVARIANT I6 across dream episodes.
 *
 * The confidence gate pairs a candidate's per-task outcomes against the
 * champion's. Those champion outcomes lived only on the RatchetHandler, and
 * every dream episode builds a fresh engine — so the FIRST candidate of EVERY
 * episode had no baseline and was waved through ("confidence gate bypassed:
 * no champion baseline yet (bootstrap)"), leaving Rust's strict-greater on a
 * noisy score as the only bar. The bootstrap bypass was meant for the first
 * candidate an install ever sees, not the first one each time it wakes up.
 *
 * The champion's outcomes are now persisted with champion.json and seed the
 * next episode's baseline.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RsiBridge, type RsiResponse } from "../src/rsi/infra/bridge.ts";
import { RsiSidecar } from "../src/rsi/sidecar.ts";
import type { InvokeRouter } from "../src/rsi/infra/invoke-agent.ts";
import { openDatabase } from "../src/db.ts";
import { readChampion } from "../src/rsi/l1-config/champion.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers every eval prompt identically, so two genomes produce the same
 *  per-task outcomes — the case the gate exists to stop. */
class SameAnswerRouter implements InvokeRouter {
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

const TIER0: RsiResponse = {
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

/** A bridge whose ratchet always advances when asked. Records every request. */
class Bridge extends RsiBridge {
  readonly sent: string[] = [];
  constructor() {
    super({ send: () => {} });
  }
  request<T>(method: string, params: unknown): Promise<T> {
    const id = `rsi-${this.sent.length + 1}`;
    this.sent.push(method);
    const reply = (): RsiResponse => {
      switch (method) {
        case "rsi_get_tier0_specs":
          return TIER0;
        case "rsi_score":
          return { id: "", ok: true, data: { score: 50 } };
        case "rsi_commit_genome":
          return { id: "", ok: true, data: { commitHash: "c".repeat(40) } };
        case "rsi_ratchet_attempt":
          return {
            id: "",
            ok: true,
            data: { advanced: true, previous_tip: null, new_tip: "c".repeat(40), candidate_score: 50, prior_score: null },
          };
        case "rsi_log":
          return { id: "", ok: true, data: [] };
        default:
          return { id: "", ok: true, data: null };
      }
    };
    setTimeout(() => this.onResponse({ ...reply(), id }), 0);
    return super.request<T>(method, params);
  }
}

async function runEpisode(sidecar: RsiSidecar): Promise<void> {
  await sidecar.start({ goal: "t", maxIterations: 1, maxTotalTokens: 1_000_000, concurrency: 1 });
  for (let i = 0; i < 400 && sidecar.isRunning(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(sidecar.isRunning()).toBe(false);
}

describe("the confidence gate has a baseline in every episode, not only the first", () => {
  test("episode 2's first candidate is gated against episode 1's champion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-gate-episodes-"));
    dirs.push(dir);
    const bridge = new Bridge();
    const sidecar = new RsiSidecar({
      bridge,
      db: openDatabase(":memory:"),
      router: new SameAnswerRouter(),
      send: () => {},
      championPath: join(dir, "champion.json"),
      championTreePath: join(dir, "champion-tree.json"),
      populationSnapshotPath: join(dir, "population.json"),
      fsRoot: join(dir, "meta"),
    });

    // Episode 1, fresh install: nothing to compare against, so the first
    // candidate bootstraps the baseline — that bypass is by design.
    await runEpisode(sidecar);
    expect(bridge.sent.filter((m) => m === "rsi_ratchet_attempt").length).toBe(1);
    const champion = readChampion(join(dir, "champion.json"));
    expect(champion).not.toBeNull();
    // The baseline travels with the champion.
    expect(champion!.outcomes?.length ?? 0).toBeGreaterThanOrEqual(10);

    // Episode 2: a new engine. Its first candidate answers exactly like the
    // champion did — no evidence of improvement — so it must never be offered
    // to the ratchet. Before the fix it was, because the gate had no baseline.
    const before = bridge.sent.length;
    await runEpisode(sidecar);
    const episode2 = bridge.sent.slice(before);
    expect(episode2).toContain("rsi_commit_genome");
    expect(episode2.filter((m) => m === "rsi_ratchet_attempt").length).toBe(0);
  });
});

describe("RatchetHandler — a seeded baseline", () => {
  const { EventBus } = require("../src/rsi/infra/event-bus.ts") as typeof import("../src/rsi/infra/event-bus.ts");
  const { RatchetHandler } = require("../src/rsi/l1-config/ratchet-handler.ts") as typeof import("../src/rsi/l1-config/ratchet-handler.ts");
  type Outcome = import("../src/rsi/infra/eval-worker.ts").EvalOutcome;
  const outcomes = (prefix: string, n: number): Outcome[] =>
    Array.from({ length: n }, (_, i) => ({ taskId: `${prefix}${i}`, tier: 1, success: i % 2 === 0, latencyMs: 1, tokens: 1, errored: false }));
  const reject = { accept: false, reason: "stub reject", bootstrap: { mean: 0, ciLower: 0, ciUpper: 0, pValue: 1, effectSize: 0 } };

  function handler(championOutcomes: Outcome[]) {
    const dir = mkdtempSync(join(tmpdir(), "cinderpaw-gate-seed-"));
    dirs.push(dir);
    const bus = new EventBus();
    const seen = { gate: 0, attempts: 0, bypass: [] as string[] };
    bus.on("ConfidenceFailed", (e) => void seen.bypass.push(String(e.reason)));
    new RatchetHandler(bus, {
      commitGenome: async () => ({ commitHash: "d".repeat(40) }),
      ratchetAttempt: async () => {
        seen.attempts += 1;
        return { advanced: true, previousBest: 0, candidateScore: 1, hadPrior: true };
      },
      evaluateGate: () => {
        seen.gate += 1;
        return reject;
      },
      championOutcomes,
      journalPath: () => join(dir, "journal.jsonl"),
    });
    return { bus, seen };
  }

  test("the first candidate of a fresh engine is gated against it", async () => {
    const { bus, seen } = handler(outcomes("t", 12));
    await bus.emit({ type: "EvalComplete", genomeId: "g", score: 99, outcomes: outcomes("t", 12), errored: false });
    expect(seen.gate).toBe(1);
    expect(seen.attempts).toBe(0);
  });

  test("a baseline from a different suite re-bootstraps instead of freezing evolution", async () => {
    // Every task was renamed by an update: nothing pairs. Gating would reject
    // every candidate as "insufficient samples" and nothing could ever refresh
    // the baseline, so this candidate bootstraps like a fresh install's first.
    const { bus, seen } = handler(outcomes("old/", 12));
    await bus.emit({ type: "EvalComplete", genomeId: "g", score: 99, outcomes: outcomes("new/", 12), errored: false });
    expect(seen.gate).toBe(0);
    expect(seen.attempts).toBe(1);
  });
});
