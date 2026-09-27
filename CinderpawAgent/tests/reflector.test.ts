import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { SemanticMemory } from "../src/memory/semantic.ts";
import { ObservationStore, weekPeriod } from "../src/memory/observations.ts";
import { Reflector, memoryIdleTick, REFLECT_IDLE_MS } from "../src/memory/reflector.ts";
import type { ChatMessage, InferenceRouter } from "../src/types.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 27, 9);

function rig(reply: string) {
  const prompts: string[] = [];
  const router = {
    complete: async (req: { messages: ChatMessage[] }) => {
      prompts.push(req.messages.map((m) => m.content).join("\n---\n"));
      return { content: reply };
    },
    evictSession: () => {},
  } as unknown as InferenceRouter;
  const db = openDatabase(":memory:");
  const store = new ObservationStore(db.raw);
  const semantic = new SemanticMemory(db.raw, () => {});
  let now = NOW;
  const reflector = new Reflector({ router, store, semantic, now: () => now });
  return { db, store, semantic, reflector, prompts, setNow: (t: number) => (now = t) };
}
const add = (store: ObservationStore, at: number, text: string) =>
  store.add({ sessionId: "s", scope: "", observedAt: at, refDate: null, priority: "med", text });

describe("Reflector.due", () => {
  test("nothing to do on a fresh install", () => {
    const { db, reflector } = rig("");
    expect(reflector.due()).toBe(false);
    db.close();
  });
  test("five notes and no card is enough", () => {
    const { db, store, reflector } = rig("");
    for (let i = 0; i < 5; i++) add(store, NOW - i * 1000, `n${i}`);
    expect(reflector.due()).toBe(true);
    db.close();
  });
  test("an undigested note older than a week is enough", () => {
    const { db, store, reflector } = rig("");
    store.setCard("", "card", NOW);
    add(store, NOW - 9 * DAY, "old");
    expect(reflector.due()).toBe(true);
    db.close();
  });
});

describe("Reflector.run", () => {
  test("writes the card and one digest per requested week, mapped by week", async () => {
    const old = NOW - 9 * DAY;
    const week = weekPeriod(old);
    const { db, store, reflector, prompts } = rig(
      `=== CARD ===\nDarius builds Cinderpaw.\n=== DIGESTS ===\n${week} | Planned the Lisbon trip, 800 EUR.\n1999-01-04..1999-01-10 | invented week`,
    );
    const a = add(store, old, "Flight to Lisbon, 800 EUR");
    for (let i = 0; i < 5; i++) add(store, NOW - i * 1000, `recent ${i}`);
    expect(await reflector.run()).toBe(true);
    expect(store.card("")?.text).toBe("Darius builds Cinderpaw.");
    expect(store.digests("").map((d) => [d.period, d.text])).toEqual([[week, "Planned the Lisbon trip, 800 EUR."]]);
    expect(store.list("").find((n) => n.id === a)?.digestedAt).toBe(NOW);
    expect(prompts[0]).toContain(`${week}:`);
    db.close();
  });

  test("tells the model what was forgotten", async () => {
    const { db, store, semantic, reflector, prompts } = rig("=== CARD ===\nx\n=== DIGESTS ===\n");
    semantic.upsert("girlfriend", "Ana", "", "relationship", NOW - 5 * DAY);
    semantic.delete("girlfriend");
    for (let i = 0; i < 5; i++) add(store, NOW - i * 1000, `n${i}`);
    await reflector.run();
    expect(prompts[0]).toContain("FORGOTTEN (never mention): girlfriend");
    db.close();
  });

  test("an empty card is a failure and leaves the old card alone", async () => {
    const { db, store, reflector } = rig("I could not do it.");
    store.setCard("", "old card", NOW - DAY);
    for (let i = 0; i < 20; i++) add(store, NOW - i * 1000, `n${i}`);
    expect(await reflector.run()).toBe(false);
    expect(store.card("")?.text).toBe("old card");
    expect(reflector.health.failures).toBe(1);
    db.close();
  });

  test("the 4 h cooldown holds after a run", async () => {
    const { db, store, reflector, setNow } = rig("=== CARD ===\nx\n=== DIGESTS ===\n");
    for (let i = 0; i < 20; i++) add(store, NOW - i * 1000, `n${i}`);
    await reflector.run();
    for (let i = 0; i < 20; i++) add(store, NOW + 1000 + i, `m${i}`);
    setNow(NOW + 60 * 60_000);
    expect(reflector.due()).toBe(false);
    setNow(NOW + 5 * 60 * 60_000);
    expect(reflector.due()).toBe(true);
    db.close();
  });
});

describe("memoryIdleTick", () => {
  const fake = (due: boolean) => {
    const calls: string[] = [];
    return {
      calls,
      d: {
        reindex: async () => void calls.push("reindex"),
        reflector: { due: () => due, run: async () => (calls.push("run"), true) },
      },
    };
  };
  test("busy or not idle: touches nothing", async () => {
    const { calls, d } = fake(true);
    expect(await memoryIdleTick({ ...d, busy: true, idleMs: 1e9 })).toBe("busy");
    expect(await memoryIdleTick({ ...d, busy: false, idleMs: REFLECT_IDLE_MS - 1 })).toBe("not idle");
    expect(calls).toEqual([]);
  });
  test("idle: reindex, then reflect when due", async () => {
    const { calls, d } = fake(true);
    expect(await memoryIdleTick({ ...d, busy: false, idleMs: REFLECT_IDLE_MS })).toBe("ran");
    expect(calls).toEqual(["reindex", "run"]);
  });
});
