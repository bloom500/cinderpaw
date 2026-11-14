// Spec slice 5 (4.8): a machine that was never set up. An empty data folder,
// no keys, no messenger, no history. The free paths must still reach the
// person on the desktop, and the paid thought loop must stay off.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { cfgBool } from "../src/config.ts";
import { Nudges } from "../src/core/nudges.ts";
import { RunStore } from "../src/core/run-store.ts";
import { FollowUpLedger, offerFollowUp, recordInteractiveTurn } from "../src/core/proactive-followups.ts";

const dirs: string[] = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), "cinderpaw-new-install-"));
  dirs.push(dir);
  return openDatabase(join(dir, "data", "cinderpaw.db"));
}
// ponytail: Windows can keep the closed SQLite file locked a moment; a leftover temp folder is harmless.
afterEach(() => { for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch { /* locked */ } });

function ledgerRows(db: ReturnType<typeof openDatabase>) {
  return db.raw.query("SELECT kind, channel, user_requested FROM nudges").all();
}

describe("a new install (empty data folder, no messenger)", () => {
  test("a reminder rings on the desktop and is recorded", async () => {
    const db = freshHome();
    const nudges = new Nudges(db.raw);
    const fired: Array<string | null> = [];
    // Same call boot.ts makes when no messenger is connected: phone is null.
    const via = await nudges.route({ kind: "task", sourceId: "job-1", userRequested: true }, {
      phone: null,
      desktop: (rang) => { fired.push(rang); },
    });
    expect(via).toBe("desktop");
    expect(fired).toEqual([null]); // null = ring here
    expect(ledgerRows(db)).toEqual([{ kind: "task", channel: "desktop", user_requested: 1 }]);
    db.close();
  });

  test("unfinished work is offered as a card, while away too, never to a phone", async () => {
    const db = freshHome();
    const nudges = new Nudges(db.raw);
    const ledger = new FollowUpLedger(db.raw);
    recordInteractiveTurn(new RunStore(db.raw), "chat-1", "Plan my week", "out_of_time", "Ran out of time");
    const cards: string[] = [];
    const later = Date.now() + 11 * 60_000;
    const noon = new Date(later); noon.setHours(12, 0, 0, 0); // outside quiet hours
    if (noon.getTime() < later) noon.setDate(noon.getDate() + 1); // the next noon
    const at = noon.getTime();

    // Before the window reported the switch, the scheduler offers nothing.
    expect(await offerFollowUp({ from: "tick", ledger, nudges, phone: null, card: (f) => cards.push(f.mission), now: at })).toBeNull();
    // The window reports it on its first start (default on); then the card appears on the desktop.
    ledger.setEnabled(true, at)
    expect(await offerFollowUp({ from: "tick", ledger, nudges, phone: null, card: (f) => cards.push(f.mission), now: at })).toBe("desktop");
    expect(cards).toEqual(["Plan my week"]);
    expect(ledgerRows(db)).toEqual([{ kind: "followup", channel: "desktop", user_requested: 0 }]);
    db.close();
  });

  test("the thought loop (paid model calls) is not loaded by default", () => {
    const saved = [process.env.CINDERPAW_PROACTIVE_ENABLED, process.env.FERAL_PROACTIVE_ENABLED];
    delete process.env.CINDERPAW_PROACTIVE_ENABLED;
    delete process.env.FERAL_PROACTIVE_ENABLED;
    try {
      // boot.ts loads InnerThoughtsLoop only when this is true.
      expect(cfgBool("CINDERPAW_PROACTIVE_ENABLED")).toBe(false);
    } finally {
      if (saved[0] !== undefined) process.env.CINDERPAW_PROACTIVE_ENABLED = saved[0];
      if (saved[1] !== undefined) process.env.FERAL_PROACTIVE_ENABLED = saved[1];
    }
  });
});
