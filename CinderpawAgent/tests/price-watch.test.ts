// Spec slice 6 (4.10, 4.11): price watches. Saved shop pages, no live network,
// no model. Fixtures are real product pages from 15 Nov 2026, trimmed to their
// price markup (eMAG: JSON-LD; evoMAG and Thomann: microdata).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db.ts";
import { CronJobsRepo } from "../src/cron/jobs.ts";
import { CronScheduler } from "../src/cron/scheduler.ts";
import { NO_PRICE, checkWatch, firstPriceRead, readPrice } from "../src/cron/watch.ts";
import { Nudges } from "../src/core/nudges.ts";
import { PhoneOffers } from "../src/core/phone-offers.ts";
import { createSuggestTaskTool, type TaskSuggestion } from "../src/tools/builtin/suggest-task.ts";
import type { CinderpawFetch, CronJobInput } from "../src/types.ts";

const shop = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "shops", `${name}.html`), "utf8");
const page = (html: string): CinderpawFetch => (async () => ({ ok: true, status: 200, headers: { "content-type": "text/html" }, text: async () => html, json: async () => null })) as never;
const product = (price: number) => `<html><head><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Headphones", offers: { "@type": "Offer", price: String(price), priceCurrency: "RON" } })}</script></head><body>Headphones</body></html>`;
const URL_ = "https://shop.example/headphones";

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function repo() { const db = openDatabase(":memory:"); dbs.push(db); return { db, repo: new CronJobsRepo(db.raw) }; }

describe("reading the price a page declares", () => {
  test("three real shops, three answers", () => {
    expect(readPrice(shop("emag"))).toEqual({ amount: 1799.99, currency: "RON" }); // JSON-LD
    expect(readPrice(shop("evomag"))).toEqual({ amount: 1179.99, currency: "RON" }); // microdata
    expect(readPrice(shop("thomann"))).toEqual({ amount: 799, currency: "RON" }); // microdata
  });

  test("meta tags, in either attribute order, and JSON-LD inside @graph", () => {
    expect(readPrice(`<meta content="49.90" property="product:price:amount"><meta property="product:price:currency" content="EUR">`)).toEqual({ amount: 49.9, currency: "EUR" });
    expect(readPrice(`<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":["Product"],"offers":[{"price":"1799,99","priceCurrency":"RON"}]}]}</script>`)).toEqual({ amount: 1799.99, currency: "RON" });
  });

  test("no structured price: nothing is guessed from the visible text", () => {
    expect(readPrice("<html><body><span class=price>529 lei</span></body></html>")).toBeNull();
    expect(readPrice(`<script type="application/ld+json">{ broken</script>`)).toBeNull();
  });
});

describe("one check", () => {
  test("fires below the limit, with the price read and the link", async () => {
    const r = await checkWatch({ sourceUrl: URL_, priceBelow: 2000, currency: "RON" }, page(shop("emag")), 5);
    expect(r.proof).toMatchObject({ sourceUrl: URL_, checkedAt: 5, price: 1799.99 });
    expect(r.result).toBe(`The price dropped to 1799.99 RON, under your 2000 RON.\n${URL_}`);
  });

  test("stays silent above it, and says what it read", async () => {
    const r = await checkWatch({ sourceUrl: URL_, priceBelow: 1500 }, page(shop("emag")), 5);
    expect(r.proof).toBeUndefined();
    expect(r.result).toBe("Read 1799.99 RON. Waiting for under 1500 RON.");
  });

  test("fails closed with a clear sentence when the page has no price", async () => {
    await expect(checkWatch({ sourceUrl: URL_, priceBelow: 500 }, page("<body>Sold out</body>"), 5)).rejects.toThrow(NO_PRICE);
  });

  test("a shop that never answers gets a sentence a person can act on", async () => {
    const silent: CinderpawFetch = (async () => { throw new Error("EgressError: request timed out after 60000ms"); }) as never;
    await expect(checkWatch({ sourceUrl: "https://altex.ro/casti/cpd/X/", priceBelow: 500 }, silent, 5))
      .rejects.toThrow("altex.ro did not answer. Some shops block automatic readers. Try the same product on another shop.");
    const refused: CinderpawFetch = (async () => ({ ok: false, status: 403, headers: {}, text: async () => "", json: async () => null })) as never;
    await expect(checkWatch({ sourceUrl: "https://www.pcgarage.ro/x", priceBelow: 500 }, refused, 5)).rejects.toThrow("pcgarage.ro refused the read (HTTP 403)");
  });

  test("a page that changed currency is not compared", async () => {
    await expect(checkWatch({ sourceUrl: URL_, priceBelow: 500, currency: "EUR" }, page(shop("thomann")), 5)).rejects.toThrow("in RON, not EUR");
  });

  test("text watches answer as before", async () => {
    const r = await checkWatch({ sourceUrl: URL_, contains: "Version 3" }, page("<body>Version 2</body>"), 5);
    expect(r).toEqual({ proof: undefined, result: "Checked source; expected text is not present yet." });
  });
});

describe("turning one on", () => {
  test("the first read is what the person is told; already under the limit means nothing to wait for", async () => {
    expect(await firstPriceRead({ sourceUrl: URL_, priceBelow: 500 }, page(product(529)))).toEqual({ text: "I read 529 RON on this page today. I will tell you when it is under 500 RON.", below: false });
    expect((await firstPriceRead({ sourceUrl: URL_, priceBelow: 500 }, page(product(479)))).below).toBe(true);
  });

  test("a task stores a price watch; a bad limit or currency is refused", () => {
    const { repo: r } = repo();
    const base = { name: "Headphones", task: "Headphones under 500", kind: "watch", schedule: { kind: "every", intervalMs: 3_600_000 }, delivery: { kind: "chat", sessionId: "chat" } } as const;
    expect(r.upsert({ ...base, watch: { sourceUrl: URL_, priceBelow: 500, currency: "RON" } } as CronJobInput).watch).toEqual({ sourceUrl: URL_, priceBelow: 500, currency: "RON" });
    expect(() => r.upsert({ ...base, watch: { sourceUrl: URL_, priceBelow: 0 } } as CronJobInput)).toThrow("above zero");
    expect(() => r.upsert({ ...base, watch: { sourceUrl: URL_, priceBelow: 500, currency: "lei" } } as CronJobInput)).toThrow("three-letter");
  });

  test("price reads are numbers only, kept 31 days, and go with the watch", () => {
    const { repo: r } = repo();
    const base = { name: "Headphones", task: "Headphones under 500", kind: "watch", schedule: { kind: "every", intervalMs: 3_600_000 }, delivery: { kind: "chat", sessionId: "chat" } } as const;
    const watch = r.upsert({ ...base, watch: { sourceUrl: URL_, priceBelow: 500 } } as CronJobInput);
    const text = r.upsert({ ...base, watch: { sourceUrl: URL_, contains: "in stock" } } as CronJobInput);
    const day = 86_400_000;
    r.addPrice(watch.id, 0, 600);
    r.addPrice(watch.id, 32 * day, 550);
    expect(r.forPeople().find((j) => j.id === watch.id)!.prices).toEqual([{ at: 32 * day, amount: 550 }]);
    expect(r.forPeople().find((j) => j.id === text.id)!.prices).toBeUndefined();
    r.remove(watch.id);
    r.upsert({ ...base, id: watch.id, watch: { sourceUrl: URL_, priceBelow: 500 } } as CronJobInput);
    expect(r.forPeople().find((j) => j.id === watch.id)!.prices).toEqual([]);
  });

  test("suggest_task offers a price watch with the price the agent saw, and downloads nothing", async () => {
    const tool = createSuggestTaskTool();
    const res = await tool.execute({ title: "Headphones under 500", task: "Sony headphones under 500 lei", kind: "watch", repeat: "hourly", asked: true,
      watch: { sourceUrl: URL_, priceBelow: 500, currency: "ron", seenPrice: 529 } }, { sessionId: "s" } as never);
    const card = (res.data as { taskSuggestion: TaskSuggestion }).taskSuggestion;
    expect(card.watch).toEqual({ sourceUrl: URL_, priceBelow: 500, currency: "RON" });
    expect(card.seenPrice).toBe(529);
    // Seen 1199 with a limit of 1500 (the 15 Nov live test): nothing to wait for, so no card.
    const already = await createSuggestTaskTool().execute({ title: "XM5 under 1500", task: "Sony XM5 under 1500 lei", kind: "watch", repeat: "hourly", asked: true,
      watch: { sourceUrl: URL_, priceBelow: 1500, seenPrice: 1199 } }, { sessionId: "s" } as never);
    expect(already.ok).toBe(false);
    expect(already.error).toContain("already under 1500");
    const noCondition = await createSuggestTaskTool().execute({ title: "X", task: "X", kind: "watch", repeat: "hourly", watch: { sourceUrl: URL_ } }, { sessionId: "s" } as never);
    expect(noCondition.ok).toBe(false);
  });
});

test("the headphones scenario, start to finish: offer, 'da' on the phone, a drop days later, one message, answered", async () => {
  const { db, repo: r } = repo();
  const nudges = new Nudges(db.raw);
  let price = 529;
  const fetch = () => page(product(price));
  const sent: string[] = [];

  // 1. In a WhatsApp chat the agent offers a watch, with the price it saw.
  const offers = new PhoneOffers({
    isChat: () => true, isOwner: () => true,
    // As boot.ts: read once, then create; the reply says what was read.
    create: (card, sessionId) => firstPriceRead(card.watch as never, fetch()).then((read) => {
      r.upsert({ name: card.title, task: card.task, kind: card.kind, schedule: card.schedule, delivery: { kind: "chat", sessionId, phone: true }, watch: card.watch, expiryDays: card.expiryDays });
      return `✅ Turned on: "${card.title}". ${read.text}`;
    }),
  });
  const tool = createSuggestTaskTool(undefined, undefined, undefined, (sid, card) => offers.offer(sid, card));
  await tool.execute({ title: "Headphones under 500", task: "Sony headphones under 500 lei", kind: "watch", repeat: "hourly", asked: true,
    watch: { sourceUrl: URL_, priceBelow: 500, currency: "RON", seenPrice: 529 } }, { sessionId: "whatsapp:me" } as never);
  expect(offers.tail("whatsapp:me")).toBe(`"Headphones under 500", every hour. I saw 529 on the page. Reply "yes" to turn it on.`);

  // 2. The owner says "da": the page is read and the reply says the price.
  expect(await offers.answer("whatsapp:me", "da")).toBe(`✅ Turned on: "Headphones under 500". I read 529 RON on this page today. I will tell you when it is under 500 RON.`);
  const job = r.list()[0]!;

  // 3. Hourly checks; nothing runs a model.
  let now = job.nextRunMs!;
  let modelRuns = 0;
  const scheduler = new CronScheduler({
    repo: r, watchQuiet: () => false, now: () => new Date(now), watchFetch: fetch,
    runJob: async () => { modelRuns++; return { text: "", finished: true }; },
    deliver: (_t, content) => nudges.route({ kind: "watch", sourceId: job.id, userRequested: true }, {
      phone: async () => { sent.push(content); return "whatsapp"; }, desktop: () => {},
    }, now).then(() => undefined),
  } as never);
  await scheduler.tick();
  expect(sent).toEqual([]);

  // 4. Days later the price drops: one message, with the price and the link.
  now += 3 * 24 * 3_600_000; price = 479;
  await scheduler.tick();
  now += 3_600_000;
  await scheduler.tick();
  expect(sent).toEqual([`The price dropped to 479 RON, under your 500 RON.\n${URL_}`]);
  expect(r.get(job.id)!.history.at(-1)?.proof?.price).toBe(479);
  expect(modelRuns).toBe(0);
  // Every read is kept for the card's graph (spec 4.13), and only for people.
  expect(r.forPeople()[0]!.prices!.map((p) => p.amount)).toEqual([529, 479]);
  expect(r.list()[0]!.prices).toBeUndefined();

  // 5. The person replies on the phone: the nudge is answered.
  nudges.inbound("whatsapp", now + 60_000);
  expect(db.raw.query("SELECT kind, channel, outcome FROM nudges").all()).toEqual([{ kind: "watch", channel: "whatsapp", outcome: "answered" }]);
});
