/**
 * Phase 1 — Brain Autonomy.
 *
 * Covers the two things that were missing, not the routing policy: where a
 * registry comes from when nobody wrote one, and that `classify()` still
 * cannot produce `multilingual` (a documented defect this phase must not
 * make worse — see docs/specs/2026-08-19-phase-1-brain-autonomy.md).
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveDefaultConfig,
  brainConfigFileExists,
  loadBrainConfig,
} from "../src/brain/brain-config.ts";
import { profileFor, isKnownFamily, isLocalTarget } from "../src/brain/model-profiles.ts";
import { BrainStack } from "../src/brain/brain-stack.ts";
import { CircuitBreaker } from "../src/egress/circuit-breaker.ts";
import { classify } from "../src/brain/task-classifier.ts";
import type { ModelTarget } from "../src/types.ts";

const LOCAL: ModelTarget = {
  provider: "openai_compatible",
  model: "qwen2.5:7b",
  baseUrl: "http://127.0.0.1:11435",
};
const CLOUD: ModelTarget = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "sk-ant-test",
};

describe("profileFor", () => {
  test("known cloud family scores high on reasoning and is not local", () => {
    const p = profileFor(CLOUD);
    expect(p.local).toBe(false);
    expect(p.capabilities.reasoning).toBeGreaterThanOrEqual(8);
    expect(p.cost).toBe(3);
  });

  test("a loopback target is local and cheap regardless of family", () => {
    // Same premium family, served on loopback: cost must follow the host,
    // not the name, or a local proxy would be scored as a paid API.
    const p = profileFor({ ...CLOUD, baseUrl: "http://localhost:8080" });
    expect(p.local).toBe(true);
    expect(p.cost).toBe(1);
  });

  test("unknown model gets the conservative profile, and vision stays 0", () => {
    const p = profileFor({
      provider: "openai_compatible",
      model: "some-brand-new-thing-v9",
      baseUrl: "https://example.test/v1",
    });
    expect(isKnownFamily("some-brand-new-thing-v9")).toBe(false);
    // Mid everywhere it can be wrong cheaply...
    expect(p.capabilities.reasoning).toBe(5);
    // ...but never optimistic about a hard capability: a text model that
    // "scores 5 at vision" wins vision routes and fails every one.
    expect(p.capabilities.vision).toBe(0);
  });

  test("a vision marker in the name raises vision even for an unknown model", () => {
    const p = profileFor({
      provider: "openai_compatible",
      model: "mystery-vl-8b",
      baseUrl: "http://127.0.0.1:11435",
    });
    expect(p.capabilities.vision).toBeGreaterThanOrEqual(7);
  });

  test("coder variants outscore their base family at coding", () => {
    const base = profileFor({ ...LOCAL, model: "qwen2.5:7b" });
    const coder = profileFor({ ...LOCAL, model: "qwen2.5-coder:7b" });
    expect(coder.capabilities.coding).toBeGreaterThan(base.capabilities.coding);
  });

  test("isLocalTarget rejects a malformed URL instead of throwing", () => {
    expect(isLocalTarget("not a url")).toBe(false);
  });
});

describe("deriveDefaultConfig", () => {
  test("two targets produce an enabled, balanced, two-model registry", () => {
    const cfg = deriveDefaultConfig([LOCAL, CLOUD]);
    expect(cfg).not.toBeNull();
    expect(cfg!.enabled).toBe(true);
    expect(cfg!.mode).toBe("balanced");
    expect(cfg!.registry).toHaveLength(2);
  });

  test("one target still yields a usable single-model registry", () => {
    const cfg = deriveDefaultConfig([LOCAL, undefined]);
    expect(cfg!.registry).toHaveLength(1);
  });

  test("zero targets yields null — no model is not a routing problem", () => {
    expect(deriveDefaultConfig([undefined, undefined])).toBeNull();
    expect(deriveDefaultConfig([])).toBeNull();
  });

  test("duplicate targets collapse — CapabilityRegistry throws on dup ids", () => {
    const cfg = deriveDefaultConfig([LOCAL, { ...LOCAL }]);
    expect(cfg!.registry).toHaveLength(1);
    // The real assertion: the derived config must be constructible.
    expect(() => new BrainStack(cfg!, new CircuitBreaker())).not.toThrow();
  });

  test("the derived config actually routes a turn", () => {
    const brain = new BrainStack(deriveDefaultConfig([LOCAL, CLOUD])!, new CircuitBreaker());
    const result = brain.route({ text: "hello", hasImages: false, offline: false });
    expect(result.primary).toBeDefined();
    expect([LOCAL.model, CLOUD.model]).toContain(result.primary.model);
  });

  test("a cloud target with no key is invisible to routing", () => {
    // isConfigured() treats an empty key as "key was cleared".
    const keyless = { ...CLOUD, apiKey: "" };
    const brain = new BrainStack(deriveDefaultConfig([keyless])!, new CircuitBreaker());
    expect(() => brain.route({ text: "hi", hasImages: false, offline: false })).toThrow();
  });

  test("routing splits: a coding prompt and a simple prompt differ", () => {
    const brain = new BrainStack(deriveDefaultConfig([LOCAL, CLOUD])!, new CircuitBreaker());
    const coding = brain.route({
      text: "refactor this function and fix the stack trace",
      hasImages: false,
      offline: false,
    });
    const simple = brain.route({ text: "hi", hasImages: false, offline: false });
    // The point of Phase 1: two configured models are actually used
    // differently, rather than always taking the router's primary.
    expect(coding.classification.category).toBe("coding");
    expect(simple.classification.category).toBe("simple");
  });
});

describe("brainConfigFileExists", () => {
  test("distinguishes 'no file' from 'file says enabled: false'", () => {
    const dir = mkdtempSync(join(tmpdir(), "feral-brain-"));
    const brainPath = join(dir, "brain.json");
    try {
      expect(brainConfigFileExists({ brainPath })).toBe(false);

      writeFileSync(
        brainPath,
        JSON.stringify({ enabled: false, mode: "balanced", registry: [] }),
      );
      // Both return null from the loader — only this predicate separates
      // them, and boot.ts must not derive a config over an explicit off.
      expect(loadBrainConfig({ brainPath, env: {} })).toBeNull();
      expect(brainConfigFileExists({ brainPath })).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("known defect: multilingual is unreachable", () => {
  // Regression pin, NOT a fix. `Category` declares "multilingual",
  // REQUIREMENTS weights it 1.0, and the scorer is tested against it — but
  // classify() has six return sites and none emits it. Phase 1 records the
  // behaviour so a later correction is a visible, deliberate change.
  const PROBES = [
    "tradu textul asta în română",
    "translate this into French please",
    "こんにちは、元気ですか",
    "¿puedes ayudarme con esto?",
    "hello",
  ];

  for (const text of PROBES) {
    test(`classify(${JSON.stringify(text.slice(0, 24))}) is not multilingual`, () => {
      expect(classify({ text, hasImages: false, offline: false }).category)
        .not.toBe("multilingual");
    });
  }
});
