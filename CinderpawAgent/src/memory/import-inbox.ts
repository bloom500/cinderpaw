/**
 * Memory brought over from OpenClaw or Hermes Agent.
 *
 * The import (crates/cinderpaw-core/src/migrate/memory.rs) writes
 * `<home>/import/<source>/<name>.jsonl`, one line per note, because only the
 * sidecar writes memory (the writer contract in
 * docs/agents-memory/project_memory_roadmap.md). This files them on the first
 * turn of the next owner conversation, so the agent knows them from its very
 * first reply after onboarding:
 *  - a `note` line becomes a dated note (source "import"), shown on the Memory
 *    page like any other and deletable there;
 *  - a `card` line (USER.md) becomes the card about the person, unless they
 *    already have one: then its lines become notes and their own card stays.
 *  - a `schedule` line (crates/cinderpaw-core/src/migrate/schedules.rs) becomes
 *    a scheduled task, switched off: the old agent may still run the same job.
 *    It delivers where the app's own new tasks do (`chat` session "cron").
 * A filed file moves to `import/done/<source>/`, and a note or task imported
 * once is not added again when the same setup is brought over twice.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CronJobsRepo } from "../cron/jobs.ts";
import type { Schedule } from "../types.ts";
import type { NotePriority, ObservationStore } from "./observations.ts";

interface Line {
  kind: "note" | "card";
  text: string;
  date?: string;
  priority?: NotePriority;
}

interface ScheduleLine {
  kind: "schedule";
  id: string;
  text: string;
  task: string;
  schedule: Schedule;
}

function parseSchedule(l: Partial<ScheduleLine>): ScheduleLine[] {
  const s = l.schedule as Partial<Record<string, unknown>> | undefined;
  const ok =
    (s?.kind === "cron" && typeof s.expression === "string") ||
    (s?.kind === "every" && typeof s.intervalMs === "number" && s.intervalMs > 0) ||
    (s?.kind === "at" && typeof s.isoTimestamp === "string");
  if (!ok || typeof l.id !== "string" || typeof l.task !== "string" || !l.task.trim()) return [];
  return [{ kind: "schedule", id: l.id, text: typeof l.text === "string" && l.text.trim() ? l.text.trim() : l.task.slice(0, 50), task: l.task, schedule: l.schedule as Schedule }];
}

function parse(raw: string): Array<Line | ScheduleLine> {
  try {
    const l = JSON.parse(raw) as Partial<Line> | Partial<ScheduleLine>;
    if (l.kind === "schedule") return parseSchedule(l as Partial<ScheduleLine>);
    if ((l.kind === "note" || l.kind === "card") && typeof l.text === "string" && l.text.trim()) {
      const priority = l.priority === "high" || l.priority === "low" ? l.priority : "med";
      const date = typeof l.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(l.date) ? l.date : undefined;
      return [{ kind: l.kind, text: l.text.trim(), date, priority }];
    }
  } catch {
    // a broken line is skipped, the rest of the file still counts
  }
  return [];
}

/** File everything waiting in `dir`; returns how many notes, cards and tasks were added. */
export function ingestImports(dir: string, to: { notes: ObservationStore; cron?: CronJobsRepo }, now = Date.now()): number {
  const { notes, cron } = to;
  if (!existsSync(dir)) return 0;
  let filed = 0;
  for (const source of readdirSync(dir)) {
    const sub = join(dir, source);
    if (source === "done" || !statSync(sub).isDirectory()) continue;
    for (const name of readdirSync(sub).filter((f) => f.endsWith(".jsonl"))) {
      const file = join(sub, name);
      const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).flatMap(parse);
      const known = new Set(notes.list("", 100_000).filter((n) => n.source === "import").map((n) => n.text));
      for (const l of lines) {
        if (l.kind === "schedule") {
          // ponytail: no cron store (a test, or a caller without one) leaves the file for next time
          if (!cron) continue;
          if (!cron.get(l.id)) {
            cron.upsert({ id: l.id, name: l.text, task: l.task, schedule: l.schedule, delivery: { kind: "chat", sessionId: "cron" }, enabled: false });
            filed++;
          }
          continue;
        }
        const card = notes.card("")?.text.trim() ?? "";
        if (l.kind === "card" && (!card || card === l.text)) {
          if (!card) {
            notes.setCard("", l.text, now);
            filed++;
          }
          continue;
        }
        const texts = l.kind === "card" ? l.text.split("\n").map((t) => t.replace(/^- /, "").trim()).filter(Boolean) : [l.text];
        for (const text of texts) {
          if (known.has(text)) continue;
          notes.add({
            sessionId: `import:${source}`,
            scope: "",
            observedAt: now,
            refDate: l.date ?? null,
            priority: l.kind === "card" ? "high" : (l.priority ?? "med"),
            text,
            source: "import",
          });
          known.add(text);
          filed++;
        }
      }
      if (!cron && lines.some((l) => l.kind === "schedule")) continue;
      const done = join(dir, "done", source);
      mkdirSync(done, { recursive: true });
      renameSync(file, join(done, `${now}-${name}`));
    }
  }
  return filed;
}
