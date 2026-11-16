// Spec 4.7: "stop telling me about X", said in chat. Writes the same learned
// line as the rule, with the same Undo; never touches what the person set up.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { Nudges } from "../src/core/nudges.ts";
import { createQuietNudgesTool } from "../src/tools/builtin/quiet-nudges.ts";
import { OWNER_ONLY_TOOLS } from "../src/tools/tiers.ts";

const noon = new Date(2026, 10, 16, 13, 0).getTime();
// "00000005-..." would be the control arm; a stop said in words applies to it too.
const ids = ["00000005-0000-4000-8000-000000000000", "00000006-0000-4000-8000-000000000000"];

test("said in chat: that kind stops at every hour, shows on My day, and Undo brings it back", async () => {
  const db = openDatabase(":memory:");
  let i = 0;
  const nudges = new Nudges(db.raw, { newId: () => ids[i++ % 2]! });
  const tool = createQuietNudgesTool(nudges);
  const sent = (kind: "followup" | "task" | "watch", userRequested = false) =>
    nudges.send({ kind, sourceId: `s${i}`, userRequested }, () => "desktop", noon);

  const r = await tool.execute({ about: "unfinished_work" }, {} as never);
  expect(r).toEqual({ ok: true, content: "Done. You asked me to stop mentioning unfinished work. They can undo it on the My day page." });
  expect(nudges.learned()).toEqual([{ bucket: "followup:asked", line: "You asked me to stop mentioning unfinished work." }]);

  expect(await sent("followup")).toBeNull(); // control-arm id
  expect(await sent("followup")).toBeNull(); // rule-arm id
  // What the person set up still arrives.
  expect(await sent("task", true)).toBe("desktop");
  expect(await sent("watch", true)).toBe("desktop");

  nudges.undo("followup:asked", noon);
  expect(nudges.learned()).toEqual([]);
  expect(await sent("followup")).toBe("desktop");
  db.close();
});

test("start again from chat, wrong kinds refused, and only the owner can use it", async () => {
  const db = openDatabase(":memory:");
  const nudges = new Nudges(db.raw);
  const tool = createQuietNudgesTool(nudges);
  await tool.execute({ about: "weekly_summary" }, {} as never);
  expect((await tool.execute({ about: "weekly_summary", start_again: true }, {} as never)).content).toBe("Done. I can mention the weekly summary again.");
  expect(nudges.learned()).toEqual([]);
  expect((await tool.execute({ about: "tasks" }, {} as never)).ok).toBe(false);
  expect(() => nudges.stop("watch")).toThrow("can be stopped");
  expect(OWNER_ONLY_TOOLS.has("quiet_nudges")).toBe(true);
  db.close();
});
