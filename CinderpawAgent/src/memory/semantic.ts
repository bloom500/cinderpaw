/**
 * Semantic memory — the persistent model of the user.
 *
 * Stores key-value facts the agent extracts from conversation: preferences,
 * occupation, recurring topics, communication style, constraints. Unlike
 * episodic (what happened), semantic is what the agent *knows* — durable
 * beliefs that survive session boundaries and inform every future interaction.
 *
 * V1: agent writes facts explicitly via `upsert`; reading integrates into
 * recall. V2: automatic extraction via LLM summarization pass after sessions.
 */

import type { Database } from "bun:sqlite";
import type { AuditLogger } from "../types.ts";
import { redactPII, piiRedactionEnabled } from "./privacy.ts";
import { encryptField, decryptField } from "../egress/field-crypto.ts";

/**
 * What kind of thing a fact is. Memanto's thirteen, adopted as they are: a
 * closed set so a query can ask for "every commitment" and get exactly those,
 * and so a category the extractor invents is never stored.
 */
export const FACT_CATEGORIES = [
  "fact",
  "preference",
  "decision",
  "commitment",
  "goal",
  "event",
  "instruction",
  "relationship",
  "context",
  "learning",
  "observation",
  "error",
  "artifact",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

/** The category if it is one of ours, else `fact`. Never a guess from text. */
export function asCategory(raw: string | undefined): FactCategory {
  const c = (raw ?? "").trim().toLowerCase();
  return (FACT_CATEGORIES as readonly string[]).includes(c) ? (c as FactCategory) : "fact";
}

export interface SemanticFact {
  key: string;
  value: string;
  updatedAt: number;
  category: FactCategory;
}

/** One value a fact held, and for how long. `validTo` null = still current. */
export interface FactVersion {
  id: number;
  key: string;
  value: string;
  category: FactCategory;
  validFrom: number;
  validTo: number | null;
  supersededBy: number | null;
}

interface HistRow {
  id: number;
  key: string;
  value: string;
  category: string;
  valid_from: number;
  valid_to: number | null;
  superseded_by: number | null;
}

function fromHist(r: HistRow): FactVersion {
  return {
    id: r.id,
    key: stripScope(r.key),
    value: decryptField(r.value),
    category: asCategory(r.category),
    validFrom: r.valid_from,
    validTo: r.valid_to,
    supersededBy: r.superseded_by,
  };
}

/**
 * The scope merge every reader shares: with no scope, every row; with one,
 * that identity's rows plus the global ones, the scoped row shadowing a
 * global one with the same key. Two passes so the scoped row always wins,
 * regardless of the order rows arrive in.
 */
function mergeScoped<T extends { key: string }>(rows: Array<T & { storedKey: string }>, scope: string): T[] {
  // Unscoped is the maintenance view (boot cleanup, fractal migration): it
  // sees every row under its STORAGE key, prefix included, so a scoped row
  // never masquerades as the owner's.
  if (!scope) return rows.map(({ storedKey, ...r }) => ({ ...r, key: storedKey }) as unknown as T);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const pass of [scope, ""]) {
    for (const r of rows) {
      if (scopeOf(r.storedKey) !== pass) continue;
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      const { storedKey: _s, ...rest } = r;
      out.push(rest as unknown as T);
    }
  }
  return out;
}

/**
 * Separator between a fact's scope and its key inside the `key` column.
 * A unit separator can never appear in a key the agent writes (keys are
 * slugs), so scoped and global rows can share one PRIMARY KEY column and no
 * table rebuild is needed.
 *
 * ponytail: a real `scope` column with UNIQUE(scope, key) is the textbook
 * shape, but SQLite cannot change a PRIMARY KEY without rewriting the table,
 * and this store already holds every user's history. Upgrade path if scope
 * ever needs its own index: rebuild `semantic` in a migration and split the
 * prefix out then — `scopeOf`/`stripScope` below are the only readers.
 */
const SCOPE_SEP = "";

/**
 * The identity a fact belongs to, derived from the session writing it.
 *
 * Empty string = the owner's global memory: the desktop app, the TUI, cron —
 * every surface where "the user" is one person. That is the default, so
 * nothing about single-user Cinderpaw changes.
 *
 * A Discord session names a channel AND a speaker, and a channel can hold
 * many speakers. Without this, "call me Alex" from one member of a guild
 * channel became a global fact and the agent called everyone Alex. Facts
 * written from such a session are scoped to the speaker; reads see their own
 * facts plus the global ones, never another user's.
 *
 * WhatsApp is genuinely one-session-per-person (the JID *is* the sender), so
 * it needs no scope here. Its separate problem — a public lead's facts being
 * mined into memory at all — is fixed upstream in the agent loop, which does
 * not run the extractor for restricted-profile sessions.
 */
/**
 * The transports whose session is `<transport>:<room>:<speaker>`: a room can
 * hold many speakers, so a fact is the speaker's, not the owner's. Named one
 * by one rather than "any three-segment id", because `subagent:<parent>:<id>`
 * is three segments on the owner's side. WhatsApp, Signal and Nostr are one
 * session per person and stay off this list.
 */
export const ROOM_KEYED_TRANSPORTS: ReadonlySet<string> = new Set([
  "discord", "slack", "telegram", "matrix", "mattermost", "feishu", "irc",
  "nextcloud-talk", "twitch", "zalo",
]);

export function memoryScope(sessionId: string): string {
  const [transport, , userId] = sessionId.split(":");
  // `<transport>:<room>:<user>` (plus `discord:dm:<user>`, where the speaker is
  // still last). A legacy two-segment session has no speaker and stays global.
  if (!transport || !ROOM_KEYED_TRANSPORTS.has(transport)) return "";
  if (!userId) return "";
  // The owner speaking from a chat app is still the owner. Without this their
  // own facts were scoped like a guest's, and a scoped fact shadows the global
  // one, so a change made on the desktop never reached Discord.
  if (chatOwners.get(transport) === userId) return "";
  return speakerScope(transport, userId);
}

/** The scope a guest's facts live under. One spelling, for writers and for promotion. */
export function speakerScope(transport: string, userId: string): string {
  return `${transport}/${userId}`;
}

/**
 * Who the owner is on each room-keyed transport, set from the connector config
 * (see `soleAllowlisted` in transports/connectors.ts). Process-wide on purpose:
 * `memoryScope` is a plain function with six callers, and threading the config
 * through each of them would be six places to forget it.
 */
const chatOwners = new Map<string, string>();

export function setChatOwner(transport: string, userId: string | null): void {
  if (userId) chatOwners.set(transport, userId);
  else chatOwners.delete(transport);
}

/** Storage key for `key` under `scope`. Global scope stores the bare key. */
function scopedKey(scope: string, key: string): string {
  return scope ? `${scope}${SCOPE_SEP}${key}` : key;
}

/** The scope half of a storage key ("" when the row is global). */
function scopeOf(storedKey: string): string {
  const at = storedKey.indexOf(SCOPE_SEP);
  return at === -1 ? "" : storedKey.slice(0, at);
}

/** The agent-visible key half of a storage key. */
function stripScope(storedKey: string): string {
  const at = storedKey.indexOf(SCOPE_SEP);
  return at === -1 ? storedKey : storedKey.slice(at + 1);
}

export class SemanticMemory {
  readonly #db: Database;
  readonly #audit: AuditLogger;
  readonly #upsert: ReturnType<Database["query"]>;

  constructor(db: Database, audit: AuditLogger) {
    this.#db = db;
    this.#audit = audit;
    this.#upsert = db.query(`
      INSERT INTO semantic (key, value, updated_at, category)
      VALUES ($key, $value, $updatedAt, $category)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        category = excluded.category
    `);
  }

  /**
   * Write or overwrite a single fact about the user. High-confidence PII in the
   * value (card / IBAN / CNP / email / phone) is redacted before persistence
   * (M-2) so durable memory never silently retains it. Disable with
   * `CINDERPAW_PII_REDACTION=off`.
   */
  upsert(key: string, value: string, scope = "", category: FactCategory = "fact", now = Date.now()): void {
    if (!key.trim()) return;
    const cat = asCategory(category);
    let storedValue = value;
    let redactions = 0;
    if (piiRedactionEnabled()) {
      const r = redactPII(value);
      storedValue = r.text;
      redactions = r.redactions;
    }
    const storedKey = scopedKey(scope, key.trim().toLowerCase());
    // Encrypt at rest (H-1). No-op when no key is provisioned.
    const stored = encryptField(storedValue);
    try {
      // The current row and its history move together or not at all.
      this.#db.transaction(() => {
        const prev = this.#db
          .query<{ value: string }, [string]>("SELECT value FROM semantic WHERE key = ?")
          .get(storedKey);
        // Re-stating the same value moves `updated_at` and nothing else: a
        // history row per repetition would make every "still true" a change.
        const changed = !prev || decryptField(prev.value) !== storedValue;
        this.#upsert.run({ $key: storedKey, $value: stored, $updatedAt: now, $category: cat });
        if (!changed) return;
        const open = this.#db
          .query<{ id: number }, [string]>(
            "SELECT id FROM semantic_history WHERE key = ? AND valid_to IS NULL ORDER BY id DESC LIMIT 1",
          )
          .get(storedKey);
        const ins = this.#db
          .query("INSERT INTO semantic_history (key, value, category, valid_from) VALUES (?, ?, ?, ?)")
          .run(storedKey, stored, cat, now);
        if (open) {
          this.#db
            .query("UPDATE semantic_history SET valid_to = ?, superseded_by = ? WHERE id = ?")
            .run(now, Number(ins.lastInsertRowid), open.id);
        }
      })();
      this.#audit({
        timestamp: Date.now(),
        sessionId: "semantic",
        actionType: "memory_write",
        result: "success",
        argsJson: JSON.stringify({ key, length: storedValue.length, redactions }),
      });
    } catch (err) {
      this.#audit({
        timestamp: Date.now(),
        sessionId: "semantic",
        actionType: "memory_write",
        result: "error",
        blockedReason: String(err),
      });
    }
  }

  /**
   * Retrieve known facts, most recently updated first.
   *
   * With no scope this is every row, which is what the owner's surfaces and
   * the maintenance passes (boot cleanup, fractal migration) want. With a
   * scope it is that identity's facts plus the global ones — a Discord user
   * sees what the owner taught the agent, never what another member did. A
   * scoped fact shadows a global one with the same key.
   */
  all(scope = ""): SemanticFact[] {
    // The old name. Everything that asks "what is known" wants what is
    // known NOW, which is what `current` says out loud.
    return this.current(scope);
  }

  /** The facts as they stand now. */
  current(scope = ""): SemanticFact[] {
    const rows = this.#rows().map((r) => ({
      storedKey: r.key,
      key: stripScope(r.key),
      value: decryptField(r.value),
      updatedAt: r.updated_at,
      category: asCategory(r.category),
    }));
    return mergeScoped<SemanticFact>(rows, scope).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Every value one fact has held, oldest first. */
  history(key: string, scope = ""): FactVersion[] {
    return this.#db
      .query<HistRow, [string]>("SELECT * FROM semantic_history WHERE key = ? ORDER BY id ASC")
      .all(scopedKey(scope, key.trim().toLowerCase()))
      .map(fromHist);
  }

  /** The facts as they stood at `ts`: whichever version was open then. */
  asOf(ts: number, scope = ""): SemanticFact[] {
    const rows = this.#db
      .query<HistRow, [number, number]>(
        `SELECT * FROM semantic_history
         WHERE valid_from <= ?1 AND (valid_to IS NULL OR valid_to > ?2)
         ORDER BY valid_from DESC`,
      )
      .all(ts, ts);
    return mergeScoped<SemanticFact>(rows.map((r) => this.#asFact(r)), scope);
  }

  /** Facts whose current value arrived after `ts`, newest first. */
  changedSince(ts: number, scope = ""): SemanticFact[] {
    const rows = this.#db
      .query<HistRow, [number]>(
        "SELECT * FROM semantic_history WHERE valid_from > ? AND valid_to IS NULL ORDER BY valid_from DESC",
      )
      .all(ts);
    return mergeScoped<SemanticFact>(rows.map((r) => this.#asFact(r)), scope);
  }

  #asFact(r: HistRow): SemanticFact & { storedKey: string } {
    const v = fromHist(r);
    return { storedKey: r.key, key: v.key, value: v.value, updatedAt: v.validFrom, category: v.category };
  }

  #rows(): Array<{ key: string; value: string; updated_at: number; category: string }> {
    return this.#db
      .query<{ key: string; value: string; updated_at: number; category: string }, []>(
        "SELECT key, value, updated_at, category FROM semantic ORDER BY updated_at DESC",
      )
      .all();
  }

  /**
   * Facts this scope OWNS — no global fallback, and for the owner (`""`) no
   * other identity's rows either.
   *
   * `all()` merges the global rows in on purpose: a Discord member should see
   * what the owner taught the agent. The notebook is the one reader that must
   * not work that way. Its rows are not facts about a person, they are the
   * agent's in-flight working notes for whatever run wrote them — merging would
   * put one session's scratchpad ("next: deploy the staging key") into a
   * different person's prompt, and would let the owner's ten notes fill every
   * guest's `MAX_NOTES` so no guest could ever write one.
   *
   * Ownership, not visibility. Use `all()` for anything the agent is supposed to
   * KNOW, and this for anything it is supposed to MAINTAIN.
   */
  own(scope = ""): SemanticFact[] {
    return this.#rows()
      .filter((r) => scopeOf(r.key) === scope)
      .map((r) => ({
        key: stripScope(r.key),
        value: decryptField(r.value),
        updatedAt: r.updated_at,
        category: asCategory(r.category),
      }));
  }

  /** Look up a single fact by key, or undefined when unknown. Falls back to
   *  the global fact when the scope has none. */
  get(key: string, scope = ""): SemanticFact | undefined {
    const q = this.#db.query<{ key: string; value: string; updated_at: number; category: string }, [string]>(
      "SELECT key, value, updated_at, category FROM semantic WHERE key = ?",
    );
    const bare = key.trim().toLowerCase();
    const row = (scope ? q.get(scopedKey(scope, bare)) : null) ?? q.get(bare);
    if (!row) return undefined;
    return {
      key: stripScope(row.key),
      value: decryptField(row.value),
      updatedAt: row.updated_at,
      category: asCategory(row.category),
    };
  }

  /**
   * Fold one speaker's facts into the owner's, once that speaker turns out to
   * BE the owner.
   *
   * Per key, the newer statement wins, which is what the person meant: the last
   * thing they said, wherever they said it. The scoped row is removed either
   * way, because leaving it would keep shadowing the owner's value on that chat
   * app, which is the bug this exists to end. Its history moves with it and is
   * closed at the moment it stopped being true.
   *
   * Idempotent: a second run finds nothing under the scope. An empty scope is
   * refused, since it would mean every owner row.
   */
  promoteScope(scope: string): number {
    if (!scope) return 0;
    const prefix = scopedKey(scope, "");
    let promoted = 0;
    for (const r of this.#rows().filter((row) => row.key.startsWith(prefix))) {
      const key = r.key.slice(prefix.length);
      const global = this.#db
        .query<{ updated_at: number }, [string]>("SELECT updated_at FROM semantic WHERE key = ?")
        .get(key);
      const wins = !global || r.updated_at > global.updated_at;
      this.#db.transaction(() => {
        this.#db
          .query("UPDATE semantic_history SET key = ?, valid_to = COALESCE(valid_to, ?) WHERE key = ?")
          .run(key, Math.max(r.updated_at, global?.updated_at ?? 0), r.key);
        this.#db.query("DELETE FROM semantic WHERE key = ?").run(r.key);
      })();
      if (wins) {
        this.upsert(key, decryptField(r.value), "", asCategory(r.category), r.updated_at);
        promoted++;
      }
    }
    return promoted;
  }

  /** Delete a fact (e.g. user explicitly asks agent to forget something).
   *  Scoped callers may only delete their own — one user cannot erase the
   *  owner's memory by guessing a key. */
  delete(key: string, scope = ""): void {
    const storedKey = scopedKey(scope, key.trim().toLowerCase());
    this.#db.transaction(() => {
      this.#db.query("DELETE FROM semantic WHERE key = ?").run(storedKey);
      // Forgetting closes the version rather than erasing it: "as of last
      // week" is still allowed to know what the user has since withdrawn.
      this.#db
        .query("UPDATE semantic_history SET valid_to = ? WHERE key = ? AND valid_to IS NULL")
        .run(Date.now(), storedKey);
    })();
  }

  /**
   * Render facts as a compact block for prompt injection.
   *
   * This used to be "the 30 most recently updated facts", full stop, with a
   * comment claiming recency "gives the most relevant recent knowledge".
   * Measured with `scripts/memory-intrusion.ts` over 300 facts on ten
   * unrelated subjects, it was 10% relevant: one subject in ten, which is
   * chance. Twenty-seven of the thirty lines in front of the model were about
   * a car while the person asked about bread, and the fact that DID answer was
   * usually absent, because it was not recent. Recency is not a relevance
   * signal, and it was the only signal.
   *
   * What it does now, in order:
   *   - Under the cap, everything is injected, exactly as before. A fresh
   *     install with nine facts loses nothing and behaves identically.
   *   - Over the cap with a query, facts are ranked by how much of the query
   *     they contain, and anything scoring zero is left out rather than padded
   *     back in by recency.
   *   - Over the cap with no query (a caller with no user message), recency,
   *     as before.
   *
   * Identity facts are pinned regardless: "call me Alex" matches no question
   * about tyres, and an agent that forgets a name whenever the subject changes
   * is worse than one that spends five lines.
   *
   * ponytail: word overlap, not embeddings. The embedding path exists
   * (FractalMemory) and is better, but it needs a model on disk and a built
   * tree, and it is absent on first run and after any failed rebuild, which is
   * exactly when this code runs. KNOWN CEILING: overlap is per-language, so a
   * Romanian question does not match an English fact; cross-language recall
   * needs the embedding path. This only stops the block being random.
   */
  static readonly MAX_PROMPT_FACTS = 30;

  /**
   * The facts `renderForPrompt` would render, as data.
   *
   * Exists because the knowledge-graph block is built from the same extracted
   * facts (`extractor.ts` mirrors every fact into the graph as
   * `key —has→ value`), so without knowing what this block already said, the
   * graph spends twenty more lines repeating it. The caller needs the list, not
   * the string.
   */
  selectForPrompt(scope = "", query = ""): SemanticFact[] {
    const all = this.all(scope);
    if (all.length === 0) return [];

    const facts =
      all.length <= SemanticMemory.MAX_PROMPT_FACTS
        ? all
        : query.trim()
          ? rankByQuery(all, query).slice(0, SemanticMemory.MAX_PROMPT_FACTS)
          : all.slice(0, SemanticMemory.MAX_PROMPT_FACTS);

    return dedupeByValue(facts);
  }

  renderForPrompt(scope = "", query = ""): string {
    const facts = this.selectForPrompt(scope, query);
    if (facts.length === 0) return "";
    const lines = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
    return `Known facts about the user:\n${lines}`;
  }
}

/**
 * Drop facts that say the same thing under a different name.
 *
 * `upsert` dedupes on the key, and the extractor's alias table catches the
 * families that recur ("user name" → "name"), but the extractor is a language
 * model: it writes `preferred_daw` one week and `daw_choice` the next, and both
 * rows survive, both are current, and both are rendered. The model then reads
 * the same fact twice and has no way to tell that it is one fact.
 *
 * Done here, at render time, rather than by deleting a row: two keys holding
 * the same value today may hold different values next month, and a write-time
 * merge would have thrown one of them away for good. This costs one pass over
 * at most thirty facts and is undone by simply not calling it.
 *
 * The SHORTER key wins, because `daw` survives the rewrite that `preferred_daw`
 * does not, and because the first one written is usually the plainer one.
 */
function dedupeByValue(facts: SemanticFact[]): SemanticFact[] {
  const byValue = new Map<string, SemanticFact>();
  const order: string[] = [];
  for (const f of facts) {
    const norm = f.value.trim().toLowerCase().replace(/\s+/g, " ");
    const seen = byValue.get(norm);
    if (!seen) {
      byValue.set(norm, f);
      order.push(norm);
    } else if (f.key.length < seen.key.length) {
      byValue.set(norm, f);
    }
  }
  return order.map((v) => byValue.get(v)!);
}

/**
 * Facts that answer every question because they are about the person rather
 * than about a subject. Deliberately short: each one is a line spent on every
 * turn, and the canonical key table in the extractor already collapses
 * "user name", "users name" and "user's name" onto `name`.
 */
const ALWAYS_RELEVANT = new Set([
  "name", "language", "pronouns", "occupation", "location", "timezone",
]);

/**
 * Words too common to carry a subject. Two languages, because he types to it
 * in Romanian while the stored facts are usually English: one stopword left in
 * makes "care este" match every fact containing "este".
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at", "is", "are",
  "do", "does", "did", "my", "me", "what", "which", "when", "how", "who", "with",
  "that", "this", "it", "be", "have", "has", "was", "were", "should", "about",
  "care", "este", "sunt", "cum", "cand", "unde", "meu", "mea", "mele", "mei",
  "din", "pe", "si", "sau", "cu", "ce", "imi", "mi", "lui", "ei",
]);

/** Lowercase words of three letters or more, minus the stopwords. */
export function memoryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * Rank facts by how much of the question they contain.
 *
 * A fact scores for every query word it holds, the key counting double: the
 * key is what the extractor named the thing ("oil_type"), so a hit there is a
 * hit on the subject, while a hit in the value can be a word that merely
 * appears in a sentence. Length-normalised, or a long chatty value outranks
 * the short fact that actually answers.
 *
 * Recency survives as the tiebreak, not as the ranking: between two facts that
 * match equally well, the one restated last week is the one they meant.
 */
function rankByQuery(facts: SemanticFact[], query: string): SemanticFact[] {
  const want = new Set(memoryTokens(query));
  if (want.size === 0) return facts;

  return facts
    .map((f) => {
      const keyWords = memoryTokens(f.key);
      const valueWords = memoryTokens(f.value);
      let score = 0;
      for (const w of keyWords) if (want.has(w)) score += 2;
      for (const w of valueWords) if (want.has(w)) score += 1;
      const size = Math.sqrt(keyWords.length + valueWords.length + 1);
      return { fact: f, score: score / size, pinned: ALWAYS_RELEVANT.has(f.key) };
    })
    .filter((s) => s.pinned || s.score > 0)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return b.fact.updatedAt - a.fact.updatedAt;
    })
    .map((s) => s.fact);
}
