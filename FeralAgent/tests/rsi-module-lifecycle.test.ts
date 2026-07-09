/**
 * L4 Architecture — B5: lifecycle state machine + promotion (spec §3, §6).
 *
 * Contract under test:
 *   AC1 — a real fixture module walks the full lifecycle: propose →
 *         sandbox → build (real subprocess hello) → evaluate (stubbed
 *         suite runner) → gate → awaiting_approval → approve → promoted
 *         (registry active) → demote → retired (builtin restored).
 *   AC6 — promotion without an approval record is impossible: evaluate
 *         never repoints; approve is the only door and refuses any state
 *         but awaiting_approval.
 *   §3  — one candidate per seam past `built` (serialization); every
 *         transition appends a history row.
 *   §6  — the contract FSM writes exactly ONE journal row, layer "L4";
 *         stale candidates (30 days) are withdrawn.
 *   §7  — frozen.l4 refuses every step.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGenesisPolicy } from "../src/rsi/governance-lifecycle.ts";
import type { EvalSpec } from "../src/rsi/eval-spec.ts";
import type { EvalOutcome } from "../src/rsi/eval-worker.ts";
import { ModuleLifecycle, STALE_CANDIDATE_MS } from "../src/rsi/module-lifecycle.ts";
import { ModuleRegistry } from "../src/rsi/module-registry.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "modules");
const MOD_ID = "mod-retrieval-fixture-01";
const SEAM = "retrieval_strategy";
const RUNTIME = "2026.7.9";

const tmpDirs: string[] = [];
afterEach(() => {
  // Windows: a just-stopped module host can hold its cwd for a beat —
  // retry the rm instead of failing the test on EBUSY.
  for (const d of tmpDirs.splice(0)) {
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt >= 10) throw err;
        Bun.sleepSync(100);
      }
    }
  }
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "feral-l4-b5-"));
  tmpDirs.push(d);
  return d;
}

function specs(n = 20): EvalSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i}`,
    tier: i < 2 ? 0 : 1,
    name: `task ${i}`,
    description: "",
    prompt: "p",
    kind: "fact_lookup" as const,
    expected: { type: "fact_lookup" as const, answer: "x" },
  }));
}

function outcomes(all: EvalSpec[], pass: (i: number) => boolean): EvalOutcome[] {
  return all.map((s, i) => ({
    taskId: s.id,
    tier: s.tier,
    success: pass(i),
    latencyMs: 100,
    tokens: 10,
    errored: false,
  }));
}

/** Stubbed suite: incumbent loses 8 Tier-1 tasks, candidate passes all. */
function betterCandidateDeps(suite = specs()) {
  return {
    getSpecs: async () => suite,
    runSuite: async (binding: "incumbent" | "candidate") =>
      binding === "candidate"
        ? outcomes(suite, () => true)
        : outcomes(suite, (i) => i < 2 || i % 2 === 0),
    genomeId: "genome-1",
    modelId: "model-1",
    bootstrapIterations: 2_000,
  };
}

function harness(opts: { frozen?: boolean } = {}) {
  const modulesDir = freshDir();
  const envelopesDir = freshDir();
  const governanceDir = freshDir();
  const journalDir = freshDir();
  const journalPath = join(journalDir, "journal-test.jsonl");
  if (!opts.frozen) ensureGenesisPolicy(governanceDir);
  else {
    // No policy file → loadPolicy fail-closed builtin → everything frozen.
  }
  cpSync(join(FIXTURES, "good-retrieval"), join(modulesDir, MOD_ID), { recursive: true });
  const registry = new ModuleRegistry({ dir: modulesDir, governanceDir });
  const lifecycle = new ModuleLifecycle({
    registry,
    runtimeVersion: RUNTIME,
    modulesDir,
    envelopesDir,
    governanceDir,
    journalPath: () => journalPath,
  });
  return { lifecycle, registry, modulesDir, envelopesDir, governanceDir, journalPath };
}

function journalRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("ModuleLifecycle — full walk (AC1)", () => {
  test("propose → sandbox → build → evaluate → approve → promoted → demote", async () => {
    const { lifecycle, registry, journalPath } = harness();

    expect(lifecycle.propose(MOD_ID)).toEqual({ ok: true, state: "proposed" });
    expect(lifecycle.sandbox(MOD_ID)).toEqual({ ok: true, state: "sandboxed" });
    expect(await lifecycle.build(MOD_ID)).toEqual({ ok: true, state: "built" });

    const ev = await lifecycle.evaluate(MOD_ID, betterCandidateDeps());
    expect(ev.ok).toBe(true);
    expect(lifecycle.stateOf(MOD_ID)).toBe("awaiting_approval");
    expect(ev.report?.accept).toBe(true);

    // AC6: evaluated + gates passed, but NOT promoted — registry untouched.
    expect(registry.activeFor(SEAM)).toBe("builtin");
    expect(registry.candidatesFor(SEAM)).toEqual([MOD_ID]);

    // §6: exactly one journal row, layer L4, accepted.
    const rows = journalRows(journalPath);
    expect(rows.length).toBe(1);
    const experimented = rows[0]!.experimented as Record<string, unknown>;
    expect(experimented.layer).toBe("L4");
    expect(experimented.candidateId).toBe(MOD_ID);
    expect((rows[0]!.decided as Record<string, unknown>).action).toBe("accept");

    // Approve = the only promotion door.
    expect(lifecycle.approve(MOD_ID, "darius")).toEqual({ ok: true, state: "promoted" });
    expect(registry.activeFor(SEAM)).toBe(MOD_ID);
    expect(registry.candidatesFor(SEAM)).toEqual([]);
    const env = lifecycle.envelopeOf(MOD_ID)!;
    expect(env.data.approvedBy).toBe("darius");
    expect(env.data.promotedAt).toBeGreaterThan(0);
    expect(env.parents).toEqual([`builtin:${SEAM}`]);

    // Demote: instant, no approval, builtin restored (§8.1).
    expect(lifecycle.demote(SEAM, "darius", "manual rollback")).toEqual({ ok: true, state: "retired" });
    expect(registry.activeFor(SEAM)).toBe("builtin");
    expect(lifecycle.stateOf(MOD_ID)).toBe("retired");
  });

  test("history has a row for every lifecycle transition (§3)", async () => {
    const { lifecycle, registry } = harness();
    lifecycle.propose(MOD_ID);
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    await lifecycle.evaluate(MOD_ID, betterCandidateDeps());
    const states = registry
      .historyRows()
      .filter((r) => r.moduleId === MOD_ID)
      .map((r) => r.to);
    expect(states).toEqual(["proposed", "sandboxed", "built", "evaluated", "awaiting_approval"]);
  });
});

describe("ModuleLifecycle — gates and guards", () => {
  test("AC6: approve refuses every state except awaiting_approval", async () => {
    const { lifecycle, registry } = harness();
    expect(lifecycle.approve(MOD_ID, "darius").ok).toBe(false); // missing
    lifecycle.propose(MOD_ID);
    expect(lifecycle.approve(MOD_ID, "darius").ok).toBe(false); // proposed
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    expect(lifecycle.approve(MOD_ID, "darius").ok).toBe(false); // built
    expect(registry.activeFor(SEAM)).toBe("builtin");
  });

  test("frozen.l4 refuses every step (§7)", () => {
    const { lifecycle } = harness({ frozen: true });
    const res = lifecycle.propose(MOD_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("frozen");
  });

  test("eval rejection (identical candidate) → failed, no candidate added", async () => {
    const { lifecycle, registry } = harness();
    lifecycle.propose(MOD_ID);
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    const suite = specs();
    const same = outcomes(suite, () => true);
    const res = await lifecycle.evaluate(MOD_ID, {
      getSpecs: async () => suite,
      runSuite: async () => same,
      genomeId: "g",
      modelId: "m",
      bootstrapIterations: 2_000,
    });
    expect(res.ok).toBe(false);
    expect(lifecycle.stateOf(MOD_ID)).toBe("failed");
    expect(registry.candidatesFor(SEAM)).toEqual([]);
  });

  test("serialization: a second candidate on the seam is refused (§3)", async () => {
    const { lifecycle, registry, modulesDir } = harness();
    lifecycle.propose(MOD_ID);
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    await lifecycle.evaluate(MOD_ID, betterCandidateDeps());
    expect(registry.candidatesFor(SEAM)).toEqual([MOD_ID]);

    const otherId = "mod-retrieval-other-02";
    cpSync(join(FIXTURES, "good-retrieval"), join(modulesDir, otherId), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(modulesDir, otherId, "manifest.json"), "utf8"));
    manifest.id = otherId;
    writeFileSync(join(modulesDir, otherId, "manifest.json"), JSON.stringify(manifest));
    lifecycle.propose(otherId);
    lifecycle.sandbox(otherId);
    await lifecycle.build(otherId);
    const res = await lifecycle.evaluate(otherId, betterCandidateDeps());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("in flight");
  });

  test("sandbox wall failure → failed", () => {
    const { lifecycle, modulesDir } = harness();
    writeFileSync(
      join(modulesDir, MOD_ID, "module.ts"),
      'export const methods = { retrieve: () => fetch("http://x") };',
    );
    lifecycle.propose(MOD_ID);
    const res = lifecycle.sandbox(MOD_ID);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("lexical wall");
    expect(lifecycle.stateOf(MOD_ID)).toBe("failed");
  });

  test("stale candidates are withdrawn after 30 days (§6)", async () => {
    const { lifecycle, registry, modulesDir, envelopesDir, governanceDir } = harness();
    lifecycle.propose(MOD_ID);
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    await lifecycle.evaluate(MOD_ID, betterCandidateDeps());
    expect(lifecycle.withdrawStale()).toEqual([]); // fresh — kept
    // Fake the clock past the horizon via a second lifecycle instance.
    const later = new ModuleLifecycle({
      registry,
      runtimeVersion: RUNTIME,
      modulesDir,
      envelopesDir,
      governanceDir,
      now: () => Date.now() + STALE_CANDIDATE_MS + 1,
    });
    expect(later.withdrawStale()).toEqual([MOD_ID]);
    expect(later.stateOf(MOD_ID)).toBe("withdrawn");
    expect(registry.candidatesFor(SEAM)).toEqual([]);
  });
});

describe("ModuleLifecycle — provenance (AC8)", () => {
  test("from the module id alone: seam, parent chain, eval evidence, approver", async () => {
    const { lifecycle } = harness();
    lifecycle.propose(MOD_ID);
    lifecycle.sandbox(MOD_ID);
    await lifecycle.build(MOD_ID);
    await lifecycle.evaluate(MOD_ID, betterCandidateDeps());
    lifecycle.approve(MOD_ID, "darius");

    const env = lifecycle.envelopeOf(MOD_ID)!;
    expect(env.data.seam).toBe(SEAM);
    expect(env.parents).toEqual([`builtin:${SEAM}`]);
    const report = env.data.evalReport as Record<string, unknown>;
    expect(report.moduleId).toBe(MOD_ID);
    expect(report.accept).toBe(true);
    expect(Array.isArray(report.pairs)).toBe(true);
    expect(report.seed).toBeDefined();
    expect(env.data.approvedBy).toBe("darius");
    expect(env.data.capabilitiesMeasured).toBeDefined();
  });
});
