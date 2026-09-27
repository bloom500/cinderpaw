/**
 * The Reflector: while the user is away, rewrite the user card and fold notes
 * older than a week into one digest per week. It never deletes a note; a
 * digested note only leaves the snapshot, so an exact detail stays findable.
 *
 * One model call per run, at most once per 4 hours, only when there is work.
 * Spec: docs/superpowers/specs/2026-09-27-observational-memory-design.md
 */
import type { InferenceRouter } from "../egress/inference-router.ts";
import type { SemanticMemory } from "./semantic.ts";
import { weekPeriod, type Note, type ObservationStore } from "./observations.ts";
import type { MemoryHealth } from "./extractor.ts";

export const REFLECT_IDLE_MS = 10 * 60_000;
export const REFLECT_COOLDOWN_MS = 4 * 60 * 60_000;
const DIGEST_AFTER_MS = 7 * 86_400_000;
const NEW_NOTES_FOR_CARD = 15;
const FIRST_CARD_NOTES = 5;
const CARD_MAX_CHARS = 2500;
const MAX_FACTS = 60;
const MAX_INPUT_NOTES = 200;

export interface ReflectorDeps {
  router: Pick<InferenceRouter, "complete" | "evictSession">;
  store: ObservationStore;
  semantic: Pick<SemanticMemory, "selectForPrompt" | "forgottenSince">;
  now?: () => number;
  log?: (m: string) => void;
}

const stamp = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const line = (n: Note) => `${stamp(n.observedAt)} ${n.priority}: ${n.text}${n.refDate ? ` (for ${n.refDate})` : ""}`;

function sections(raw: string): { card: string; digests: string } {
  const heads = [...raw.matchAll(/={2,}\s*(CARD|DIGESTS)\s*={2,}/gi)];
  const out = { card: "", digests: "" };
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : raw.length;
    const body = raw.slice(h.index! + h[0].length, end).trim();
    if (h[1]!.toUpperCase() === "CARD") out.card = body;
    else out.digests = body;
  });
  return out;
}

export class Reflector {
  readonly #d: ReflectorDeps;
  readonly #now: () => number;
  #lastRunAt = 0;
  #health: MemoryHealth = { lastOkAt: null, failures: 0, lastError: null };

  constructor(deps: ReflectorDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  get health(): MemoryHealth {
    return { ...this.#health };
  }

  due(): boolean {
    const now = this.#now();
    if (this.#lastRunAt && now - this.#lastRunAt < REFLECT_COOLDOWN_MS) return false;
    const card = this.#d.store.card("");
    const fresh = this.#d.store.since("", card?.updatedAt ?? 0).length;
    if (!card && fresh >= FIRST_CARD_NOTES) return true;
    if (card && fresh >= NEW_NOTES_FOR_CARD) return true;
    return this.#d.store.undigestedBefore("", now - DIGEST_AFTER_MS).length > 0;
  }

  async run(): Promise<boolean> {
    const now = this.#now();
    this.#lastRunAt = now;
    const store = this.#d.store;
    const card = store.card("");
    const since = card?.updatedAt ?? 0;
    const fresh = store.since("", since).slice(-MAX_INPUT_NOTES);
    const weeks = new Map<string, Note[]>();
    for (const n of store.undigestedBefore("", now - DIGEST_AFTER_MS).slice(0, MAX_INPUT_NOTES)) {
      const p = weekPeriod(n.observedAt);
      weeks.set(p, [...(weeks.get(p) ?? []), n]);
    }
    const forgotten = this.#d.semantic.forgottenSince(since, "");
    const facts = this.#d.semantic.selectForPrompt("", "").slice(0, MAX_FACTS);
    const user = [
      "CURRENT CARD:",
      card?.text ?? "(none)",
      "",
      "FACTS:",
      facts.length > 0 ? facts.map((f) => `- ${f.key}: ${f.value}`).join("\n") : "(none)",
      "",
      `FORGOTTEN (never mention): ${forgotten.length > 0 ? forgotten.join(", ") : "(none)"}`,
      "",
      "NEW NOTES:",
      fresh.length > 0 ? fresh.map(line).join("\n") : "(none)",
      "",
      "WEEKS TO SUMMARIZE:",
      weeks.size > 0 ? [...weeks].map(([p, ns]) => `${p}:\n${ns.map((n) => `- ${line(n)}`).join("\n")}`).join("\n") : "(none)",
    ].join("\n");
    const system = [
      `You keep the memory of a personal assistant. Today is ${stamp(now)}.`,
      "Write two sections.",
      "=== CARD ===",
      "Who the user is and what matters to them now, at most 250 words, in the language of the notes.",
      "Stable things first (identity, work, preferences, people), then what is in progress.",
      "Keep exact names, numbers and dates. Drop what a newer note replaced. Never mention anything FORGOTTEN.",
      "=== DIGESTS ===",
      "One line per week listed under WEEKS TO SUMMARIZE, exactly: period | summary",
      "Each summary at most 60 words, keeping exact numbers, names and dates.",
    ].join("\n");
    const sessionId = "memory__reflector";
    let raw: string;
    try {
      const res = await this.#d.router.complete({
        sessionId,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        maxTokens: 1500,
        temperature: 0.2,
      });
      raw = res.content.trim();
    } catch (e) {
      return this.#fail(e instanceof Error ? e.message : String(e));
    } finally {
      this.#d.router.evictSession(sessionId);
    }
    const out = sections(raw);
    const newCard = out.card.slice(0, CARD_MAX_CHARS).trim();
    if (!newCard) return this.#fail("the model wrote no card");
    store.setCard("", newCard, now);
    // The week is found by the first date on the line, so "2026-09-14 to
    // 2026-09-20" or a backticked period still counts; an invented week does not.
    let folded = 0;
    for (const l of out.digests.split("\n")) {
      const bar = l.indexOf("|");
      if (bar < 0) continue;
      const first = l.slice(0, bar).match(/\d{4}-\d{2}-\d{2}/)?.[0];
      const period = first ? weekPeriod(Date.parse(first)) : "";
      const text = l.slice(bar + 1).trim();
      const ns = weeks.get(period);
      if (!ns || !text) continue;
      store.addDigest("", period, text, ns.map((n) => n.id), now);
      folded++;
    }
    // ponytail: a model that never writes digests is retried every 4 h (the
    // cooldown caps the cost); the reason is on the Memory page, not only here.
    if (weeks.size > 0 && folded === 0) return this.#fail("the model wrote the card but no weekly digest");
    this.#health = { lastOkAt: now, failures: 0, lastError: null };
    this.#d.log?.(`memory: reflected (${fresh.length} new notes, ${weeks.size} week(s) to digest)`);
    return true;
  }

  #fail(reason: string): false {
    this.#health = { ...this.#health, failures: this.#health.failures + 1, lastError: reason };
    this.#d.log?.(`memory: reflection failed: ${reason}`);
    return false;
  }
}

/** One idle-tick decision. Never during a turn, never before 10 min of quiet. */
export async function memoryIdleTick(d: {
  busy: boolean;
  idleMs: number;
  reindex: () => Promise<unknown>;
  reflector: Pick<Reflector, "due" | "run">;
}): Promise<"busy" | "not idle" | "nothing due" | "ran"> {
  if (d.busy) return "busy";
  if (d.idleMs < REFLECT_IDLE_MS) return "not idle";
  await d.reindex().catch(() => undefined);
  if (!d.reflector.due()) return "nothing due";
  await d.reflector.run();
  return "ran";
}
