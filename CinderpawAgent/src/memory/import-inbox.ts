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
 * A filed file moves to `import/done/<source>/`, and a note imported once is
 * not added again when the same setup is brought over twice.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NotePriority, ObservationStore } from "./observations.ts";

interface Line {
  kind: "note" | "card";
  text: string;
  date?: string;
  priority?: NotePriority;
}

function parse(raw: string): Line[] {
  try {
    const l = JSON.parse(raw) as Partial<Line>;
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

/** File everything waiting in `dir`; returns how many notes (and cards) were added. */
export function ingestImports(dir: string, notes: ObservationStore, now = Date.now()): number {
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
      const done = join(dir, "done", source);
      mkdirSync(done, { recursive: true });
      renameSync(file, join(done, `${now}-${name}`));
    }
  }
  return filed;
}
