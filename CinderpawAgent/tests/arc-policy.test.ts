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
