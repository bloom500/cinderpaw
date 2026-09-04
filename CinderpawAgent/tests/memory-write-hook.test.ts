/**
 * after_memory_write hook event — Pathway 3 step 2 Task 1.
 *
 * Pins the wire shape of the new event the MemoryExtractor fires on
 * every fact / observation write. The reconciler (Task 2) subscribes
 * to this event; the engine never calls it directly.
 *
 * What this test guards:
 *   1. The event resolves through the existing registry contract
 *      (handler ordering, blocking-result, error tolerance).
 *   2. The payload reaches the handler untouched.
 *   3. A handler that throws is logged and the fire() call resolves
 *      to null (never rejects).
 *
 * The extractor-specific firing is covered in extractor-hook-fire.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HookRegistry } from "../src/core/hook-registry.ts";
import type {
  AfterMemoryWritePayload,
  HookResult,
} from "../src/types.ts";

// Capture stderr writes so the "handler error" test doesn't pollute the
// test output. Same pattern as hooks.test.ts.
let stderrWrites: string[];
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stderrWrites = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = origStderrWrite;
});

const sampleFactPayload: AfterMemoryWritePayload = {
  kind: "fact",
  sessionId: "s1",
  ts: 1_700_000_000,
  key: "language",
  value: "ro",
};

const sampleObsPayload: AfterMemoryWritePayload = {
  kind: "observation",
  sessionId: "s1",
  ts: 1_700_000_000,
  obsType: "preference",
  title: "user prefers Romanian",
  concepts: ["language", "ui"],
};

describe("after_memory_write hook event", () => {
  test("fires once per fact write and carries the payload", async () => {
    const r = new HookRegistry();
    const seen: AfterMemoryWritePayload[] = [];
    r.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    const result = await r.fire("after_memory_write", sampleFactPayload);
    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(sampleFactPayload);
  });

  test("fires once per observation write with the obs-shaped payload", async () => {
    const r = new HookRegistry();
    const seen: AfterMemoryWritePayload[] = [];
    r.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    await r.fire("after_memory_write", sampleObsPayload);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("observation");
    if (seen[0]?.kind === "observation") {
      expect(seen[0].obsType).toBe("preference");
      expect(seen[0].concepts).toEqual(["language", "ui"]);
    }
  });

  test("returns the first blocking result and short-circuits the rest", async () => {
    const r = new HookRegistry();
    const later: AfterMemoryWritePayload[] = [];
    r.on("after_memory_write", (p) => {
      later.push(p);
      return { block: true, reason: "reconciler busy" };
    });
    // A second handler must NOT see the event once the first blocks.
    r.on("after_memory_write", (p) => {
      later.push(p);
      return { block: false };
    });
    const result: HookResult | null = await r.fire("after_memory_write", sampleFactPayload);
    expect(result).toEqual({ block: true, reason: "reconciler busy" });
    expect(later).toHaveLength(1);
  });

  test("a misbehaving handler does not crash the pipeline", async () => {
    const r = new HookRegistry();
    r.on("after_memory_write", () => {
      throw new Error("reconciler bug");
    });
    // fire() must never reject — handlers are caught and logged.
    const result = await r.fire("after_memory_write", sampleFactPayload);
    expect(result).toBeNull();
    // stderr saw the warning.
    expect(stderrWrites.some((s) => s.includes("after_memory_write"))).toBe(true);
  });

  test("with no subscribers the fire resolves to null (no-op)", async () => {
    const r = new HookRegistry();
    const result = await r.fire("after_memory_write", sampleFactPayload);
    expect(result).toBeNull();
  });

  test("handlers run in registration order", async () => {
    const r = new HookRegistry();
    const order: string[] = [];
    r.on("after_memory_write", () => { order.push("a"); return { block: false }; });
    r.on("after_memory_write", () => { order.push("b"); return { block: false }; });
    r.on("after_memory_write", () => { order.push("c"); return { block: false }; });
    await r.fire("after_memory_write", sampleFactPayload);
    expect(order).toEqual(["a", "b", "c"]);
  });
});
