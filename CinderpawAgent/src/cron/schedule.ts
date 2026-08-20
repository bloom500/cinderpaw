/**
 * Schedule parsing & next-run computation.
 *
 * Supports three schedule kinds (see {@link Schedule}):
 *   - `every` — fixed interval, repeats forever (trivial math)
 *   - `at`    — one-shot at an ISO timestamp
 *   - `cron`  — standard 5-field cron, parsed via `cron-parser`
 *
 * Returns the next run time in epoch ms, or `null` when the schedule is
 * exhausted (one-shot already fired) or malformed. Returning `null` lets
 * the scheduler silently skip the job rather than crash.
 */

import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "../types.ts";

/** Maximum size of the cron-parser history/iterator budget. */
const CRON_ITERATIONS = 1;

export function nextRunAt(
  schedule: Schedule,
  from: Date = new Date(),
): number | null {
  switch (schedule.kind) {
    case "every": {
      if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
        return null;
      }
      return from.getTime() + schedule.intervalMs;
    }

    case "at": {
      const target = Date.parse(schedule.isoTimestamp);
      if (Number.isNaN(target)) return null;
      // One-shot: only schedule if still in the future.
      return target > from.getTime() ? target : null;
    }

    case "cron": {
      try {
        // cron-parser interprets expressions in the runtime's local
        // timezone by default. We accept that — users authoring jobs
        // in their own timezone will see matching behaviour. Tests
        // use UTC-shaped ISO strings, which parse the same way.
        const interval = CronExpressionParser.parse(schedule.expression, {
          currentDate: from,
        });
        const next = interval.next();
        return next.toDate().getTime();
      } catch {
        // Malformed expression — caller (scheduler) skips the job and
        // emits a diagnostic. We never throw across this boundary.
        void CRON_ITERATIONS; // keep the import live; cron-parser's TS sometimes optimises it away
        return null;
      }
    }
  }
}
