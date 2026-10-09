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
    // The file builds up to 8 Oct wrote ({month, code, since}) still reads, and is migrated.
    expect(JSON.parse(bodies[0]!).code).toBe("a".repeat(32));
    expect(JSON.parse(readFileSync(join(home, "usage-code.json"), "utf8"))).toEqual({ codes: { "2026-10": "a".repeat(32) }, since: "2026-10-05" });
    expect(bodies[0]).not.toContain("secret-session");
    expect(bodies[0]).not.toContain("\"new\"");
    expect(logAtSend).toContain("2026-10-09");
    expect(await sendPending(db.raw, { now: new Date("2026-10-10T09:00:00Z"), fetchFn })).toBe(0);
    db.close();
  });

  test("one code per month of the DAY, not of the send; keeps since; forgetCode deletes it", () => {
    const oct = monthlyCode(new Date("2026-10-31T23:00:00Z"), "2026-10-31");
    const nov = monthlyCode(new Date("2026-11-01T01:00:00Z"), "2026-11-01");
    const lateOct = monthlyCode(new Date("2026-11-01T01:00:00Z"), "2026-10-30");
    expect(oct.code).toMatch(/^[0-9a-f]{32}$/);
    expect(nov.code).not.toBe(oct.code);
    expect(lateOct.code).toBe(oct.code);
    expect(nov.since).toBe(oct.since);
    forgetCode();
    expect(existsSync(join(home, "usage-code.json"))).toBe(false);
  });

  // Final review M2: 31 Oct leaves on 1 Nov; under November's code it was a second install in October.
  test("2026-10-31 sent on 2026-11-01 carries the same code as 2026-10-30", async () => {
    const db = openDatabase(":memory:");
    for (const d of ["2026-10-30", "2026-10-31"]) {
      beginTask(db.raw, { taskId: d, sessionId: "s", startedAt: day(d), brsiOn: false, memoryOn: false });
      finishTask(db.raw, d, { durationMs: 1000, outcome: "completed", errorCategory: null, toolCalls: 0, attemptedProvider: "openrouter.ai", attemptedModel: "m" });
    }
    setSharing(true);
    const codes: Record<string, string> = {};
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const p = JSON.parse(String(init?.body)) as { day: string; code: string };
      codes[p.day] = p.code;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    writeFileSync(join(home, "usage-code.json"), JSON.stringify({ codes: {}, since: "2026-10-01" }));
    expect(await sendPending(db.raw, { now: new Date("2026-10-31T08:00:00Z"), fetchFn })).toBe(1);
    expect(await sendPending(db.raw, { now: new Date("2026-11-01T08:00:00Z"), fetchFn })).toBe(1);
    expect(codes["2026-10-31"]).toMatch(/^[0-9a-f]{32}$/);
    expect(codes["2026-10-31"]).toBe(codes["2026-10-30"]!);
    db.close();
  });

  test("months outside the 30-day window are dropped from the file", () => {
    const [aug, sep, oct] = ["8", "9", "a"].map((c) => c.repeat(32));
    writeFileSync(join(home, "usage-code.json"), JSON.stringify({ codes: { "2026-08": aug, "2026-09": sep, "2026-10": oct }, since: "2026-08-01" }));
    expect(monthlyCode(new Date("2026-10-20T08:00:00Z"), "2026-09-25").code).toBe(sep!);
    const file = JSON.parse(readFileSync(join(home, "usage-code.json"), "utf8"));
    expect(file).toEqual({ codes: { "2026-09": sep, "2026-10": oct }, since: "2026-08-01" });
  });

  test("pendingDays: previous days only, within 30, not already sent", () => {
    const now = new Date("2026-10-10T08:00:00Z");
    expect(pendingDays(now, "2026-10-08", new Set(["2026-10-08"]))).toEqual(["2026-10-09"]);
    expect(pendingDays(now, "2026-01-01", new Set()).length).toBe(30);
  });
});
