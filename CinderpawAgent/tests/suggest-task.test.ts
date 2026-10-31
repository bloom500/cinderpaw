import { describe, expect, test } from "bun:test";
import { buildSchedule, createSuggestTaskTool, SuggestionLedger } from "../src/tools/builtin/suggest-task.ts";
import { isOwnerOnlyTool } from "../src/tools/tiers.ts";

const NOW = new Date(2026, 9, 24, 17, 0); // Sat 24 Oct 2026, 17:00 local
const ctx = { sessionId: "s1" } as never;

describe("buildSchedule", () => {
  test("plain fields become a schedule and its words; no cron from the model", () => {
    expect(buildSchedule({ repeat: "weekdays", time: "9:00" }, NOW)).toEqual({ schedule: { kind: "cron", expression: "0 9 * * 1-5" }, when: "Every weekday at 09:00" });
    expect(buildSchedule({ repeat: "daily", time: "21:30" }, NOW)).toEqual({ schedule: { kind: "cron", expression: "30 21 * * *" }, when: "Every day at 21:30" });
    expect(buildSchedule({ repeat: "weekly", day: "Monday", time: "08:15" }, NOW)).toEqual({ schedule: { kind: "cron", expression: "15 8 * * 1" }, when: "Every Monday at 08:15" });
    expect(buildSchedule({ repeat: "hourly", every_hours: 6 }, NOW)).toEqual({ schedule: { kind: "every", intervalMs: 6 * 3_600_000 }, when: "Every 6 hours" });
  });

  test("a one-time task is in local time and must be in the future", () => {
    const r = buildSchedule({ repeat: "once", date: "2026-10-26", time: "10:00" }, NOW);
    expect("schedule" in r && r.schedule.kind === "at" && new Date(r.schedule.isoTimestamp).getHours()).toBe(10);
    expect(buildSchedule({ repeat: "once", date: "2026-10-24", time: "16:00" }, NOW)).toEqual({ error: expect.stringMatching(/passed/) });
    expect(buildSchedule({ repeat: "once", date: "2026-02-30", time: "10:00" }, NOW)).toEqual({ error: expect.stringMatching(/does not exist/) });
  });

  test("bad input is refused with a reason the model can fix", () => {
    expect(buildSchedule({ repeat: "sometimes" }, NOW)).toEqual({ error: expect.stringMatching(/repeat must be/) });
    expect(buildSchedule({ repeat: "daily", time: "25:00" }, NOW)).toEqual({ error: expect.stringMatching(/HH:MM/) });
    expect(buildSchedule({ repeat: "hourly", every_hours: 0.2 }, NOW)).toEqual({ error: expect.stringMatching(/between 1 and 168/) });
  });
});

describe("suggest_task", () => {
  test("condition watches are proposed with an explicit public source, expiry and zero inference budget", async () => {
    const tool = createSuggestTaskTool(new SuggestionLedger(), () => NOW);
    const r = await tool.execute({
      title: "Watch the release", task: "Tell me when the release is available.", kind: "watch", repeat: "hourly",
      watch: { sourceUrl: "https://example.com/releases", contains: "Version 2.0 is available", official: true },
    }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as any).taskSuggestion).toMatchObject({ kind: "watch", expiryDays: 30,
      watch: { sourceUrl: "https://example.com/releases", contains: "Version 2.0 is available", official: true } });
  });

  test.each([
    { sourceUrl: "http://example.com/releases", contains: "released" },
    { sourceUrl: "https://127.0.0.1/private", contains: "released" },
    { sourceUrl: "https://localhost/private", contains: "released" },
    { sourceUrl: "https://user:secret@example.com/releases", contains: "released" },
    { sourceUrl: "https://example.com/releases", contains: " " },
  ])("invalid watch conditions never produce a card: %j", async watch => {
    const r = await createSuggestTaskTool().execute({ title: "Watch", task: "Check the release.", kind: "watch", repeat: "hourly", watch }, ctx);
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
  });

  test("agent proposals carry no per-task money cap: one weekly limit covers all tasks", async () => {
    const args = { title: "Check the weather", task: "Check the weather in Cluj.", kind: "agent", repeat: "hourly" };
    const r = await createSuggestTaskTool().execute(args, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as any).taskSuggestion.budgetUsd).toBeUndefined();
  });

  test("offers a card and creates nothing; the same title or a quick second card is held back", async () => {
    let t = NOW.getTime();
    const tool = createSuggestTaskTool(new SuggestionLedger(), () => new Date(t));
    const r = await tool.execute({ title: "Call the bank", task: "Call the bank about the card.", kind: "reminder", repeat: "once", date: "2026-10-26", time: "09:00" }, ctx);
    const card = (r.data as { taskSuggestion: { kind: string; when: string } }).taskSuggestion;
    expect(card.kind).toBe("reminder");
    expect(card.when).toMatch(/^Mon,? 26 Oct at 09:00$/);
    expect(r.content).toMatch(/created only when they press Create/);
    const again = await tool.execute({ title: "call the BANK", task: "x", kind: "reminder", repeat: "daily", time: "09:00" }, ctx);
    expect((again.data as { taskSuggestion?: unknown })?.taskSuggestion).toBeUndefined();
    t += 60_000;
    const quick = await tool.execute({ title: "Water the plants", task: "x", kind: "reminder", repeat: "daily", time: "19:00" }, ctx);
    expect((quick.data as { taskSuggestion?: unknown })?.taskSuggestion).toBeUndefined();
  });

  test("with no phone connected, the first card in a chat offers WhatsApp once; a connected phone never hears it", async () => {
    let t = NOW.getTime();
    const card = (title: string) => ({ title, task: "x", kind: "reminder", repeat: "daily", time: "09:00" });
    const offline = createSuggestTaskTool(new SuggestionLedger(), () => new Date(t), () => null);
    const first = await offline.execute(card("Water the plants"), ctx);
    expect(first.content).toMatch(/WhatsApp.*connectors_manage/);
    t += 10 * 60_000;
    const second = await offline.execute(card("Feed the cat"), ctx);
    expect(second.ok).toBe(true);
    expect(second.content).not.toMatch(/WhatsApp/);
    const online = createSuggestTaskTool(new SuggestionLedger(), () => NOW, () => "telegram");
    expect((await online.execute(card("Water the plants"), ctx)).content).not.toMatch(/WhatsApp/);
  });

  test("never reaches a stranger on a connector", () => {
    expect(isOwnerOnlyTool("suggest_task")).toBe(true);
  });
});

describe("in_minutes", () => {
  test("a reminder in N minutes is counted from now, no clock reading needed", () => {
    const r = buildSchedule({ repeat: "once", in_minutes: 3 }, NOW);
    expect(r).toEqual({ schedule: { kind: "at", isoTimestamp: new Date(NOW.getTime() + 180_000).toISOString() }, when: "Today at 17:03" });
    expect(buildSchedule({ repeat: "once", in_minutes: 0 }, NOW)).toEqual({ error: expect.stringMatching(/in_minutes/) });
  });
});
