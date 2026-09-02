/**
 * Episodic search — precision first, but never at the cost of finding nothing.
 *
 * `toFtsQuery` ANDed every token of the query, so each word had to appear in
 * the stored row. That is fine for a keyword search and useless for the only
 * query shape any caller actually produces: the `recall` tool passes the
 * user's question, and so does the per-turn injection. Measured 2026-09-02
 * against a row that literally contained the answer:
 *
 *   "staging database password"                    -> 1 hit
 *   "Where is the staging database password kept?" -> 0 hits
 *
 * Memory looked empty while it was full, which is most of why cross-task carry
 * measured at nil. The docstring above `toFtsQuery` had promised an OR
 * fallback "for recall" that was never written; these tests hold it to that.
 */

import { describe, expect, test } from "bun:test";

import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { RecallEngine } from "../src/memory/recall.ts";

function fixture() {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const episodic = new EpisodicMemory(db.raw, audit.logger);
  return { db, episodic, audit };
}

const FACT = "The staging database password is kept in vault/staging/db.";

describe("EpisodicMemory.search — natural-language queries", () => {
  test("a question finds the row that answers it", async () => {
    const { db, episodic } = fixture();
    episodic.record("sess-a", "user", `Remember this for later: ${FACT}`);

    // Keyword form worked before this fix and must keep working.
    expect(episodic.search("staging database password", 10)).toHaveLength(1);
    // Question form is the one that returned nothing.
    expect(episodic.search("Where is the staging database password kept?", 10)).toHaveLength(1);
    db.close();
  });

  test("the strict AND pass still wins when it matches", async () => {
    // The widening must not cost precision where precision was available: an
    // exact multi-term query should not start dragging in loosely related rows.
    const { db, episodic } = fixture();
    episodic.record("s1", "user", "the deploy key lives in vault/prod");
    episodic.record("s1", "user", "the staging database password is in vault/staging");

    const hits = episodic.search("staging database password", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("staging");
    db.close();
  });

  test("a query sharing no meaningful term finds nothing", async () => {
    // The OR fallback widens the net; it must not turn search into "return
    // everything". A query with no overlap still has to come back empty.
    const { db, episodic } = fixture();
    episodic.record("s1", "user", FACT);

    expect(episodic.search("kubernetes ingress certificates", 10)).toHaveLength(0);
    db.close();
  });

  test("an empty or punctuation-only query finds nothing", async () => {
    const { db, episodic } = fixture();
    episodic.record("s1", "user", FACT);

    expect(episodic.search("", 10)).toHaveLength(0);
    expect(episodic.search("???", 10)).toHaveLength(0);
    db.close();
  });
});

describe("RecallEngine — the block a turn actually receives", () => {
  test("a question asked in a NEW session recalls the previous one", async () => {
    // This is the case that matters for a benchmark: each task is its own
    // session, so the transcript carries nothing and recall is the only route.
    const { db, episodic } = fixture();
    const semantic = new SemanticMemory(db.raw);
    const engine = new RecallEngine(episodic, semantic);

    episodic.record("sess-a", "user", `Remember this for later: ${FACT}`);
    episodic.record("sess-a", "assistant", "noted");

    const result = engine.recall("Where is the staging database password kept?", "sess-b");

    expect(result.episodicHits).toBeGreaterThan(0);
    expect(result.context).toContain("[Memory context]");
    expect(result.context).toContain("vault/staging/db");
    db.close();
  });

  test("the current session's own rows are not recalled back at it", async () => {
    // The transcript already carries them; repeating them in a memory block
    // spends tokens to tell the model what it is already reading.
    const { db, episodic } = fixture();
    const semantic = new SemanticMemory(db.raw);
    const engine = new RecallEngine(episodic, semantic);

    episodic.record("sess-a", "user", `Remember this for later: ${FACT}`);

    const result = engine.recall("Where is the staging database password kept?", "sess-a");

    expect(result.episodicHits).toBe(0);
    db.close();
  });
});
