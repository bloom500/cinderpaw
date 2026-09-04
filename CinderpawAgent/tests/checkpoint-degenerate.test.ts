/**
 * The loop that made a good cloud model write nonsense.
 *
 * One reply collapsed into a repeated character. It was checkpointed, and the
 * next turn resumed from that checkpoint — so the model read its own loop back
 * as conversation history and continued it. Every turn after that was worse,
 * on any model, because nothing about the model was wrong: its context had
 * been poisoned from disk. Found in the wild as a 39 KB transcript holding a
 * single character repeated 2,334 times.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CheckpointStore, looksDegenerate } from "../src/memory/checkpoint.ts";
import type { ChatMessage } from "../src/types.ts";

const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function store() {
  const db = openDatabase(":memory:");
  dbs.push(db);
  return { raw: db.raw, cp: new CheckpointStore(db.raw) };
}

const msg = (content: string): ChatMessage =>
  ({ role: "assistant", content }) as ChatMessage;

describe("looksDegenerate", () => {
  test("ordinary text is left alone, separators included", () => {
    expect(looksDegenerate("A perfectly normal reply, in Romanian: mulțumesc.")).toBe(false);
    expect(looksDegenerate("-".repeat(80))).toBe(false);
    expect(looksDegenerate("=".repeat(100))).toBe(false);
    expect(looksDegenerate("")).toBe(false);
  });

  test("a collapsed run is caught, whatever the character", () => {
    expect(looksDegenerate("ă".repeat(120))).toBe(true);
    expect(looksDegenerate("prefix " + "a".repeat(500) + " suffix")).toBe(true);
    // The real one, at the length it actually reached.
    expect(looksDegenerate("Salut, boss — " + "ă".repeat(2_334))).toBe(true);
  });
});

describe("CheckpointStore refuses to carry the loop", () => {
  test("a collapsed transcript is not written", () => {
    const { cp } = store();
    cp.save({
      sessionId: "s1",
      messageId: "m1",
      iteration: 1,
      messages: [msg("Salut, boss — " + "ă".repeat(2_334))],
    });
    // Skipping the write costs one step of resumability. Keeping it costs
    // every turn after it.
    expect(cp.loadRunning("s1")).toBeNull();
  });

  test("a healthy transcript still round-trips", () => {
    const { cp } = store();
    const messages = [msg("Salut, boss. Sunt aici.")];
    cp.save({ sessionId: "s2", messageId: "m2", iteration: 3, messages });
    const back = cp.loadRunning("s2");
    expect(back?.iteration).toBe(3);
    expect(back?.messages[0]?.content).toBe("Salut, boss. Sunt aici.");
  });

  test("a row written before the guard existed is not resumed either", () => {
    const { raw, cp } = store();
    // Straight past `save()`, the way the 39 KB row on the affected machine
    // got there: written when nothing checked the content.
    raw.query(
      `INSERT INTO session_checkpoint (session_id, message_id, iteration, messages, status, updated_at)
       VALUES ('s3', 'm3', 1, $msgs, 'running', 1)`,
    ).run({ $msgs: JSON.stringify([msg("x".repeat(3_000))]) });

    expect(cp.loadRunning("s3")).toBeNull();
  });
});
