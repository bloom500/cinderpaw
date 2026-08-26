/**
 * The action loop. Every case here is about the one thing that decides the
 * score: an action must never be spent by accident.
 *
 * ARC-AGI-3 scores a level `(human_actions / ai_actions)^2`. Double the
 * actions is a quarter of the score, so a loop that leaks one action per level
 * across 183 levels does not lose a little — it loses most of the run.
 */

import { describe, expect, test } from "bun:test";
import { playLevel } from "../src/arc/play-level.ts";
import { isTerminal, type ArcEnvironment, type ArcObservation } from "../src/arc/environment.ts";

/** A counting environment: wins after `winAfter` actions, records every call. */
function env(opts: { winAfter?: number; actions?: string[]; startState?: ArcObservation["state"] } = {}) {
  const actions = opts.actions ?? ["ACTION1", "ACTION2"];
  const calls: string[] = [];
  let count = 0;
  let state: ArcObservation["state"] = opts.startState ?? "NOT_STARTED";
  const e: ArcEnvironment = {
    actions,
    observe: () => ({ grid: [[count]], state }),
    act: (a) => {
      calls.push(a);
      count++;
      if (opts.winAfter !== undefined && count >= opts.winAfter) state = "WIN";
      else state = "NOT_FINISHED";
      return { grid: [[count]], state };
    },
  };
  return { e, calls };
}

const always = (a: string) => () => a;

describe("playLevel — the budget is the score", () => {
  test("stops at the budget and spends not one more", async () => {
    const { e, calls } = env();
    const r = await playLevel({ env: e, policy: always("ACTION1"), maxActions: 5 });
    expect(calls).toHaveLength(5);
    expect(r.actions).toHaveLength(5);
    expect(r.stoppedBecause).toBe("budget");
  });

  test("a zero budget takes no action at all", async () => {
    const { e, calls } = env();
    const r = await playLevel({ env: e, policy: always("ACTION1"), maxActions: 0 });
    expect(calls).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  test("stops the instant the level is won — no confirming keypress", async () => {
    const { e, calls } = env({ winAfter: 3 });
    const r = await playLevel({ env: e, policy: always("ACTION1"), maxActions: 100 });
    expect(calls).toHaveLength(3);
    expect(r.state).toBe("WIN");
    expect(r.stoppedBecause).toBe("terminal");
  });

  test("a level handed over already finished costs nothing", async () => {
    // Acting here would spend a real action to learn what observe() said.
    const { e, calls } = env({ startState: "WIN" });
    const r = await playLevel({ env: e, policy: always("ACTION1"), maxActions: 10 });
    expect(calls).toEqual([]);
    expect(r.stoppedBecause).toBe("terminal");
  });

  test("the policy may concede, and conceding spends nothing further", async () => {
    // Under a squared penalty, stopping beats discovering you are stuck twice.
    const { e, calls } = env();
    let n = 0;
    const r = await playLevel({
      env: e,
      policy: () => (n++ < 2 ? "ACTION1" : null),
      maxActions: 50,
    });
    expect(calls).toHaveLength(2);
    expect(r.stoppedBecause).toBe("policy");
  });

  test("an action the game does not accept is never sent", async () => {
    // Finding out what the server charges for a typo is not something to do
    // during a scored run.
    const { e, calls } = env();
    const r = await playLevel({ env: e, policy: always("ACTION9"), maxActions: 10 });
    expect(calls).toEqual([]);
    expect(r.stoppedBecause).toBe("invalid_action");
  });
});

describe("playLevel — what the policy is told", () => {
  test("remaining counts down, and taken is the real history", async () => {
    const { e } = env();
    const seen: { remaining: number; taken: string[] }[] = [];
    await playLevel({
      env: e,
      policy: (_obs, ctx) => {
        seen.push({ remaining: ctx.remaining, taken: [...ctx.taken] });
        return "ACTION1";
      },
      maxActions: 3,
    });
    expect(seen.map((s) => s.remaining)).toEqual([3, 2, 1]);
    expect(seen[2]?.taken).toEqual(["ACTION1", "ACTION1"]);
  });

  test("the policy sees the observation AFTER the previous action", async () => {
    const { e } = env();
    const grids: number[][][] = [];
    await playLevel({
      env: e,
      policy: (obs) => {
        grids.push(obs.grid);
        return "ACTION1";
      },
      maxActions: 3,
    });
    expect(grids.map((g) => g[0]![0])).toEqual([0, 1, 2]);
  });

  test("an async policy is awaited, not raced", async () => {
    const { e, calls } = env();
    await playLevel({
      env: e,
      policy: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return "ACTION2";
      },
      maxActions: 2,
    });
    expect(calls).toEqual(["ACTION2", "ACTION2"]);
  });
});

describe("playLevel — telemetry cannot cost a level", () => {
  test("a throwing onAction does not end the run", async () => {
    const { e, calls } = env();
    const r = await playLevel({
      env: e,
      policy: always("ACTION1"),
      maxActions: 3,
      onAction: () => {
        throw new Error("panel exploded");
      },
    });
    expect(calls).toHaveLength(3);
    expect(r.stoppedBecause).toBe("budget");
  });

  test("onAction sees every action, in order, with its index", async () => {
    const { e } = env();
    const seen: [string, number][] = [];
    await playLevel({
      env: e,
      policy: always("ACTION1"),
      maxActions: 2,
      onAction: (a, _o, i) => void seen.push([a, i]),
    });
    expect(seen).toEqual([
      ["ACTION1", 1],
      ["ACTION1", 2],
    ]);
  });
});

describe("playLevel — loud on nonsense", () => {
  test("a non-integer or negative budget is refused, not silently clamped", async () => {
    const { e } = env();
    await expect(
      playLevel({ env: e, policy: always("ACTION1"), maxActions: -1 }),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      playLevel({ env: e, policy: always("ACTION1"), maxActions: 2.5 }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("isTerminal", () => {
  test("only WIN and GAME_OVER end a level", () => {
    expect(isTerminal("WIN")).toBe(true);
    expect(isTerminal("GAME_OVER")).toBe(true);
    expect(isTerminal("NOT_STARTED")).toBe(false);
    expect(isTerminal("NOT_FINISHED")).toBe(false);
  });
});
