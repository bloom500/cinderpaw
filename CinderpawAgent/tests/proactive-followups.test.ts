import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FollowUpLedger, MonthlyProactiveBudget, recordInteractiveTurn } from "../src/core/proactive-followups.ts";
import { openDatabase } from "../src/db.ts";
import { RunStore } from "../src/core/run-store.ts";

const NOW = Date.UTC(2026, 9, 24, 16);
function database() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT, mission TEXT, status TEXT,
      stopped_because TEXT, updated_at INTEGER, delivery TEXT);`);
  return db;
}
function run(db: Database, id = "run-1", session = "chat-1", status = "unfinished", at = NOW - 60 * 60_000) {
  db.query("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, session, "Finish the launch checklist", status, "deadline", at,
    JSON.stringify({ kind: "desktop", target: session, sessionId: session }),
  );
}

describe("event-driven unfinished-work follow-ups", () => {
  test("ordinary interactive chat supplies evidence without leaving resumable work", () => {
    const db = openDatabase(":memory:");
    const store = new RunStore(db.raw);
    recordInteractiveTurn(store, "chat-1", "Finish the launch checklist", "out_of_time", "Still working");
    expect(store.runningRuns()).toHaveLength(0);
    const future = Date.now() + 11 * 60_000;
    expect(new FollowUpLedger(db.raw).take(future)?.sessionId).toBe("chat-1");
    recordInteractiveTurn(store, "chat-1", "Continue", "completed", "Done");
    expect(new FollowUpLedger(db.raw).take(future + 5 * 60 * 60_000)).toBeNull();
    recordInteractiveTurn(store, "chat-2", "Stop please", "stopped", "Stopped");
    expect(new FollowUpLedger(db.raw).take(future + 5 * 60 * 60_000)).toBeNull();
    db.close();
  });
  test("offers real unfinished desktop work once, including across restart, without inference", () => {
    const db = database();
    run(db);
    const ledger = new FollowUpLedger(db);
    expect(ledger.take(NOW)).toEqual({ id: "run-1", sessionId: "chat-1", mission: "Finish the launch checklist" });
    expect(new FollowUpLedger(db).take(NOW + 5 * 60 * 60_000)).toBeNull();
    db.close();
  });

  test("never nags about finished, actively resumed, explicitly stopped or non-desktop work", () => {
    const db = database();
    run(db);
    run(db, "run-2", "chat-1", "finished", NOW - 15 * 60_000);
    run(db, "run-3", "chat-2", "running");
    run(db, "run-4", "chat-3");
    db.query("UPDATE runs SET stopped_because = 'interrupted' WHERE id = 'run-4'").run();
    run(db, "run-5", "cron:job");
    db.query("UPDATE runs SET delivery = ? WHERE id = 'run-5'").run(JSON.stringify({ kind: "cron" }));
    expect(new FollowUpLedger(db).take(NOW)).toBeNull();
    db.close();
  });

  test("waits for a real break, expires stale work and persists the cooldown", () => {
    const db = database();
    run(db, "fresh", "chat-fresh", "unfinished", NOW - 60_000);
    run(db, "stale", "chat-stale", "unfinished", NOW - 8 * 86_400_000);
    const ledger = new FollowUpLedger(db);
    expect(ledger.take(NOW)).toBeNull();
    run(db, "first", "chat-1");
    run(db, "second", "chat-2");
    expect(ledger.take(NOW)).not.toBeNull();
    expect(new FollowUpLedger(db).take(NOW + 60_000)).toBeNull();
    expect(new FollowUpLedger(db).take(NOW + 4 * 60 * 60_000)).not.toBeNull();
    db.close();
  });
});

describe("automatic proactive spend is separate from confirmed tasks", () => {
  test("a damaged spending ledger refuses inference rather than granting a fresh budget", async () => {
    const db = database();
    db.query("INSERT INTO meta VALUES (?, ?, ?)").run("proactive.monthly-spend.v1", "broken-json", NOW);
    const budget = new MonthlyProactiveBudget(db, { now: () => NOW, price: () => null });
    let called = false;
    await expect(budget.run(async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
    db.close();
  });
  test("defaults to $1 per UTC month, settles actual charges and refuses before exceeding it", async () => {
    const db = database();
    const budget = new MonthlyProactiveBudget(db, { now: () => NOW, price: () => ({ inputPerMillionUsd: 0, outputPerMillionUsd: 1_000_000 }) });
    const target = { provider: "test", model: "test", baseUrl: "https://api.example.com" };
    await budget.run(async (authority) => {
      const hold = authority.reserve({ targets: [target], maxPromptTokens: 0, maxCompletionTokens: 0.6 });
      hold.settle({ target, usage: { promptTokens: 0, completionTokens: 0.6 } });
    });
    expect(budget.spent()).toBeCloseTo(0.6);
    await expect(budget.run(async (authority) => {
      authority.reserve({ targets: [target], maxPromptTokens: 0, maxCompletionTokens: 0.5 });
    })).rejects.toThrow();
    expect(budget.spent()).toBeCloseTo(0.6);
    expect(new MonthlyProactiveBudget(db, { now: () => Date.UTC(2026, 10, 1), price: () => null }).spent()).toBe(0);
    db.close();
  });

  test("unknown prices and zero cap fail closed; an interrupted reservation survives restart", async () => {
    const db = database();
    const target = { provider: "test", model: "unknown", baseUrl: "https://api.example.com" };
    const budget = new MonthlyProactiveBudget(db, { now: () => NOW, price: () => null });
    await expect(budget.run(async (authority) => {
      authority.reserve({ targets: [target], maxPromptTokens: 1, maxCompletionTokens: 1 });
    })).rejects.toThrow();
    expect(budget.spent()).toBe(0);
    const stopped = new MonthlyProactiveBudget(db, { now: () => NOW, limitUsd: () => 0, price: () => null });
    let called = false;
    await expect(stopped.run(async () => { called = true; })).rejects.toThrow();
    expect(called).toBe(false);
    await budget.run(async () => {
      expect(new MonthlyProactiveBudget(db, { now: () => NOW, price: () => null }).spent()).toBe(1);
    });
    expect(budget.spent()).toBe(0);
    db.close();
  });
});
