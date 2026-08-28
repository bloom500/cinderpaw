/**
 * The frugal policy. Every case here is about a keypress that should not have
 * been spent — because `(human/ai)^2` means a wasted action is worth more than
 * a clever one.
 */

import { describe, expect, test } from "bun:test";
import { createFrugalPolicy } from "../src/arc/policy.ts";
import { playLevel } from "../src/arc/play-level.ts";
import type { ArcEnvironment, ArcObservation } from "../src/arc/environment.ts";

/**
 * A corridor. ACTION2 walks forward and wins at `length`; ACTION1 is a wall —
 * it costs an action and changes nothing, which is the case the whole module
 * exists for.
 */
function corridor(length = 3) {
  const spent: string[] = [];
  let at = 0;
  const view = (): ArcObservation => ({
    grid: [[at]],
    state: at >= length ? "WIN" : at === 0 ? "NOT_PLAYED" : "NOT_FINISHED",
  });
  const env: ArcEnvironment = {
    actions: ["ACTION1", "ACTION2"],
    observe: view,
    act: (a) => {
      spent.push(a);
      if (a === "ACTION2" && at < length) at++;
      return view();
    },
  };
  return { env, spent };
}

const always = (a: string) => () => a;

describe("createFrugalPolicy — a proven no-op is never paid for twice", () => {
  test("a wall in one spot costs one action there, not one per spot", async () => {
    const { env, spent } = corridor(8);
    const r = await playLevel({
      env,
      policy: createFrugalPolicy({ inner: always("ACTION1") }),
      maxActions: 40,
    });
    // The table is per-position, so a wall is re-learned in each new cell —
    // until it has been inert in INERT_AFTER (3) distinct cells and never once
    // moved anything, at which point it is presumed a wall everywhere. That is
    // the whole difference between a memo and a policy: 3 wasted presses per
    // level instead of one per cell.
    expect(spent.filter((a) => a === "ACTION1")).toHaveLength(3);
    expect(r.state).toBe("WIN");
    expect(r.actions).toHaveLength(11); // 8 forward + the 3 it had to pay to learn
  });

  test("an action that has ever moved something is never presumed inert", async () => {
    // ACTION1 does nothing on even positions and advances on odd ones. It is
    // inert in plenty of states, so only the `everMoved` half of the rule stops
    // it being written off.
    const spent: string[] = [];
    let at = 0;
    const view = (): ArcObservation => ({ grid: [[at]], state: at >= 6 ? "WIN" : "NOT_FINISHED" });
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: view,
      act: (a) => {
        spent.push(a);
        if (a === "ACTION2" || at % 2 === 1) at++;
        return view();
      },
    };
    await playLevel({ env, policy: createFrugalPolicy({ inner: always("ACTION1") }), maxActions: 30 });
    expect(spent.filter((a) => a === "ACTION1").length).toBeGreaterThan(3);
  });

  test("the veto is reported, so a bad score is explainable afterwards", async () => {
    const { env } = corridor();
    const vetoes: Array<[string, string]> = [];
    await playLevel({
      env,
      policy: createFrugalPolicy({
        inner: always("ACTION1"),
        onVeto: (rejected, chosen) => vetoes.push([rejected, chosen]),
      }),
      maxActions: 10,
    });
    expect(vetoes.length).toBeGreaterThan(0);
    expect(vetoes[0]).toEqual(["ACTION1", "ACTION2"]);
  });

  test("a no-op learned in one position does not veto it in another", async () => {
    // ACTION1 is inert only at position 0; past that it advances too.
    const spent: string[] = [];
    let at = 0;
    const view = (): ArcObservation => ({ grid: [[at]], state: at >= 3 ? "WIN" : "NOT_FINISHED" });
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: view,
      act: (a) => {
        spent.push(a);
        if (a === "ACTION2" || at > 0) at++;
        return view();
      },
    };
    await playLevel({ env, policy: createFrugalPolicy({ inner: always("ACTION1") }), maxActions: 10 });
    // Position 0: ACTION1 wasted once, then redirected to ACTION2. From
    // position 1 onward ACTION1 is untried THERE, so it is allowed again.
    expect(spent).toEqual(["ACTION1", "ACTION2", "ACTION1", "ACTION1"]);
  });
});

describe("createFrugalPolicy — it narrows the choice without taking it", () => {
  test("the inner policy is offered only actions still worth choosing between", async () => {
    const { env } = corridor(4);
    const offers: string[][] = [];
    await playLevel({
      env,
      policy: createFrugalPolicy({
        inner: (_obs, ctx) => {
          offers.push([...ctx.actions]);
          return "ACTION1";
        },
      }),
      maxActions: 4,
    });
    // First turn nothing is known, so both are on the table; once ACTION1 is
    // proven inert here it stops being offered.
    expect(offers[0]).toEqual(["ACTION1", "ACTION2"]);
    expect(offers[1]).toEqual(["ACTION2"]);
  });

  test("when every action is known inert it fails open rather than stranding", async () => {
    const spent: string[] = [];
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: () => ({ grid: [[0]], state: "NOT_FINISHED" }),
      act: (a) => {
        spent.push(a);
        return { grid: [[0]], state: "NOT_FINISHED" };
      },
    };
    const r = await playLevel({
      env,
      policy: createFrugalPolicy({ inner: always("ACTION1") }),
      maxActions: 3,
    });
    // Nothing here can help, but the loop must still run and stop on budget —
    // a narrowing that empties the action list would end the level early and
    // silently.
    expect(r.stoppedBecause).toBe("budget");
    expect(spent).toHaveLength(3);
  });

  test("a policy that concedes still concedes", async () => {
    const { env, spent } = corridor();
    const r = await playLevel({ env, policy: createFrugalPolicy({ inner: () => null }), maxActions: 5 });
    expect(r.stoppedBecause).toBe("policy");
    expect(spent).toHaveLength(0);
  });
});

/**
 * MCTS rehearsal, wired in.
 *
 * The table only knows states it has already stood in. `imagination.ts` learns
 * a DSL program per action from the same before/after pairs and can predict
 * what an action does in a state nobody has visited — which is the whole
 * reason it exists. These pin the terms it is allowed to do that on.
 */
describe("frugal policy — imagination as a second opinion", () => {
  /**
   * A counter that only ACTION2 moves. Every state is distinct, so the
   * transition table can NEVER answer for the state the agent is standing in —
   * exactly the coverage gap rehearsal is for.
   */
  function counter(length = 8) {
    const spent: string[] = [];
    let at = 0;
    const view = (): ArcObservation => ({
      grid: [[at, 0], [0, 0]],
      state: at >= length ? "WIN" : at === 0 ? "NOT_PLAYED" : "NOT_FINISHED",
    });
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: view,
      act: (a) => {
        spent.push(a);
        if (a === "ACTION2" && at < length) at++;
        return view();
      },
    };
    return { env, spent };
  }

  test("off by default: no options, no behaviour change", async () => {
    const { env, spent } = counter(3);
    const learns: unknown[] = [];
    const policy = createFrugalPolicy({
      inner: () => "ACTION2",
      onLearn: (i) => learns.push(i),
    });
    await playLevel({ env, policy, maxActions: 10 });
    expect(learns).toEqual([]);
    expect(spent.length).toBeGreaterThan(0);
  });

  test("learning runs, is reported, and stays inside its time budget", async () => {
    const { env } = counter(12);
    const learns: { elapsedMs: number; budgetSpent: boolean }[] = [];
    const policy = createFrugalPolicy({
      inner: () => "ACTION2",
      imagination: { iterations: 20, relearnEvery: 2, learnBudgetMs: 5_000 },
      onLearn: (i) => learns.push({ elapsedMs: i.elapsedMs, budgetSpent: i.budgetSpent }),
    });
    await playLevel({ env, policy, maxActions: 12 });
    expect(learns.length).toBeGreaterThan(0);
    // The budget is a total across passes, not a per-pass timeout.
    const total = learns.reduce((sum, l) => sum + l.elapsedMs, 0);
    expect(total).toBeLessThan(30_000);
  });

  test("a prediction can never strand the agent", async () => {
    // Every action is doubted or useless; the fallback tier is filtered by
    // observation alone, so `inner` must still be offered something.
    const { env } = counter(4);
    const offered: number[] = [];
    const policy = createFrugalPolicy({
      inner: (_o, ctx) => {
        offered.push(ctx.actions.length);
        return ctx.actions[0] ?? null;
      },
      imagination: { iterations: 20, relearnEvery: 1, learnBudgetMs: 5_000 },
    });
    await playLevel({ env, policy, maxActions: 8 });
    expect(offered.length).toBeGreaterThan(0);
    expect(Math.min(...offered)).toBeGreaterThanOrEqual(1);
  });

  test("an observed no-op is still vetoed outright, imagination or not", async () => {
    const { env, spent } = counter(3);
    const vetoes: string[] = [];
    const policy = createFrugalPolicy({
      inner: () => "ACTION1", // the wall, every time
      imagination: { iterations: 20, relearnEvery: 2, learnBudgetMs: 5_000 },
      onVeto: (rejected) => vetoes.push(rejected),
    });
    await playLevel({ env, policy, maxActions: 8 });
    expect(vetoes.length).toBeGreaterThan(0);
    expect(spent).toContain("ACTION2");
  });
});

/**
 * Memory that survives a level.
 *
 * The runner builds ONE policy for a whole game, so everything learned in
 * level 1 is still there in level 2 — the lever NVIDIA's AVO writeup calls its
 * main one. This pins it, because the obvious "tidy" refactor is to construct
 * the policy per level, and that silently pays presses to relearn the same
 * buttons at every boundary.
 */
describe("frugal policy — what it remembers across a level boundary", () => {
  test("a wall proven useless in level 1 is not paid for again in level 2", async () => {
    const spent: string[] = [];
    let level = 1;
    let at = 0;
    // ACTION1 is inert in BOTH levels; ACTION2 advances. Level 2's grids are
    // disjoint from level 1's, so nothing the transition table stored can match
    // — only the inertness inference carries, which is the point.
    const view = (): ArcObservation => ({
      grid: [[level * 1000 + at]],
      state: at >= 3 ? "WIN" : "NOT_FINISHED",
    });
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: view,
      act: (a) => {
        spent.push(a);
        if (a === "ACTION2" && at < 3) at++;
        return view();
      },
    };

    const policy = createFrugalPolicy({ inner: () => "ACTION1" });
    await playLevel({ env, policy, maxActions: 12 });
    const level1Walls = spent.filter((a) => a === "ACTION1").length;

    // Same policy, new level: the grids are all different values now.
    level = 2;
    at = 0;
    spent.length = 0;
    await playLevel({ env, policy, maxActions: 12 });
    const level2Walls = spent.filter((a) => a === "ACTION1").length;

    // Level 1 pays to discover the wall. Level 2 must not pay as much again.
    expect(level1Walls).toBeGreaterThan(0);
    expect(level2Walls).toBeLessThan(level1Walls);
  });

  test("and it still finishes the level, never stranded by its own memory", async () => {
    const { env, spent } = corridor(3);
    const policy = createFrugalPolicy({ inner: () => "ACTION1" });
    await playLevel({ env, policy, maxActions: 12 });
    const first = await playLevel({ env, policy, maxActions: 12 });
    expect(first.state).toBe("WIN");
    expect(spent.length).toBeGreaterThan(0);
  });
});

describe("outcome feedback — the inner policy is told what its presses did", () => {
  test("a wall reads as 'nothing changed', a step as 'the grid changed'", async () => {
    const { env } = corridor(8);
    const seen: (readonly string[] | undefined)[] = [];
    // ACTION1 is the wall, ACTION2 walks. Alternating proves both spellings and
    // proves the outcome is the PREVIOUS press, not the one being chosen.
    let i = 0;
    const policy = createFrugalPolicy({
      inner: (_o, ctx) => {
        seen.push(ctx.outcomes ? [...ctx.outcomes] : undefined);
        return i++ % 2 === 0 ? "ACTION2" : "ACTION1";
      },
    });
    await playLevel({ env, policy, maxActions: 4 });

    expect(seen[0]).toEqual([]); // first press: nothing has happened yet
    expect(seen[1]).toEqual(["ACTION2 -> the grid changed"]);
    // The frugal veto can substitute an action, and what is logged must be what
    // was actually pressed — so read the tail rather than assuming ACTION1.
    expect(seen[2]?.length).toBe(2);
    expect(seen[2]?.[0]).toBe("ACTION2 -> the grid changed");
  });

  test("the outcome log is bounded, so the prompt cannot grow without limit", async () => {
    const { env } = corridor(200);
    let longest = 0;
    const policy = createFrugalPolicy({
      inner: (_o, ctx) => {
        longest = Math.max(longest, ctx.outcomes?.length ?? 0);
        return "ACTION2";
      },
    });
    await playLevel({ env, policy, maxActions: 30 });
    expect(longest).toBe(8);
  });
});

/**
 * The bug that made every system above inert on a real game.
 *
 * ARC `bp35-0a0ad940` paints a 64-press move bar along the bottom row. It ticks
 * on every press, so with it in the key no grid is ever seen twice: the run
 * reported 0 vetoes, 0 learned rules and 0 demotions over 32 presses while 17
 * of those presses did nothing to the board.
 */
describe("a counter drawn in the grid must not count as the game changing", () => {
  /** A board with a wall (ACTION1) and a step (ACTION2), plus a move bar on the last row. */
  function boardWithMoveBar() {
    let at = 0;
    let presses = 0;
    const view = (): ArcObservation => ({
      // Row 0 is the game. The last row is the bar: one more cell filled per press.
      grid: [[at, 0, 0, 0], Array.from({ length: 4 }, (_, x) => (x < presses ? 1 : 0))],
      state: "NOT_FINISHED",
    });
    return {
      actions: ["ACTION1", "ACTION2"],
      observe: view,
      act: (a: string) => {
        presses++;
        if (a === "ACTION2") at++;
        return view();
      },
    } satisfies ArcEnvironment;
  }

  test("the wall is still recognised as a wall, and the model is told so", async () => {
    const env = boardWithMoveBar();
    const seen: string[] = [];
    const vetoed: string[] = [];
    // Always ask for the wall. Without HUD detection the bar makes every press
    // look effective, nothing is ever vetoed, and the outcome line always lies.
    const policy = createFrugalPolicy({
      inner: (_o, ctx) => {
        seen.push(...(ctx.outcomes ?? []).slice(-1));
        return "ACTION1";
      },
      onVeto: (from) => vetoed.push(from),
    });
    await playLevel({ env, policy, maxActions: 12 });

    expect(seen.some((line) => line === "ACTION1 -> nothing changed")).toBe(true);
    expect(vetoed.length).toBeGreaterThan(0);
  });

  test("an animated board is not mistaken for a HUD", async () => {
    // Every row repaints every press. Blanking all of them would make every
    // state identical, which is worse than the bug — so nothing is blanked.
    let n = 0;
    const env: ArcEnvironment = {
      actions: ["ACTION1", "ACTION2"],
      observe: () => ({ grid: [[n], [n], [n], [n]], state: "NOT_FINISHED" }),
      act: () => {
        n++;
        return { grid: [[n], [n], [n], [n]], state: "NOT_FINISHED" as const };
      },
    };
    const lines: string[] = [];
    const policy = createFrugalPolicy({
      inner: (_o, ctx) => {
        lines.push(...(ctx.outcomes ?? []).slice(-1));
        return "ACTION1";
      },
    });
    await playLevel({ env, policy, maxActions: 12 });
    expect(lines.every((l) => l.endsWith("the grid changed"))).toBe(true);
  });
})
