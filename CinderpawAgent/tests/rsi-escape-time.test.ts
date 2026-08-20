/**
 * Faza 3 — Fractal Search: escape-time tracking.
 *
 * Escape-time is how many iterations a lineage survives before it
 * plateaus (PLAN.md "Fractal Search"). The search quantises the genome
 * space into regions; long-escape-time regions are promising and get
 * zoomed in (finer mutations), short-escape-time regions are dead ends
 * and get pruned. This module provides the pure escape-time measure, the
 * region quantiser, and a tracker that turns accumulated escape-times
 * into a zoom factor + prune decision per region.
 */

import { describe, expect, test } from "bun:test";
import {
  EscapeTimeTracker,
  escapeTimeOf,
  regionKey,
} from "../src/rsi/l1-config/escape-time.ts";
import type { GenomeConfig } from "../src/rsi/l1-config/genome.ts";

const cfg = (over: Partial<GenomeConfig> = {}): GenomeConfig => ({
  promptTemplateId: 0,
  temperature: 0.5,
  systemPromptId: 0,
  retrievalStrategy: "episodic",
  contextWindowUsage: 0.5,
  toolPreferenceWeights: [0.25, 0.25, 0.25, 0.25],
  decompositionDepth: 1,
  ...over,
});

describe("escapeTimeOf", () => {
  test("counts strict improvements before the first plateau", () => {
    expect(escapeTimeOf([])).toBe(0);
    expect(escapeTimeOf([10])).toBe(0);
    expect(escapeTimeOf([10, 20, 30])).toBe(2);
    expect(escapeTimeOf([10, 20, 20])).toBe(1); // plateau on the 2nd step
    expect(escapeTimeOf([10, 5])).toBe(0); // immediate decline
    expect(escapeTimeOf([10, 20, 30, 30, 40])).toBe(2); // stops at first stall
  });
});

describe("regionKey", () => {
  test("configs within the same bins map to the same region", () => {
    expect(regionKey(cfg({ temperature: 0.51 }))).toBe(
      regionKey(cfg({ temperature: 0.55 })),
    );
  });

  test("a different retrieval strategy is a different region", () => {
    expect(regionKey(cfg({ retrievalStrategy: "graph" }))).not.toBe(
      regionKey(cfg({ retrievalStrategy: "episodic" })),
    );
  });

  test("a different decomposition depth is a different region", () => {
    expect(regionKey(cfg({ decompositionDepth: 0 }))).not.toBe(
      regionKey(cfg({ decompositionDepth: 3 })),
    );
  });

  test("far-apart temperatures fall in different regions", () => {
    expect(regionKey(cfg({ temperature: 0.05 }))).not.toBe(
      regionKey(cfg({ temperature: 0.95 })),
    );
  });
});

describe("EscapeTimeTracker", () => {
  test("an unseen region has a neutral zoom factor of 1", () => {
    const t = new EscapeTimeTracker();
    expect(t.zoomFactorFor("r")).toBe(1);
  });

  test("a long-escape-time region zooms in (factor < 1)", () => {
    const t = new EscapeTimeTracker();
    t.record("hot", 8);
    t.record("hot", 10);
    expect(t.zoomFactorFor("hot")).toBeLessThan(1);
  });

  test("a longer-escape region zooms in more than a shorter one", () => {
    const t = new EscapeTimeTracker();
    t.record("long", 10);
    t.record("short", 1);
    expect(t.zoomFactorFor("long")).toBeLessThan(t.zoomFactorFor("short"));
  });

  test("shouldPrune flags low-escape regions once there is enough evidence", () => {
    const t = new EscapeTimeTracker({ pruneThreshold: 1, minSamples: 3 });
    t.record("dead", 0);
    t.record("dead", 0);
    expect(t.shouldPrune("dead")).toBe(false); // < minSamples
    t.record("dead", 1);
    expect(t.shouldPrune("dead")).toBe(true); // mean 1/3 ≤ threshold, 3 samples
  });

  test("does not prune a productive region", () => {
    const t = new EscapeTimeTracker({ pruneThreshold: 1, minSamples: 2 });
    t.record("rich", 5);
    t.record("rich", 6);
    expect(t.shouldPrune("rich")).toBe(false);
  });
});
