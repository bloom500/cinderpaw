/**
 * Faza 3.5 — Meta-RSI via PBT: the bus handler.
 *
 * PbtHandler is the seam between the Level-1 engine and the meta layer.
 * It subscribes to RatchetAdvanced (the only event the spec syncs on),
 * credits the PbtController with the improvement (scoreDelta = score −
 * previousBest, tokenCost), emits PBTSyncTriggered with the sync
 * summary, and calls an injected persist hook so the sidecar can write
 * the strategy population to the DB + meta/pbt_state.json.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";
import { PbtController, type StrategyGenome } from "../src/rsi/pbt-controller.ts";
import { PbtHandler } from "../src/rsi/pbt-handler.ts";

function strat(id: string): StrategyGenome {
  return {
    id,
    hyperparams: {
      mutation_rate: 0.1,
      population_size: 16,
      selection_pressure: 1.0,
      zoom_policy: {
        coarse_threshold_high: 6,
        coarse_threshold_low: 2,
        fine_threshold_high: 10,
        fine_threshold_low: 2,
        wild_explorer_pct: 0.05,
      },
    },
    ratchetCount: 0,
    fitness: 0,
  };
}

describe("PbtHandler — RatchetAdvanced → credit + sync + persist", () => {
  test("credits the active strategy with the improvement on RatchetAdvanced", async () => {
    const bus = new EventBus();
    const controller = new PbtController({
      strategies: [strat("s1"), strat("s2")],
      rng: () => 0.5,
      exploitFraction: 0,
    });
    new PbtHandler(bus, { controller });

    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g1",
      commitHash: "h",
      score: 70,
      previousBest: 40,
      tokenCost: 300,
    });

    const s1 = controller.strategies().find((s) => s.id === "s1")!;
    expect(s1.ratchetCount).toBe(1);
    expect(s1.fitness).toBeGreaterThan(0); // (70−40)/300 > 0
    expect(controller.active().id).toBe("s2"); // rotated
  });

  test("emits PBTSyncTriggered carrying the sync summary", async () => {
    const bus = new EventBus();
    const controller = new PbtController({
      strategies: [strat("s1"), strat("s2")],
      rng: () => 0.5,
      exploitFraction: 0,
    });
    new PbtHandler(bus, { controller });

    const synced: RsiEvent[] = [];
    bus.on("PBTSyncTriggered", async (e) => synced.push(e));

    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g1",
      commitHash: "h",
      score: 70,
      previousBest: 40,
      tokenCost: 300,
    });

    expect(synced.length).toBe(1);
    const e = synced[0] as RsiEvent & { creditedId: string; nextActiveId: string };
    expect(e.creditedId).toBe("s1");
    expect(e.nextActiveId).toBe("s2");
  });

  test("calls persist with the post-sync strategy population", async () => {
    const bus = new EventBus();
    const controller = new PbtController({
      strategies: [strat("s1"), strat("s2")],
      rng: () => 0.5,
      exploitFraction: 0,
    });
    let persisted: StrategyGenome[] | null = null;
    new PbtHandler(bus, {
      controller,
      persist: (strategies) => {
        persisted = strategies.map((s) => ({ ...s }));
      },
    });

    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g1",
      commitHash: "h",
      score: 55,
      previousBest: 50,
      tokenCost: 100,
    });

    expect(persisted).not.toBeNull();
    expect(persisted!.length).toBe(2);
    expect(persisted!.find((s) => s.id === "s1")!.ratchetCount).toBe(1);
  });

  test("a persist that throws does not crash the cascade", async () => {
    const bus = new EventBus();
    const controller = new PbtController({
      strategies: [strat("s1")],
      rng: () => 0.5,
      exploitFraction: 0,
    });
    new PbtHandler(bus, {
      controller,
      persist: () => {
        throw new Error("disk full");
      },
    });

    // Must not throw out of the bus pump.
    await bus.emit({
      type: "RatchetAdvanced",
      genomeId: "g1",
      commitHash: "h",
      score: 60,
      previousBest: 50,
      tokenCost: 100,
    });
    expect(controller.strategies()[0]!.ratchetCount).toBe(1);
  });
});
