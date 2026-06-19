/**
 * Faza 1 — runEval real: the `scoreGenome` bridge adapter.
 *
 * The EvalWorker scores a batch by calling Rust's `rsi_score` over the
 * bridge (protocol (a)) — the sidecar never computes the composite score
 * itself (asymmetric trust). The bridge is a thin JSON pipe with no
 * camelCase translation, so this adapter maps the sidecar's camelCase
 * `EvalOutcome` into the snake_case shape Rust's `EvalOutcome`
 * deserialises, and unwraps the `ScoreBreakdown.score` into the
 * worker's `ScoreResult`.
 */

import { describe, expect, test } from "bun:test";
import { RsiBridge, type RsiResponse } from "../src/rsi/bridge.ts";
import { makeScoreGenomeAdapter } from "../src/rsi/adapters.ts";
import type { EvalOutcome } from "../src/rsi/eval-worker.ts";

class MockBridge extends RsiBridge {
  readonly sent: Array<{ id: string; method: string; params: unknown }> = [];
  constructor() {
    super({ send: (m) => this.sent.push(m as { id: string; method: string; params: unknown }) });
  }
  enqueue(resp: Omit<RsiResponse, "type">): void {
    this.onResponse({ type: "rsi_response", ...resp });
  }
}

const outcomes: EvalOutcome[] = [
  { taskId: "tier0/x", tier: 0, success: true, latencyMs: 120, tokens: 30, errored: false },
  {
    taskId: "tier1/y",
    tier: 1,
    success: false,
    latencyMs: 90,
    tokens: 0,
    errored: true,
    errorMessage: "boom",
  },
];

describe("makeScoreGenomeAdapter", () => {
  test("sends snake_case outcomes to rsi_score and returns the composite score", async () => {
    const bridge = new MockBridge();
    const scoreGenome = makeScoreGenomeAdapter({ bridge });

    const promise = scoreGenome(outcomes);
    const { id, method, params } = bridge.sent[0]!;
    expect(method).toBe("rsi_score");
    expect(params).toEqual({
      outcomes: [
        { task_id: "tier0/x", tier: 0, success: true, latency_ms: 120, tokens: 30, errored: false, error_message: null },
        { task_id: "tier1/y", tier: 1, success: false, latency_ms: 90, tokens: 0, errored: true, error_message: "boom" },
      ],
    });

    bridge.enqueue({ id, ok: true, data: { score: 73.5, success_component: 1 } });
    expect(await promise).toEqual({ score: 73.5 });
  });

  test("surfaces a Rust-side error", async () => {
    const bridge = new MockBridge();
    const scoreGenome = makeScoreGenomeAdapter({ bridge });
    const promise = scoreGenome(outcomes);
    const { id } = bridge.sent[0]!;
    bridge.enqueue({ id, ok: false, error: "scorer exploded" });
    await expect(promise).rejects.toThrow(/scorer exploded/);
  });
});
