// Spec slice 9: the thought loop talks only about real things. No real model:
// fetch is faked, like tests/proactive-loop.test.ts.
import { afterEach, expect, test } from "bun:test";
import { openDatabase } from "../src/db.ts";
import { AuditLog } from "../src/egress/audit-log.ts";
import { InferenceRouter } from "../src/egress/inference-router.ts";
import { EpisodicMemory } from "../src/memory/episodic.ts";
import { MoodEngine } from "../src/core/mood.ts";
import { InnerThoughtsLoop } from "../src/core/inner-thoughts.ts";
import { namedThought, teamThoughtSituation, thoughtSituation, type Situation } from "../src/core/thought-situation.ts";
import type { CronJob, OutboundEvent } from "../src/types.ts";

const now = new Date(2026, 10, 16, 14, 0).getTime();
const job = (o: Partial<CronJob>): CronJob => ({ id: "j", name: "x", task: "x", kind: "agent", enabled: true, schedule: { kind: "every", intervalMs: 3_600_000 },
  delivery: { kind: "chat", sessionId: "s" }, history: [], maxRetries: 3, retryCount: 0, createdAt: 0, updatedAt: 0, ...o } as CronJob);

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("the situation: enabled watches with their last check, tasks due within a day, unfinished work, the week", () => {
  const db = openDatabase(":memory:");
  const s = thoughtSituation(() => [
    job({ id: "a", name: "Headphones under 500", kind: "watch", history: [{ runAt: 1, status: "waiting", durationMs: 1, result: "Read 529 RON. Waiting for under 500 RON." }] }),
    job({ id: "b", name: "Paused watch", kind: "watch", enabled: false }),
    job({ id: "c", name: "Weekly report", nextRunMs: now + 3_600_000 }),
    job({ id: "d", name: "Next month", nextRunMs: now + 40 * 86_400_000 }),
  ], db.raw, () => ({ wroteFirst: 4, answered: 1 }), now);
  expect(s.items.map((i) => i.id)).toEqual(["W1", "T1"]);
  expect(s.items[0]!.line).toBe('Watch "Headphones under 500", last check: Read 529 RON. Waiting for under 500 RON.');
  expect(s.items[1]!.line).toStartWith('Task "Weekly report" runs Mon Nov 16 2026 15:00');
  expect(s.notes).toEqual(["Last 7 days: you wrote first 4 times; the person opened, answered or acted on 1."]);
  db.close();
});

test("a thought must name a known item; the tag is taken off", () => {
  const ids = new Set(["W1", "T1"]);
  expect(namedThought("[W1] The headphones are at 529 now, close to your 500.", ids)).toBe("The headphones are at 529 now, close to your 500.");
  expect(namedThought("[W9] Something", ids)).toBeNull();
  expect(namedThought("Just checking in! How are you?", ids)).toBeNull();
  expect(namedThought("[W1]", ids)).toBeNull();
});

function loop(reply: string, situation: () => Situation) {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db.raw);
  const router = new InferenceRouter({ primary: { provider: "ollama", model: "m", baseUrl: "http://localhost:11434" },
    tokenBudget: { perConversation: 50_000, perDay: 500_000, onExhausted: "stop" } }, audit.logger, db.raw);
  const mood = new MoodEngine();
  mood.applyEvent("new_topic");
  const calls: string[] = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(JSON.stringify({ message: { content: reply }, prompt_eval_count: 5, eval_count: 5 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const l = new InnerThoughtsLoop(router, new EpisodicMemory(db.raw, audit.logger), mood, db.raw,
    { intervalMs: 10, minIdleMs: 10, cooldownMs: 10, dailyCap: 100, situation });
  const events: OutboundEvent[] = [];
  l.setEmit((e) => events.push(e));
  return { l, events, calls, close: () => db.close() };
}

const one: Situation = { items: [{ id: "W1", line: 'Watch "Headphones under 500", last check: Read 529 RON.' }], notes: [] };

test("one shared reflection tick picks one eligible teammate and reads their own work", async () => {
  const db = openDatabase(":memory:");
  const roster = ["Atlas", "Bolt", "Scout"].map((name) => ({ id: name.toLowerCase(), name, role: "Research" }));
  const jobs = roster.slice(0, 2).map((agent) => job({ name: agent.name + " watch", ownerAgentId: agent.id, kind: "watch" }));
  const next = teamThoughtSituation(() => roster, (owner) => thoughtSituation(() => jobs, db.raw, () => ({ wroteFirst: 0, answered: 0 }), now, owner));
  const atlas = loop("[W1] I checked the price.", next);
  await atlas.l.tickNow();
  expect(atlas.events).toEqual([{ type: "proactive", ownerAgentId: "atlas", content: "I checked the price." }]);
  expect(atlas.calls).toHaveLength(1);
  expect(atlas.calls[0]).toContain("Atlas watch");
  expect(atlas.calls[0]).not.toContain("Bolt watch");
  expect(next().owner?.id).toBe("bolt");
  expect(next().owner?.id).toBe("atlas");
  atlas.close();
  db.close();
});

test("named: sent without the tag, and the model saw the list", async () => {
  const t = loop("[W1] The headphones dropped to 529, close to your 500.", () => one);
  await t.l.tickNow();
  expect(t.events).toEqual([{ type: "proactive", content: "The headphones dropped to 529, close to your 500." }]);
  expect(t.calls[0]).toContain("[W1] Watch \\\"Headphones under 500\\\"");
  t.close();
});

test("filler that names nothing is not sent; an empty list costs no model call", async () => {
  const a = loop("Hey! Hope your day is going well.", () => one);
  await a.l.tickNow();
  expect(a.events).toEqual([]);
  a.close();
  const b = loop("[W1] anything", () => ({ items: [], notes: [] }));
  await b.l.tickNow();
  expect(b.calls).toEqual([]);
  expect(b.events).toEqual([]);
  b.close();
});
