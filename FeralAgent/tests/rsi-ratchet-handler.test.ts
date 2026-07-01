/**
 * Faza 1 — Async RSI Engine: the ratchet handler.
 *
 * Listens for EvalComplete. For a non-errored result it commits the
 * genome as a candidate (Rust commit_genome) and asks Rust to attempt a
 * fast-forward of `main` (ratchet_attempt). The monotonicity guarantee
 * lives in Rust: `main` advances ONLY when the new score beats the prior
 * best. The handler emits RatchetAdvanced iff main actually moved.
 *
 * commit_genome / ratchet_attempt are injected (protocol (a) in prod) so
 * the ratchet decision logic is unit-testable without a live git repo.
 */

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus, type RsiEvent } from "../src/rsi/event-bus.ts";
import { RatchetHandler } from "../src/rsi/ratchet-handler.ts";

/** Scratch journal path so the per-candidate Contract rows never touch the
 *  real ~/.feral/rsi/journal during tests. */
const journalPath = () => join(tmpdir(), `rsi-ratchet-test-${process.pid}.jsonl`);

describe("RSI ratchet handler", () => {
  test("commits the candidate and emits RatchetAdvanced when main advances", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    const committed: Array<{ genomeId: string; score: number; tokenCost: number; durationMs: number }> = [];
    new RatchetHandler(bus, {
      commitGenome: async (req) => {
        committed.push(req);
        return { commitHash: "a".repeat(40) };
      },
      ratchetAttempt: async (_commitHash, _score) => ({
        advanced: true,
        previousBest: 50,
      }),
      journalPath,
    });

    await bus.emit({
      type: "EvalComplete",
      genomeId: "g1",
      score: 73,
      tokenCost: 1234,
      durationMs: 56,
      errored: false,
    });

    // commitGenome receives the full context it needs to build a commit;
    // config/lineage/mutationType are filled by the adapter from the population.
    expect(committed).toEqual([{ genomeId: "g1", score: 73, tokenCost: 1234, durationMs: 56 }]);
    expect(advanced.length).toBe(1);
    const e = advanced[0] as RsiEvent & {
      genomeId: string;
      commitHash: string;
      score: number;
      previousBest: number;
      tokenCost: number;
    };
    expect(e.genomeId).toBe("g1");
    expect(e.commitHash).toBe("a".repeat(40));
    expect(e.score).toBe(73);
    expect(e.previousBest).toBe(50);
    // Carried through for the recalcitrance tracker.
    expect(e.tokenCost).toBe(1234);
  });

  test("a non-advancing candidate is committed but emits no RatchetAdvanced", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let commits = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => {
        commits += 1;
        return { commitHash: "b".repeat(40) };
      },
      ratchetAttempt: async () => ({ advanced: false, previousBest: 90 }),
      journalPath,
    });

    await bus.emit({ type: "EvalComplete", genomeId: "g2", score: 60, errored: false });

    expect(commits).toBe(1); // candidate still recorded on its branch
    expect(advanced.length).toBe(0); // main did not move
  });

  test("an errored eval is neither committed nor ratcheted", async () => {
    const bus = new EventBus();
    const advanced: RsiEvent[] = [];
    bus.on("RatchetAdvanced", async (e) => advanced.push(e));

    let commits = 0;
    let attempts = 0;
    new RatchetHandler(bus, {
      commitGenome: async () => {
        commits += 1;
        return { commitHash: "c".repeat(40) };
      },
      ratchetAttempt: async () => {
        attempts += 1;
        return { advanced: false, previousBest: 0 };
      },
      journalPath,
    });

    await bus.emit({ type: "EvalComplete", genomeId: "g3", score: 0, errored: true });

    expect(commits).toBe(0);
    expect(attempts).toBe(0);
    expect(advanced.length).toBe(0);
  });
});
