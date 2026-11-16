// Spec 4.14 (slice 10): pages the agent composes once, as data. Checked before
// they are saved; every card then reads its source with no model call. The
// same pieces serve any field: five fields below, nothing field-specific.
import { expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { checkPage, Pages, viewPage, type PageSpec } from "../src/core/pages.ts";
import { createComposePageTool } from "../src/tools/builtin/compose-page.ts";
import { OWNER_ONLY_TOOLS } from "../src/tools/tiers.ts";
import type { CronJob } from "../src/types.ts";

const now = new Date(2026, 10, 16, 14, 0).getTime();
const job = (o: Partial<CronJob>): CronJob => ({ id: "j", name: "x", task: "x", kind: "agent", enabled: true, schedule: { kind: "every", intervalMs: 3_600_000 },
  delivery: { kind: "chat", sessionId: "s" }, history: [], maxRetries: 3, retryCount: 0, createdAt: 0, updatedAt: 0, ...o } as CronJob);
const week = () => ({ wroteFirst: 4, answered: 2, days: [0, 1, 0, 1, 0, 2, 0] });

// Five fields, the same pieces.
const jobs: CronJob[] = [
  job({ id: "shop", kind: "watch", watch: { sourceUrl: "https://shop.example/h", priceBelow: 500, currency: "RON" }, prices: [{ at: 1, amount: 529 }, { at: 2, amount: 479 }] }), // shopping
  job({ id: "grade", kind: "watch", watch: { sourceUrl: "https://uni.example/grades", priceBelow: 9.5 }, prices: [{ at: 1, amount: 8.7 }, { at: 2, amount: 9.1 }] }), // school
  job({ id: "stock", kind: "watch", watch: { sourceUrl: "https://supplier.example/flour", priceBelow: 120, currency: "EUR" }, prices: [{ at: 1, amount: 130 }] }), // a small shop
  job({ id: "ci", name: "Nightly build report", nextRunMs: now + 3_600_000, history: [
    { runAt: 10, status: "success", durationMs: 1, result: "All 412 tests pass.\nmore" },
    { runAt: 20, status: "failed", durationMs: 1, error: "Build broke on main" },
  ] }), // code
  job({ id: "bins", kind: "reminder", name: "Put the bins out", nextRunMs: now + 5 * 3_600_000 }), // home
];

const pages: Record<string, PageSpec> = {
  shopping: { title: "Headphones", cards: [{ piece: "number_over_time", label: "Sony price", source: { kind: "watch", id: "shop" } }, { piece: "before_after", label: "Since I started watching", source: { kind: "watch", id: "shop" } }] },
  school: { title: "My thesis", cards: [{ piece: "countdown", label: "Hand-in", date: "2027-01-15T12:00:00Z" }, { piece: "number_over_time", label: "Average grade", source: { kind: "watch", id: "grade" } }, { piece: "plain_list", label: "Papers to read", items: ["Smith 2024", "Ionescu 2025"] }] },
  smallShop: { title: "Bakery costs", cards: [{ piece: "before_after", label: "Flour, 25 kg", source: { kind: "watch", id: "stock" } }, { piece: "your_numbers", label: "How Cubby helped this week" }] },
  code: { title: "Releases", cards: [{ piece: "done_with_proof", label: "Nightly build", source: { kind: "task", id: "ci" } }, { piece: "countdown", label: "Next report", source: { kind: "task", id: "ci" } }] },
  home: { title: "House", cards: [{ piece: "countdown", label: "Bins", source: { kind: "task", id: "bins" } }, { piece: "plain_list", label: "Shopping", items: ["Milk", "Bread"] }] },
};

test("five fields, the same pieces: every page is accepted and drawn from its sources", () => {
  for (const [field, spec] of Object.entries(pages)) {
    const r = checkPage(spec, jobs, now);
    expect("page" in r ? field : `${field}: ${(r as { error: string }).error}`).toBe(field);
  }
  const shop = viewPage("p1", (checkPage(pages.shopping, jobs, now) as { page: PageSpec }).page, jobs, week);
  expect(shop.cards).toEqual([
    { piece: "number_over_time", label: "Sony price", prices: [{ at: 1, amount: 529 }, { at: 2, amount: 479 }], limit: 500, unit: "RON" },
    { piece: "before_after", label: "Since I started watching", before: 529, after: 479, unit: "RON" },
  ]);
  const grade = viewPage("p2", pages.school, jobs, week).cards[1];
  expect(grade).toEqual({ piece: "number_over_time", label: "Average grade", prices: [{ at: 1, amount: 8.7 }, { at: 2, amount: 9.1 }], limit: 9.5 }); // no unit invented
  const code = viewPage("p3", pages.code, jobs, week).cards;
  expect(code[0]).toEqual({ piece: "done_with_proof", label: "Nightly build", runs: [{ at: 20, ok: false, text: "Build broke on main" }, { at: 10, ok: true, text: "All 412 tests pass." }] });
  expect(code[1]).toEqual({ piece: "countdown", label: "Next report", at: now + 3_600_000 });
  expect(viewPage("p4", pages.smallShop, jobs, week).cards[1]).toEqual({ piece: "your_numbers", label: "How Cubby helped this week", ...week() });
});

test("refused before saving: unknown piece, too many cards, missing or wrong source, bad date, long text", () => {
  const err = (spec: unknown) => (checkPage(spec, jobs, now) as { error?: string }).error;
  expect(err({ title: "x", cards: [{ piece: "html", label: "x" }] })).toContain("piece must be one of");
  expect(err({ title: "x", cards: Array.from({ length: 9 }, () => ({ piece: "plain_list", label: "x", items: ["a"] })) })).toBe("A page has 1-8 cards.");
  expect(err({ title: "x", cards: [{ piece: "number_over_time", label: "x", source: { kind: "watch", id: "nope" } }] })).toContain("no task or watch with that id");
  expect(err({ title: "x", cards: [{ piece: "number_over_time", label: "x", source: { kind: "task", id: "ci" } }] })).toContain("needs a price watch");
  expect(err({ title: "x", cards: [{ piece: "countdown", label: "x", date: "2099-01-01" }] })).toContain("within 5 years");
  expect(err({ title: "x".repeat(61), cards: [{ piece: "your_numbers", label: "x" }] })).toBe("The title must be 1-60 characters.");
  expect(err({ title: "x", cards: [{ piece: "plain_list", label: "x", items: ["y".repeat(121)] }] })).toContain("up to 120 characters");
});

test("a removed source shows as gone, not as a crash", () => {
  expect(viewPage("p", pages.home, [], week).cards[0]).toEqual({ piece: "gone", label: "Bins" });
});

test("the tool saves, lists and removes; only the owner can use it", async () => {
  const db = openDatabase(":memory:");
  const store = new Pages(db.raw);
  const tool = createComposePageTool(store, () => jobs);
  const r = await tool.execute({ title: "My thesis", cards: pages.school.cards }, {} as never);
  expect(r.ok).toBe(true);
  const [saved] = store.views(jobs, week);
  expect(saved!.title).toBe("My thesis");
  expect(saved!.cards.map((c) => c.piece)).toEqual(["countdown", "number_over_time", "plain_list"]);
  expect((await tool.execute({ title: "Bad", cards: [{ piece: "html", label: "x" }] }, {} as never)).ok).toBe(false);
  expect(store.list()).toHaveLength(1);
  expect((await tool.execute({ remove: saved!.id }, {} as never)).content).toBe("Removed the page.");
  expect(store.list()).toEqual([]);
  expect(OWNER_ONLY_TOOLS.has("compose_page")).toBe(true);
  db.close();
});

test("a question card: checked, answered only by the person's button, read back by the agent", async () => {
  const db = openDatabase(":memory:");
  const store = new Pages(db.raw);
  const tool = createComposePageTool(store, () => jobs);
  expect((await tool.execute({ title: "Shop", cards: [{ piece: "question", label: "Supplier", ask: "y".repeat(121) }] }, {} as never)).ok).toBe(false);
  // The model cannot pre-answer: checkPage drops `answer`.
  await tool.execute({ title: "Shop", cards: [{ piece: "plain_list", label: "Today", items: ["Bread"] }, { piece: "question", label: "Supplier", ask: "Should I ask Moara Noua for a price?", answer: "yes" }] }, {} as never);
  const id = store.list()[0]!.id;
  expect(store.views(jobs, week)[0]!.cards[1]).toEqual({ piece: "question", label: "Supplier", ask: "Should I ask Moara Noua for a price?" });
  expect(store.answer(id, 0, true)).toBe(false); // not a question card
  expect(store.answer(id, 1, true)).toBe(true);
  expect(store.views(jobs, week)[0]!.cards[1]).toEqual({ piece: "question", label: "Supplier", ask: "Should I ask Moara Noua for a price?", answer: "yes" });
  expect((await tool.execute({}, {} as never)).content).toContain('"answer": "yes"');
  db.close();
});

test("a recipe keeps the cards and blanks out this person's sources and answers", () => {
  const recipe = JSON.parse(viewPage("p", { title: "Headphones", cards: [
    { piece: "number_over_time", label: "Sony price", source: { kind: "watch", id: "shop" } },
    { piece: "question", label: "Buy?", ask: "Buy at 479?", answer: "yes" },
  ] }, jobs, week).recipe);
  expect(recipe).toEqual({ recipe: "cinderpaw-page/1", title: "Headphones", cards: [
    { piece: "number_over_time", label: "Sony price", source: { kind: "watch", blank: "pick your watch" } },
    { piece: "question", label: "Buy?", ask: "Buy at 479?" },
  ] });
  expect(JSON.stringify(recipe)).not.toContain("shop");
});
