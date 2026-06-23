/**
 * Reconciler — Pathway 3 step 2 Task 2.
 *
 * Listens to `after_memory_write` and (in Task 3) routes the payload
 * into the FractalMemory tree via upsertLeaf, plus mirrors into the
 * MemoryGraph. This task ONLY wires the subscription pattern — the
 * handler body is a debug-log no-op until Task 3.
 *
 * What this test guards:
 *   1. start()/stop() register and detach the hook handler.
 *   2. start() is idempotent — calling it twice must not double-subscribe.
 *   3. stop() before start() is a no-op (no throw, registry untouched).
 *   4. With a counting handler on the registry, fire() reaches it.
 *
 * The actual upsert / graph reconcile wiring lives in Task 3; that
 * test set will pin the side effects (leaves added, pulses emitted,
 * graph edges mirrored).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { Reconciler } from "../src/memory/reconciler.ts";
import { HookRegistry } from "../src/core/hook-registry.ts";
import type { AfterMemoryWritePayload } from "../src/types.ts";

/** Minimal stubs — Task 3 will add real FractalMemory / MemoryGraph. */
function makeDeps() {
  const hooks = new HookRegistry();
  const fractal = {
    upsertLeaf: () => Promise.resolve({ kind: "grow", leafId: 0 } as const),
  };
  const graph = {
    reconcile: () => {},
  };
  return { hooks, fractal, graph };
}

describe("Reconciler subscription", () => {
  test("subscribes on start and unsubscribes on stop", () => {
    const { hooks } = makeDeps();
    const r = new Reconciler({ hooks, fractal: {} as any, graph: {} as any });
    expect(hooks.countFor("after_memory_write")).toBe(0);
    r.start();
    expect(hooks.countFor("after_memory_write")).toBe(1);
    r.stop();
    expect(hooks.countFor("after_memory_write")).toBe(0);
  });

  test("start() is idempotent — second call does not double-subscribe", () => {
    const { hooks } = makeDeps();
    const r = new Reconciler({ hooks, fractal: {} as any, graph: {} as any });
    r.start();
    r.start();
    expect(hooks.countFor("after_memory_write")).toBe(1);
    r.stop();
    expect(hooks.countFor("after_memory_write")).toBe(0);
  });

  test("stop() before start() is a no-op (does not throw)", () => {
    const { hooks } = makeDeps();
    const r = new Reconciler({ hooks, fractal: {} as any, graph: {} as any });
    expect(() => r.stop()).not.toThrow();
    expect(hooks.countFor("after_memory_write")).toBe(0);
  });

  test("stop() is idempotent — second call after unsubscribe does not throw", () => {
    const { hooks } = makeDeps();
    const r = new Reconciler({ hooks, fractal: {} as any, graph: {} as any });
    r.start();
    r.stop();
    expect(() => r.stop()).not.toThrow();
  });

  test("does not interfere with other handlers on the same event", async () => {
    const { hooks } = makeDeps();
    const r = new Reconciler({ hooks, fractal: {} as any, graph: {} as any });
    const seen: AfterMemoryWritePayload[] = [];
    hooks.on("after_memory_write", (p) => {
      seen.push(p);
      return { block: false };
    });
    r.start();
    await hooks.fire("after_memory_write", {
      kind: "fact",
      sessionId: "s",
      ts: 1,
      key: "k",
      value: "v",
    });
    expect(seen).toHaveLength(1);
    r.stop();
  });
});
