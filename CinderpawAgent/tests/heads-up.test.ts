/**
 * heads_up: "Something you should know" while the agent keeps working. The
 * card rides the tool's `data`; it stays rare (no repeat title, two minutes
 * apart) and "I already knew this" reaches the agent on its next card.
 */

import { describe, expect, test } from "bun:test";
import { HeadsUpLedger, createHeadsUpTool } from "../src/tools/builtin/heads-up.ts";
import type { ToolContext } from "../src/types.ts";

const ctx = (sessionId = "s1") => ({ sessionId }) as unknown as ToolContext;

function harness() {
  let t = 1_000_000;
  const ledger = new HeadsUpLedger();
  const tool = createHeadsUpTool(ledger, () => t);
  return { ledger, tool, later: (ms: number) => (t += ms) };
}

const card = (r: { data?: unknown }) => (r.data as { headsUp?: { id: string; title: string; detail: string; more?: string } } | undefined)?.headsUp;

describe("heads_up", () => {
  test("shows a card the app draws from data, and tells the agent not to wait", async () => {
    const { tool } = harness();
    const r = await tool.execute({ title: "The total does not match", detail: "You said 1,200 lei; the PDF says 1,450.", more: "Page 2 adds a line." }, ctx());
    expect(r.ok).toBe(true);
    expect(card(r)).toMatchObject({ title: "The total does not match", detail: "You said 1,200 lei; the PDF says 1,450.", more: "Page 2 adds a line." });
    expect(card(r)!.id).toBeTruthy();
    expect(r.content).toContain("do not wait");
  });

  test("a title or detail missing, or too long, is refused with an example", async () => {
    const { tool } = harness();
    expect((await tool.execute({ title: "x" }, ctx())).error).toContain("Example");
    expect((await tool.execute({ title: "x".repeat(91), detail: "y" }, ctx())).ok).toBe(false);
  });

  test("the same title is never shown twice in a chat; another chat may show it", async () => {
    const { tool, later } = harness();
    await tool.execute({ title: "Missing file", detail: "notes.txt is not there." }, ctx());
    later(10 * 60_000);
    const again = await tool.execute({ title: "  missing FILE ", detail: "Still missing." }, ctx());
    expect(card(again)).toBeUndefined();
    expect(again.content).toContain("Already shown");
    expect(card(await tool.execute({ title: "Missing file", detail: "notes.txt is not there." }, ctx("s2")))).toBeDefined();
  });

  test("a second card within two minutes is refused: say it in the reply", async () => {
    const { tool, later } = harness();
    await tool.execute({ title: "One", detail: "First." }, ctx());
    later(60_000);
    const soon = await tool.execute({ title: "Two", detail: "Second." }, ctx());
    expect(card(soon)).toBeUndefined();
    expect(soon.content).toContain("say it in your reply");
    later(61_000);
    expect(card(await tool.execute({ title: "Two", detail: "Second." }, ctx()))).toBeDefined();
  });

  test("'I already knew this' reaches the agent with its next card", async () => {
    const { ledger, tool, later } = harness();
    const first = card(await tool.execute({ title: "Prices are in euro", detail: "The sheet uses EUR." }, ctx()))!;
    expect(ledger.answer("s1", first.id, "knew")).toBe("Prices are in euro");
    expect(ledger.answer("s1", "not-a-card", "knew")).toBeNull();
    later(3 * 60_000);
    const next = await tool.execute({ title: "Two rows are duplicates", detail: "Rows 4 and 9 are the same." }, ctx());
    expect(next.content).toContain("They already knew: Prices are in euro");
  });
});
