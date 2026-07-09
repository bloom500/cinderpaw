/**
 * Chained governance audit mirror (L5 G-INV-5): every policy transition
 * and every L6 evolve/rollback lands one row in
 * `<governance>/governance_audit.jsonl`. Standalone module (not part of
 * `governance-lifecycle.ts`) so `meta-evolution.ts` can call it without
 * an import cycle — this file depends only on `hash-chain.ts`.
 */

import { join } from "node:path";
import { appendChained } from "../infra/hash-chain.ts";

export interface AuditRow {
  timestamp: number;
  source: "policy" | "l6" | "l4";
  event: string;
  refId: string;
  summary: string;
}

export function governanceAuditPath(dir: string): string {
  return join(dir, "governance_audit.jsonl");
}

/** Append one row to the chained governance audit. Best-effort with
 *  stderr visibility (same posture as `sandbox/audit-log.ts`): the
 *  mirror must never take down the caller — L6 calls this from its
 *  live evolve path. */
export function appendGovernanceAudit(dir: string, row: AuditRow): void {
  try {
    appendChained(governanceAuditPath(dir), row as unknown as Record<string, unknown>);
  } catch (err) {
    process.stderr.write(`[governance] failed to mirror audit row: ${String(err)}\n`);
  }
}
