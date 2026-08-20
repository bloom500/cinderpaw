/**
 * L5 Governance — A4: cross-layer integration (spec §7, §8; AC 6).
 *
 * Contract under test:
 *   1. `governanceCheck(action, ctx)` is the single permission entry
 *      point: frozen layers refuse; approval-required actions refuse
 *      without `approvalPresent`; reads are never frozen.
 *   2. `ensureGenesisPolicy`: a FRESH install gets the genesis policy
 *      (codifies the pre-L5 hardcoded defaults, unfrozen) exactly once;
 *      a dir with history but no policy.json stays fail-closed (AC5 is
 *      about deletion, not first boot).
 *   3. L6 reads through the policy accessor (§7): frozen.l6 makes
 *      evolve()/rollback() refuse while status() keeps working; policy
 *      minCycles / acceptMargin / bounds compose tighten-only on top of
 *      the hardcoded walls.
 *   4. G-INV-4 ≥half rule (§9 row 4): when at least half the journal
 *      window fails verification, L6 refuses to settle.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinFailClosedPolicy,
  defaultGenesisPolicy,
  governanceCheck,
  loadPolicy,
} from "../src/rsi/l5-gov/governance.ts";
import { ensureGenesisPolicy, GovernanceLifecycle } from "../src/rsi/l5-gov/governance-lifecycle.ts";
import { verifyChainFile } from "../src/rsi/infra/hash-chain.ts";
import { appendJournal, journalFilename, type JournalEntry } from "../src/rsi/infra/journal.ts";
import {
  defaultReadWindowVerified,
  MetaEvolution,
  META_BOUNDS,
  mutateMetaGenome,
  DEFAULT_META_GENOME,
  type MetaGenome,
} from "../src/rsi/l6-meta/meta-evolution.ts";
import type { GovernancePolicy } from "../src/rsi/l5-gov/governance.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-gov-int-"));
  tmpDirs.push(d);
  return d;
}

const T0 = 1_751_600_000_000;

function entries(n: number, aggregate = 0.5): JournalEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    cycleId: `c-${i}`,
    timestamp: T0 + i,
    durationMin: 1,
    observed: [],
    hypothesized: [],
    experimented: null,
    result: {
      fitnessVector: { accuracy: 0.5, latency: 0.1, cost: 0.1, toolSuccess: 0.5, hallucination: 0.1, userSatisfaction: 0.5 },
      aggregate,
      confidence: 0.9,
      tier0: "passed" as const,
      tier1: "no_regression" as const,
    },
    decided: { action: "accept" as const, reason: "x" },
    budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
  }));
}

// ── ensureGenesisPolicy ────────────────────────────────────────────────────

describe("ensureGenesisPolicy", () => {
  test("fresh dir: writes the genesis policy (unfrozen, pre-L5 defaults) exactly once", () => {
    const dir = freshDir();
    expect(ensureGenesisPolicy(dir, () => T0)).toBe(true);
    const load = loadPolicy(dir);
    expect(load.source).toBe("file");
    expect(load.policy.frozen.l6).toBe(false);
    expect(load.policy.parentId).toBeNull();
    expect(verifyChainFile(join(dir, "policy_history.jsonl")).ok).toBe(true);
    // Idempotent.
    expect(ensureGenesisPolicy(dir, () => T0)).toBe(false);
  });

  test("dir with history but no policy.json stays fail-closed (deletion ≠ first boot)", () => {
    const dir = freshDir();
    ensureGenesisPolicy(dir, () => T0);
    rmSync(join(dir, "policy.json"));
    expect(ensureGenesisPolicy(dir, () => T0)).toBe(false);
    expect(loadPolicy(dir).source).toBe("builtin");
  });

  test("genesis document equals the spec §2.1 defaults", () => {
    const doc = defaultGenesisPolicy(T0);
    expect(doc.gates).toEqual({ pValueMax: 0.05, effectSizeMin: 0.1, confidenceMin: 0.95 });
    expect(doc.approvals.l6Evolve).toBe(false);
    expect(doc.approvals.l4ModulePromote).toBe(true);
    expect(doc.frozen).toEqual({ l1: false, l2: false, l3: false, l4: false, l6: false });
  });
});

// ── governanceCheck (§8 — the single entry point) ──────────────────────────

describe("governanceCheck", () => {
  test("fail-closed builtin (no policy) refuses every evolving action", () => {
    const dir = freshDir();
    for (const action of ["l6_evolve", "l6_rollback", "l3_code_patch_apply", "l2_lora_promote", "l4_module_promote"] as const) {
      const res = governanceCheck(action, { dir, approvalPresent: true });
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/frozen/i);
    }
  });

  test("under the genesis policy: l6 flows autonomously, human-gated actions need the approval flag", () => {
    const dir = freshDir();
    ensureGenesisPolicy(dir, () => T0);
    expect(governanceCheck("l6_evolve", { dir }).allowed).toBe(true);
    // Human-gated (approvals.* = true): refuse without, allow with.
    for (const action of ["l3_code_patch_apply", "l2_lora_promote", "l4_module_promote"] as const) {
      expect(governanceCheck(action, { dir }).allowed).toBe(false);
      expect(governanceCheck(action, { dir }).reason).toMatch(/approval/i);
      expect(governanceCheck(action, { dir, approvalPresent: true }).allowed).toBe(true);
    }
  });

  test("a frozen layer refuses even with an approval present (freeze supremacy, G-INV-7)", () => {
    const dir = freshDir();
    ensureGenesisPolicy(dir, () => T0);
    const gl = new GovernanceLifecycle({ dir, now: () => T0 });
    expect(gl.freeze(["l3"], "audit", "operator").ok).toBe(true);
    const res = governanceCheck("l3_code_patch_apply", { dir, approvalPresent: true });
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/frozen/i);
  });
});

// ── L6 through the policy accessor (§7, AC6 sidecar half) ──────────────────

function metaWith(policy: GovernancePolicy, window: () => JournalEntry[]): MetaEvolution {
  return new MetaEvolution({
    dir: freshDir(),
    now: () => T0,
    readWindow: (since) => window().filter((e) => e.timestamp >= since),
    seedSource: () => 7,
    policy: () => policy,
  });
}

describe("MetaEvolution × policy accessor (§7)", () => {
  test("frozen.l6 → evolve and rollback refuse; status keeps working", () => {
    const policy = defaultGenesisPolicy(T0);
    policy.frozen.l6 = true;
    const meta = metaWith(policy, () => entries(6));
    const ev = meta.evolve();
    expect(ev.ok).toBe(false);
    expect(String(ev.reason)).toMatch(/frozen by governance/);
    const rb = meta.rollback();
    expect(rb.ok).toBe(false);
    expect(String(rb.reason)).toMatch(/frozen by governance/);
    expect(meta.status().ok).toBe(true); // reads are never frozen
  });

  test("policy minCycles above the hardcoded floor is enforced", () => {
    const policy = defaultGenesisPolicy(T0);
    policy.meta.minCycles = 10;
    const meta = metaWith(policy, () => entries(6)); // ≥ hardcoded 5, < policy 10
    const ev = meta.evolve();
    expect(ev.ok).toBe(false);
    expect(String(ev.reason)).toMatch(/10/);
  });

  test("policy acceptMargin above the hardcoded floor rejects a small win", () => {
    // Window A (baseline) → bootstrap; window B beats it by ~0.16.
    let window = entries(6, 0.1);
    const strict = defaultGenesisPolicy(T0);
    strict.meta.acceptMargin = 0.5;
    const meta = metaWith(strict, () => window);
    expect(meta.evolve().ok).toBe(true); // bootstrap, sets baseline
    window = entries(6, 0.5);
    const second = meta.evolve();
    expect(second.ok).toBe(true);
    expect(second.settled).toBe("rejected"); // margin 0.5 swallows the win

    // Same shape under the default margin (0.02): accepted.
    let window2 = entries(6, 0.1);
    const lax = defaultGenesisPolicy(T0);
    const meta2 = metaWith(lax, () => window2);
    expect(meta2.evolve().ok).toBe(true);
    window2 = entries(6, 0.5);
    const second2 = meta2.evolve();
    expect(second2.ok).toBe(true);
    expect(second2.settled).toBe("accepted");
  });

  test("mutateMetaGenome honors narrowed bounds (effective = intersect with wall)", () => {
    const narrowed: Record<keyof MetaGenome, [number, number]> = {
      ...META_BOUNDS,
      exploration: [0.1, 0.12],
      mutation_rate: [0.15, 0.2],
    };
    for (let seed = 0; seed < 60; seed++) {
      const { child } = mutateMetaGenome(DEFAULT_META_GENOME, seed, narrowed);
      for (const key of Object.keys(narrowed) as (keyof MetaGenome)[]) {
        // Only the mutated field moves, but every field must sit inside
        // the narrowed interval OR be the (unmutated) parent value.
        if (child[key] !== DEFAULT_META_GENOME[key]) {
          expect(child[key]).toBeGreaterThanOrEqual(narrowed[key][0]);
          expect(child[key]).toBeLessThanOrEqual(narrowed[key][1]);
        }
      }
    }
  });
});

// ── ≥half-window rule (§9 row 4) ───────────────────────────────────────────

describe("verified-evidence floor (G-INV-4, §9 row 4)", () => {
  test("defaultReadWindowVerified counts the rows of excluded files", () => {
    const dir = freshDir();
    const now = Date.UTC(2026, 6, 8, 12, 0, 0);
    // Good file yesterday (2 rows), tampered file today (3 rows).
    const good = join(dir, journalFilename(new Date(now - 86_400_000)));
    for (const e of entries(2)) appendJournal(good, e);
    const bad = join(dir, journalFilename(new Date(now)));
    for (const e of entries(3)) appendJournal(bad, e);
    const lines = readFileSync(bad, "utf8").split("\n").filter((l) => l.trim());
    const t = JSON.parse(lines[0]!) as JournalEntry;
    t.durationMin = 999;
    writeFileSync(bad, [JSON.stringify(t), ...lines.slice(1)].join("\n") + "\n", "utf8");

    const res = defaultReadWindowVerified(0, now, { dir });
    expect(res.entries).toHaveLength(2);
    expect(res.excludedRows).toBe(3);
  });

  test("L6 refuses to settle when ≥ half the window is unverified", () => {
    const meta = new MetaEvolution({
      dir: freshDir(),
      now: () => T0,
      readWindowVerified: () => ({ entries: entries(6), excludedRows: 6 }),
      seedSource: () => 7,
    });
    const ev = meta.evolve();
    expect(ev.ok).toBe(false);
    expect(String(ev.reason)).toMatch(/verif/i);
  });

  test("a minority of unverified rows does not block evolution", () => {
    const meta = new MetaEvolution({
      dir: freshDir(),
      now: () => T0,
      readWindowVerified: () => ({ entries: entries(6), excludedRows: 2 }),
      seedSource: () => 7,
    });
    expect(meta.evolve().ok).toBe(true);
  });
});

// ── fail-closed sanity: builtin refuses everything end to end ──────────────

describe("builtin policy is inert", () => {
  test("builtinFailClosedPolicy freezes l6 through the accessor", () => {
    const meta = metaWith(builtinFailClosedPolicy(T0), () => entries(6));
    expect(meta.evolve().ok).toBe(false);
  });
});
