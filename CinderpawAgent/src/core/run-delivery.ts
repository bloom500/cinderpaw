/**
 * Handing a concluded run's report to the person who is owed it.
 *
 * A run has two things that must both survive a crash: what it did, and the
 * sentence that tells someone about it. `run-store.ts` makes the first durable.
 * This module owns the second — specifically the ordering, which is the entire
 * content of the bug it exists to fix.
 *
 * The rule, stated once so no call site has to re-derive it:
 *
 *     finish(status, …, report)   → the row knows it ended AND what it owes
 *     deliver(report)             → the message goes out
 *     markDelivered()             → only now is the debt discharged
 *
 * Reversing the last two would put the report beyond recovery a moment before it
 * was actually sent, which is the original bug in a smaller window. Keeping this
 * order costs a duplicate message when a process dies between the send and the
 * mark. That is the deliberate trade: against a chat API with no idempotency
 * key, at-least-once is the strongest guarantee available, and a report seen
 * twice is a nuisance where a report never seen is a broken promise.
 *
 * Like `run-resume.ts`, the side effects belong to the caller: delivery needs a
 * connector, and this needs to be testable without one.
 */

import type { RunRow, RunStore } from "./run-store.ts";

/**
 * What a delivery attempt came back as. Mirrors `ChannelAskRouter.notify`,
 * because the distinction it draws is the whole basis of the retry bound below.
 */
export type DeliveryOutcome = "sent" | "no_channel" | "refused";

/**
 * How many times the TARGET may refuse a report before it becomes a log entry.
 *
 * The invariant, stated so it can be argued with:
 *
 *   We stop retrying only once the target itself has refused, and only after
 *   enough refusals to rule out a transient fault. Being unable to try is never
 *   counted against a report.
 *
 * That is what makes this a bound rather than a guess. A wall-clock deadline
 * cannot express it: an hour of downtime and a channel deleted an hour ago look
 * identical to a clock, so any number of hours is picked by feel. A refusal is
 * evidence about the target — the connector was up, the send was made, it
 * failed.
 *
 * WHY NOT UNBOUNDED. Every way a send is genuinely refused — channel deleted,
 * bot kicked, permission revoked, token rotated — is fixed by a person, not by
 * asking again. Past that point retrying is not persistence, it is refusing to
 * admit whose problem it is: the run stays owed forever, the drain re-attempts
 * it at every boot ahead of real work, and nothing ever says "this one needs
 * you". That is the same silence this whole feature exists to end, relocated.
 * The bound is where responsibility transfers to the operator, and the log is
 * the handover.
 *
 * WHY NOT ONE. A single refusal cannot separate permanent (404, 403) from
 * transient (429, 5xx, a dropped socket): both arrive as a throw. More than one,
 * across more than one process lifetime, is what makes "permanent" the likelier
 * reading — and the drain runs once per boot, so these are distinct boots at
 * which the connector was live and the target still would not take it.
 *
 * WHY EXACTLY THREE — honestly: not derived. The floor (>1) is; the exact value
 * is a small integer chosen above that floor. `opts.maxRefusals` overrides it.
 *
 * ponytail: the constant disappears entirely the day a refusal carries its
 * reason — 404/403 is permanent and should hand over on the FIRST one, 429/5xx
 * is transient and should not count at all. That needs per-connector error
 * classification (discord.js `DiscordAPIError.status`, Slack's `data.error`,
 * Baileys' own shapes), and today only Discord has durable runs. Do it when a
 * second connector gets them, or the first time a report is lost to three
 * rate-limits in a crash loop.
 */
export const MAX_DELIVERY_REFUSALS = 3;

/**
 * Prefix on a report that arrives late.
 *
 * Someone reading a conclusion hours after the fact — or, after a crash between
 * send and mark, for the second time — is owed the reason. An unexplained
 * duplicate reads as a bug; an explained one reads as a system that did not
 * drop their work.
 */
export const REDELIVERY_NOTE =
  "_(re-sent after a restart — the process stopped before this reached you)_";

/**
 * Hands `text` over and records what came back.
 *
 * `sent` discharges the debt. `refused` counts against the target. `no_channel`
 * does neither — it is not a fact about the delivery, only about this moment.
 */
export async function deliverAndMark(
  store: RunStore,
  run: RunRow,
  text: string,
  deliver: (run: RunRow, text: string) => Promise<DeliveryOutcome>,
): Promise<DeliveryOutcome> {
  const outcome = await deliver(run, text);
  if (outcome === "sent") store.markDelivered(run.id);
  else if (outcome === "refused") store.recordDeliveryRefusal(run.id);
  return outcome;
}

/**
 * Every report on disk that never reached anyone, handed over now.
 *
 * Call at boot, BEFORE the resume pass: a person owed the conclusion of
 * yesterday's work should get it before this process starts making more.
 *
 * One unreachable channel must not cost the other people their reports, so a
 * failure is logged and the pass continues — the same rule, and the same reason,
 * as `resumeInterruptedRuns`.
 */
export async function drainUndelivered(
  store: RunStore,
  deliver: (run: RunRow, text: string) => Promise<DeliveryOutcome>,
  opts: { maxRefusals?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const maxRefusals = opts.maxRefusals ?? MAX_DELIVERY_REFUSALS;
  const log = opts.log ?? (() => {});
  for (const run of store.undelivered()) {
    // Defensive: `undelivered()` filters on a non-null report, so this cannot
    // fire. It costs one comparison and makes the non-null below a fact rather
    // than an assertion.
    if (!run.report) continue;
    try {
      if (run.deliveryAttempts >= maxRefusals) {
        log(`run ${run.id}: refused ${run.deliveryAttempts} times — the target is gone, keeping it in the log`);
        log(`run ${run.id} report:\n${run.report}`);
        // Marked even though nobody received it: the log IS where it ended up,
        // and leaving it owed forever would be the unbounded retry.
        store.markDelivered(run.id);
        continue;
      }
      await deliverAndMark(store, run, `${REDELIVERY_NOTE}\n\n${run.report}`, deliver);
    } catch (err) {
      // Deliberately NOT counted as a refusal. A throw out of `deliver` is our
      // fault, not the target's, and discarding someone's report because of a
      // bug on this side is the wrong direction to be wrong in. It stays owed
      // and this line repeats every boot until somebody fixes it.
      log(`run ${run.id}: re-delivery failed: ${String(err)}`);
    }
  }
}
