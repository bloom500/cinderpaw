// Spec slice 8 (4.12): what "Send my numbers" may carry is numbers only, never text, ids or times.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Nudges } from "../src/core/nudges.ts";
import { dispatch, parseArgs } from "../src/cli.ts";

const KINDS = new Set(["followup", "task", "watch", "digest", "thought", "receipt"]);

/** Every leaf is a number (or null for "no data"); every key is a known kind or a fixed field name. */
function onlyNumbers(v: unknown, path = "payload"): string[] {
  if (v === null || typeof v === "number") return [];
  if (typeof v !== "object") return [`${path} is a ${typeof v}`];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => onlyNumbers(x, `${path}.${k}`));
}

test("the numbers payload holds only numbers, even with secret-looking text in the ledger", async () => {
  const db = openDatabase(":memory:");
  const nudges = new Nudges(db.raw);
  const at = new Date(2026, 10, 10, 10).getTime();
  // Titles, session ids and channels that must never leave.
  await nudges.send({ kind: "followup", sourceId: "run-SECRET-title", sessionId: "whatsapp:+40700000000" }, () => "whatsapp", at);
  await nudges.send({ kind: "task", sourceId: "job-call-the-bank", userRequested: true }, () => "desktop", at + 1000);
  nudges.react("run-SECRET-title", "opened", at + 2000);
  db.raw.query("INSERT INTO nudges (id, kind, channel, created_at, local_hour, arm, decision) VALUES ('x', 'evil kind', 'c', 1, 1, 'rule', 'sent')").run();

  const payload = nudges.numbers(at + 3000);
  expect(onlyNumbers(payload)).toEqual([]);
  expect(Object.keys(payload.kinds).every((k) => KINDS.has(k))).toBe(true); // a stored odd kind is not echoed back
  const text = JSON.stringify(payload);
  for (const secret of ["SECRET", "+40700000000", "whatsapp", "bank", "evil"]) expect(text).not.toContain(secret);
  expect(payload.kinds.followup).toEqual({ sent: 1, positive: 1, dismissed: 0, daysAnswered: 1 });
  expect(payload.onTimePct).toBe(100);
  db.close();
});

test("Send my numbers: what is logged is exactly what leaves, and the worker accepts it", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "cp-numbers-"));
  const saved = process.env.CINDERPAW_HOME;
  process.env.CINDERPAW_HOME = home;
  try {
    const { sendNumbers, NUMBERS_URL } = await import("../src/telemetry/usage-sender.ts");
    const { validateNumbers } = await import("../../workers/bug-report/usage.js");
    const db = openDatabase(":memory:");
    const nudges = new Nudges(db.raw);
    await nudges.send({ kind: "task", sourceId: "job-secret", userRequested: true }, () => "desktop", Date.now());
    let sent: { url: string; body: string } | null = null;
    const r = await sendNumbers(nudges.numbers(), { fetchFn: (async (url: string, init: RequestInit) => { sent = { url, body: String(init.body) }; return new Response(null, { status: 204 }); }) as never });
    expect(r).toEqual({ ok: true });
    expect(sent!.url).toBe(NUMBERS_URL);
    const logged = readFileSync(join(home, "telemetry-sent.jsonl"), "utf8").trim();
    expect(logged).toBe(sent!.body);
    expect(validateNumbers(JSON.parse(sent!.body))).toEqual({ ok: true });
    expect(sent!.body).not.toContain("secret");
    // Usage sharing was never turned on: its code file (with its "since" day) is not created.
    expect(() => readFileSync(join(home, "usage-code.json"))).toThrow();
    const offline = await sendNumbers(nudges.numbers(), { fetchFn: (async () => { throw new Error("offline"); }) as never });
    expect(offline).toEqual({ ok: false, error: "Could not reach the server. Check your internet and try again." });
    db.close();
  } finally {
    if (saved === undefined) delete process.env.CINDERPAW_HOME; else process.env.CINDERPAW_HOME = saved;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* locked on Windows */ }
  }
});

test("`numbers` is a read-only command of the engine", () => {
  expect(dispatch(parseArgs(["numbers"]))).toEqual({ kind: "subcommand", name: "numbers" });
  expect(dispatch(parseArgs(["metrics"]))).toEqual({ kind: "subcommand", name: "numbers" });
});
