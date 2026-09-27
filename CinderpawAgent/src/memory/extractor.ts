/**
 * Memory writer: after a conversation, one model call writes two things.
 *
 *   1. FACTS: durable facts about the user (name, role, preferences) as
 *      `category | key: value` lines → SemanticMemory, typed and versioned.
 *
 *   2. NOTES (the Observer): what a later conversation should know about this
 *      one, one dated sentence per line → ObservationStore. The notes are what
 *      the next conversation's "What you remember" block is built from
 *      (memory/snapshot.ts), and what the Reflector folds into the user card
 *      and weekly digests (memory/reflector.ts).
 *
 * It reads whole user messages and the agent's final answers, from where it
 * last stopped, and runs on the first exchange, every third one after, when
 * the conversation goes quiet, before compaction, and at shutdown, so no
 * exchange is left unread. It never blocks the user's turn.
 *
 * Spec: docs/superpowers/specs/2026-09-27-observational-memory-design.md
 */

import type { InferenceRouter } from "../egress/inference-router.ts";
import { memoryScope, asCategory, type FactCategory, type SemanticMemory } from "./semantic.ts";
import type { EpisodicMemory } from "./episodic.ts";
import type { ChatMessage, AfterMemoryWritePayload } from "../types.ts";
import type { MemoryGraph } from "./graph.ts";
import type { HookRegistry } from "../core/hook-registry.ts";
import type { ObservationStore, NotePriority } from "./observations.ts";

const USER_CHARS = 4000;
const ANSWER_CHARS = 1500;
const WINDOW_CHARS = 12_000;
const DUE_EXCHANGES = 3;
const DUE_CHARS = 6000;
const QUIET_MS = 5 * 60_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Whether memory writing works, for the Memory page: a stranger whose small
 *  model cannot follow the format must see why nothing is being remembered. */
export interface MemoryHealth {
  lastOkAt: number | null;
  failures: number;
  lastError: string | null;
}

export interface ParsedNote {
  priority: NotePriority;
  refDate: string | null;
  text: string;
}

const PRIORITY_WORDS: Record<string, NotePriority> = { high: "high", med: "med", medium: "med", low: "low" };

/** `priority | date | note` per line. A bad line is dropped, never guessed at. */
export function parseNotes(section: string): ParsedNote[] {
  const out: ParsedNote[] = [];
  for (const raw of section.split("\n")) {
    const parts = raw.trim().replace(/^[-*•]\s*/, "").split("|");
    if (parts.length < 3) continue;
    const priority = PRIORITY_WORDS[parts[0]!.trim().toLowerCase()];
    const date = parts[1]!.trim();
    const text = parts.slice(2).join("|").trim();
    if (!priority || !text || text.length > 500) continue;
    out.push({ priority, refDate: /^\d{4}-\d{2}(-\d{2})?$/.test(date) ? date : null, text });
  }
  return out;
}

/** `=== FACTS ===` and `=== NOTES ===`, in either order; no header = all facts. */
export function parseCombined(raw: string): { facts: string; notes: string } {
  const heads = [...raw.matchAll(/={2,}\s*(FACTS|NOTES)\s*={2,}/gi)];
  if (heads.length === 0) return { facts: raw.trim(), notes: "" };
  const out = { facts: "", notes: "" };
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.index! : raw.length;
    const body = raw.slice(h.index! + h[0].length, end).trim();
    if (h[1]!.toUpperCase() === "FACTS") out.facts = body;
    else out.notes = body;
  });
  return out;
}

/** The conversation as the Observer reads it: whole user messages (up to
 *  4000 chars), final answers (up to 1500), newest kept under 12000. */
export function observerTranscript(exchanges: readonly ChatMessage[]): string {
  const lines = exchanges.map(
    (m) => `${m.role}: ${m.content.slice(0, m.role === "user" ? USER_CHARS : ANSWER_CHARS)}`,
  );
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i]!.length + 1;
    if (total > WINDOW_CHARS && kept.length > 0) break;
    kept.unshift(lines[i]!);
  }
  return kept.join("\n");
}

function lastExchanges(conversation: ChatMessage[], n: number): ChatMessage[] {
  let first = conversation.length;
  for (let seen = 0; first > 0 && seen < n; ) {
    first--;
    if (conversation[first]!.role === "user") seen++;
  }
  return conversation.slice(first);
}

/**
 * What the Observer has not read yet: everything after the last exchange it
 * saw, found by that exchange's text rather than an index, because compaction
 * shrinks the transcript and an index would point at the wrong turn. Not found
 * (compacted away, or a restart) = the last three exchanges.
 * ponytail: two identical exchanges resolve to the later one; the notes the
 * Observer already wrote are in its prompt, which absorbs the repeat.
 */
export function unobserved(
  conversation: ChatMessage[],
  mark: { user: string; answer: string } | undefined,
): ChatMessage[] {
  if (mark) {
    for (let i = conversation.length - 2; i >= 0; i--) {
      if (
        conversation[i]!.role === "user" &&
        conversation[i]!.content === mark.user &&
        conversation[i + 1]?.content === mark.answer
      ) {
        return conversation.slice(i + 2);
      }
    }
  }
  return lastExchanges(conversation, DUE_EXCHANGES);
}

function todayWithWeekday(now: number): string {
  const d = new Date(now);
  return `${d.toISOString().slice(0, 10)} (${WEEKDAYS[d.getUTCDay()]})`;
}

function observerPrompt(now: number): string {
  return [
    `You write the memory of a personal assistant. Today is ${todayWithWeekday(now)}.`,
    "Read the conversation and write two sections.",
    "",
    "=== FACTS ===",
    "Durable facts about the USER (identity, role, preferences, decisions, goals, commitments).",
    "One per line: category | key: value",
    "category is one of: fact, preference, decision, commitment, goal, event, instruction, relationship, context, learning, observation, error, artifact",
    "Example: preference | units: metric",
    "If none: NONE",
    "",
    "=== NOTES ===",
    "What a later conversation should know about this one: plans, decisions, dates, numbers, names,",
    "what the user asked for, and what the assistant recommended or did.",
    "One per line: priority | date | note",
    "priority: high (commitments, deadlines, decisions), med, or low.",
    "date: the day the note is ABOUT as YYYY-MM-DD, or YYYY-MM, resolved against today",
    '("next Friday" becomes a real date), or - when it is about no particular day.',
    "Each note is one self-contained sentence with the exact numbers and names,",
    "in the language the user wrote in. Do not repeat the notes already written.",
    "Example: high | 2026-10-12 | Dentist moved to 12 Oct at 10:00, same clinic",
    "If nothing is worth keeping: NONE",
  ].join("\n");
}

/** A timer that never holds the process open on its own. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });
}

/**
 * What the extractor reads: what the user said and what the agent finally
 * answered, one pair per exchange, in order.
 *
 * It used to read the last six messages of the working transcript, which in
 * an agentic turn are tool calls and tool output: three tool calls and the
 * user's own message is out of the window, and "facts about the USER" get
 * mined from a file listing. The cadence counted assistant MESSAGES, and a
 * tool-calling turn adds one per call, so which turns were extracted at all
 * depended on how many tools they happened to use. Tool results, the
 * intermediate tool-calling messages, and the loop's own `(system: …)` nudges
 * (which are sent in the user role) are none of them the person talking.
 */
export function conversationForExtraction(turns: readonly ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let answer: ChatMessage | null = null;
  for (const m of turns) {
    if (m.role === "user") {
      if (m.content.trimStart().startsWith("(system:")) continue;
      if (answer) out.push(answer);
      answer = null;
      out.push(m);
    } else if (m.role === "assistant" && m.content.trim()) {
      // The last assistant message before the next user message is the answer.
      answer = m;
    }
  }
  if (answer) out.push(answer);
  return out;
}

export class MemoryExtractor {
  readonly #router: InferenceRouter;
  readonly #semantic: SemanticMemory;
  readonly #hooks: HookRegistry | null;
  readonly #running = new Set<string>();
  readonly #queue: { sessionId: string; turns: ChatMessage[]; force: boolean }[] = [];
  #isIdle: () => boolean = () => true;
  #processing = false;
  #graph: MemoryGraph | null = null;
  #notes: ObservationStore | null = null;
  #now: () => number = Date.now;
  #quietMs = QUIET_MS;
  /** Per session: the last exchange the Observer read (see `unobserved`). */
  readonly #marks = new Map<string, { user: string; answer: string }>();
  readonly #lastTurns = new Map<string, ChatMessage[]>();
  readonly #quiet = new Map<string, ReturnType<typeof setTimeout>>();
  #health: MemoryHealth = { lastOkAt: null, failures: 0, lastError: null };

  constructor(
    router: InferenceRouter,
    semantic: SemanticMemory,
    // ponytail: unused since notes moved to ObservationStore; kept so the
    // constructor's callers need no change.
    _episodic?: EpisodicMemory,
    hooks?: HookRegistry | null,
  ) {
    this.#router = router;
    this.#semantic = semantic;
    this.#hooks = hooks ?? null;
  }

  setIdleChecker(checker: () => boolean) {
    this.#isIdle = checker;
  }

  setGraph(graph: MemoryGraph): void {
    this.#graph = graph;
  }

  /** Where notes go. Without a store the FACTS half still runs and notes are dropped. */
  setObservationStore(store: ObservationStore, opts: { now?: () => number; quietMs?: number } = {}): void {
    this.#notes = store;
    if (opts.now) this.#now = opts.now;
    if (opts.quietMs !== undefined) this.#quietMs = opts.quietMs;
  }

  /** Last success, consecutive failures and why, for the Memory page. */
  get health(): MemoryHealth {
    return { ...this.#health };
  }

  extractAsync(sessionId: string, recentTurns: ChatMessage[]): void {
    if (recentTurns.length < 2) return;
    this.#lastTurns.set(sessionId, recentTurns);
    this.#enqueue(sessionId, recentTurns, false);
    this.#armQuiet(sessionId);
    this.runPending();
  }

  /**
   * Observe now, whatever the cadence says: before compaction summarises the
   * exchanges away, and when a conversation has gone quiet. Without the quiet
   * flush the second exchange of a two-exchange chat was never read.
   */
  observeNow(sessionId: string, turns?: ChatMessage[]): void {
    const t = turns ?? this.#lastTurns.get(sessionId);
    if (!t || t.length < 2) return;
    this.#enqueue(sessionId, t, true);
    this.runPending();
  }

  #enqueue(sessionId: string, turns: ChatMessage[], force: boolean): void {
    // A forced item holds turns that may be about to be compacted away; a
    // later ordinary item must not overwrite them, so it queues behind.
    const existing = this.#queue.find((q) => q.sessionId === sessionId && !q.force);
    if (existing && !force) existing.turns = turns;
    else this.#queue.push({ sessionId, turns: [...turns], force });
  }

  #armQuiet(sessionId: string): void {
    const prev = this.#quiet.get(sessionId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.#quiet.delete(sessionId);
      this.observeNow(sessionId);
    }, this.#quietMs);
    (t as { unref?: () => void }).unref?.();
    this.#quiet.set(sessionId, t);
  }

  /**
   * Write what is still queued, NOW, before the process goes away.
   *
   * Extraction is deliberately lazy: it waits for the agent to be idle so it
   * never competes with a user's turn. That is right for a long-lived desktop
   * session and wrong for every process with a short life, which is most of
   * them — a cron job, a connector reply, and above all a benchmark task,
   * where the runner sends `shutdown` seconds after the turn ends.
   *
   * Every queued item is forced: shutdown means write what is unwritten, not
   * wait for the third exchange. The old drain applied the cadence here too,
   * so a second exchange queued at shutdown was dropped on the way out.
   *
   * Bounded on purpose. A shutdown that hangs is worse than a lost lesson —
   * the caller kills the process anyway — so this returns when the queue is
   * empty OR when the deadline passes, whichever comes first, and says which.
   */
  async drain(timeoutMs = 8000): Promise<{ written: number; pending: number }> {
    if (timeoutMs <= 0) return { written: 0, pending: this.#queue.length };
    const deadline = Date.now() + timeoutMs;
    let written = 0;
    let expired = false;

    // Ignores the idle check by design: shutdown means nothing else is
    // running, so the reason to wait no longer exists.
    while (this.#queue.length > 0 && !expired && Date.now() < deadline) {
      const item = this.#queue.shift();
      if (!item || this.#running.has(item.sessionId)) continue;
      this.#running.add(item.sessionId);
      try {
        // The deadline has to bound the MODEL CALL, not just the gap between
        // items. Checking it only between extractions leaves a single hung
        // completion able to hold the process open for ever, which is the
        // exact failure this budget exists to prevent.
        const done = await Promise.race([
          this.#extract(item.sessionId, item.turns, true).then(() => true as const),
          sleep(Math.max(0, deadline - Date.now())).then(() => false as const),
        ]);
        if (done) written++;
        else {
          // Put it back: unwritten, and honestly reported as such rather than
          // silently dropped on the way out.
          expired = true;
          this.#queue.unshift(item);
        }
      } catch {
        // A failed extraction must never hold up shutdown.
      } finally {
        this.#running.delete(item.sessionId);
      }
    }
    return { written, pending: this.#queue.length };
  }

  async runPending(): Promise<void> {
    if (this.#processing) return;
    if (!this.#isIdle()) return;

    this.#processing = true;
    try {
      while (this.#queue.length > 0 && this.#isIdle()) {
        const item = this.#queue.shift();
        if (!item) break;

        if (this.#running.has(item.sessionId)) continue;

        this.#running.add(item.sessionId);
        try {
          await this.#extract(item.sessionId, item.turns, item.force);
        } finally {
          this.#running.delete(item.sessionId);
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #extract(sessionId: string, turns: ChatMessage[], force: boolean): Promise<void> {
    const conversation = conversationForExtraction(turns);
    const totalExchanges = conversation.filter((m) => m.role === "user").length;
    if (totalExchanges === 0 || !conversation.some((m) => m.role === "assistant")) return;
    const fresh = unobserved(conversation, this.#marks.get(sessionId));
    const freshExchanges = fresh.filter((m) => m.role === "user").length;
    if (freshExchanges === 0) return;
    const freshChars = fresh.reduce((n, m) => n + m.content.length, 0);
    const due = force || totalExchanges === 1 || freshExchanges >= DUE_EXCHANGES || freshChars >= DUE_CHARS;
    if (!due) return;
    const ok = await this.#observe(sessionId, observerTranscript(fresh));
    if (!ok) return; // a failed call is retried on the next turn
    let lastUser = -1;
    for (let i = fresh.length - 1; i >= 0; i--) {
      if (fresh[i]!.role === "user") {
        lastUser = i;
        break;
      }
    }
    this.#marks.set(sessionId, { user: fresh[lastUser]!.content, answer: fresh[lastUser + 1]?.content ?? "" });
  }

  /**
   * One model call; false when the call or the write failed, so the same
   * exchanges are read again next time. Never throws: a memory write must not
   * cost a turn, and extractAsync does not await it.
   */
  async #observe(sessionId: string, transcript: string): Promise<boolean> {
    const extractionSessionId = `${sessionId}__extraction`;
    const now = this.#now();
    let content: string;
    try {
      const already = this.#notes?.forSession(sessionId, 10) ?? [];
      const user = [
        "Notes already written for this conversation:",
        already.length > 0 ? already.map((n) => `- ${n.text}`).join("\n") : "(none)",
        "",
        "Conversation:",
        transcript,
      ].join("\n");
      const res = await this.#router.complete({
        sessionId: extractionSessionId,
        messages: [
          { role: "system", content: observerPrompt(now) },
          { role: "user", content: user },
        ],
        maxTokens: 600,
        temperature: 0.1,
      });
      content = res.content.trim();
    } catch (e) {
      this.#fail(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      try {
        this.#router.evictSession(extractionSessionId);
      } catch {
        // Nothing to evict is not a reason to lose what was just written.
      }
    }
    try {
      return await this.#store(sessionId, content, now);
    } catch (e) {
      this.#fail(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async #store(sessionId: string, content: string, now: number): Promise<boolean> {
    const sections = parseCombined(content);
    try {
      await this.#writeFacts(sessionId, sections.facts);
    } catch {
      // A fact that could not be stored must not cost the notes.
    }
    const notesText = sections.notes.trim();
    if (!notesText || notesText.toUpperCase() === "NONE") {
      this.#ok(now);
      return true;
    }
    const parsed = parseNotes(notesText);
    if (parsed.length === 0) {
      this.#fail("the model did not write notes in the expected format");
      return true;
    }
    const scope = memoryScope(sessionId);
    for (const n of parsed) {
      this.#notes?.add({ sessionId, scope, observedAt: now, refDate: n.refDate, priority: n.priority, text: n.text });
      await this.#fireMemoryWrite({
        kind: "observation",
        sessionId,
        ts: now,
        obsType: n.priority,
        title: n.text.slice(0, 80),
        concepts: [],
      });
    }
    this.#ok(now);
    return true;
  }

  #ok(now: number): void {
    this.#health = { lastOkAt: now, failures: 0, lastError: null };
  }

  #fail(reason: string): void {
    this.#health = { ...this.#health, failures: this.#health.failures + 1, lastError: reason };
  }

  async #writeFacts(sessionId: string, factsText: string): Promise<void> {
    if (factsText && factsText.toUpperCase() !== "NONE") {
      const graphFacts: Array<{ key: string; value: string }> = [];
      for (const line of factsText.split("\n")) {
        const split = splitFactLine(line);
        if (!split) continue;
        const fact = sanitizeFact(split.rawKey, split.rawValue);
        if (fact) {
          // Scoped to the speaker on a multi-party session, global
          // everywhere else — mined facts leak the same way explicit ones
          // do. See `memoryScope`.
          this.#semantic.upsert(fact.key, fact.value, memoryScope(sessionId), fact.category);
          graphFacts.push(fact);
          // Fire after_memory_write ONCE per fact write — the
          // Reconciler (Pathway 3 step 2) subscribes to upsert into
          // the fractal tree. Awaited so the hook completes before
          // the extraction loop moves on; the registry contract
          // guarantees handlers never throw.
          await this.#fireMemoryWrite({
            kind: "fact",
            sessionId,
            ts: Date.now(),
            key: fact.key,
            value: fact.value,
          });
        }
      }
      // The graph has no scopes: every edge in it is rendered into every
      // session's recall. A guest speaker's facts are scoped in
      // SemanticMemory precisely so they never reach anyone else ("call me
      // Alex" from one guild member must not make everyone Alex), and
      // mirroring them here put them straight back in front of the owner
      // and every other member. Only the owner's global facts go in.
      if (this.#graph && graphFacts.length > 0 && memoryScope(sessionId) === "") {
        for (const { key, value } of graphFacts) {
          // One value per key, as in SemanticMemory: a new value replaces.
          this.#graph.setFact(key, "has", value);
        }
        this.#graph.persist();
      }
    }
  }

  /**
   * Fire `after_memory_write` to the registry, if one is attached. No-op
   * when the extractor was constructed without a HookRegistry (the
   * pathway-3-step-1 substrate was hook-less). The registry's own
   * fire() catches handler errors so this method never rejects — keeping
   * the extraction pipeline resilient exactly like the rest of the
   * memory write path.
   */
  async #fireMemoryWrite(payload: AfterMemoryWritePayload): Promise<void> {
    if (!this.#hooks) return;
    await this.#hooks.fire("after_memory_write", payload);
  }
}

/** Keys that are conversation roles / prompt scaffolding, never user facts. */
const FACT_KEY_BLOCKLIST = new Set([
  "user", "assistant", "model", "bot", "system", "nick", "observation",
  "facts", "type", "title", "concepts", "none", "skip",
]);

/**
 * Is this (already-lowercased, trimmed) key unusable as a fact name?
 * Shared by the extraction-time sanitizer and the boot-time hygiene sweep
 * so junk that ever reached the store gets removed by the same rules that
 * prevent new junk from being written.
 */
export function isJunkFactKey(key: string): boolean {
  if (!key) return true;
  if (FACT_KEY_BLOCKLIST.has(key)) return true;
  if (key.length > 40) return true;
  // List markers / numbering leaked from the model's bullet output.
  if (/^[-*•]/.test(key) || /^\d+[.)]/.test(key)) return true;
  // Sentence-shaped keys are reasoning leakage, not fact names.
  if (key.split(/\s+/).length > 4) return true;
  // Quotes, markup, or JSON fragments in the key mean a malformed line.
  if (/["'<>{}()`\\]/.test(key)) return true;
  return false;
}

/**
 * Validate and normalize one extracted `key: value` fact line.
 *
 * Local models leak reasoning text, markdown bullets, and Windows paths into
 * the facts output; the old colon-split stored keys like "- language",
 * "1. user shared a link", "we need to produce final answer", and
 * "the user has a project at `d" (path split at the drive-letter colon).
 * Those keys are unguessable, so any future tool that targets a fact by key
 * would never hit them and the graph would fill with junk nodes — hence the
 * aggressive sanitation here.
 *
 * Returns the cleaned fact, or null when the line is not a usable fact.
 */
/**
 * One FACTS line → its raw key and value. The colon we split on is the first
 * one, exactly as before; the category, when present, sits before a pipe
 * that is itself before that colon, so a pipe inside the value is left alone.
 */
export function splitFactLine(line: string): { rawKey: string; rawValue: string } | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  return { rawKey: line.slice(0, colon), rawValue: line.slice(colon + 1) };
}

export function sanitizeFact(
  rawKey: string,
  rawValue: string,
): { key: string; value: string; category: FactCategory } | null {
  // `category | key`: the category is whatever stands before the pipe, if it
  // is one of ours. An unknown word there is not promoted to a category, and
  // the old bare `key` form is a `fact`, which is what it always was.
  let category: FactCategory = "fact";
  const pipe = rawKey.indexOf("|");
  if (pipe !== -1) {
    category = asCategory(rawKey.slice(0, pipe));
    rawKey = rawKey.slice(pipe + 1);
  }
  // Strip markdown list markers and numbering from the key.
  const key = rawKey
    .trim()
    .replace(/^[-*•]\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim()
    .toLowerCase();
  const value = rawValue.trim();

  if (!value || isJunkFactKey(key)) return null;
  const canonicalKey = canonicalFactKey(key);
  if (value.length > 300) return null;
  // A value starting with a path separator means the colon we split on was
  // a Windows drive letter ("...at c:\Users\...") — the line is not a fact.
  if (/^[\\/]/.test(value)) return null;
  // Thinking markup in the value is model leakage.
  if (/<\/?think/i.test(value)) return null;

  return { key: canonicalKey, value, category };
}

/**
 * Collapse synonym keys onto one canonical name.
 *
 * `SemanticMemory.upsert` dedupes on the PRIMARY KEY, so a re-stated fact
 * correctly overwrites — but only when the key matches exactly. The extractor
 * is a language model: it writes `project path` one session and
 * `project directory` the next, so a user who moves their repo ends up with
 * BOTH rows, both recent, both rendered into the prompt. The model is then
 * handed two contradictory facts with equal authority. Deduping the storage
 * layer was never the missing piece; agreeing on the key was.
 *
 * ponytail: a fixed table, not embeddings. Whitespace→underscore alone kills
 * roughly half the collisions; the table handles the identity/location/path
 * families that actually recur. If contradictions show up on a key that is
 * not here, add a row — semantic clustering over the fact keys would be more
 * code than the layer it protects.
 */
/**
 * Every alias maps onto the name ALREADY in use (`name`, `language`, …)
 * rather than a prettier one. Canonicalising away from the incumbent would
 * orphan every fact already on disk under the old key — a migration, not a
 * dedup — and the point here is to stop contradictions, not to rename them.
 */
const FACT_KEY_ALIASES: Readonly<Record<string, string>> = {
  "user name": "name",
  "users name": "name",
  "user's name": "name",
  "full name": "name",
  "project path": "project_dir",
  "project directory": "project_dir",
  "project folder": "project_dir",
  "project root": "project_dir",
  "working directory": "project_dir",
  "repo path": "project_dir",
  "city": "location",
  "lives in": "location",
  "based in": "location",
  "speaks": "language",
  "spoken language": "language",
  "preferred language": "language",
  "job": "occupation",
  "role": "occupation",
  "profession": "occupation",
};

/** Canonical storage key for an already-lowercased, sanitized fact name. */
export function canonicalFactKey(key: string): string {
  const alias = FACT_KEY_ALIASES[key];
  if (alias) return alias;
  // `project dir` and `project_dir` must not be two different facts.
  return key.replace(/\s+/g, "_");
}
