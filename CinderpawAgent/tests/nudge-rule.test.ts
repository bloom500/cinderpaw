// Spec slice 7 (4.6, 4.7, weekly receipt): the rule that learns when to stay
// quiet. Counting only, no model, fake clock.
import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Nudges, RULE } from "../src/core/nudges.ts";
import { buildDigest, buildReceipt, maybeSendReceipt } from "../src/cron/digest.ts";

const HOUR = 3_600_000;
const at = (day: number, hour: number) => new Date(2026, 10, 2 + day, hour, 0).getTime(); // 2 Nov 2026 was a Monday

// Ids decide the arm: first 8 hex digits % 5 === 0 is control. These are all "rule".
let n = 0;
const ruleIds = () => `${(++n * 5 + 1).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
const controlId = () => "00000005-0000-4000-8000-000000000000";

function ledger(o: { digestOn?: boolean; rule?: boolean; newId?: () => string } = {}) {
  const db = openDatabase(":memory:");
  const nudges = new Nudges(db.raw, { digestOn: () => o.digestOn ?? true, rule: o.rule, newId: o.newId ?? ruleIds });
  const decisions = () => db.raw.query("SELECT decision FROM nudges ORDER BY created_at").all().map((r) => (r as { decision: string }).decision);
  return { db, nudges, decisions };
}

/** One follow-up through the door at `now`; true when it reached the person. */
async function followup(nudges: Nudges, now: number, id = `run-${now}`) {
  return (await nudges.send({ kind: "followup", sourceId: id }, () => "desktop", now)) !== null;
}

describe("the rule (4.6)", () => {
  test(`after ${RULE.holdMinSent} evening follow-ups nobody touched, the next one is held for the digest`, async () => {
    const { db, nudges, decisions } = ledger();
    for (let d = 0; d < RULE.holdMinSent; d++) expect(await followup(nudges, at(d, 19))).toBe(true);
    nudges.expire(at(RULE.holdMinSent, 19)); // all ignored after a day
    expect(await followup(nudges, at(RULE.holdMinSent, 19))).toBe(false);
    expect(decisions().at(-1)).toBe("held_for_digest");
    // The morning is another bucket: still sent.
    expect(await followup(nudges, at(RULE.holdMinSent, 9))).toBe(true);
    // The digest says what was held, without the message text.
    const held = nudges.heldSince(at(RULE.holdMinSent, 0), at(RULE.holdMinSent + 1, 0));
    expect(held).toEqual(["• I kept one note about unfinished work for this summary instead of writing at once."]);
    expect(buildDigest([], 0, held)).toBe(`Your day\n\n${held[0]}`);
    db.close();
  });

  test("with the digest off, the rule drops instead of holding, and records it", async () => {
    const { db, nudges, decisions } = ledger({ digestOn: false });
    for (let d = 0; d < RULE.holdMinSent; d++) await followup(nudges, at(d, 19));
    nudges.expire(at(RULE.holdMinSent, 19));
    expect(await followup(nudges, at(RULE.holdMinSent, 19))).toBe(false);
    expect(decisions().at(-1)).toBe("dropped");
    db.close();
  });

  test("answered nudges keep a bucket open", async () => {
    const { db, nudges } = ledger();
    for (let d = 0; d < 8; d++) {
      await followup(nudges, at(d, 19), `run-${d}`);
      if (d % 2 === 0) nudges.react(`run-${d}`, "opened", at(d, 20));
    }
    nudges.expire(at(9, 19));
    expect(await followup(nudges, at(9, 19))).toBe(true);
    db.close();
  });

  test("something the person asked for is never held, even in a bad bucket", async () => {
    const { db, nudges } = ledger();
    for (let d = 0; d < 6; d++) await followup(nudges, at(d, 19));
    nudges.expire(at(7, 19));
    expect(await nudges.send({ kind: "task", userRequested: true }, () => "desktop", at(7, 19))).toBe("desktop");
    expect(await nudges.send({ kind: "digest" }, () => "desktop", at(7, 19))).toBe("desktop");
    db.close();
  });

  test("the control arm skips the rule", async () => {
    const { db, nudges } = ledger();
    for (let d = 0; d < 6; d++) await followup(nudges, at(d, 19));
    nudges.expire(at(7, 19));
    const control = new Nudges(db.raw, { newId: controlId });
    expect(await followup(control, at(7, 19))).toBe(true);
    expect(db.raw.query("SELECT arm FROM nudges ORDER BY created_at DESC LIMIT 1").get()).toEqual({ arm: "control" });
    db.close();
  });
});

describe("what Cubby learned, with Undo (4.7)", () => {
  test(`${RULE.stopMinDismissed} closes out of ${RULE.stopMinSent} in the evening: stopped, said in one line; Undo brings it back`, async () => {
    const { db, nudges, decisions } = ledger();
    for (let d = 0; d < RULE.stopMinSent; d++) {
      await followup(nudges, at(d, 19), `run-${d}`);
      if (d < RULE.stopMinDismissed) nudges.react(`run-${d}`, "dismissed", at(d, 20));
      else nudges.react(`run-${d}`, "opened", at(d, 20)); // opened often enough not to be held
    }
    expect(nudges.learned()).toEqual([{ bucket: "followup:evening", line: "I stopped mentioning unfinished work in the evening. You closed it 3 times." }]);
    expect(await followup(nudges, at(9, 19))).toBe(false);
    expect(decisions().at(-1)).toBe("dropped");

    nudges.undo("followup:evening", at(9, 21));
    expect(nudges.learned()).toEqual([]);
    expect(await followup(nudges, at(10, 19))).toBe(true);
    db.close();
  });

  test("Undo ignores keys it does not know", () => {
    const { db, nudges } = ledger();
    nudges.undo("task:evening");
    nudges.undo("nonsense");
    expect(db.raw.query("SELECT value FROM meta WHERE key = 'proactive.rule-reset.v1'").get()).toBeNull();
    db.close();
  });
});

describe("the weekly receipt", () => {
  const job = (kind: "agent" | "watch", history: Array<{ runAt: number; status: string; proof?: object }>) => ({ kind, history }) as never;

  test("numbers only, and it says they stay on this computer", () => {
    const text = buildReceipt([job("agent", [{ runAt: 10, status: "success" }, { runAt: 20, status: "success" }]), job("watch", [{ runAt: 30, status: "waiting" }, { runAt: 40, status: "success", proof: {} }])], { wroteFirst: 4, answered: 2 }, 0);
    expect(text).toBe("Your week with Cinderpaw\n\n• Tasks ran 2 times.\n• I checked your watched pages 2 times and found what you wanted 1 time.\n• I wrote to you first 4 times; you answered or opened 2.\n\nThese numbers stay on this computer.");
    expect(buildReceipt([], { wroteFirst: 0, answered: 0 }, 0)).toBeNull();
  });

  test("goes out on Sunday at the digest hour, once", async () => {
    const file = `${process.env.TEMP ?? "/tmp"}/cp-receipt-${Date.now()}`;
    const sent: string[] = [];
    const o = { hour: 20, file, jobs: () => [], week: () => ({ wroteFirst: 3, answered: 1 }), send: async (t: string) => { sent.push(t); return "desktop"; } };
    expect(await maybeSendReceipt({ ...o, now: at(5, 21) })).toBeNull(); // Saturday
    expect(await maybeSendReceipt({ ...o, now: at(6, 19) })).toBeNull(); // Sunday, too early
    expect(await maybeSendReceipt({ ...o, now: at(6, 21) })).not.toBeNull();
    expect(await maybeSendReceipt({ ...o, now: at(6, 22) })).toBeNull(); // once
    expect(sent).toHaveLength(1);
  });
});

/**
 * The replay the spec asks for: six simulated weeks, costing nothing. The
 * person opens morning follow-ups, never the evening ones, and has one daily
 * reminder they asked for. Rule on vs off, same days.
 */
test("replay: with the rule on, 'ignored' goes down and what they asked for still arrives on time", async () => {
  async function run(rule: boolean) {
    const { db, nudges } = ledger({ rule });
    for (let d = 0; d < 42; d++) {
      nudges.expire(at(d, 8));
      await nudges.send({ kind: "task", userRequested: true }, () => "desktop", at(d, 9));
      if (await followup(nudges, at(d, 10), `m-${d}`)) nudges.react(`m-${d}`, "opened", at(d, 11));
      await followup(nudges, at(d, 19), `e-${d}`); // never touched
    }
    nudges.expire(at(43, 0));
    const m = nudges.metrics(at(43, 0));
    db.close();
    return m;
  }
  const off = await run(false);
  const on = await run(true);
  console.log("replay, rule off:", off);
  console.log("replay, rule on: ", on);
  expect(on.ignored).toBeLessThan(off.ignored);
  expect(on.onTime).toBe(1);
  expect(off.onTime).toBe(1);
  expect(on.answeredTwoWeeks).toBe(true);
});
