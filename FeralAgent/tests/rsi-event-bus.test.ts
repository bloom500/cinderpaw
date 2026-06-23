/**
 * Faza 1 — Async RSI Engine: the event bus.
 *
 * Event-driven, not loop-based. No master scheduler. Handlers react to
 * events and may emit new events; the bus serialises processing through
 * a single async pump so a cascade (EvalComplete → RatchetAdvanced →
 * PBTSyncTriggered) runs deterministically, one event at a time.
 */

import { describe, expect, test } from "bun:test";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";

describe("RSI event bus", () => {
  test("emit invokes only handlers registered for that event type", async () => {
    const bus = new EventBus();
    const born: RsiEvent[] = [];
    const died: RsiEvent[] = [];
    bus.on("GenomeBorn", async (e) => {
      born.push(e);
    });
    bus.on("GenomeDied", async (e) => {
      died.push(e);
    });

    await bus.emit({ type: "GenomeBorn", genomeId: "g1" });

    expect(born.map((e) => e.type)).toEqual(["GenomeBorn"]);
    expect((born[0] as { genomeId: string }).genomeId).toBe("g1");
    expect(died).toEqual([]);
  });

  test("events emitted from within a handler are queued, not nested (serialised pump)", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("EvalComplete", async (_e) => {
      order.push("eval:start");
      // A ratchet check is emitted mid-handler; it must run only after
      // the current handler completes, not nested in the middle of it.
      await bus.emit({ type: "RatchetAdvanced" });
      order.push("eval:end");
    });
    bus.on("RatchetAdvanced", async (_e) => {
      order.push("ratchet");
    });

    await bus.emit({ type: "EvalComplete" });

    expect(order).toEqual(["eval:start", "eval:end", "ratchet"]);
  });

  test("emit resolves only after the full cascade has drained", async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on("EvalComplete", async () => {
      await bus.emit({ type: "RatchetAdvanced" });
    });
    bus.on("RatchetAdvanced", async () => {
      await bus.emit({ type: "PBTSyncTriggered" });
    });
    bus.on("PBTSyncTriggered", async () => {
      seen.push("pbt");
    });

    await bus.emit({ type: "EvalComplete" });

    // The whole chain must have run by the time the outer emit resolves.
    expect(seen).toEqual(["pbt"]);
  });
});
