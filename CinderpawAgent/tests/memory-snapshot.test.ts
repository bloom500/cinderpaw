import { describe, expect, test } from "bun:test";
import { buildSnapshot, snapshotBudgetChars, ago, SNAPSHOT_HEADER } from "../src/memory/snapshot.ts";
import { stripToolsFromSystemPrompt } from "../src/egress/inference-providers.ts";
import type { Note } from "../src/memory/observations.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 27, 9);
let id = 0;
const n = (daysAgo: number, text: string, priority: Note["priority"] = "med", refDate: string | null = null): Note => ({
  id: ++id, sessionId: "s", scope: "", observedAt: NOW - daysAgo * DAY, refDate, priority, text,
  source: "observer", period: null, digestedAt: null,
});
const base = { now: NOW, card: null, facts: [], notes: [], digests: [], budgetChars: 8000 };

describe("buildSnapshot", () => {
  test("nothing known, nothing injected", () => {
    expect(buildSnapshot(base)).toBe("");
  });

  test("facts until a card exists, then the card", () => {
    const facts = [{ key: "name", value: "Darius" }];
    expect(buildSnapshot({ ...base, facts })).toContain("- name: Darius");
    const withCard = buildSnapshot({ ...base, facts, card: "Darius builds Cinderpaw." });
    expect(withCard).toContain("Darius builds Cinderpaw.");
    expect(withCard).not.toContain("- name: Darius");
  });

  test("notes grouped by day, oldest first, with age, priority and the date they are about", () => {
    const s = buildSnapshot({ ...base, notes: [n(0, "Asked for a recipe", "low"), n(3, "Flight to Lisbon", "high", "2026-10-12")] });
    expect(s.startsWith(`${SNAPSHOT_HEADER} (today is 2026-09-27, Sunday)`)).toBe(true);
    const older = s.indexOf("2026-09-24 (3 days ago)");
    const today = s.indexOf("2026-09-27 (today)");
    expect(older).toBeGreaterThan(0);
    expect(today).toBeGreaterThan(older);
    expect(s).toContain("- 🔴 Flight to Lisbon (for 2026-10-12)");
    expect(s).toContain("- 🟢 Asked for a recipe");
  });

  test("never exceeds the budget, keeps the newest notes", () => {
    const notes = Array.from({ length: 300 }, (_, i) => n(i, `note ${i} ${"x".repeat(80)}`));
    const s = buildSnapshot({ ...base, notes, budgetChars: 2000, card: "c".repeat(900) });
    expect(s.length).toBeLessThanOrEqual(2000);
    expect(s).toContain("note 0 ");
    expect(s).not.toContain("note 299 ");
  });

  test("digests come under Earlier", () => {
    const d: Note = { ...n(20, "Bought tickets and chose seats."), source: "reflector", period: "2026-09-01..2026-09-07" };
    expect(buildSnapshot({ ...base, digests: [d] })).toContain("Earlier:\n- 2026-09-01..2026-09-07: Bought tickets and chose seats.");
  });

  test("survives the provider stripping the tools block before it", () => {
    const system = `Base prompt\n\n## Available tools\n- read_file: reads\n\n${buildSnapshot({ ...base, card: "Card text." })}`;
    expect(stripToolsFromSystemPrompt(system)).toContain("Card text.");
  });
});

describe("helpers", () => {
  test("ago", () => {
    expect(ago(NOW, NOW)).toBe("today");
    expect(ago(NOW, NOW - DAY)).toBe("yesterday");
    expect(ago(NOW, NOW - 3 * DAY)).toBe("3 days ago");
    expect(ago(NOW, NOW - 21 * DAY)).toBe("3 weeks ago");
    expect(ago(NOW, NOW - 90 * DAY)).toBe("3 months ago");
  });
  test("snapshotBudgetChars clamps to 2000..8000", () => {
    expect(snapshotBudgetChars(1024)).toBe(2000);
    expect(snapshotBudgetChars(200_000)).toBe(8000);
    expect(snapshotBudgetChars(12_000)).toBe(3840);
  });
});
