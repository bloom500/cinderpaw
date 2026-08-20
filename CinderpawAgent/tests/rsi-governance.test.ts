/**
 * L5 Governance — A1: GovernancePolicy schema + G0 loader.
 *
 * Contract under test (docs/2026-07-04-l5-governance-evolution-spec.md §1, §2.1, §9 rows 1–2):
 *   1. `clampPolicy` mirrors `clampMetaGenome` discipline: unknown keys
 *      dropped, numerics clamped into the hardcoded G0 walls, missing
 *      fields defaulted to the strictest built-in.
 *   2. G-INV-1: no clamped policy can carry gates weaker than
 *      DEFAULT_GATE_THRESHOLDS or meta bounds wider than META_BOUNDS
 *      (property-fuzzed).
 *   3. `approvals.l4ModulePromote` is always true in v1.
 *   4. `loadPolicy` fail-closed (G-INV-3): missing file → builtin
 *      strictest defaults with ALL layers frozen.
 *   5. Corrupt / structurally-invalid / G0-violating policy.json →
 *      quarantined as `policy.json.quarantine-<ts>` + fail-closed (§9 row 2).
 *   6. A valid policy document loads unchanged (source: "file").
 *   7. `InstancePaths.governance` exists under the rsi root.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GATE_THRESHOLDS } from "../src/rsi/infra/confidence.ts";
import { META_BOUNDS, META_ACCEPT_MARGIN, MIN_META_CYCLES } from "../src/rsi/l6-meta/meta-evolution.ts";
import { paths } from "../src/rsi/infra/instance-paths.ts";
import {
  builtinFailClosedPolicy,
  clampPolicy,
  effectiveGates,
  effectiveMetaBounds,
  loadPolicy,
  type GovernancePolicy,
} from "../src/rsi/l5-gov/governance.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "feral-gov-"));
}

/** A fully-valid policy document (the spec §2.1 example, gp-7). */
function validPolicy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
  return {
    version: 1,
    policyId: "gp-7",
    parentId: "gp-6",
    createdAt: 1_751_600_000_000,
    activatedAt: 1_751_600_001_000,
    prevHash: "abc123",
    approval: null,
    frozen: { l1: false, l2: false, l3: false, l4: false, l6: false },
    gates: { pValueMax: 0.05, effectSizeMin: 0.1, confidenceMin: 0.95 },
    meta: {
      bounds: {
        mutation_rate: [0.01, 0.8],
        exploration: [0.01, 0.5],
        confidence_gate: [0.95, 0.995],
        dream_batch: [5, 100],
        selection_pressure: [0.1, 3.0],
      },
      minCycles: 5,
      acceptMargin: 0.02,
    },
    budgets: {
      episodeMaxIterations: 100,
      episodeMaxTokens: 2_000_000,
      episodeMaxCostUsd: 0,
      episodeMaxWallClockMs: 480_000,
    },
    approvals: {
      l3CodePatchApply: true,
      l2LoraPromote: true,
      l4ModulePromote: true,
      l6Evolve: false,
    },
    ...overrides,
  };
}

function writePolicy(dir: string, doc: unknown): string {
  const p = join(dir, "policy.json");
  writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc), "utf8");
  return p;
}

describe("InstancePaths.governance", () => {
  test("governance dir sits under the rsi root", () => {
    const p = paths();
    expect(p.governance).toBe(join(p.root, "governance"));
  });
});

describe("clampPolicy — G0 walls (G-INV-1)", () => {
  test("weak gates are clamped to the locked floor", () => {
    const { policy, clamped } = clampPolicy(
      validPolicy({ gates: { pValueMax: 0.2, effectSizeMin: 0.01, confidenceMin: 0.5 } }),
    );
    expect(policy.gates.pValueMax).toBe(DEFAULT_GATE_THRESHOLDS.pValueMax);
    expect(policy.gates.effectSizeMin).toBe(DEFAULT_GATE_THRESHOLDS.effectSizeMin);
    expect(policy.gates.confidenceMin).toBe(DEFAULT_GATE_THRESHOLDS.confidenceMin);
    expect(clamped.length).toBeGreaterThan(0);
  });

  test("stricter-than-floor gates pass through unclamped", () => {
    const { policy, clamped } = clampPolicy(
      validPolicy({ gates: { pValueMax: 0.01, effectSizeMin: 0.3, confidenceMin: 0.99 } }),
    );
    expect(policy.gates).toEqual({ pValueMax: 0.01, effectSizeMin: 0.3, confidenceMin: 0.99 });
    expect(clamped).toEqual([]);
  });

  test("meta bounds wider than META_BOUNDS are intersected with the wall", () => {
    const doc = validPolicy();
    doc.meta.bounds.mutation_rate = [0.001, 0.99];
    const { policy, clamped } = clampPolicy(doc);
    expect(policy.meta.bounds.mutation_rate).toEqual(META_BOUNDS.mutation_rate);
    expect(clamped.some((f) => f.includes("mutation_rate"))).toBe(true);
  });

  test("sub-interval meta bounds pass through", () => {
    const doc = validPolicy();
    doc.meta.bounds.exploration = [0.05, 0.2];
    const { policy, clamped } = clampPolicy(doc);
    expect(policy.meta.bounds.exploration).toEqual([0.05, 0.2]);
    expect(clamped).toEqual([]);
  });

  test("minCycles below MIN_META_CYCLES and acceptMargin below META_ACCEPT_MARGIN are raised", () => {
    const doc = validPolicy();
    doc.meta.minCycles = 1;
    doc.meta.acceptMargin = 0.001;
    const { policy, clamped } = clampPolicy(doc);
    expect(policy.meta.minCycles).toBe(MIN_META_CYCLES);
    expect(policy.meta.acceptMargin).toBe(META_ACCEPT_MARGIN);
    expect(clamped.length).toBe(2);
  });

  test("budgets above the G0 wall are clamped down; negatives to zero", () => {
    const doc = validPolicy();
    doc.budgets.episodeMaxTokens = 999_999_999_999;
    doc.budgets.episodeMaxIterations = -5;
    const { policy, clamped } = clampPolicy(doc);
    expect(policy.budgets.episodeMaxTokens).toBeLessThan(999_999_999_999);
    expect(policy.budgets.episodeMaxIterations).toBe(0);
    expect(clamped.length).toBe(2);
  });

  test("l4ModulePromote is forced true (always-human in v1)", () => {
    const doc = validPolicy();
    (doc.approvals as Record<string, unknown>).l4ModulePromote = false;
    const { policy } = clampPolicy(doc);
    expect(policy.approvals.l4ModulePromote).toBe(true);
  });

  test("unknown keys are dropped", () => {
    const doc = { ...validPolicy(), evilKnob: 666, gates: { ...validPolicy().gates, extra: 1 } };
    const { policy } = clampPolicy(doc);
    expect("evilKnob" in policy).toBe(false);
    expect("extra" in policy.gates).toBe(false);
  });

  test("missing sections default to the strictest built-in", () => {
    const doc = validPolicy() as Record<string, unknown>;
    delete doc.approvals;
    delete doc.frozen;
    delete doc.gates;
    const { policy, defaulted } = clampPolicy(doc);
    // Strictest: all approvals required, all layers frozen, gates at floor.
    expect(policy.approvals.l6Evolve).toBe(true);
    expect(policy.frozen.l6).toBe(true);
    expect(policy.gates).toEqual(DEFAULT_GATE_THRESHOLDS);
    expect(defaulted.length).toBeGreaterThan(0);
  });

  test("non-finite numerics fall back to the strictest default", () => {
    const doc = validPolicy();
    doc.gates.pValueMax = Number.NaN;
    doc.meta.minCycles = Number.POSITIVE_INFINITY as unknown as number;
    const { policy } = clampPolicy(doc);
    expect(policy.gates.pValueMax).toBe(DEFAULT_GATE_THRESHOLDS.pValueMax);
    expect(Number.isFinite(policy.meta.minCycles)).toBe(true);
  });

  test("property: no document produces effective gates weaker than the floor or bounds wider than the wall", () => {
    // Deterministic fuzz: 200 garbage documents.
    let seed = 42;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const garbageValue = (): unknown => {
      const r = rnd();
      if (r < 0.2) return rnd() * 200 - 100;
      if (r < 0.4) return [rnd() * 10 - 5, rnd() * 10 - 5];
      if (r < 0.5) return "junk";
      if (r < 0.6) return null;
      if (r < 0.7) return { nested: rnd() };
      return rnd() < 0.5;
    };
    for (let i = 0; i < 200; i++) {
      const doc: Record<string, unknown> = validPolicy() as unknown as Record<string, unknown>;
      // Randomly corrupt 1–5 paths.
      const sections = ["gates", "meta", "budgets", "approvals", "frozen"];
      for (let k = 0; k < 1 + Math.floor(rnd() * 5); k++) {
        const sec = sections[Math.floor(rnd() * sections.length)]!;
        const obj = doc[sec] as Record<string, unknown> | undefined;
        if (!obj || typeof obj !== "object") continue;
        const target = sec === "meta" && rnd() < 0.5
          ? ((obj.bounds ?? {}) as Record<string, unknown>)
          : obj;
        const keys = Object.keys(target);
        if (keys.length === 0) continue;
        target[keys[Math.floor(rnd() * keys.length)]!] = garbageValue();
      }
      const { policy } = clampPolicy(doc);
      const g = effectiveGates(policy);
      expect(g.pValueMax).toBeLessThanOrEqual(DEFAULT_GATE_THRESHOLDS.pValueMax);
      expect(g.effectSizeMin).toBeGreaterThanOrEqual(DEFAULT_GATE_THRESHOLDS.effectSizeMin);
      expect(g.confidenceMin).toBeGreaterThanOrEqual(DEFAULT_GATE_THRESHOLDS.confidenceMin);
      const b = effectiveMetaBounds(policy);
      for (const key of Object.keys(META_BOUNDS) as (keyof typeof META_BOUNDS)[]) {
        expect(b[key][0]).toBeGreaterThanOrEqual(META_BOUNDS[key][0]);
        expect(b[key][1]).toBeLessThanOrEqual(META_BOUNDS[key][1]);
        expect(b[key][0]).toBeLessThanOrEqual(b[key][1]);
      }
    }
  });
});

describe("builtinFailClosedPolicy (G-INV-3)", () => {
  test("all layers frozen, gates at floor, all approvals required", () => {
    const p = builtinFailClosedPolicy();
    expect(p.frozen).toEqual({ l1: true, l2: true, l3: true, l4: true, l6: true });
    expect(p.gates).toEqual(DEFAULT_GATE_THRESHOLDS);
    expect(p.approvals.l3CodePatchApply).toBe(true);
    expect(p.approvals.l2LoraPromote).toBe(true);
    expect(p.approvals.l4ModulePromote).toBe(true);
    expect(p.approvals.l6Evolve).toBe(true);
  });

  test("survives its own clamp unchanged (fixpoint)", () => {
    const p = builtinFailClosedPolicy();
    const { policy, clamped, defaulted } = clampPolicy(p);
    expect(policy).toEqual(p);
    expect(clamped).toEqual([]);
    expect(defaulted).toEqual([]);
  });
});

describe("loadPolicy — fail-closed (§9 rows 1–2)", () => {
  test("missing policy.json → builtin, all frozen, no quarantine", () => {
    const dir = freshDir();
    const res = loadPolicy(dir);
    expect(res.source).toBe("builtin");
    if (res.source === "builtin") {
      expect(res.reason).toMatch(/missing/i);
      expect(res.quarantinedTo).toBeNull();
      expect(res.policy.frozen.l6).toBe(true);
    }
  });

  test("unparseable policy.json → builtin + quarantine file preserved for forensics", () => {
    const dir = freshDir();
    writePolicy(dir, "{not valid json!!");
    const res = loadPolicy(dir);
    expect(res.source).toBe("builtin");
    if (res.source === "builtin") {
      expect(res.quarantinedTo).toMatch(/policy\.json\.quarantine-\d+/);
      expect(existsSync(res.quarantinedTo!)).toBe(true);
      expect(readFileSync(res.quarantinedTo!, "utf8")).toBe("{not valid json!!");
    }
    // The corrupt file is MOVED, not copied — no half-trusted file left.
    expect(existsSync(join(dir, "policy.json"))).toBe(false);
  });

  test("unsupported version → quarantine + builtin", () => {
    const dir = freshDir();
    writePolicy(dir, validPolicy({ version: 2 as unknown as 1 }));
    const res = loadPolicy(dir);
    expect(res.source).toBe("builtin");
    if (res.source === "builtin") expect(res.reason).toMatch(/version/i);
    expect(readdirSync(dir).some((f) => f.startsWith("policy.json.quarantine-"))).toBe(true);
  });

  test("G0 violation in the active policy → quarantine + builtin (hand-edit is corruption)", () => {
    const dir = freshDir();
    writePolicy(dir, validPolicy({ gates: { pValueMax: 0.5, effectSizeMin: 0.1, confidenceMin: 0.95 } }));
    const res = loadPolicy(dir);
    expect(res.source).toBe("builtin");
    if (res.source === "builtin") expect(res.reason).toMatch(/G0/);
    expect(readdirSync(dir).some((f) => f.startsWith("policy.json.quarantine-"))).toBe(true);
  });

  test("valid policy loads as-is (source: file)", () => {
    const dir = freshDir();
    const doc = validPolicy();
    writePolicy(dir, doc);
    const res = loadPolicy(dir);
    expect(res.source).toBe("file");
    if (res.source === "file") {
      expect(res.policy).toEqual(doc);
      expect(res.defaulted).toEqual([]);
    }
    // Untouched on disk.
    expect(existsSync(join(dir, "policy.json"))).toBe(true);
  });

  test("policy with missing optional-ish fields loads with defaults reported (no quarantine)", () => {
    const dir = freshDir();
    const doc = validPolicy() as Record<string, unknown>;
    delete doc.budgets;
    writePolicy(dir, doc);
    const res = loadPolicy(dir);
    expect(res.source).toBe("file");
    if (res.source === "file") {
      expect(res.defaulted.some((f) => f.startsWith("budgets"))).toBe(true);
    }
  });
});
