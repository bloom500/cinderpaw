/**
 * Pages Cubby composes for one person (spec 4.14, slice 10). The model writes
 * a page spec once: data, never code. It is checked here before it is saved
 * (known pieces, a cap on cards, text limits, sources that exist), and every
 * card then updates from its source by code, with no model call.
 *
 * No piece knows a field: labels, units and limits all come from the spec or
 * the source, so "number over time" serves lei, grades or kilograms alike.
 */
import type { Database } from "bun:sqlite";
import type { CronJob } from "../types.ts";

export const PIECES = ["number_over_time", "before_after", "countdown", "done_with_proof", "your_numbers", "plain_list", "question"] as const;
export type Piece = (typeof PIECES)[number];

export interface CardSpec {
  piece: Piece;
  label: string;
  /** number_over_time, before_after: a price watch. done_with_proof, countdown: a task. */
  source?: { kind: "watch" | "task"; id: string };
  /** countdown without a task: a date and time, ISO. */
  date?: string;
  /** plain_list only. */
  items?: string[];
  /** question only: one yes-or-no question, in the person's words. */
  ask?: string;
  /** question only, set by the person's button, never by the model. */
  answer?: "yes" | "not_now";
}
export interface PageSpec { title: string; cards: CardSpec[] }

export const LIMITS = { cards: 8, title: 60, label: 60, items: 10, item: 120, ask: 120 } as const;

const WATCH_PIECES: ReadonlySet<Piece> = new Set(["number_over_time", "before_after"]);
const isPriceWatch = (j: CronJob) => j.kind === "watch" && !!j.watch && "priceBelow" in j.watch;

/** The page as stored, or an error a person (or the model) can act on. Never throws. */
export function checkPage(input: unknown, jobs: CronJob[], now = Date.now()): { page: PageSpec } | { error: string } {
  const p = input as Partial<PageSpec> | null;
  const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= max;
  if (!p || typeof p !== "object") return { error: "A page needs a title and cards." };
  if (!text(p.title, LIMITS.title)) return { error: `The title must be 1-${LIMITS.title} characters.` };
  if (!Array.isArray(p.cards) || p.cards.length === 0 || p.cards.length > LIMITS.cards) return { error: `A page has 1-${LIMITS.cards} cards.` };
  const cards: CardSpec[] = [];
  for (const [n, raw] of p.cards.entries()) {
    const c = raw as Partial<CardSpec>;
    const where = `Card ${n + 1}`;
    if (!c || !PIECES.includes(c.piece as Piece)) return { error: `${where}: piece must be one of ${PIECES.join(", ")}.` };
    if (!text(c.label, LIMITS.label)) return { error: `${where}: the label must be 1-${LIMITS.label} characters.` };
    const card: CardSpec = { piece: c.piece as Piece, label: c.label!.trim() };
    if (WATCH_PIECES.has(card.piece) || card.piece === "done_with_proof" || (card.piece === "countdown" && !c.date)) {
      const job = jobs.find((j) => j.id === c.source?.id);
      if (!job) return { error: `${where}: no task or watch with that id. Use the id from tasks_list.` };
      if (WATCH_PIECES.has(card.piece) && !isPriceWatch(job)) return { error: `${where}: ${card.piece} needs a price watch.` };
      card.source = { kind: job.kind === "watch" ? "watch" : "task", id: job.id };
    }
    if (card.piece === "countdown" && c.date) {
      const at = Date.parse(c.date);
      if (!Number.isFinite(at) || at < now - 86_400_000 || at > now + 5 * 365 * 86_400_000) return { error: `${where}: the date must be a real date within 5 years.` };
      card.date = new Date(at).toISOString();
    }
    if (card.piece === "plain_list") {
      if (!Array.isArray(c.items) || c.items.length === 0 || c.items.length > LIMITS.items || !c.items.every((i) => text(i, LIMITS.item))) {
        return { error: `${where}: a list has 1-${LIMITS.items} lines of up to ${LIMITS.item} characters.` };
      }
      card.items = c.items.map((i) => i.trim());
    }
    if (card.piece === "question") {
      if (!text(c.ask, LIMITS.ask)) return { error: `${where}: a question of up to ${LIMITS.ask} characters.` };
      card.ask = c.ask!.trim();
    }
    cards.push(card);
  }
  return { page: { title: p.title!.trim(), cards } };
}

/** One card ready to draw: the window only draws, it never looks anything up. */
export type CardView =
  | { piece: "number_over_time"; label: string; prices: { at: number; amount: number }[]; limit: number; unit?: string }
  | { piece: "before_after"; label: string; before?: number; after?: number; unit?: string }
  | { piece: "countdown"; label: string; at?: number }
  | { piece: "done_with_proof"; label: string; runs: { at: number; ok: boolean; text: string; link?: string }[] }
  | { piece: "your_numbers"; label: string; wroteFirst: number; answered: number; days: number[] }
  | { piece: "plain_list"; label: string; items: string[] }
  | { piece: "question"; label: string; ask: string; answer?: "yes" | "not_now" }
  | { piece: "gone"; label: string };
/** `recipe`: the page as a shareable recipe (recipeOf), ready to copy. */
export interface PageView { id: string; title: string; cards: CardView[]; recipe: string }

type Week = () => { wroteFirst: number; answered: number; days: number[] };

export function viewPage(id: string, page: PageSpec, jobs: CronJob[], week: Week): PageView {
  const cards = page.cards.map((c): CardView => {
    const job = c.source ? jobs.find((j) => j.id === c.source!.id) : undefined;
    if (c.source && !job) return { piece: "gone", label: c.label };
    const price = job?.watch && "priceBelow" in job.watch ? job.watch : undefined;
    const unit = price?.currency;
    switch (c.piece) {
      case "number_over_time":
        return { piece: c.piece, label: c.label, prices: job!.prices ?? [], limit: price!.priceBelow, ...(unit ? { unit } : {}) };
      case "before_after": {
        const p = job!.prices ?? [];
        return { piece: c.piece, label: c.label, ...(p.length ? { before: p[0]!.amount, after: p.at(-1)!.amount } : {}), ...(unit ? { unit } : {}) };
      }
      case "countdown": {
        const at = c.date ? Date.parse(c.date) : job?.nextRunMs;
        return { piece: c.piece, label: c.label, ...(at ? { at } : {}) };
      }
      case "done_with_proof":
        return { piece: c.piece, label: c.label, runs: job!.history.filter((r) => r.status !== "running").slice(-5).reverse().map((r) => ({
          at: r.runAt, ok: r.status === "success", text: (r.result ?? r.error ?? r.status).split("\n")[0]!.slice(0, 200),
          ...(r.proof?.sourceUrl ? { link: r.proof.sourceUrl } : {}),
        })) };
      case "your_numbers":
        return { piece: c.piece, label: c.label, ...week() };
      case "plain_list":
        return { piece: c.piece, label: c.label, items: c.items ?? [] };
      case "question":
        return { piece: c.piece, label: c.label, ask: c.ask ?? "", ...(c.answer ? { answer: c.answer } : {}) };
    }
  });
  return { id, title: page.title, cards, recipe: recipeOf(page) };
}

/**
 * A page as a recipe anyone can reuse (spec 4.14): the same cards with this
 * person's sources and answers taken out. Each source becomes a blank to fill
 * ("pick your watch"). Opening a recipe never creates a task or a watch: the
 * person fills the blanks and accepts, as with suggest_task.
 */
export function recipeOf(page: PageSpec): string {
  return JSON.stringify({
    recipe: "cinderpaw-page/1",
    title: page.title,
    cards: page.cards.map(({ source, answer: _a, ...c }) => (source ? { ...c, source: { kind: source.kind, blank: `pick your ${source.kind}` } } : c)),
  });
}

export class Pages {
  readonly #db: Database;
  constructor(db: Database) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, spec_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  }
  add(page: PageSpec, now = Date.now()): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.#db.query("INSERT INTO pages (id, spec_json, created_at) VALUES (?, ?, ?)").run(id, JSON.stringify(page), now);
    return id;
  }
  remove(id: string): boolean {
    return this.#db.query("DELETE FROM pages WHERE id = ?").run(id).changes > 0;
  }
  /** The person pressed Yes or Not now on a question card. Only a question card takes an answer. */
  answer(id: string, index: number, yes: boolean): boolean {
    const row = this.list().find((p) => p.id === id);
    const card = row?.page.cards[index];
    if (!row || card?.piece !== "question") return false;
    card.answer = yes ? "yes" : "not_now";
    this.#db.query("UPDATE pages SET spec_json = ? WHERE id = ?").run(JSON.stringify(row.page), id);
    return true;
  }
  list(): Array<{ id: string; page: PageSpec }> {
    try {
      return (this.#db.query("SELECT id, spec_json FROM pages ORDER BY created_at ASC").all() as Array<{ id: string; spec_json: string }>)
        .map((r) => ({ id: r.id, page: JSON.parse(r.spec_json) as PageSpec }));
    } catch { return []; }
  }
  views(jobs: CronJob[], week: Week): PageView[] {
    return this.list().map(({ id, page }) => viewPage(id, page, jobs, week));
  }
}
