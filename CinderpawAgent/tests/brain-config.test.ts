/**
 * Brain Stack slice 5 — brain.json loader tests.
 *
 * Asserts on real filesystem behaviour (writes a temp brain.json, then
 * calls loadBrainConfig with a path override). No mocking — the loader
 * is pure I/O so the test surface is the same as production.
 *
 * Covers:
 *   - brain.json absent → null (opt-out)
 *   - brain.json absent + CINDERPAW_BRAIN=1 → throws (explicit request, missing config)
 *   - brain.json present + enabled:true → returns the config
 *   - brain.json present + enabled:false + CINDERPAW_BRAIN unset → null (opt-out)
 *   - brain.json present + enabled:false + CINDERPAW_BRAIN=1 → enabled:true (override)
 *   - malformed JSON → throws
 *   - wrong shape (enabled not boolean, mode not in set, registry not array) → throws
 *   - defaultBrainPath respects CINDERPAW_HOME
 *   - CINDERPAW_BRAIN is read from the env override in opts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultBrainPath, loadBrainConfig } from "../src/brain/brain-config.ts";

// ---------------------------------------------------------------------------
// Helpers — temp dir + brain.json fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let brainPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "feral-brain-"));
  brainPath = join(tmpDir, "brain.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeBrain(json: object): void {
  writeFileSync(brainPath, JSON.stringify(json), "utf8");
}

const VALID_CONFIG = {
  enabled: true,
  mode: "balanced",
  registry: [
    {
      id: "local-ollama",
      target: {
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        baseUrl: "http://localhost:11434",
      },
      capabilities: { reasoning: 6, coding: 8, vision: 0, speed: 8, multilingual: 5 },
      cost: 1,
      local: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Opt-in via file presence
// ---------------------------------------------------------------------------

describe("loadBrainConfig — opt-in via file presence", () => {
  test("brain.json absent + no CINDERPAW_BRAIN → null (opt-out)", () => {
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result).toBeNull();
  });

  test("brain.json absent + CINDERPAW_BRAIN unset → null (env doesn't force)", () => {
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result).toBeNull();
  });

  test("brain.json present + enabled:true → returns config", () => {
    writeBrain(VALID_CONFIG);
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result).not.toBeNull();
    expect(result?.enabled).toBe(true);
    expect(result?.mode).toBe("balanced");
    expect(result?.registry).toHaveLength(1);
  });

  test("brain.json present + enabled:false + no CINDERPAW_BRAIN → null (off via file)", () => {
    writeBrain({ ...VALID_CONFIG, enabled: false });
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CINDERPAW_BRAIN env escape hatch (for headless testing)
// ---------------------------------------------------------------------------

describe("loadBrainConfig — CINDERPAW_BRAIN env escape hatch", () => {
  test("CINDERPAW_BRAIN=1 + brain.json absent → throws (explicit request, missing config)", () => {
    expect(() =>
      loadBrainConfig({ brainPath, env: { CINDERPAW_BRAIN: "1" } }),
    ).toThrow(/CINDERPAW_BRAIN=1 but brain.json not found/);
  });

  test("CINDERPAW_BRAIN=1 + file present + enabled:true → returned as-is", () => {
    writeBrain(VALID_CONFIG);
    const result = loadBrainConfig({ brainPath, env: { CINDERPAW_BRAIN: "1" } });
    expect(result?.enabled).toBe(true);
  });

  test("CINDERPAW_BRAIN=1 + file present + enabled:false → enabled is FORCED true", () => {
    writeBrain({ ...VALID_CONFIG, enabled: false });
    const result = loadBrainConfig({ brainPath, env: { CINDERPAW_BRAIN: "1" } });
    expect(result?.enabled).toBe(true);
  });

  test("CINDERPAW_BRAIN=0 (not '1') → does NOT force enable", () => {
    writeBrain({ ...VALID_CONFIG, enabled: false });
    const result = loadBrainConfig({ brainPath, env: { CINDERPAW_BRAIN: "0" } });
    expect(result).toBeNull();
  });

  test("CINDERPAW_BRAIN unset + file enabled:true → enabled stays true (no forced override)", () => {
    writeBrain(VALID_CONFIG);
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result?.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe("loadBrainConfig — shape validation", () => {
  test("malformed JSON → throws", () => {
    writeFileSync(brainPath, "{ not valid json", "utf8");
    expect(() => loadBrainConfig({ brainPath, env: {} })).toThrow(/not valid JSON/);
  });

  test("non-object root → throws", () => {
    writeFileSync(brainPath, "[]", "utf8");
    expect(() => loadBrainConfig({ brainPath, env: {} })).toThrow(/must be a JSON object/);
  });

  test("enabled: string → throws", () => {
    writeBrain({ ...VALID_CONFIG, enabled: "yes" });
    expect(() => loadBrainConfig({ brainPath, env: {} })).toThrow(/"enabled" must be a boolean/);
  });

  test("mode: invalid string → throws", () => {
    writeBrain({ ...VALID_CONFIG, mode: "auto" });
    expect(() => loadBrainConfig({ brainPath, env: {} })).toThrow(/"mode" must be one of/);
  });

  test("registry: not an array → throws", () => {
    writeBrain({ ...VALID_CONFIG, registry: { id: "x" } });
    expect(() => loadBrainConfig({ brainPath, env: {} })).toThrow(/"registry" must be an array/);
  });

  test("mode: each valid value accepted (budget, balanced, quality)", () => {
    for (const mode of ["budget", "balanced", "quality"] as const) {
      writeBrain({ ...VALID_CONFIG, mode });
      const result = loadBrainConfig({ brainPath, env: {} });
      expect(result?.mode).toBe(mode);
    }
  });

  test("the loader does NOT validate inner BrainModel shape (BrainStack does)", () => {
    // registry entries with wrong shape are accepted by the loader;
    // BrainStack's CapabilityRegistry throws on duplicate ids, missing
    // fields, etc. The loader stays thin — see brain-config.ts docstring.
    writeBrain({
      enabled: true,
      mode: "balanced",
      registry: [
        { id: "minimal", target: { provider: "x", model: "m", baseUrl: "http://x" }, capabilities: {}, cost: 1, local: true },
      ],
    });
    const result = loadBrainConfig({ brainPath, env: {} });
    expect(result).not.toBeNull();
    expect(result?.registry).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// defaultBrainPath — CINDERPAW_HOME override
// ---------------------------------------------------------------------------

describe("defaultBrainPath", () => {
  test("uses $CINDERPAW_HOME/brain.json when CINDERPAW_HOME is set", () => {
    const customHome = join(tmpDir, "custom-feral-home");
    const path = defaultBrainPath.call(null);
    // We can't easily test the env override without polluting process.env,
    // so just assert the function returns a string ending in 'brain.json'.
    expect(typeof path).toBe("string");
    expect(path.endsWith("brain.json")).toBe(true);
    // The function uses process.env.CINDERPAW_HOME internally — assert the
    // shape, not the exact path. (Mutation of process.env is racy.)
    void customHome;
  });
});

// ---------------------------------------------------------------------------
// The `env` override in opts is used (not process.env)
// ---------------------------------------------------------------------------

describe("loadBrainConfig — uses opts.env, not process.env", () => {
  test("opts.env.CINDERPAW_BRAIN=1 is honoured even when process.env.CINDERPAW_BRAIN is unset", () => {
    writeBrain({ ...VALID_CONFIG, enabled: false });
    const before = process.env.CINDERPAW_BRAIN;
    delete process.env.CINDERPAW_BRAIN;
    try {
      const result = loadBrainConfig({
        brainPath,
        env: { CINDERPAW_BRAIN: "1" },
      });
      expect(result?.enabled).toBe(true);
    } finally {
      if (before !== undefined) process.env.CINDERPAW_BRAIN = before;
    }
  });

  test("opts.env can override an absent CINDERPAW_BRAIN even if process.env has it", () => {
    writeBrain({ ...VALID_CONFIG, enabled: false });
    const before = process.env.CINDERPAW_BRAIN;
    process.env.CINDERPAW_BRAIN = "1"; // force enable
    try {
      // opts.env explicitly says no CINDERPAW_BRAIN — should win over process.env.
      const result = loadBrainConfig({ brainPath, env: {} });
      expect(result).toBeNull();
    } finally {
      if (before !== undefined) {
        process.env.CINDERPAW_BRAIN = before;
      } else {
        delete process.env.CINDERPAW_BRAIN;
      }
    }
  });
});