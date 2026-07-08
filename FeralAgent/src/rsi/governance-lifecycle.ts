/**
 * L5 Governance — A3: policy lifecycle FSM
 * (spec `docs/2026-07-04-l5-governance-evolution-spec.md` §3–§6, §10, §11).
 *
 * State on disk (all under the governance dir, `InstancePaths.governance`):
 *   policy.json             — the active policy (atomic temp+rename)
 *   policy_history.jsonl    — chained, append-only; ONE row per lifecycle
 *                             transition. Rows that (re)write policy.json
 *                             (activated / frozen / unfrozen) embed the
 *                             full document → lineage replayable from
 *                             genesis and §9 crash recovery works.
 *   approvals.jsonl         — chained, append-only approval records
 *                             (who / when / note / exact document hash).
 *   governance_audit.jsonl  — chained mirror of every transition +
 *                             L6 evolve/rollback rows (G-INV-5).
 *   proposals/<id>.json     — ProposedPolicy files; status updated via
 *                             temp+rename (history/approvals stay the
 *                             append-only authorities).
 *
 * Design notes:
 *   - The FSM owns identity: policyId, parentId, createdAt/activatedAt
 *     and the approval record are assigned here — a proposer supplies a
 *     document plus the `prevHash` it is proposing AGAINST (chain gate
 *     §4.4). No separate `superseded` history row: the successor's
 *     `activated` row encodes it (its parentId names the superseded id).
 *   - Rollback walk-back (§6): re-activation happens under a NEW id with
 *     `parentId` = the rolled-back policy (§3, id lineage stays linear),
 *     so the DOCUMENT ancestry needs its own pointer — `sourceId` on the
 *     activated row names the policy whose content it carries. The next
 *     rollback targets the parent of the SOURCE, which is what makes
 *     repeated invocations walk back instead of ping-ponging.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendChained, sha256Canonical, verifyChainFile } from "./hash-chain.ts";
import { appendGovernanceAudit } from "./governance-audit.ts";
import {
  clampPolicy,
  defaultGenesisPolicy,
  defaultGovernanceDir,
  loadPolicy,
  type FrozenFlags,
  type GovernancePolicy,
} from "./governance.ts";
import { META_BOUNDS, type MetaGenome } from "./meta-evolution.ts";

export type Direction = "tightening" | "relaxing" | "mixed";
export type Proposer = "operator" | "l6" | "system";
export type LayerKey = keyof FrozenFlags;

export type HistoryEvent =
  | "proposed"
  | "activated"
  | "rejected"
  | "withdrawn"
  | "rolled_back"
  | "frozen"
  | "unfrozen"
  | "fail_closed";

export interface HistoryRow {
  policyId: string;
  parentId: string | null;
  event: HistoryEvent;
  timestamp: number;
  actor: string;
  diff: string[];
  reason: string;
  /** Present on rows that (re)write policy.json. */
  document?: GovernancePolicy;
  /** Document-ancestry pointer for rollback walk-back — see header. */
  sourceId?: string;
  prevHash: string;
  hash: string;
}

export type ProposalStatus = "queued" | "awaiting_approval" | "activated" | "rejected" | "withdrawn";

export interface ProposalFile {
  document: GovernancePolicy;
  proposedBy: Proposer;
  /** Computed by the FSM at propose time — never proposer-supplied (§2.3). */
  direction: Direction;
  requiredApproval: boolean;
  status: ProposalStatus;
  /** parentId (= active policy at propose time) and the head the
   *  proposal was made against; re-checked at activation. */
  parentId: string | null;
  prevHash: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/** At most one auto-adopted policy per 24h (§5 cooldown). */
export const AUTO_ADOPT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── Direction (§5 partial order) ───────────────────────────────────────────

export function computeDirection(
  current: GovernancePolicy,
  candidate: GovernancePolicy,
): { direction: Direction; diff: string[] } {
  let tighten = false;
  let relax = false;
  const diff: string[] = [];

  // smallerIsTighter: pValueMax, budgets.*; largerIsTighter: the rest.
  const scalar = (path: string, cur: number, cand: number, smallerIsTighter: boolean) => {
    if (cur === cand) return;
    diff.push(`${path}: ${cur} → ${cand}`);
    const wentSmaller = cand < cur;
    if (wentSmaller === smallerIsTighter) tighten = true;
    else relax = true;
  };
  const bool = (path: string, cur: boolean, cand: boolean) => {
    if (cur === cand) return;
    diff.push(`${path}: ${cur} → ${cand}`);
    // false→true is tightening for both approvals and frozen flags.
    if (cand) tighten = true;
    else relax = true;
  };

  scalar("gates.pValueMax", current.gates.pValueMax, candidate.gates.pValueMax, true);
  scalar("gates.effectSizeMin", current.gates.effectSizeMin, candidate.gates.effectSizeMin, false);
  scalar("gates.confidenceMin", current.gates.confidenceMin, candidate.gates.confidenceMin, false);

  for (const key of Object.keys(META_BOUNDS) as (keyof MetaGenome)[]) {
    const [lo1, hi1] = current.meta.bounds[key];
    const [lo2, hi2] = candidate.meta.bounds[key];
    if (lo1 === lo2 && hi1 === hi2) continue;
    diff.push(`meta.bounds.${key}: [${lo1}, ${hi1}] → [${lo2}, ${hi2}]`);
    if (lo2 >= lo1 && hi2 <= hi1) tighten = true; // sub-interval
    else if (lo2 <= lo1 && hi2 >= hi1) relax = true; // superset
    else {
      // Shifted: one end tightened, the other loosened.
      tighten = true;
      relax = true;
    }
  }
  scalar("meta.minCycles", current.meta.minCycles, candidate.meta.minCycles, false);
  scalar("meta.acceptMargin", current.meta.acceptMargin, candidate.meta.acceptMargin, false);

  for (const key of Object.keys(current.budgets) as (keyof GovernancePolicy["budgets"])[]) {
    scalar(`budgets.${key}`, current.budgets[key], candidate.budgets[key], true);
  }
  for (const key of Object.keys(current.approvals) as (keyof GovernancePolicy["approvals"])[]) {
    bool(`approvals.${key}`, current.approvals[key], candidate.approvals[key]);
  }
  for (const key of Object.keys(current.frozen) as LayerKey[]) {
    bool(`frozen.${key}`, current.frozen[key], candidate.frozen[key]);
  }

  // No netting (§5): anything not strictly-tightening is mixed/relaxing.
  const direction: Direction = relax ? (tighten ? "mixed" : "relaxing") : "tightening";
  return { direction, diff };
}

// ── Result shapes ──────────────────────────────────────────────────────────

export type ProposeResult =
  | { ok: true; policyId: string; direction: Direction; status: "active" | "awaiting_approval" | "queued" }
  | { ok: false; reason: string };

export type OpResult = { ok: true } | { ok: false; reason: string };

export type VerifyResult =
  | { ok: true; historyRows: number; auditRows: number; approvalRows: number }
  | { ok: false; file: string; badRow: number; reason: string };

export interface GovernanceStatus {
  ok: true;
  policy: GovernancePolicy;
  source: "file" | "builtin";
  failClosed: boolean;
  /** Hash of the last document-bearing history row — what a proposer's
   *  `prevHash` must match (chain gate §4.4). Null before genesis. */
  headHash: string | null;
  pending: Array<{ policyId: string; direction: Direction; status: ProposalStatus; requiredApproval: boolean }>;
}

// ── Genesis bootstrap ──────────────────────────────────────────────────────

/** First-boot bootstrap: a dir with NO policy and NO history gets the
 *  genesis policy (the pre-L5 hardcoded defaults — activating it changes
 *  nothing). A dir with history but no policy.json is NOT bootstrapped:
 *  that is a deletion, and it fail-closes per §9 / AC5. Returns whether
 *  genesis was written. Called by the sidecar at startup. */
export function ensureGenesisPolicy(
  dir: string = defaultGovernanceDir(),
  now: () => number = Date.now,
): boolean {
  const policyPath = join(dir, "policy.json");
  const historyPath = join(dir, "policy_history.jsonl");
  if (existsSync(policyPath) || existsSync(historyPath)) return false;
  const doc: GovernancePolicy = { ...defaultGenesisPolicy(now()), activatedAt: now() };
  appendChained(historyPath, {
    policyId: doc.policyId,
    parentId: null,
    event: "activated",
    timestamp: now(),
    actor: "system",
    diff: [],
    reason: "genesis bootstrap — codifies the pre-L5 hardcoded defaults",
    document: doc,
    sourceId: doc.policyId,
  });
  const tmp = `${policyPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  renameSync(tmp, policyPath);
  appendGovernanceAudit(dir, {
    timestamp: now(),
    source: "policy",
    event: "activated",
    refId: doc.policyId,
    summary: "genesis bootstrap",
  });
  return true;
}

// ── The FSM ────────────────────────────────────────────────────────────────

export interface GovernanceLifecycleOpts {
  /** Governance dir override (tests). Default: `paths().governance`. */
  dir?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

export class GovernanceLifecycle {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly policyPath: string;
  private readonly historyPath: string;
  private readonly approvalsPath: string;
  private readonly proposalsDir: string;

  constructor(opts: GovernanceLifecycleOpts = {}) {
    this.dir = opts.dir ?? defaultGovernanceDir();
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.policyPath = join(this.dir, "policy.json");
    this.historyPath = join(this.dir, "policy_history.jsonl");
    this.approvalsPath = join(this.dir, "approvals.jsonl");
    this.proposalsDir = join(this.dir, "proposals");
    mkdirSync(this.proposalsDir, { recursive: true });
    this.recover();
  }

  // ── Reads ────────────────────────────────────────────────────────────

  status(): GovernanceStatus {
    const load = loadPolicy(this.dir);
    return {
      ok: true,
      policy: load.policy,
      source: load.source,
      failClosed: load.source === "builtin",
      headHash: this.headRow()?.hash ?? null,
      pending: this.pendingProposals().map(({ id, file }) => ({
        policyId: id,
        direction: file.direction,
        status: file.status,
        requiredApproval: file.requiredApproval,
      })),
    };
  }

  historyRows(limit = 200): HistoryRow[] {
    return readRows<HistoryRow>(this.historyPath).slice(-limit);
  }

  /** The stored document of a proposal — what an approver hashes. */
  proposalDocument(policyId: string): GovernancePolicy | null {
    return this.readProposal(policyId)?.document ?? null;
  }

  verify(): VerifyResult {
    for (const [file, path] of [
      ["policy_history.jsonl", this.historyPath],
      ["governance_audit.jsonl", join(this.dir, "governance_audit.jsonl")],
      ["approvals.jsonl", this.approvalsPath],
    ] as const) {
      const res = verifyChainFile(path);
      if (!res.ok) return { ok: false, file, badRow: res.badRow, reason: res.reason };
    }
    return {
      ok: true,
      historyRows: verifyOk(this.historyPath),
      auditRows: verifyOk(join(this.dir, "governance_audit.jsonl")),
      approvalRows: verifyOk(this.approvalsPath),
    };
  }

  // ── Propose (§4 gates, in order) ─────────────────────────────────────

  propose(rawDoc: unknown, proposedBy: Proposer): ProposeResult {
    // 1. Schema gate.
    const src = rawDoc && typeof rawDoc === "object" ? (rawDoc as Record<string, unknown>) : null;
    if (!src) return { ok: false, reason: "schema: proposal is not an object" };
    if (src.version !== 1) return { ok: false, reason: `schema: unsupported version ${String(src.version)}` };

    // 2. G0 gate — REJECT, never clamp, at propose time (§4.2).
    const { policy: candidate, clamped } = clampPolicy(src);
    if (clamped.length > 0) {
      return { ok: false, reason: `G0 violation: ${clamped.join(", ")} (a proposal needing clamps is a buggy or hostile proposer)` };
    }

    const active = loadPolicy(this.dir).policy;

    // 3. Direction gate (§5) — computed here, never proposer-supplied.
    const { direction, diff } = computeDirection(active, candidate);
    if (diff.length === 0) return { ok: false, reason: "no-op proposal: candidate equals the active policy" };

    // 4. Chain gate (§4.4) — the proposer names the head it saw.
    const head = this.headRow()?.hash ?? null;
    const claimed = typeof src.prevHash === "string" ? src.prevHash : null;
    if (claimed !== head) {
      return { ok: false, reason: `prevHash mismatch: proposal is against ${claimed ?? "genesis"}, head is ${head ?? "genesis"} — rebase and re-propose` };
    }

    // 5. Freeze gate (§4.5) — l6 proposals refused while l6 is frozen.
    if (proposedBy === "l6" && active.frozen.l6) {
      return { ok: false, reason: "frozen by governance: l6 proposals are refused while frozen.l6 (G-INV-7)" };
    }

    const policyId = this.nextPolicyId();
    const requiredApproval = direction !== "tightening";
    const proposal: ProposalFile = {
      document: { ...candidate, policyId, parentId: active.policyId === "gp-builtin" ? null : active.policyId, createdAt: this.now(), prevHash: head },
      proposedBy,
      direction,
      requiredApproval,
      status: requiredApproval ? "awaiting_approval" : "queued",
      parentId: active.policyId === "gp-builtin" ? null : active.policyId,
      prevHash: head,
      createdAt: this.now(),
      decidedAt: null,
    };
    this.writeProposal(policyId, proposal);
    this.appendHistory({
      policyId,
      parentId: proposal.parentId,
      event: "proposed",
      actor: proposedBy,
      diff,
      reason: `direction=${direction}${requiredApproval ? " (awaiting approval)" : ""}`,
    });

    if (!requiredApproval) {
      // Auto-adopt path (G-INV-2) under the 24h cooldown (§5).
      if (this.cooldownActive()) {
        this.log(`governance: ${policyId} tightening but auto-adopt cooldown active — queued`);
        return { ok: true, policyId, direction, status: "queued" };
      }
      this.activate(policyId, "system", `auto-adopted (strictly tightening)`);
      return { ok: true, policyId, direction, status: "active" };
    }
    return { ok: true, policyId, direction, status: "awaiting_approval" };
  }

  /** Activate the oldest queued tightening proposal if the cooldown
   *  allows. Called by operators/API on their own cadence — queued
   *  proposals never auto-fire from a timer in v1. */
  processQueue(): { activated: string | null } {
    if (this.cooldownActive()) return { activated: null };
    const queued = this.pendingProposals()
      .filter(({ file }) => file.status === "queued")
      .sort((a, b) => a.file.createdAt - b.file.createdAt);
    const next = queued[0];
    if (!next) return { activated: null };
    const res = this.activate(next.id, "system", "auto-adopted from queue (cooldown expired)");
    return { activated: res.ok ? next.id : null };
  }

  // ── Approval path (G-INV-6) ──────────────────────────────────────────

  approve(policyId: string, documentHash: string, note: string, approvedBy: string): OpResult {
    const proposal = this.readProposal(policyId);
    if (!proposal) return { ok: false, reason: `unknown proposal: ${policyId}` };
    if (proposal.status !== "awaiting_approval" && proposal.status !== "queued") {
      return { ok: false, reason: `proposal ${policyId} is ${proposal.status} (terminal)` };
    }
    const actualHash = sha256Canonical(proposal.document);
    if (documentHash !== actualHash) {
      return { ok: false, reason: `document hash mismatch: approvals bind to the exact document (§10) — expected ${actualHash}` };
    }
    // Approval record is append-only (G-INV-8) and chained.
    appendChained(this.approvalsPath, {
      policyId,
      documentHash,
      approvedBy,
      at: this.now(),
      note,
    });
    return this.activate(policyId, approvedBy, `human-approved: ${note}`, { approvedBy, at: this.now(), note });
  }

  reject(policyId: string, reason: string, actor: string): OpResult {
    return this.decide(policyId, "rejected", reason, actor);
  }

  withdraw(policyId: string, actor: string): OpResult {
    return this.decide(policyId, "withdrawn", "withdrawn by proposer", actor);
  }

  // ── Rollback (§6) ────────────────────────────────────────────────────

  rollback(reason: string, actor: string): OpResult {
    const head = this.headRow();
    if (!head?.document) return { ok: false, reason: "no active policy to roll back" };
    const current = head.document;
    // Document ancestry: the content we carry came from `sourceId`
    // (self for normal activations); the rollback target is ITS parent.
    const sourceId = head.sourceId ?? current.policyId;
    const sourceRow = this.activationRowOf(sourceId);
    const targetId = sourceRow?.document?.parentId ?? null;
    if (!targetId) return { ok: false, reason: "at genesis — no parent policy to roll back to" };
    const targetRow = this.activationRowOf(targetId);
    if (!targetRow?.document) return { ok: false, reason: `no activation row found for parent ${targetId} (history incomplete)` };

    const newId = this.nextPolicyId();
    const doc: GovernancePolicy = {
      ...structuredClone(targetRow.document),
      policyId: newId,
      parentId: current.policyId, // §3: id lineage stays linear
      createdAt: this.now(),
      activatedAt: this.now(),
      prevHash: head.hash,
      approval: null,
    };
    this.appendHistory({
      policyId: current.policyId,
      parentId: current.parentId,
      event: "rolled_back",
      actor,
      diff: [],
      reason,
    });
    const row = this.appendHistory({
      policyId: newId,
      parentId: current.policyId,
      event: "activated",
      actor,
      diff: computeDirection(current, doc).diff,
      reason: `rollback: re-activating the document of ${targetId}`,
      document: doc,
      sourceId: targetId,
    });
    this.writePolicyAtomic(doc);
    this.log(`governance: rolled back ${current.policyId} → ${newId} (content of ${targetId}, row ${row.hash.slice(0, 8)})`);
    return { ok: true };
  }

  // ── Freeze / unfreeze (§3 flags) ─────────────────────────────────────

  freeze(layers: LayerKey[], reason: string, actor: string): OpResult {
    return this.setFrozen(layers, true, reason, actor);
  }

  /** Unfreeze is always a relaxation → human-only (G-INV-6, §3).
   *  ponytail: single-operator install — anything that is not a machine
   *  actor counts as the operator; widen to a role check when RBAC lands. */
  unfreeze(layers: LayerKey[], reason: string, actor: string): OpResult {
    if (actor === "l6" || actor === "system") {
      return { ok: false, reason: "unfreeze requires the operator (G-INV-6)" };
    }
    return this.setFrozen(layers, false, reason, actor);
  }

  // ── Internals ────────────────────────────────────────────────────────

  private setFrozen(layers: LayerKey[], value: boolean, reason: string, actor: string): OpResult {
    const bad = layers.filter((l) => !["l1", "l2", "l3", "l4", "l6"].includes(l));
    if (bad.length > 0 || layers.length === 0) {
      return { ok: false, reason: `invalid layers: ${bad.join(", ") || "(none given)"}` };
    }
    const head = this.headRow();
    if (!head?.document) {
      return { ok: false, reason: "no active policy on disk — recover by proposing a policy first" };
    }
    const doc = structuredClone(head.document);
    const diff: string[] = [];
    for (const l of layers) {
      if (doc.frozen[l] !== value) {
        diff.push(`frozen.${l}: ${doc.frozen[l]} → ${value}`);
        doc.frozen[l] = value;
      }
    }
    if (diff.length === 0) return { ok: true }; // already in the requested state
    this.appendHistory({
      policyId: doc.policyId,
      parentId: doc.parentId,
      event: value ? "frozen" : "unfrozen",
      actor,
      diff,
      reason,
      document: doc,
      sourceId: head.sourceId ?? doc.policyId,
    });
    this.writePolicyAtomic(doc);
    return { ok: true };
  }

  private decide(policyId: string, status: "rejected" | "withdrawn", reason: string, actor: string): OpResult {
    const proposal = this.readProposal(policyId);
    if (!proposal) return { ok: false, reason: `unknown proposal: ${policyId}` };
    if (proposal.status !== "awaiting_approval" && proposal.status !== "queued") {
      return { ok: false, reason: `proposal ${policyId} is ${proposal.status} (terminal)` };
    }
    this.writeProposal(policyId, { ...proposal, status, decidedAt: this.now() });
    this.appendHistory({
      policyId,
      parentId: proposal.parentId,
      event: status,
      actor,
      diff: [],
      reason,
    });
    return { ok: true };
  }

  /** History row appended FIRST, then policy.json temp+rename (§9 crash
   *  rule: history is the authority; recovery re-derives the file). */
  private activate(
    policyId: string,
    actor: string,
    reason: string,
    approval: GovernancePolicy["approval"] = null,
  ): OpResult {
    const proposal = this.readProposal(policyId);
    if (!proposal) return { ok: false, reason: `unknown proposal: ${policyId}` };
    const head = this.headRow();
    if ((head?.hash ?? null) !== proposal.prevHash) {
      return { ok: false, reason: `prevHash mismatch at activation: head moved since propose — rebase and re-propose` };
    }
    const doc: GovernancePolicy = {
      ...structuredClone(proposal.document),
      activatedAt: this.now(),
      approval,
    };
    this.appendHistory({
      policyId,
      parentId: proposal.parentId,
      event: "activated",
      actor,
      diff: [],
      reason,
      document: doc,
      sourceId: policyId,
    });
    this.writePolicyAtomic(doc);
    this.writeProposal(policyId, { ...proposal, status: "activated", decidedAt: this.now() });
    this.log(`governance: activated ${policyId} (${reason})`);
    return { ok: true };
  }

  private appendHistory(row: Omit<HistoryRow, "timestamp" | "prevHash" | "hash">): HistoryRow {
    const full = appendChained(this.historyPath, {
      ...row,
      timestamp: this.now(),
    } as unknown as Record<string, unknown>) as unknown as HistoryRow;
    // G-INV-5 mirror — every transition, best-effort.
    appendGovernanceAudit(this.dir, {
      timestamp: full.timestamp,
      source: "policy",
      event: row.event,
      refId: row.policyId,
      summary: row.reason,
    });
    return full;
  }

  private writePolicyAtomic(doc: GovernancePolicy): void {
    const tmp = `${this.policyPath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    renameSync(tmp, this.policyPath);
  }

  /** The last history row that (re)wrote policy.json — the chain-gate
   *  anchor and the §9 recovery authority. */
  private headRow(): HistoryRow | null {
    const rows = readRows<HistoryRow>(this.historyPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.document) return rows[i]!;
    }
    return null;
  }

  private activationRowOf(policyId: string): HistoryRow | null {
    const rows = readRows<HistoryRow>(this.historyPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.event === "activated" && r.policyId === policyId && r.document) return r;
    }
    return null;
  }

  private cooldownActive(): boolean {
    const rows = readRows<HistoryRow>(this.historyPath);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.event === "activated" && r.actor === "system") {
        // Genesis bootstrap (parentId null) is written with actor "system"
        // but is NOT an auto-adoption (§5 counts auto-adopted policies
        // only) — counting it would queue every fresh install's first
        // tightening proposal for 24h.
        if (r.document?.parentId === null) continue;
        return this.now() - r.timestamp < AUTO_ADOPT_COOLDOWN_MS;
      }
    }
    return false;
  }

  private nextPolicyId(): string {
    let max = 0;
    for (const r of readRows<HistoryRow>(this.historyPath)) {
      const n = idNumber(r.policyId);
      if (n > max) max = n;
    }
    for (const { id } of this.pendingProposals(true)) {
      const n = idNumber(id);
      if (n > max) max = n;
    }
    return `gp-${max + 1}`;
  }

  private pendingProposals(includeTerminal = false): Array<{ id: string; file: ProposalFile }> {
    let names: string[];
    try {
      names = readdirSync(this.proposalsDir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: Array<{ id: string; file: ProposalFile }> = [];
    for (const name of names) {
      const id = name.slice(0, -".json".length);
      const file = this.readProposal(id);
      if (!file) continue;
      if (!includeTerminal && file.status !== "awaiting_approval" && file.status !== "queued") continue;
      out.push({ id, file });
    }
    return out;
  }

  private readProposal(policyId: string): ProposalFile | null {
    try {
      return JSON.parse(readFileSync(join(this.proposalsDir, `${policyId}.json`), "utf8")) as ProposalFile;
    } catch {
      return null;
    }
  }

  private writeProposal(policyId: string, file: ProposalFile): void {
    const path = join(this.proposalsDir, `${policyId}.json`);
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
    renameSync(tmp, path);
  }

  /** §9 boot-time reconciliation, run once from the constructor:
   *  - torn activation (policy.json valid but ≠ last activated document)
   *    → rewrite policy.json from history (history is the authority);
   *  - no valid policy loadable → record the fail_closed governance
   *    event (once — not on every restart while still failed). */
  private recover(): void {
    const head = this.headRow();
    if (head?.document && existsSync(this.policyPath)) {
      try {
        const onDisk = JSON.parse(readFileSync(this.policyPath, "utf8")) as unknown;
        if (sha256Canonical(onDisk) !== sha256Canonical(head.document)) {
          this.writePolicyAtomic(head.document);
          this.log(`governance: policy.json diverged from history — rewritten from row ${head.hash.slice(0, 8)} (§9)`);
        }
      } catch {
        // Unparseable → loadPolicy will quarantine + fail closed below.
      }
    }
    const load = loadPolicy(this.dir);
    if (load.source === "builtin") {
      const rows = readRows<HistoryRow>(this.historyPath);
      const last = rows[rows.length - 1];
      if (last?.event !== "fail_closed") {
        this.appendHistory({
          policyId: "gp-builtin",
          parentId: null,
          event: "fail_closed",
          actor: "system",
          diff: [],
          reason: load.reason,
        });
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readRows<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // verify() reports corruption; reads stay best-effort.
    }
  }
  return out;
}

function verifyOk(path: string): number {
  const res = verifyChainFile(path);
  return res.ok ? res.rows : 0;
}

function idNumber(id: string): number {
  const m = /^gp-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}
