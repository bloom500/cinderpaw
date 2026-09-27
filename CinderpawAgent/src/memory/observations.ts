/**
 * Observational memory's store: the dated notes the Observer writes after a
 * conversation, the Reflector's weekly digests of them, and the user card.
 *
 * Separate from `episodic` on purpose. `episodic` is what was SAID, verbatim;
 * this is what is worth REMEMBERING about it, one sentence per note, with the
 * date it is about. The extractor used to write these into `episodic` as
 * `[obs:…]` rows with role `assistant`; `importLegacyNotes` moves them here.
 *
 * Nothing here calls a model.
 * Spec: docs/superpowers/specs/2026-09-27-observational-memory-design.md
 */
import type { Database } from "bun:sqlite";
import { memoryScope } from "./semantic.ts";

export type NotePriority = "high" | "med" | "low";
export type NoteSource = "observer" | "reflector" | "import";

export interface Note {
  id: number;
  sessionId: string;
  scope: string;
  observedAt: number;
  /** The day or month the note is ABOUT (`YYYY-MM-DD` / `YYYY-MM`), if any. */
  refDate: string | null;
  priority: NotePriority;
  text: string;
  source: NoteSource;
  /** For a digest: the week it stands for, `YYYY-MM-DD..YYYY-MM-DD`. */
  period: string | null;
  /** On a note a digest now stands for: out of the snapshot, still listed. */
  digestedAt: number | null;
}

interface Row {
  id: number;
  session_id: string;
  scope: string;
  observed_at: number;
  ref_date: string | null;
  priority: string;
  text: string;
  source: string;
  period: string | null;
  digested_at: number | null;
}

const COLS = "id, session_id, scope, observed_at, ref_date, priority, text, source, period, digested_at";
const DAY = 86_400_000;

function fromRow(r: Row): Note {
  return {
    id: r.id,
    sessionId: r.session_id,
    scope: r.scope,
    observedAt: r.observed_at,
    refDate: r.ref_date,
    priority: r.priority === "high" || r.priority === "low" ? r.priority : "med",
    text: r.text,
    source: r.source === "reflector" || r.source === "import" ? r.source : "observer",
    period: r.period,
    digestedAt: r.digested_at,
  };
}

/** Monday..Sunday (UTC) of the week `ts` falls in, as `YYYY-MM-DD..YYYY-MM-DD`. */
export function weekPeriod(ts: number): string {
  const d = new Date(ts);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return `${iso(monday)}..${iso(monday + 6 * DAY)}`;
}

/** [start, end) in ms for a `weekPeriod` string. */
function periodRange(period: string): [number, number] {
  const start = Date.parse(`${period.slice(0, 10)}T00:00:00Z`);
  return [start, start + 7 * DAY];
}

export class ObservationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  add(n: {
    sessionId: string;
    scope: string;
    observedAt: number;
    refDate: string | null;
    priority: NotePriority;
    text: string;
    source?: NoteSource;
    period?: string | null;
  }): number {
    const r = this.#db
      .query(
        `INSERT INTO observations (session_id, scope, observed_at, ref_date, priority, text, source, period)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(n.sessionId, n.scope, n.observedAt, n.refDate, n.priority, n.text, n.source ?? "observer", n.period ?? null);
    return Number(r.lastInsertRowid);
  }

  /** This conversation's latest notes, oldest first: the Observer reads them so it does not repeat itself. */
  forSession(sessionId: string, limit = 10): Note[] {
    return this.#db
      .query<Row, [string, number]>(
        `SELECT ${COLS} FROM (
           SELECT ${COLS} FROM observations
           WHERE session_id = ? AND source != 'reflector'
           ORDER BY observed_at DESC, id DESC LIMIT ?)
         ORDER BY observed_at, id`,
      )
      .all(sessionId, limit)
      .map(fromRow);
  }

  /** Undigested notes (not digests) for `scope`, newest first, one session left out. */
  recent(scope: string, opts: { excludeSessionId?: string; limit?: number } = {}): Note[] {
    const ex = opts.excludeSessionId ?? null;
    return this.#db
      .query<Row, [string, string | null, string | null, number]>(
        `SELECT ${COLS} FROM observations
         WHERE scope = ? AND source != 'reflector' AND digested_at IS NULL
           AND (? IS NULL OR session_id != ?)
         ORDER BY observed_at DESC, id DESC LIMIT ?`,
      )
      .all(scope, ex, ex, opts.limit ?? 200)
      .map(fromRow);
  }

  /** The Reflector's digests for `scope`, newest week first. */
  digests(scope: string, limit = 20): Note[] {
    return this.#db
      .query<Row, [string, number]>(
        `SELECT ${COLS} FROM observations
         WHERE scope = ? AND source = 'reflector'
         ORDER BY period DESC, id DESC LIMIT ?`,
      )
      .all(scope, limit)
      .map(fromRow);
  }

  /** Notes (not digests) observed after `ts`, oldest first. */
  since(scope: string, ts: number): Note[] {
    return this.#db
      .query<Row, [string, number]>(
        `SELECT ${COLS} FROM observations
         WHERE scope = ? AND source != 'reflector' AND observed_at > ?
         ORDER BY observed_at, id`,
      )
      .all(scope, ts)
      .map(fromRow);
  }

  /** Undigested notes observed before `ts`, oldest first: what the Reflector folds into weeks. */
  undigestedBefore(scope: string, ts: number): Note[] {
    return this.#db
      .query<Row, [string, number]>(
        `SELECT ${COLS} FROM observations
         WHERE scope = ? AND source != 'reflector' AND digested_at IS NULL AND observed_at < ?
         ORDER BY observed_at, id`,
      )
      .all(scope, ts)
      .map(fromRow);
  }

  /** One digest for `period`; the notes it stands for leave the snapshot but stay listed. */
  addDigest(scope: string, period: string, text: string, noteIds: number[], at: number): number {
    let id = 0;
    this.#db.transaction(() => {
      id = this.add({
        sessionId: "reflector",
        scope,
        observedAt: at,
        refDate: null,
        priority: "med",
        text,
        source: "reflector",
        period,
      });
      const mark = this.#db.query("UPDATE observations SET digested_at = ? WHERE id = ? AND scope = ?");
      for (const n of noteIds) mark.run(at, n, scope);
    })();
    return id;
  }

  /** Everything, digests included, newest first: the Memory page's list. */
  list(scope: string, limit = 200): Note[] {
    return this.#db
      .query<Row, [string, number]>(
        `SELECT ${COLS} FROM observations WHERE scope = ? ORDER BY observed_at DESC, id DESC LIMIT ?`,
      )
      .all(scope, limit)
      .map(fromRow);
  }

  count(scope: string): number {
    const r = this.#db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM observations WHERE scope = ?")
      .get(scope);
    return r?.n ?? 0;
  }

  /**
   * Delete one note of `scope`. A note inside a digested week takes that
   * week's digest with it and returns the rest of the week to undigested, so
   * the Reflector rebuilds the digest without it; otherwise the digest would
   * keep saying what the user just deleted. Deleting a digest does the same.
   */
  delete(id: number, scope: string): Note | null {
    const row = this.#db
      .query<Row, [number, string]>(`SELECT ${COLS} FROM observations WHERE id = ? AND scope = ?`)
      .get(id, scope);
    if (!row) return null;
    const n = fromRow(row);
    this.#db.transaction(() => {
      this.#db.query("DELETE FROM observations WHERE id = ?").run(id);
      const period = n.source === "reflector" ? n.period : n.digestedAt !== null ? weekPeriod(n.observedAt) : null;
      if (!period) return;
      const [start, end] = periodRange(period);
      this.#db
        .query("DELETE FROM observations WHERE scope = ? AND source = 'reflector' AND period = ?")
        .run(scope, period);
      this.#db
        .query(
          `UPDATE observations SET digested_at = NULL
           WHERE scope = ? AND source != 'reflector' AND observed_at >= ? AND observed_at < ?`,
        )
        .run(scope, start, end);
    })();
    return n;
  }

  /** Delete every note (never a digest) whose text contains all `words`, ignoring case. */
  deleteMatching(scope: string, words: string[]): Note[] {
    const ws = words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0);
    if (ws.length === 0) return [];
    // ponytail: a scan, not FTS. A person has thousands of notes, not millions.
    const hits = this.list(scope, 100_000).filter(
      (n) => n.source !== "reflector" && ws.every((w) => n.text.toLowerCase().includes(w)),
    );
    for (const n of hits) this.delete(n.id, scope);
    return hits;
  }

  card(scope: string): { text: string; updatedAt: number } | null {
    const r = this.#db
      .query<{ text: string; updated_at: number }, [string]>("SELECT text, updated_at FROM memory_card WHERE scope = ?")
      .get(scope);
    return r ? { text: r.text, updatedAt: r.updated_at } : null;
  }

  setCard(scope: string, text: string, at: number): void {
    this.#db
      .query(
        `INSERT INTO memory_card (scope, text, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
      )
      .run(scope, text, at);
  }

  dropCard(scope: string): void {
    this.#db.query("DELETE FROM memory_card WHERE scope = ?").run(scope);
  }
}

/** `[obs:decision] Title\n  • a\n  • b\n  concepts: x` → `Title: a; b`. */
export function legacyNoteText(content: string): string {
  const lines = content.split("\n");
  const title = (lines[0] ?? "").replace(/^\[obs:[^\]]*\]\s*/, "").trim();
  const facts = lines
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("•"))
    .map((l) => l.slice(1).trim())
    .filter(Boolean);
  return facts.length > 0 ? `${title}: ${facts.join("; ")}` : title;
}

/**
 * One-time move of the extractor's old `[obs:<type>]` rows out of `episodic`.
 * Idempotent: once moved there is nothing left to match. The `[obs:%` filter
 * in `EpisodicMemory.conversation` stays as a guard for a row an older build
 * writes after this ran.
 */
export function importLegacyNotes(db: Database): number {
  const rows = db
    .query<{ id: number; session_id: string; timestamp: number; content: string }, []>(
      "SELECT id, session_id, timestamp, content FROM episodic WHERE content LIKE '[obs:%'",
    )
    .all();
  if (rows.length === 0) return 0;
  const ins = db.query(
    `INSERT INTO observations (session_id, scope, observed_at, priority, text, source)
     VALUES (?, ?, ?, 'low', ?, 'import')`,
  );
  const del = db.query("DELETE FROM episodic WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      ins.run(r.session_id, memoryScope(r.session_id), r.timestamp, legacyNoteText(r.content));
      del.run(r.id);
    }
  })();
  return rows.length;
}
