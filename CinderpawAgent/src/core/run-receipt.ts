/**
 * The receipt a user run leaves behind (competence plan §3.1, live induction).
 *
 * An L3 receipt's `file` is the patched target, so a procedure induced from
 * it is a history, not a skill. A user run has a real step: the tool sequence
 * that a verifier then passed or failed. Measured on 14 Sep 2026, the first
 * real `done_when` run left `write_file` then `read_file` in the audit log,
 * `done_when_pass = 1` and 523 tokens in `run_turns`, and nothing else; this
 * is that, in the Attempt shape `induceProcedure` already reads.
 *
 * Same shape, separate ledger: the M0 selector reads the L3 ledger by `file`
 * and would take "write_file>read_file" for a file to repair.
 */

import type { Attempt } from "../rsi/l3-code/experiment-selector.ts";
import type { DoneWhen } from "../cron/done-when.ts";

export const RUN_RECEIPT_METHOD = "run-receipt.1";

/** `condition` is the verifier's kind, not the mission text: two real
 *  missions are rarely identical, so a mission fingerprint would never fill
 *  the held-out set a procedure needs. `done_when:file_contains` is coarse
 *  and honest. */
export const runCondition = (doneWhen: DoneWhen): string => `done_when:${doneWhen.kind}`;

export function runReceipt(opts: {
  doneWhen: DoneWhen;
  verified: boolean;
  /** Tool names in call order, from `toolCallsOfRun`. */
  tools: string[];
  /** Tokens the run spent, summed over its turns: the cost per task. */
  tokens: number;
  now: number;
}): Attempt | null {
  // No tools, no step: a verified answer with nothing done is not a procedure.
  if (opts.tools.length === 0) return null;
  const what = opts.doneWhen.path ?? opts.doneWhen.value ?? "";
  return {
    file: opts.tools.join(">"),
    rationale: `user run, verified by ${opts.doneWhen.kind}`,
    verdict: opts.verified ? "accept" : "reject",
    reason: `done_when ${opts.doneWhen.kind} ${what} ${opts.verified ? "passed" : "failed"}`.trim(),
    ts: opts.now,
    observed: { accepted: opts.verified, effect: null, cost: opts.tokens, failureClass: null },
    methodVersion: { selector: RUN_RECEIPT_METHOD, promptHash: "none" },
    condition: runCondition(opts.doneWhen),
  };
}
