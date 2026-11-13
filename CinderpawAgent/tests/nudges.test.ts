import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Nudges } from "../src/core/nudges.ts";

const AT = new Date(2026, 10, 13, 18, 30).getTime(); // 18:30 local

const HOUR = 3_600_000;

function rows(db: ReturnType<typeof openDatabase>) {
  return db.raw.query("SELECT * FROM nudges ORDER BY created_at").all() as Array<Record<string, unknown>>;
}
function outcomes(db: ReturnType<typeof openDatabase>) {
  return rows(db).map((r) => r.outcome);
}

describe("nudges: what the person did after (fake clock, fake phone)", () => {
  test("the owner's next phone message within 12 hours answers the nudge", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task" }, async () => "telegram", AT);
    nudges.inbound("telegram", AT + 2 * HOUR);
    expect(rows(db)[0]).toMatchObject({ outcome: "answered", outcome_at: AT + 2 * HOUR });
    db.close();
  });

  test("a reply after 12 hours is not an answer", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task" }, async () => "telegram", AT);
    nudges.inbound("telegram", AT + 13 * HOUR);
    expect(outcomes(db)).toEqual(["ignored"]);
    db.close();
  });

  test("only the latest nudge is answered; the one before it was ignored", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task", sourceId: "a" }, async () => "telegram", AT);
    await nudges.send({ kind: "digest", sourceId: "b" }, async () => "telegram", AT + HOUR);
    nudges.inbound("telegram", AT + 2 * HOUR);
    expect(outcomes(db)).toEqual(["ignored", "answered"]);
    db.close();
  });

  test("chatting on afterwards is not counted as more answers", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task" }, async () => "telegram", AT);
    nudges.inbound("telegram", AT + HOUR);
    nudges.inbound("telegram", AT + 2 * HOUR);
    expect(rows(db)[0]).toMatchObject({ outcome: "answered", outcome_at: AT + HOUR });
    db.close();
  });

  test("a reply after Cubby said something else answers that, not the nudge", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task" }, async () => "telegram", AT);
    nudges.outbound("telegram", AT + HOUR); // e.g. Cubby asked a question in that chat
    nudges.inbound("telegram", AT + 2 * HOUR);
    expect(outcomes(db)).toEqual(["ignored"]);
    db.close();
  });

  test("a message on another channel changes nothing", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task" }, async () => "telegram", AT);
    nudges.inbound("whatsapp", AT + HOUR);
    expect(outcomes(db)).toEqual([null]);
    db.close();
  });

  test("the desktop card: opened and dismissed by its source", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "followup", sourceId: "run-1", sessionId: "chat-1" }, () => "desktop", AT);
    await nudges.send({ kind: "followup", sourceId: "run-2", sessionId: "chat-2" }, () => "desktop", AT + 1);
    nudges.react("run-1", "opened", AT + HOUR);
    nudges.react("run-2", "dismissed", AT + HOUR);
    expect(outcomes(db)).toEqual(["opened", "dismissed"]);
    db.close();
  });

  test("writing in that conversation within a day means the work was continued", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "followup", sourceId: "run-1", sessionId: "chat-1" }, () => "desktop", AT);
    nudges.continued("chat-other", AT + HOUR);
    expect(outcomes(db)).toEqual([null]);
    nudges.continued("chat-1", AT + 2 * HOUR);
    expect(outcomes(db)).toEqual(["acted"]);
    db.close();
  });

  test("nothing after 24 hours is ignored, at the next look", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "thought" }, () => "desktop", AT);
    nudges.expire(AT + 23 * HOUR);
    expect(outcomes(db)).toEqual([null]);
    nudges.expire(AT + 24 * HOUR);
    expect(outcomes(db)).toEqual(["ignored"]);
    db.close();
  });

  test("a stronger outcome replaces a weaker one, never the other way", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "followup", sourceId: "run-1", sessionId: "chat-1" }, () => "desktop", AT);
    nudges.expire(AT + 25 * HOUR); // ignored first, then the person comes back
    nudges.react("run-1", "opened", AT + 26 * HOUR);
    expect(outcomes(db)).toEqual(["opened"]);
    // acted only within a day of the nudge, so this one is a fresh nudge
    await nudges.send({ kind: "followup", sourceId: "run-2", sessionId: "chat-2" }, () => "desktop", AT + 30 * HOUR);
    nudges.continued("chat-2", AT + 31 * HOUR);
    nudges.react("run-2", "opened", AT + 32 * HOUR);
    expect(outcomes(db)).toEqual(["opened", "acted"]);
    db.close();
  });

  test("dismissed is final, but does not undo work already done", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "followup", sourceId: "run-1", sessionId: "chat-1" }, () => "desktop", AT);
    nudges.react("run-1", "opened", AT + 1);
    nudges.react("run-1", "dismissed", AT + 2);
    nudges.continued("chat-1", AT + 3);
    expect(outcomes(db)).toEqual(["dismissed"]);
    await nudges.send({ kind: "followup", sourceId: "run-2", sessionId: "chat-2" }, () => "desktop", AT + 4);
    nudges.continued("chat-2", AT + 5);
    nudges.react("run-2", "dismissed", AT + 6);
    expect(outcomes(db)).toEqual(["dismissed", "acted"]);
    db.close();
  });
});

describe("nudges: the one door every first-contact message goes through", () => {
  test("each kind leaves one row with the channel that delivered it", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "followup", sourceId: "run-1", sessionId: "chat-1" }, () => "desktop", AT);
    await nudges.send({ kind: "task", sourceId: "job-1", sessionId: "chat-2", userRequested: true }, async () => "telegram", AT + 1);
    await nudges.send({ kind: "watch", sourceId: "job-2", userRequested: true }, async () => "desktop", AT + 2);
    await nudges.send({ kind: "digest" }, async () => "whatsapp", AT + 3);
    await nudges.send({ kind: "thought" }, () => "desktop", AT + 4);
    const all = rows(db);
    expect(all.map((r) => [r.kind, r.channel])).toEqual([
      ["followup", "desktop"], ["task", "telegram"], ["watch", "desktop"], ["digest", "whatsapp"], ["thought", "desktop"],
    ]);
    expect(all[0]).toMatchObject({ source_id: "run-1", session_id: "chat-1", decision: "sent", sent_at: AT, local_hour: 18, user_requested: 0, outcome: null });
    expect(all[1]).toMatchObject({ user_requested: 1 });
    for (const r of all) expect(["rule", "control"]).toContain(r.arm as string);
    db.close();
  });

  test("the message itself is never stored", () => {
    const db = openDatabase(":memory:");
    const cols = (db.raw.query("PRAGMA table_info(nudges)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("text");
    expect(cols).not.toContain("content");
    db.close();
  });

  test("nothing delivered leaves no row, and the caller still gets null", async () => {
    const db = openDatabase(":memory:");
    expect(await new Nudges(db.raw).send({ kind: "digest" }, async () => null, AT)).toBeNull();
    expect(rows(db)).toHaveLength(0);
    db.close();
  });

  test("a failed send still fails for the caller, as before", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await expect(nudges.send({ kind: "task" }, async () => { throw new Error("offline"); }, AT)).rejects.toThrow("offline");
    expect(rows(db)).toHaveLength(0);
    db.close();
  });

  test("a broken ledger never stops the message", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    db.raw.exec("DROP TABLE nudges");
    let delivered = false;
    expect(await nudges.send({ kind: "followup" }, () => { delivered = true; return "desktop"; }, AT)).toBe("desktop");
    expect(delivered).toBe(true);
    db.close();
  });

  test("the ledger is also expired lazily on every send", async () => {
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "thought" }, () => "desktop", AT);
    await nudges.send({ kind: "thought" }, () => "desktop", AT + 25 * HOUR);
    expect(outcomes(db)).toEqual(["ignored", null]);
    db.close();
  });

  test("a synchronous sender runs before send() returns, so event order is unchanged", () => {
    const db = openDatabase(":memory:");
    const order: string[] = [];
    void new Nudges(db.raw).send({ kind: "followup" }, () => { order.push("sent"); return "desktop"; }, AT);
    order.push("after");
    expect(order).toEqual(["sent", "after"]);
    db.close();
  });
});
