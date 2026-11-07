/**
 * tasks_list — the scheduled tasks that really exist, read-only.
 *
 * suggest_task only offers a card; a task exists once the person presses
 * Create, in whichever window they are. A chat on WhatsApp had no way to see
 * that, and told Darius his reminder was "not confirmed as created" after he
 * had created it in the app (smoke test, 7 Nov). This is the list itself.
 *
 * Times are written in full with the weekday ("Sun Nov 08 2026 20:00"), so a
 * reply never has to work out which day a date falls on.
 */
import type { CronJob, Tool } from "../../types.ts";

const when = (ms: number | undefined) => (ms ? new Date(ms).toString().replace(/:\d\d GMT.*$/, "") : null);

export function createTasksListTool(jobs: () => CronJob[]): Tool {
  return {
    manifest: {
      name: "tasks_list",
      description:
        "The person's scheduled tasks and reminders as they are right now: name, kind, when it runs next, " +
        "paused or not, last run. Call it before saying whether a task or reminder exists, was created or ran: " +
        "a card you offered with suggest_task is a task only once they pressed Create.",
      permissions: [],
      networkAccess: false,
    },
    parameters: {},
    async execute() {
      const rows = jobs().map((j) => ({
        name: j.name,
        kind: j.kind,
        active: j.enabled,
        next_run: when(j.nextRunMs),
        last_run: when(j.lastRunMs),
      }));
      return {
        ok: true,
        content: rows.length ? JSON.stringify(rows, null, 2) : "No scheduled tasks or reminders exist.",
        data: { tasks: rows },
      };
    },
  };
}
