/**
 * Mood engine — V1 scope: event-driven state transitions only.
 * Decay, shouldBeProactive, and idleSeconds are V2 and not present.
 */

import { describe, expect, test } from "bun:test";
import { MoodEngine } from "../src/core/mood.ts";

describe("MoodEngine", () => {
  test("starts at initial values", () => {
    const mood = new MoodEngine();
    const s = mood.state;
    expect(s.energy).toBeCloseTo(0.5, 1);
    expect(s.curiosity).toBeCloseTo(0.5, 1);
    expect(s.satisfaction).toBeCloseTo(0.6, 1);
    expect(s.concern).toBeCloseTo(0.1, 1);
  });

  test("message_received raises energy and curiosity", () => {
    const mood = new MoodEngine();
    const before = mood.state;
    mood.applyEvent("message_received");
    expect(mood.state.energy).toBeGreaterThan(before.energy);
    expect(mood.state.curiosity).toBeGreaterThan(before.curiosity);
  });

  test("tool_error raises concern and lowers satisfaction", () => {
    const mood = new MoodEngine();
    const before = mood.state;
    mood.applyEvent("tool_error");
    expect(mood.state.concern).toBeGreaterThan(before.concern);
    expect(mood.state.satisfaction).toBeLessThan(before.satisfaction);
  });

  test("inference_error raises concern and lowers energy", () => {
    const mood = new MoodEngine();
    const before = mood.state;
    mood.applyEvent("inference_error");
    expect(mood.state.concern).toBeGreaterThan(before.concern);
    expect(mood.state.energy).toBeLessThan(before.energy);
  });

  test("values are clamped to [0, 1]", () => {
    const mood = new MoodEngine({ energy: 0.99 });
    for (let i = 0; i < 20; i++) mood.applyEvent("message_received");
    expect(mood.state.energy).toBeLessThanOrEqual(1);

    const low = new MoodEngine({ satisfaction: 0.01 });
    for (let i = 0; i < 20; i++) low.applyEvent("tool_error");
    expect(low.state.satisfaction).toBeGreaterThanOrEqual(0);
  });

  test("describe returns a non-empty string", () => {
    expect(new MoodEngine().describe().length).toBeGreaterThan(0);
  });

  test("snapshot returns a copy, not the live state", () => {
    const mood = new MoodEngine();
    const snap = mood.snapshot();
    mood.applyEvent("tool_error");
    expect(snap.concern).toBeCloseTo(0.1, 1);
  });
});
