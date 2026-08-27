/**
 * L5 Governance — A3: policy lifecycle FSM (spec §3–§6, §10, §11).
 *
 * Contract under test:
 *   AC2 — direction computation: tightening / relaxing / mixed on every
 *         field class; mixed → approval.
 *   AC3 — auto-adoption: strictly-tightening proposal activates without
 *         approval, appends chained history, survives restart; 24h
 *         cooldown queues the excess.
 *   AC4 — relaxation cannot activate without an approval record;
 *         approval of a stale document hash fails.
 *   AC8 — every policy transition appears in the chained governance
 *         audit; verify() green; flipping one byte → failure naming row.
 *   AC9 — rollback walks exactly one step per invocation, re-activates
 *         the parent document under a NEW policyId, repeated invocations
 *         walk further back.
 *   §4  — safety gates in order: schema, G0 (reject not clamp), direction,
 *         chain (prevHash race), freeze (l6 refused while frozen).
 *   §9  — crash mid-activation: history is the authority, policy.json
 *         rewritten from it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical, verifyChainFile } from "../src/rsi/infra/hash-chain.ts";
import { loadPolicy, type GovernancePolicy } from "../src/rsi/l5-gov/governance.ts";
import {
  computeDirection,
  ensureGenesisPolicy,
  GovernanceLifecycle,
} from "../src/rsi/l5-gov/governance-lifecycle.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cinderpaw-gov-fsm-"));
  tmpDirs.push(d);
  return d;
}

const T0 = 1_751_600_000_000;

/** The spec §2.1 example document — a usable, unfrozen baseline. */
function basePolicy(overrides: Partial<GovernancePolicy> = {}): GovernancePolicy {
  return {
    version: 1,
    policyId: "ignored-by-fsm",
    parentId: null,
    createdAt: T0,
    activatedAt: T0,
    prevHash: null,
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

interface Harness {
  gl: GovernanceLifecycle;
  dir: string;
  now: () => number;
  advance: (ms: number) => void;
}

function harness(): Harness {
  const dir = freshDir();
  let t = T0;
  const now = () => t;
  const gl = new GovernanceLifecycle({ dir, now });
  return { gl, dir, now, advance: (ms) => (t += ms) };
}

/** Propose + approve the base policy so tests start from an active,
 *  unfrozen policy (genesis is a relaxation vs the fail-closed builtin,
 *  so it takes the human path). */
function bootstrap(h: Harness, doc: GovernancePolicy = basePolicy()): string {
  const res = h.gl.propose(doc, "operator");
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.reason);
  expect(res.status).toBe("awaiting_approval");
  const hash = sha256Canonical(h.gl.proposalDocument(res.policyId)!);
  const ap = h.gl.approve(res.policyId, hash, "bootstrap", "darius");
  expect(ap.ok).toBe(true);
  return res.policyId;
}

/** A tightening successor of the current active policy. */
function tighterDoc(h: Harness): GovernancePolicy {
  const st = h.gl.status();
  const doc = structuredClone(st.policy);
  doc.gates.confidenceMin = Math.min(0.995, doc.gates.confidenceMin + 0.01);
  doc.prevHash = st.headHash;
  return doc;
}

/** A relaxing successor (raises a budget). */
function relaxerDoc(h: Harness): GovernancePolicy {
  const st = h.gl.status();
  const doc = structuredClone(st.policy);
  doc.budgets.episodeMaxIterations += 50;
  doc.prevHash = st.headHash;
  return doc;
}

// ── AC2: direction computation ─────────────────────────────────────────────

describe("computeDirection (AC2)", () => {
  const cur = basePolicy();

  test("stricter gate → tightening, with a human-readable diff", () => {
    const cand = structuredClone(cur);
    cand.gates.confidenceMin = 0.96;
    const { direction, diff } = computeDirection(cur, cand);
    expect(direction).toBe("tightening");
    expect(diff).toEqual(["gates.confidenceMin: 0.95 → 0.96"]);
  });

  test("looser gate → relaxing", () => {
    const tight = structuredClone(cur);
    tight.gates.pValueMax = 0.04; // current is tighter than the candidate
    expect(computeDirection(tight, cur).direction).toBe("relaxing");
  });

  test("meta bounds sub-interval → tightening; superset → relaxing; shifted → mixed", () => {
    const sub = structuredClone(cur);
    sub.meta.bounds.exploration = [0.05, 0.3];
    expect(computeDirection(cur, sub).direction).toBe("tightening");

    // Superset relative to a narrowed current.
    expect(computeDirection(sub, cur).direction).toBe("relaxing");

    const shifted = structuredClone(sub);
    shifted.meta.bounds.exploration = [0.1, 0.4]; // raises lo (tighten), raises hi (relax)
    expect(computeDirection(sub, shifted).direction).toBe("mixed");
  });

  test("minCycles / acceptMargin up → tightening; down → relaxing", () => {
    const up = structuredClone(cur);
    up.meta.minCycles = 10;
    up.meta.acceptMargin = 0.05;
    expect(computeDirection(cur, up).direction).toBe("tightening");
    expect(computeDirection(up, cur).direction).toBe("relaxing");
  });

  test("budget down → tightening; up → relaxing", () => {
    const down = structuredClone(cur);
    down.budgets.episodeMaxTokens = 1_000_000;
    expect(computeDirection(cur, down).direction).toBe("tightening");
    expect(computeDirection(down, cur).direction).toBe("relaxing");
  });

  test("approvals false→true → tightening; true→false → relaxing", () => {
    const req = structuredClone(cur);
    req.approvals.l6Evolve = true;
    expect(computeDirection(cur, req).direction).toBe("tightening");
    expect(computeDirection(req, cur).direction).toBe("relaxing");
  });

  test("setting a freeze → tightening; clearing → relaxing", () => {
    const frozen = structuredClone(cur);
    frozen.frozen.l6 = true;
    expect(computeDirection(cur, frozen).direction).toBe("tightening");
    expect(computeDirection(frozen, cur).direction).toBe("relaxing");
  });

  test("no netting: three tightenings + one loosening → mixed", () => {
    const cand = structuredClone(cur);
    cand.gates.confidenceMin = 0.99;
    cand.meta.minCycles = 20;
    cand.budgets.episodeMaxTokens = 1;
    cand.approvals.l6Evolve = false; // equal, not a loosening
    cand.budgets.episodeMaxIterations = 999; // the loosening
    expect(computeDirection(cur, cand).direction).toBe("mixed");
  });
});

// ── Bootstrap + fail-closed boot ───────────────────────────────────────────

describe("boot states", () => {
  test("empty dir boots fail-closed (builtin, all frozen) and records the governance event", () => {
    const h = harness();
    const st = h.gl.status();
    expect(st.failClosed).toBe(true);
    expect(st.policy.frozen.l6).toBe(true);
    const rows = h.gl.historyRows();
    expect(rows.some((r) => r.event === "fail_closed")).toBe(true);
  });

  test("genesis proposal (vs fail-closed builtin) takes the human path, then activates", () => {
    const h = harness();
    bootstrap(h);
    const st = h.gl.status();
    expect(st.failClosed).toBe(false);
    expect(st.policy.frozen.l6).toBe(false);
    expect(st.policy.approval?.approvedBy).toBe("darius");
    // Active policy is on disk and loads clean.
    const load = loadPolicy(h.dir);
    expect(load.source).toBe("file");
  });
});

// ── AC3: auto-adoption + cooldown ──────────────────────────────────────────

describe("auto-adoption (AC3)", () => {
  test("strictly-tightening proposal activates without approval", () => {
    const h = harness();
    bootstrap(h);
    const res = h.gl.propose(tighterDoc(h), "operator");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.direction).toBe("tightening");
    expect(res.status).toBe("active");
    const st = h.gl.status();
    expect(st.policy.policyId).toBe(res.policyId);
    expect(st.policy.approval).toBeNull(); // auto-adopted
  });

  test("chained history row appended; verify() green; survives restart", () => {
    const h = harness();
    bootstrap(h);
    const res = h.gl.propose(tighterDoc(h), "operator");
    expect(res.ok && res.status === "active").toBe(true);
    expect(h.gl.verify().ok).toBe(true);
    // Restart: a fresh instance over the same dir sees the same active.
    const gl2 = new GovernanceLifecycle({ dir: h.dir, now: h.now });
    expect(gl2.status().policy.policyId).toBe(h.gl.status().policy.policyId);
    expect(gl2.verify().ok).toBe(true);
  });

  test("cooldown: second tightening within 24h queues; processQueue activates after", () => {
    const h = harness();
    bootstrap(h);
    h.advance(60_000);
    const first = h.gl.propose(tighterDoc(h), "operator");
    expect(first.ok && first.status === "active").toBe(true);
    h.advance(60_000);
    const second = h.gl.propose(tighterDoc(h), "operator");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.status).toBe("queued");
    // Still queued within the window.
    expect(h.gl.processQueue().activated).toBeNull();
    h.advance(25 * 60 * 60 * 1000);
    expect(h.gl.processQueue().activated).toBe(second.policyId);
    expect(h.gl.status().policy.policyId).toBe(second.policyId);
  });

  test("genesis bootstrap does not start the auto-adopt cooldown (A7 smoke regression)", () => {
    // Genesis is written with actor "system" but is NOT an auto-adoption
    // (§5 counts auto-adopted policies only) — a fresh install's first
    // tightening proposal must activate immediately, not queue for 24h.
    const dir = freshDir();
    let t = T0;
    const now = () => t;
    ensureGenesisPolicy(dir, now);
    const gl = new GovernanceLifecycle({ dir, now });
    t += 60_000; // one minute after first boot — well inside 24h
    const st = gl.status();
    const doc = structuredClone(st.policy);
    doc.gates.confidenceMin = Math.min(0.995, doc.gates.confidenceMin + 0.01);
    doc.prevHash = st.headHash;
    const res = gl.propose(doc, "operator");
    expect(res.ok && res.status === "active").toBe(true);
  });
});

// ── AC4: relaxation requires approval; stale hash fails ────────────────────

describe("relaxation path (AC4)", () => {
  test("relaxing proposal waits for approval and does not activate on its own", () => {
    const h = harness();
    const genesis = bootstrap(h);
    const res = h.gl.propose(relaxerDoc(h), "operator");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.status).toBe("awaiting_approval");
    expect(h.gl.status().policy.policyId).toBe(genesis); // unchanged
    expect(h.gl.processQueue().activated).toBeNull(); // queue never bypasses approval
  });

  test("approval of a stale document hash fails; correct hash activates with the record", () => {
    const h = harness();
    bootstrap(h);
    const res = h.gl.propose(relaxerDoc(h), "operator");
    if (!res.ok) throw new Error(res.reason);
    const bad = h.gl.approve(res.policyId, "deadbeef", "lgtm", "darius");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/hash/i);
    const good = h.gl.approve(
      res.policyId,
      sha256Canonical(h.gl.proposalDocument(res.policyId)!),
      "lgtm",
      "darius",
    );
    expect(good.ok).toBe(true);
    const st = h.gl.status();
    expect(st.policy.policyId).toBe(res.policyId);
    expect(st.policy.approval?.approvedBy).toBe("darius");
    expect(st.policy.approval?.note).toBe("lgtm");
  });

  test("reject is terminal; a rejected proposal cannot be approved", () => {
    const h = harness();
    bootstrap(h);
    const res = h.gl.propose(relaxerDoc(h), "operator");
    if (!res.ok) throw new Error(res.reason);
    expect(h.gl.reject(res.policyId, "too loose", "darius").ok).toBe(true);
    const ap = h.gl.approve(
      res.policyId,
      sha256Canonical(h.gl.proposalDocument(res.policyId)!),
      "x",
      "darius",
    );
    expect(ap.ok).toBe(false);
  });

  test("withdraw is terminal", () => {
    const h = harness();
    bootstrap(h);
    const res = h.gl.propose(relaxerDoc(h), "operator");
    if (!res.ok) throw new Error(res.reason);
    expect(h.gl.withdraw(res.policyId, "operator").ok).toBe(true);
    expect(h.gl.status().pending).toHaveLength(0);
  });
});

// ── §4 safety gates ────────────────────────────────────────────────────────

describe("propose safety gates (§4, in order)", () => {
  test("G0 violation REJECTS the proposal — never clamps at propose time", () => {
    const h = harness();
    bootstrap(h);
    const doc = tighterDoc(h);
    doc.gates.confidenceMin = 0.5; // below the locked floor
    const res = h.gl.propose(doc, "operator");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/G0/);
  });

  test("chain gate: stale prevHash is refused (concurrent proposer must rebase)", () => {
    const h = harness();
    bootstrap(h);
    const stale = tighterDoc(h);
    stale.meta.minCycles = 6; // distinct content so the direction gate passes
    // Activate something else first — head moves.
    const winner = h.gl.propose(tighterDoc(h), "operator");
    expect(winner.ok).toBe(true);
    const res = h.gl.propose(stale, "operator");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/prevHash/);
  });

  test("freeze gate: l6 proposals refused while frozen.l6; operator still flows", () => {
    const h = harness();
    bootstrap(h);
    expect(h.gl.freeze(["l6"], "test freeze", "operator").ok).toBe(true);
    const doc = tighterDoc(h);
    const fromL6 = h.gl.propose(doc, "l6");
    expect(fromL6.ok).toBe(false);
    if (!fromL6.ok) expect(fromL6.reason).toMatch(/frozen/i);
    const fromOp = h.gl.propose(doc, "operator");
    expect(fromOp.ok).toBe(true);
  });

  test("a no-op proposal is refused", () => {
    const h = harness();
    bootstrap(h);
    const st = h.gl.status();
    const doc = structuredClone(st.policy);
    doc.prevHash = st.headHash;
    const res = h.gl.propose(doc, "operator");
    expect(res.ok).toBe(false);
  });
});

// ── Freeze / unfreeze ──────────────────────────────────────────────────────

describe("freeze / unfreeze (§3, G-INV-7 flags)", () => {
  test("freeze flips flags on the active policy and records history", () => {
    const h = harness();
    bootstrap(h);
    expect(h.gl.freeze(["l6", "l3"], "suspicious journal", "operator").ok).toBe(true);
    const st = h.gl.status();
    expect(st.policy.frozen.l6).toBe(true);
    expect(st.policy.frozen.l3).toBe(true);
    expect(st.policy.frozen.l2).toBe(false);
    expect(h.gl.historyRows().some((r) => r.event === "frozen")).toBe(true);
    expect(h.gl.verify().ok).toBe(true);
  });

  test("unfreeze requires the operator actor", () => {
    const h = harness();
    bootstrap(h);
    h.gl.freeze(["l6"], "x", "operator");
    expect(h.gl.unfreeze(["l6"], "y", "l6").ok).toBe(false);
    expect(h.gl.unfreeze(["l6"], "y", "operator").ok).toBe(true);
    expect(h.gl.status().policy.frozen.l6).toBe(false);
  });
});

// ── AC9: rollback ──────────────────────────────────────────────────────────

describe("rollback (AC9, §6)", () => {
  test("re-activates the parent document under a NEW policyId; repeated calls walk back", () => {
    const h = harness();
    const genesis = bootstrap(h); // gp-1 (say)
    const p2 = h.gl.propose(tighterDoc(h), "operator"); // auto-active
    if (!p2.ok) throw new Error(p2.reason);
    const genesisGates = 0.95;

    const rb1 = h.gl.rollback("first step back", "operator");
    expect(rb1.ok).toBe(true);
    const st1 = h.gl.status();
    // New id, parent lineage points at the rolled-back policy, content = genesis.
    expect(st1.policy.policyId).not.toBe(genesis);
    expect(st1.policy.policyId).not.toBe(p2.policyId);
    expect(st1.policy.parentId).toBe(p2.policyId);
    expect(st1.policy.gates.confidenceMin).toBe(genesisGates);

    // Walking further: genesis has no parent → refused.
    const rb2 = h.gl.rollback("past genesis", "operator");
    expect(rb2.ok).toBe(false);
  });

  test("three-deep lineage walks back two steps", () => {
    const h = harness();
    bootstrap(h);
    const p2 = h.gl.propose(tighterDoc(h), "operator");
    if (!p2.ok) throw new Error(p2.reason);
    h.advance(25 * 60 * 60 * 1000);
    const p3doc = tighterDoc(h);
    const p3 = h.gl.propose(p3doc, "operator");
    if (!p3.ok) throw new Error(p3.reason);
    expect(p3.status).toBe("active");

    expect(h.gl.rollback("to p2", "operator").ok).toBe(true);
    expect(h.gl.status().policy.gates.confidenceMin).toBeCloseTo(0.96, 10);
    expect(h.gl.rollback("to genesis", "operator").ok).toBe(true);
    expect(h.gl.status().policy.gates.confidenceMin).toBeCloseTo(0.95, 10);
    expect(h.gl.verify().ok).toBe(true);
  });

  test("layers pick the rollback up without restart (status reads current disk state)", () => {
    const h = harness();
    bootstrap(h);
    const p2 = h.gl.propose(tighterDoc(h), "operator");
    if (!p2.ok) throw new Error(p2.reason);
    h.gl.rollback("live", "operator");
    // A separate instance (same disk) sees the rolled-back policy at once.
    const other = new GovernanceLifecycle({ dir: h.dir, now: h.now });
    expect(other.status().policy.policyId).toBe(h.gl.status().policy.policyId);
  });
});

// ── AC8: audit chain + verify ──────────────────────────────────────────────

describe("audit mirror + verify (AC8, §11)", () => {
  test("every policy transition appears in the chained governance audit", () => {
    const h = harness();
    bootstrap(h);
    h.gl.propose(tighterDoc(h), "operator");
    h.gl.freeze(["l6"], "x", "operator");
    h.gl.unfreeze(["l6"], "y", "operator");
    h.gl.rollback("back", "operator");
    const audit = readFileSync(join(h.dir, "governance_audit.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { source: string; event: string });
    const events = audit.filter((r) => r.source === "policy").map((r) => r.event);
    for (const expected of ["proposed", "activated", "frozen", "unfrozen", "rolled_back"]) {
      expect(events).toContain(expected);
    }
    expect(verifyChainFile(join(h.dir, "governance_audit.jsonl")).ok).toBe(true);
  });

  test("flipping one byte in the history names the broken row", () => {
    const h = harness();
    bootstrap(h);
    h.gl.propose(tighterDoc(h), "operator");
    const histPath = join(h.dir, "policy_history.jsonl");
    const lines = readFileSync(histPath, "utf8").split("\n").filter((l) => l.trim());
    const mid = Math.floor(lines.length / 2);
    const row = JSON.parse(lines[mid]!) as { reason: string };
    row.reason = row.reason + "!";
    lines[mid] = JSON.stringify(row);
    writeFileSync(histPath, lines.join("\n") + "\n", "utf8");
    const res = h.gl.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.badRow).toBe(mid + 1);
      expect(res.file).toContain("policy_history");
    }
  });
});

// ── AC8: L6 evolve/rollback mirrored into the governance audit ─────────────

describe("L6 audit mirror (G-INV-5, §7)", () => {
  test("MetaEvolution evolve and rollback each land one chained audit row", async () => {
    const { MetaEvolution } = await import("../src/rsi/l6-meta/meta-evolution.ts");
    const dir = freshDir();
    // Enough fake journal evidence to let evolve() proceed.
    const entries = Array.from({ length: 6 }, (_, i) => ({
      cycleId: `c-${i}`,
      timestamp: T0 + i,
      durationMin: 1,
      observed: [],
      hypothesized: [],
      experimented: null,
      result: null,
      decided: { action: "accept" as const, reason: "x" },
      budgetRemaining: { wallClockMin: 1, tokens: 1, cpuPct: 1, ramMb: 1, diskMb: 1 },
    }));
    const meta = new MetaEvolution({
      dir,
      now: () => T0,
      readWindow: () => entries,
      seedSource: () => 7,
    });
    expect(meta.evolve().ok).toBe(true);
    expect(meta.rollback().ok).toBe(true);
    const auditPath = join(dir, "governance", "governance_audit.jsonl");
    const rows = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { source: string; event: string });
    expect(rows.filter((r) => r.source === "l6" && r.event === "evolve")).toHaveLength(1);
    expect(rows.filter((r) => r.source === "l6" && r.event === "rollback")).toHaveLength(1);
    expect(verifyChainFile(auditPath).ok).toBe(true);
  });
});

// ── §9: crash mid-activation recovery ──────────────────────────────────────

describe("crash recovery (§9 — history is the authority)", () => {
  test("policy.json differing from the last activated document is rewritten from history", () => {
    const h = harness();
    bootstrap(h);
    const p2 = h.gl.propose(tighterDoc(h), "operator");
    if (!p2.ok) throw new Error(p2.reason);
    const truth = h.gl.status().policy;
    // Simulate a torn activation: valid but stale document on disk.
    const stale = structuredClone(truth);
    stale.gates.confidenceMin = 0.95;
    stale.policyId = "gp-torn";
    writeFileSync(join(h.dir, "policy.json"), JSON.stringify(stale), "utf8");

    const recovered = new GovernanceLifecycle({ dir: h.dir, now: h.now });
    expect(recovered.status().policy).toEqual(truth);
    expect(existsSync(join(h.dir, "policy.json"))).toBe(true);
  });
});
