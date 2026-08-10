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

export interface SemanticFact {
  key: string;
  value: string;
  updatedAt: number;
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
 * nothing about single-user Feral changes.
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
export function memoryScope(sessionId: string): string {
  const [transport, , userId] = sessionId.split(":");
  // Discord and Slack are the room-keyed transports: `<transport>:<room>:<user>`
  // (plus `discord:dm:<user>`, where the speaker is still last). A legacy
  // two-segment session has no speaker and stays global.
  if (transport !== "discord" && transport !== "slack") return "";
  return userId ? `${transport}/${userId}` : "";
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
      INSERT INTO semantic (key, value, updated_at)
      VALUES ($key, $value, $updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
  }

  /**
   * Write or overwrite a single fact about the user. High-confidence PII in the
   * value (card / IBAN / CNP / email / phone) is redacted before persistence
   * (M-2) so durable memory never silently retains it. Disable with
   * `FERAL_PII_REDACTION=off`.
   */
  upsert(key: string, value: string, scope = ""): void {
    if (!key.trim()) return;
    let storedValue = value;
    let redactions = 0;
    if (piiRedactionEnabled()) {
      const r = redactPII(value);
      storedValue = r.text;
      redactions = r.redactions;
    }
    try {
      this.#upsert.run({
        $key: scopedKey(scope, key.trim().toLowerCase()),
        // Encrypt at rest (H-1). No-op when no key is provisioned.
        $value: encryptField(storedValue),
        $updatedAt: Date.now(),
      });
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
    const rows = this.#rows();
    if (!scope) {
      return rows.map((r) => ({ key: r.key, value: decryptField(r.value), updatedAt: r.updated_at }));
    }
    const out: SemanticFact[] = [];
    const seen = new Set<string>();
    // Two passes so the scoped row always wins, regardless of update order.
    for (const pass of [scope, ""]) {
      for (const r of rows) {
        if (scopeOf(r.key) !== pass) continue;
        const key = stripScope(r.key);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, value: decryptField(r.value), updatedAt: r.updated_at });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  #rows(): Array<{ key: string; value: string; updated_at: number }> {
    return this.#db
      .query<{ key: string; value: string; updated_at: number }, []>(
        "SELECT key, value, updated_at FROM semantic ORDER BY updated_at DESC",
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
      }));
  }

  /** Look up a single fact by key, or undefined when unknown. Falls back to
   *  the global fact when the scope has none. */
  get(key: string, scope = ""): SemanticFact | undefined {
    const q = this.#db.query<{ key: string; value: string; updated_at: number }, [string]>(
      "SELECT key, value, updated_at FROM semantic WHERE key = ?",
    );
    const bare = key.trim().toLowerCase();
    const row = (scope ? q.get(scopedKey(scope, bare)) : null) ?? q.get(bare);
    if (!row) return undefined;
    return { key: stripScope(row.key), value: decryptField(row.value), updatedAt: row.updated_at };
  }

  /** Delete a fact (e.g. user explicitly asks agent to forget something).
   *  Scoped callers may only delete their own — one user cannot erase the
   *  owner's memory by guessing a key. */
  delete(key: string, scope = ""): void {
    this.#db
      .query("DELETE FROM semantic WHERE key = ?")
      .run(scopedKey(scope, key.trim().toLowerCase()));
  }

  /**
   * Render the N most-recently-updated facts as a compact block for prompt
   * injection. Capped so that a long-running agent with hundreds of
   * accumulated facts never silently burns thousands of tokens on context.
   * The facts are already returned by `all()` in updated_at DESC order, so
   * slicing to MAX_PROMPT_FACTS gives the most relevant recent knowledge.
   */
  static readonly MAX_PROMPT_FACTS = 30;

  renderForPrompt(scope = ""): string {
    const facts = this.all(scope).slice(0, SemanticMemory.MAX_PROMPT_FACTS);
    if (facts.length === 0) return "";
    const lines = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
    return `Known facts about the user:\n${lines}`;
  }
}
