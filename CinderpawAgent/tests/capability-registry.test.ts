/**
 * Capability registry — Brain Stack slice 1.
 *
 * Asserts on real behaviour, not stubs:
 *   - duplicates in the catalogue throw at construction (the id is what
 *     the breaker keys on in S6 — silently dropping the second copy
 *     would be a silent routing bug)
 *   - all() / get() / size are deterministic
 *   - available() filters by BOTH creds (apiKey present, or local) AND
 *     circuit health (the callback)
 *   - hasCreds() treats empty-string apiKey as "no creds" — empty is a
 *     valid sentinel for "key was cleared" and routing to such a model
 *     would 401
 *   - normalizeCapabilities() defensively defaults missing keys to 0
 *     (the scorer will treat absent capabilities as "model can't do
 *     this"; the alternative of throwing would break user JSON edits)
 */

import { describe, expect, test } from "bun:test";

import {
  CapabilityRegistry,
  isConfigured,
  normalizeCapabilities,
  type BrainModel,
} from "../src/brain/capability-registry.ts";

// ---------------------------------------------------------------------------
// Fixtures — three models covering local, cloud-with-key, cloud-no-key.
// Keep these short and readable; the test bodies exercise the registry,
// not the fixture shape.
// ---------------------------------------------------------------------------

function localModel(id: string): BrainModel {
  return {
    id,
    target: {
      provider: "ollama",
      model: "qwen2.5-local",
      baseUrl: "http://localhost:11434",
      // apiKey intentionally absent for local
    },
    capabilities: {
      reasoning: 6,
      coding: 7,
      vision: 0,
      speed: 9,
      multilingual: 5,
    },
    cost: 1,
    local: true,
  };
}

function cloudModel(
  id: string,
  apiKey: string | undefined,
  caps?: Partial<BrainModel["capabilities"]>,
): BrainModel {
  const base: BrainModel = {
    id,
    target: {
      provider: "anthropic",
      model: "claude-sonnet-4",
      baseUrl: "https://api.anthropic.com/v1",
      ...(apiKey === undefined ? {} : { apiKey }),
    },
    capabilities: {
      reasoning: 9,
      coding: 9,
      vision: 8,
      speed: 6,
      multilingual: 9,
      ...caps,
    },
    cost: 3,
    local: false,
  };
  return base;
}

function emptyApiKeyCloudModel(id: string): BrainModel {
  return {
    id,
    target: {
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "", // cleared — must NOT be considered "has creds"
    },
    capabilities: {
      reasoning: 8,
      coding: 8,
      vision: 9,
      speed: 5,
      multilingual: 9,
    },
    cost: 3,
    local: false,
  };
}

// ---------------------------------------------------------------------------
// Construction + lookup
// ---------------------------------------------------------------------------

describe("CapabilityRegistry — construction", () => {
  test("empty registry: size 0, all() empty, get() undefined", () => {
    const r = new CapabilityRegistry([]);
    expect(r.size).toBe(0);
    expect(r.all()).toEqual([]);
    expect(r.get("nope")).toBeUndefined();
  });

  test("registers every model and reports the correct size", () => {
    const r = new CapabilityRegistry([
      localModel("a"),
      cloudModel("b", "sk-test"),
      cloudModel("c", "sk-test-2"),
    ]);
    expect(r.size).toBe(3);
    expect(r.all().map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("duplicate ids throw — the id is the breaker key in S6", () => {
    expect(() => {
      new CapabilityRegistry([
        localModel("dup"),
        cloudModel("dup", "sk-test"),
      ]);
    }).toThrow(/duplicate model id "dup"/);
  });

  test("get() returns the exact model by id", () => {
    const a = localModel("a");
    const b = cloudModel("b", "sk-test");
    const r = new CapabilityRegistry([a, b]);
    expect(r.get("a")).toBe(a);
    expect(r.get("b")).toBe(b);
    expect(r.get("missing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isConfigured() — pure helper; "ready to receive a request". Local models
// are configured by definition. Cloud targets need a non-empty apiKey.
// Empty string is "key was cleared" — routing there would 401.
// ---------------------------------------------------------------------------

describe("isConfigured()", () => {
  test("local models are configured by definition — no key needed", () => {
    expect(isConfigured(localModel("l"))).toBe(true);
  });

  test("cloud models with a non-empty apiKey are configured", () => {
    expect(isConfigured(cloudModel("c", "sk-test"))).toBe(true);
  });

  test("cloud models with no apiKey are NOT configured", () => {
    expect(isConfigured(cloudModel("c", undefined))).toBe(false);
  });

  test("empty-string apiKey is treated as unconfigured (key was cleared)", () => {
    expect(isConfigured(emptyApiKeyCloudModel("e"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// available() — the filter Brain Stack actually uses.
// ---------------------------------------------------------------------------

describe("CapabilityRegistry.available() — creds filter", () => {
  test("excludes cloud models with no apiKey; keeps local + keyed cloud", () => {
    const r = new CapabilityRegistry([
      localModel("local-ok"),
      cloudModel("cloud-ok", "sk-test"),
      cloudModel("cloud-nokey", undefined),
    ]);
    const allHealthy: (id: string) => boolean = () => true;

    const avail = r.available(allHealthy);
    expect(avail.map((m) => m.id).sort()).toEqual(["cloud-ok", "local-ok"]);
  });

  test("empty-string apiKey excludes the model even when health is fine", () => {
    const r = new CapabilityRegistry([
      localModel("local"),
      emptyApiKeyCloudModel("cloud-empty"),
    ]);
    const avail = r.available(() => true);
    expect(avail.map((m) => m.id)).toEqual(["local"]);
  });

  test("local-only registry with everything healthy returns everything", () => {
    const r = new CapabilityRegistry([
      localModel("a"),
      localModel("b"),
    ]);
    expect(r.available(() => true).map((m) => m.id).sort()).toEqual(["a", "b"]);
  });
});

describe("CapabilityRegistry.available() — health filter", () => {
  test("circuit open on one id hides it; others stay available", () => {
    const r = new CapabilityRegistry([
      localModel("a"),
      localModel("b"),
      cloudModel("c", "sk-test"),
    ]);
    // `a` is the unhealthy one.
    const avail = r.available((id) => id !== "a");

    expect(avail.map((m) => m.id).sort()).toEqual(["b", "c"]);
  });

  test("everything unhealthy → empty result (no silent fallback)", () => {
    const r = new CapabilityRegistry([
      localModel("a"),
      cloudModel("b", "sk-test"),
    ]);
    expect(r.available(() => false)).toEqual([]);
  });

  test("everything healthy → every creds-valid model is available", () => {
    const r = new CapabilityRegistry([
      localModel("a"),
      cloudModel("b", "sk-test"),
      cloudModel("c", undefined), // excluded by creds, not health
    ]);
    const avail = r.available(() => true);
    expect(avail.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  test("the health callback is invoked with each model's stable id", () => {
    const r = new CapabilityRegistry([
      localModel("x"),
      localModel("y"),
      localModel("z"),
    ]);
    const asked: string[] = [];
    r.available((id) => {
      asked.push(id);
      return true;
    });
    expect(asked.sort()).toEqual(["x", "y", "z"]);
  });

  test("creds check runs BEFORE health check — no-cred models are never asked", () => {
    const r = new CapabilityRegistry([
      cloudModel("cloud-nokey", undefined),
      localModel("local"),
    ]);
    const asked: string[] = [];
    r.available((id) => {
      asked.push(id);
      return true;
    });
    expect(asked).toEqual(["local"]);
  });
});

// ---------------------------------------------------------------------------
// normalizeCapabilities() — defensive helper for user JSON / partial sources.
// ---------------------------------------------------------------------------

describe("normalizeCapabilities()", () => {
  test("fills missing keys with 0", () => {
    const out = normalizeCapabilities({ coding: 8 });
    expect(out).toEqual({
      reasoning: 0,
      coding: 8,
      vision: 0,
      speed: 0,
      multilingual: 0,
    });
  });

  test("preserves existing values verbatim", () => {
    const out = normalizeCapabilities({
      reasoning: 7,
      coding: 6,
      vision: 9,
      speed: 3,
      multilingual: 8,
    });
    expect(out).toEqual({
      reasoning: 7,
      coding: 6,
      vision: 9,
      speed: 3,
      multilingual: 8,
    });
  });

  test("non-finite values (NaN, Infinity, undefined) default to 0", () => {
    const out = normalizeCapabilities({
      reasoning: Number.NaN,
      coding: Number.POSITIVE_INFINITY,
      vision: 4,
      speed: undefined,
      multilingual: -1, // not clamped — that's a caller decision
    });
    expect(out).toEqual({
      reasoning: 0,
      coding: 0,
      vision: 4,
      speed: 0,
      multilingual: -1,
    });
  });

  test("empty input yields all-zero capabilities", () => {
    expect(normalizeCapabilities({})).toEqual({
      reasoning: 0,
      coding: 0,
      vision: 0,
      speed: 0,
      multilingual: 0,
    });
  });
});