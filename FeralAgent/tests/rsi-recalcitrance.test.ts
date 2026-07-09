/**
 * Faza 1 — Async RSI Engine: recalcitrance tracking.
 *
 * Each successive improvement costs more than the last — a fundamental
 * property of RSI, not an anomaly. The tracker records
 * `improvement_difficulty = tokens / Δscore` on every RatchetAdvanced,
 * compares the moving average of the last `window` events against the
 * baseline (mean of the first `baselineCount` events), and emits
 * RecalcitranceHigh once MA > `multiplier` × baseline — the signal for
 * Fractal Search to zoom out + add wild explorers (Faza 3).
 *
 * Production defaults are window 10 / baseline 5 / multiplier 3; the
 * tests use smaller windows to keep the fixtures readable.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/infra/event-bus.ts";
import { RecalcitranceTracker } from "../src/rsi/l1-config/recalcitrance.ts";

/** Emit a RatchetAdvanced whose improvement_difficulty = tokenCost / Δscore. */
async function ratchet(bus: EventBus, previousBest: number, score: number, tokenCost: number) {
  await bus.emit({ type: "RatchetAdvanced", previousBest, score, tokenCost });
}

describe("RSI recalcitrance tracker", () => {
  test("emits RecalcitranceHigh once the moving average exceeds multiplier × baseline", async () => {
    const bus = new EventBus();
    const high: RsiEvent[] = [];
    bus.on("RecalcitranceHigh", async (e) => high.push(e));

    new RecalcitranceTracker(bus, { window: 4, baselineCount: 2, multiplier: 3 });

    // first two cheap improvements set the baseline: difficulty 1, 1 → baseline 1
    await ratchet(bus, 0, 10, 10); // 10/10 = 1
    await ratchet(bus, 10, 20, 10); // 1
    expect(high.length).toBe(0);

    await ratchet(bus, 20, 30, 10); // 1   MA(last4)=1
    await ratchet(bus, 30, 40, 40); // 4   MA=[1,1,4]→2
    expect(high.length).toBe(0);

    await ratchet(bus, 40, 50, 100); // 10  MA last4=[1,1,4,10]=4 > 3*1 → fire
    expect(high.length).toBe(1);
    const e = high[0] as RsiEvent & { movingAverage: number; baseline: number; ratio: number };
    expect(e.baseline).toBeCloseTo(1);
    expect(e.movingAverage).toBeCloseTo(4);
    expect(e.ratio).toBeCloseTo(4);
  });

  test("stays quiet while improvement cost is flat", async () => {
    const bus = new EventBus();
    const high: RsiEvent[] = [];
    bus.on("RecalcitranceHigh", async (e) => high.push(e));

    new RecalcitranceTracker(bus, { window: 4, baselineCount: 2, multiplier: 3 });

    for (let i = 0; i < 8; i++) {
      await ratchet(bus, i * 10, (i + 1) * 10, 12); // difficulty 1.2 every time
    }
    expect(high.length).toBe(0);
  });

  test("does not fire twice without recovering first (latched)", async () => {
    const bus = new EventBus();
    const high: RsiEvent[] = [];
    bus.on("RecalcitranceHigh", async (e) => high.push(e));

    new RecalcitranceTracker(bus, { window: 4, baselineCount: 2, multiplier: 3 });

    await ratchet(bus, 0, 10, 10); // 1
    await ratchet(bus, 10, 20, 10); // 1 → baseline 1
    await ratchet(bus, 20, 30, 100); // 10
    await ratchet(bus, 30, 40, 100); // 10 → MA high → fire once
    expect(high.length).toBe(1);

    await ratchet(bus, 40, 50, 100); // still high, but already latched
    expect(high.length).toBe(1);
  });
});
