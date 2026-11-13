import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Nudges } from "../src/core/nudges.ts";

const AT = new Date(2026, 10, 13, 18, 30).getTime(); // 18:30 local

function rows(db: ReturnType<typeof openDatabase>) {
  return db.raw.query("SELECT * FROM nudges ORDER BY created_at").all() as Array<Record<string, unknown>>;
}

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

  test("a synchronous sender runs before send() returns, so event order is unchanged", () => {
    const db = openDatabase(":memory:");
    const order: string[] = [];
    void new Nudges(db.raw).send({ kind: "followup" }, () => { order.push("sent"); return "desktop"; }, AT);
    order.push("after");
    expect(order).toEqual(["sent", "after"]);
    db.close();
  });
});
