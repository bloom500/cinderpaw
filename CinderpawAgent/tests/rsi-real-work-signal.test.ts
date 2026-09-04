/**
 * The wire from "what happened out there" to "what the engine learns".
 *
 * Until now BRSI adapted to its own plumbing. Its error trigger heard inference
 * failures — the model refusing, the endpoint dying — which are the times the
 * agent could not SPEAK, not the times it was WRONG. And its fitness vector was
 * assembled from tool results and the thumbs a user almost never gives. So the
 * agent could fail a job outright and no part of the self-improvement loop
 * counted that as a reason to change anything.
 *
 * Two consumers, one fact. A finished unit of real work now (a) feeds the
 * trigger that wakes an episode, and (b) becomes a `workflow_completion`
 * signal in the next candidate's fitness vector — the signal kind that was
 * declared in `personal-fitness.ts` and left unwired.
 *
 * What this does NOT do, stated so the tests are not read as more than they
 * are: selection still compares candidates on the eval suite. Choosing a
 * genome BECAUSE it did better on real tasks needs the genome to vary across
 * those tasks, which is a separate design. This is the sensory half.
 */

import { describe, expect, test } from "bun:test";

import { ActivityMonitor } from "../src/rsi/l1-config/activity-monitor.ts";
import {
  auditEntriesToUserSignals,
  computePersonalFitness,
} from "../src/rsi/l2-adapt/personal-fitness.ts";

const T0 = 1_700_000_000_000;

describe("ActivityMonitor — a failed job is a reason to improve", () => {
  test("a failed unit of work feeds the same trigger an inference error does", () => {
    const m = new ActivityMonitor({ errorWindowMs: 60_000 });
    expect(m.errorsInWindow(T0)).toBe(0);

    m.recordOutcome(T0, false);
    m.recordOutcome(T0 + 1, false);

    // This is the whole point: the engine wakes on the work going wrong, not
    // only on the model failing to answer.
    expect(m.errorsInWindow(T0 + 2)).toBe(2);
  });

  test("a successful unit of work is counted but is not an error", () => {
    const m = new ActivityMonitor({ errorWindowMs: 60_000 });
    m.recordOutcome(T0, true);
    m.recordOutcome(T0 + 1, true);

    expect(m.errorsInWindow(T0 + 2)).toBe(0);
    expect(m.outcomesInWindow(T0 + 2)).toEqual({ total: 2, failed: 0 });
  });

  test("the window reports a RATE, not a bare failure count", () => {
    // Three failures out of a hundred jobs is not the same situation as three
    // out of three, and a count alone cannot tell them apart.
    const m = new ActivityMonitor({ errorWindowMs: 60_000 });
    for (let i = 0; i < 97; i++) m.recordOutcome(T0 + i, true);
    for (let i = 97; i < 100; i++) m.recordOutcome(T0 + i, false);

    expect(m.outcomesInWindow(T0 + 100)).toEqual({ total: 100, failed: 3 });
  });

  test("outcomes age out of the window", () => {
    const m = new ActivityMonitor({ errorWindowMs: 60_000 });
    m.recordOutcome(T0, false);
    expect(m.outcomesInWindow(T0 + 1)).toEqual({ total: 1, failed: 1 });
    expect(m.outcomesInWindow(T0 + 120_000)).toEqual({ total: 0, failed: 0 });
  });

  test("finishing a job does not mean the user is present", () => {
    // The idle clock is what decides whether the agent is free to dream. A
    // cron job completing at 4am must not read as somebody sitting there.
    const m = new ActivityMonitor();
    m.recordOutcome(T0, true);
    expect(m.idleFor(T0 + 5_000)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("personal fitness — the job's own verdict reaches the vector", () => {
  test("a task_outcome row becomes a workflow_completion signal", () => {
    const signals = auditEntriesToUserSignals([
      { timestamp: T0, actionType: "task_outcome", result: "success", toolName: "completed" },
      { timestamp: T0 + 1, actionType: "task_outcome", result: "error", toolName: "out_of_time" },
    ]);

    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.kind === "workflow_completion")).toBe(true);
    expect(signals[0]!.value).toBe(1);
    expect(signals[1]!.value).toBe(-1);
    // The structured reason rides along, so a journal row says WHICH way it
    // ended rather than only that it did.
    expect(signals[1]!.context).toBe("out_of_time");
  });

  test("failing the real work drags satisfaction below neutral", () => {
    const failing = computePersonalFitness({
      now: T0 + 1000,
      signals: auditEntriesToUserSignals([
        { timestamp: T0, actionType: "task_outcome", result: "error" },
        { timestamp: T0, actionType: "task_outcome", result: "error" },
      ]),
    });
    const passing = computePersonalFitness({
      now: T0 + 1000,
      signals: auditEntriesToUserSignals([
        { timestamp: T0, actionType: "task_outcome", result: "success" },
        { timestamp: T0, actionType: "task_outcome", result: "success" },
      ]),
    });

    expect(failing).toBeLessThan(0.5);
    expect(passing).toBeGreaterThan(0.5);
  });

  test("the job's verdict outweighs the tool calls it took to get there", () => {
    // An agent can make a pile of successful calls and still not close the
    // issue it was asked to close. Tool success is a proxy; this is the thing.
    const value = computePersonalFitness({
      now: T0 + 1000,
      signals: auditEntriesToUserSignals([
        { timestamp: T0, actionType: "tool_call", result: "success", toolName: "shell_exec" },
        { timestamp: T0, actionType: "tool_call", result: "success", toolName: "shell_exec" },
        { timestamp: T0, actionType: "task_outcome", result: "error" },
      ]),
    });

    // workflow_completion (0.35) against two tool_success (0.20 each): the
    // failure still shows, rather than being outvoted by its own busywork.
    expect(value).toBeLessThan(0.55);
  });

  test("no signals at all is neutral, not a failure", () => {
    // A fresh install has done no work. It must not read as an agent doing
    // badly, or the engine wakes on an empty history and optimises noise.
    expect(computePersonalFitness({ now: T0, signals: [] })).toBe(0.5);
  });
});
