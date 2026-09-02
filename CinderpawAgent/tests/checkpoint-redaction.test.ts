/**
 * The third durable store.
 *
 * Slice 11 kept credentials out of memory, slice 12 kept them out of the saved
 * conversation. `session_checkpoint` was neither — and it holds more than
 * both, because it is the full working-memory transcript: a token that only
 * ever travelled as a tool argument, or came back inside a tool result, is
 * written there even though it never appeared in a user message.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { CheckpointStore } from "../src/memory/checkpoint.ts";
import type { ChatMessage } from "../src/types.ts";

const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function store() {
  const db = openDatabase(":memory:");
  dbs.push(db);
  return new CheckpointStore(db.raw);
}

const save = (cp: CheckpointStore, messages: ChatMessage[]) =>
  cp.save({ sessionId: "s1", messageId: "m1", iteration: 1, messages });

describe("checkpoint redaction", () => {
  test("a token pasted by the user does not survive to disk", () => {
    const cp = store();
    const token = "xoxb-123456789012-abcdefghijklmno";
    save(cp, [{ role: "user", content: `here it is: ${token}` } as ChatMessage]);

    const loaded = cp.loadRunning("s1");
    expect(loaded).not.toBeNull();
    const dump = JSON.stringify(loaded!.messages);
    expect(dump).not.toContain(token);
    expect(dump).toContain("[REDACTED:slack_token]");
  });

  test("a token inside a tool argument or result is caught too", () => {
    // The case episodic redaction misses: the user never typed it in this
    // turn, the agent passed it on and the service echoed it back.
    const cp = store();
    const key = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa";
    save(cp, [
      { role: "assistant", content: "saving", tool_calls: [{ id: "t1", type: "function", function: { name: "connectors_manage", arguments: `{"token":"${key}"}` } }] },
      { role: "tool", tool_call_id: "t1", content: `stored ${key}` },
    ] as unknown as ChatMessage[]);

    const dump = JSON.stringify(cp.loadRunning("s1")!.messages);
    expect(dump).not.toContain(key);
    expect(dump.match(/\[REDACTED:api_key\]/g)?.length).toBe(2);
  });

  test("the row is still valid JSON and ordinary content is byte-identical", () => {
    const cp = store();
    const plain = 'Rulează `git log --oneline` în D:\Cinderpaw Agent — commit 7ec3b91, "gata".';
    save(cp, [{ role: "assistant", content: plain } as ChatMessage]);

    const loaded = cp.loadRunning("s1");
    expect(loaded).not.toBeNull();
    expect(loaded!.messages[0]!.content).toBe(plain);
  });
});
