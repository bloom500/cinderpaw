import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { beginTask, finishTask } from "../src/telemetry/task-metrics.ts";
import { monthlyCode, pendingDays, sendPending, forgetCode } from "../src/telemetry/usage-sender.ts";

let home: string;
let prevHome: string | undefined;
beforeEach(() => { prevHome = process.env.CINDERPAW_HOME; home = mkdtempSync(join(tmpdir(), "cp-usage-")); process.env.CINDERPAW_HOME = home; });
afterEach(() => { process.env.CINDERPAW_HOME = prevHome; rmSync(home, { recursive: true, force: true }); });
const setSharing = (v: boolean | null) => writeFileSync(join(home, "settings.json"), JSON.stringify({ usage_sharing: v }));
const day = (iso: string) => Date.parse(iso + "T12:00:00Z");

describe("usage sender", () => {
  test("nothing is sent when sharing is unset or false", async () => {
    const db = openDatabase(":memory:");
    let calls = 0;
    const fetchFn = (async () => { calls++; return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
    setSharing(null);
    expect(await sendPending(db.raw, { now: new Date("2026-10-10T08:00:00Z"), fetchFn })).toBe(0);
    setSharing(false);
    expect(await sendPending(db.raw, { now: new Date("2026-10-10T08:00:00Z"), fetchFn })).toBe(0);
    expect(calls).toBe(0);
    expect(existsSync(join(home, "usage-code.json"))).toBe(false);
    db.close();
  });

  test("never sends days before since; logs before sending; no ids or text", async () => {
    const db = openDatabase(":memory:");
    for (const [id, d] of [["old", "2026-10-01"], ["new", "2026-10-09"]] as const) {
      beginTask(db.raw, { taskId: id, sessionId: "secret-session", startedAt: day(d), brsiOn: false, memoryOn: true });
      finishTask(db.raw, id, { durationMs: 1000, outcome: "completed", errorCategory: null, toolCalls: 1, attemptedProvider: "openrouter.ai", attemptedModel: "m" });
    }
    setSharing(true);
    writeFileSync(join(home, "usage-code.json"), JSON.stringify({ month: "2026-10", code: "a".repeat(32), since: "2026-10-05" }));
    const bodies: string[] = [];
    let logAtSend = "";
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      logAtSend = readFileSync(join(home, "telemetry-sent.jsonl"), "utf8");
      bodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    expect(await sendPending(db.raw, { now: new Date("2026-10-10T08:00:00Z"), fetchFn })).toBe(1);
    expect(JSON.parse(bodies[0]!).day).toBe("2026-10-09");
    expect(bodies[0]).not.toContain("secret-session");
    expect(bodies[0]).not.toContain("\"new\"");
    expect(logAtSend).toContain("2026-10-09");
    expect(await sendPending(db.raw, { now: new Date("2026-10-10T09:00:00Z"), fetchFn })).toBe(0);
    db.close();
  });

  test("code rotates with the month and keeps since; forgetCode deletes it", () => {
    const a = monthlyCode(new Date("2026-10-31T23:00:00Z"));
    const b = monthlyCode(new Date("2026-11-01T01:00:00Z"));
    expect(a.code).toMatch(/^[0-9a-f]{32}$/);
    expect(b.code).not.toBe(a.code);
    expect(b.since).toBe(a.since);
    forgetCode();
    expect(existsSync(join(home, "usage-code.json"))).toBe(false);
  });

  test("pendingDays: previous days only, within 30, not already sent", () => {
    const now = new Date("2026-10-10T08:00:00Z");
    expect(pendingDays(now, "2026-10-08", new Set(["2026-10-08"]))).toEqual(["2026-10-09"]);
    expect(pendingDays(now, "2026-01-01", new Set()).length).toBe(30);
  });
});
