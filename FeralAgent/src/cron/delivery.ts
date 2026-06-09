/**
 * Cron delivery — dispatches a job's result to the configured target.
 *
 *   - `chat`    → emit a `cron_fired` event into a Tauri session
 *   - `webhook` → POST JSON to a URL via the provided fetch
 *   - `tool`    → V2 TODO (will route through a subagent when P0-1 lands)
 *
 * The delivery layer never throws. A failed webhook becomes an
 * `error` OutboundEvent so the user can see what went wrong in the
 * chat. The scheduler treats delivery failures as run failures for
 * retry accounting.
 */

import type { CronJob, DeliveryTarget, OutboundEvent } from "../types.ts";

/**
 * Context handed to the delivery layer. The cron subsystem doesn't have
 * a direct reference to the Tauri transport; the index.ts wires
 * `emit` to `transport.send` and `fetch` to the egress proxy (or a
 * permissive one for cron-internal webhooks).
 */
export interface CronDeliveryContext {
  emit(event: OutboundEvent): void;
  fetch: typeof globalThis.fetch;
}

export async function deliverCron(
  target: DeliveryTarget,
  content: string,
  job: CronJob,
  ctx: CronDeliveryContext,
): Promise<void> {
  if (target.kind === "chat") {
    ctx.emit({
      type: "cron_fired",
      jobId: job.id,
      jobName: job.name,
      sessionId: target.sessionId,
      content,
    });
    return;
  }

  if (target.kind === "webhook") {
    try {
      const res = await ctx.fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jobId: job.id,
          jobName: job.name,
          task: job.task,
          content,
          deliveredAt: Date.now(),
        }),
      });
      if (!res.ok) {
        ctx.emit({
          type: "error",
          message: `cron webhook for "${job.name}" returned ${res.status}`,
        });
      }
    } catch (err) {
      ctx.emit({
        type: "error",
        message: `cron webhook for "${job.name}" failed: ${String(err)}`,
      });
    }
    return;
  }

  // target.kind === "tool" — V2. P0-1 will replace this with a subagent
  // call so the tool runs in an isolated context. For now we surface a
  // clear error so a misconfigured job doesn't silently no-op.
  ctx.emit({
    type: "error",
    message: `cron delivery kind "tool" is not implemented yet (job "${job.name}")`,
  });
}
