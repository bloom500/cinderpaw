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
  upsert(key: string, value: string): void {
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
        $key: key.trim().toLowerCase(),
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

  /** Retrieve all known facts, most recently updated first. */
  all(): SemanticFact[] {
    return this.#db
      .query<{ key: string; value: string; updated_at: number }, []>(
        "SELECT key, value, updated_at FROM semantic ORDER BY updated_at DESC",
      )
      .all()
      .map((r) => ({ key: r.key, value: decryptField(r.value), updatedAt: r.updated_at }));
  }

  /** Look up a single fact by key, or undefined when unknown. */
  get(key: string): SemanticFact | undefined {
    const row = this.#db
      .query<{ key: string; value: string; updated_at: number }, [string]>(
        "SELECT key, value, updated_at FROM semantic WHERE key = ?",
      )
      .get(key.trim().toLowerCase());
    if (!row) return undefined;
    return { key: row.key, value: decryptField(row.value), updatedAt: row.updated_at };
  }

  /** Delete a fact (e.g. user explicitly asks agent to forget something). */
  delete(key: string): void {
    this.#db
      .query("DELETE FROM semantic WHERE key = ?")
      .run(key.trim().toLowerCase());
  }

  /**
   * Render the N most-recently-updated facts as a compact block for prompt
   * injection. Capped so that a long-running agent with hundreds of
   * accumulated facts never silently burns thousands of tokens on context.
   * The facts are already returned by `all()` in updated_at DESC order, so
   * slicing to MAX_PROMPT_FACTS gives the most relevant recent knowledge.
   */
  static readonly MAX_PROMPT_FACTS = 30;

  renderForPrompt(): string {
    const facts = this.all().slice(0, SemanticMemory.MAX_PROMPT_FACTS);
    if (facts.length === 0) return "";
    const lines = facts.map((f) => `- ${f.key}: ${f.value}`).join("\n");
    return `Known facts about the user:\n${lines}`;
  }
}
